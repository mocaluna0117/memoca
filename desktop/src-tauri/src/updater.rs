//! New versions of the app itself: the site in its window is new as soon as
//! it is deployed, but the shell round it is not. Looked for a minute after
//! the app starts and every ten minutes since (six hours until 0.4.21), or
//! when asked from the menu,
//! in the latest release published on GitHub, and taken only if signed with
//! the key the app was built to trust (tauri.conf.json's pubkey). Put in
//! while the quick note is away and Memoca's own window closed, so nothing
//! being written is cut short, and the app started again, hidden. A window
//! pinned and left out aside is no reason to wait (it may stay out all
//! day): the quick note's, not the one in use; Memoca's own, on top, left
//! for ten minutes while another app is in use. Each is put away first,
//! what it holds kept, and stays away after the restart.

use crate::{app_window, window};
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::UpdaterExt;

const FIRST: Duration = Duration::from_secs(60);
/// Every ten minutes: a release is published by CI as soon as it is built
/// (.github/workflows/desktop.yml), and wanted here soon after, not hours
/// on. What is asked is latest.json alone, a few kilobytes, from GitHub's
/// release files (not its API, which would count the asks).
const EVERY: Duration = Duration::from_secs(10 * 60);
/// How long a window that is out is waited for before looking again.
const WAIT: Duration = Duration::from_secs(5 * 60);
/// How long asking whether there is a new version may take. With none,
/// one asked as the computer went to sleep, its answer never to come, held
/// the looking up for as long as the app ran.
const ASK_FOR: Duration = Duration::from_secs(60);
/// How long the new version may take to come down (some 10 MB, on a slow line).
const FETCH_FOR: Duration = Duration::from_secs(20 * 60);
/// How often, the new version here, the windows are looked at again for both to be away.
const AWAY_EVERY: Duration = Duration::from_secs(5);

/// The menu's line that says which version this is, and how looking went.
pub struct VersionItem(pub MenuItem<Wry>);

fn say(app: &AppHandle, what: &str) {
    let version = app.package_info().version.to_string();
    let text = if what.is_empty() {
        format!("バージョン {version}")
    } else {
        format!("バージョン {version}（{what}）")
    };
    if let Some(item) = app.try_state::<VersionItem>() {
        let _ = item.0.set_text(text);
    }
}

/// Looks now and then, for as long as the app runs.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST);
        loop {
            match tauri::async_runtime::block_on(look(&app, false)) {
                // A window out, maybe in use: asked again soon, rather than in six hours.
                Looked::Later => std::thread::sleep(WAIT),
                _ => std::thread::sleep(EVERY),
            }
        }
    });
}

/// Looks for a new version from the menu, saying on it how that went.
pub fn look_now(app: &AppHandle) {
    let app = app.clone();
    say(&app, "確認しています…");
    tauri::async_runtime::spawn(async move {
        match look(&app, true).await {
            Looked::Latest => say(&app, "最新です"),
            Looked::Failed => say(&app, "確認できませんでした"),
            Looked::Later => {}
        }
    });
}

enum Looked {
    Latest,
    /// Found, but a window is out: not now.
    Later,
    Failed,
}

/// Whether a window out is to be waited for: Memoca's own (but one pinned
/// on top and left there a while), or the quick note (but one pinned, as
/// long as it is not the one in use).
fn waits(app_shown: bool, app_left_on_top: bool, quick_out: bool, quick_pinned_aside: bool) -> bool {
    (app_shown && !app_left_on_top) || (quick_out && !quick_pinned_aside)
}

/// [`waits`], as the windows are now: looked at on the main thread, where a
/// Mac says which app is in use. Not to be told: waited for.
fn in_use(app: &AppHandle) -> bool {
    on_main(app, in_use_here).unwrap_or(true)
}

fn in_use_here(app: &AppHandle) -> bool {
    waits(
        app_window::is_shown(app),
        app_window::is_left_on_top(app),
        window::is_out(app),
        window::is_pinned_aside(app),
    )
}

/// `look` done on the main thread, its answer brought back here; None if it
/// could not be (the app going).
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    look: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(look(&handle));
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(10)).ok()
}

async fn look(app: &AppHandle, asked: bool) -> Looked {
    let Ok(updater) = app.updater_builder().timeout(ASK_FOR).build() else {
        return Looked::Failed;
    };
    let mut update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Looked::Latest,
        Err(error) => {
            eprintln!("Memoca: could not look for a new version: {error}");
            return Looked::Failed;
        }
    };
    if !asked && in_use(app) {
        return Looked::Later;
    }
    say(app, &format!("{} を入れています…", update.version));
    update.timeout = Some(FETCH_FOR);
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("Memoca: could not fetch {}: {error}", update.version);
            say(app, "更新できませんでした");
            return Looked::Failed;
        }
    };
    if asked {
        // Asked for: put away first, the quick note's draft kept by the
        // page, and the notes, kept on this computer as they are written.
        window::hide(app);
        app_window::hide(app);
        std::thread::sleep(Duration::from_millis(1500));
    } else {
        // Come down while nothing was out: a window brought out meanwhile
        // (and being written in) is waited for, rather than closed under
        // the person with the restart. One pinned and left out is put away,
        // what it holds kept, in the same turn as the last look, so none is
        // taken back up in between; and given a moment, as one asked for is.
        loop {
            while in_use(app) {
                std::thread::sleep(AWAY_EVERY);
            }
            let put_away = on_main(app, |app| {
                if in_use_here(app) {
                    return false;
                }
                window::hide(app);
                app_window::hide(app);
                true
            });
            if put_away == Some(true) {
                break;
            }
            std::thread::sleep(AWAY_EVERY);
        }
        std::thread::sleep(Duration::from_millis(1500));
    }
    match update.install(bytes) {
        // On Windows the installer has taken over, and closes the app itself.
        Ok(()) => app.restart(),
        Err(error) => {
            eprintln!("Memoca: could not put in {}: {error}", update.version);
            say(app, "更新できませんでした");
            Looked::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::waits;

    #[test]
    fn waited_for_but_a_window_pinned_and_left_out() {
        assert!(!waits(false, false, false, false));
        // Memoca's own out: waited for, unless left on top a while.
        assert!(waits(true, false, false, false));
        assert!(!waits(true, true, false, false));
        // The quick note out: waited for, unless pinned aside.
        assert!(waits(false, false, true, false));
        assert!(!waits(false, false, true, true));
        // Both: each as it is.
        assert!(waits(true, true, true, false));
        assert!(!waits(true, true, true, true));
    }
}
