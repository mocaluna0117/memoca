//! New versions of the app itself: the site in its window is new as soon as
//! it is deployed, but the shell round it is not. Looked for a minute after
//! the app starts and every six hours since, or when asked from the menu,
//! in the latest release published on GitHub, and taken only if signed with
//! the key the app was built to trust (tauri.conf.json's pubkey). Put in
//! while the quick note is away and Memoca's own window closed, so nothing
//! being written is cut short, and the app started again, hidden.

use crate::{app_window, window};
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::UpdaterExt;

const FIRST: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
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

/// Whether a window is out: the quick note (but one pinned, as long as it
/// is not the one in use), or Memoca's own.
fn in_use(app: &AppHandle) -> bool {
    app_window::is_shown(app) || (window::is_out(app) && !window::is_pinned_aside(app))
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
        // the person with the restart.
        while in_use(app) {
            std::thread::sleep(AWAY_EVERY);
        }
        // A pinned one left out, not in use: put away, its draft kept.
        window::hide(app);
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
