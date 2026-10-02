//! New versions of the app itself: the site in its window is new as soon as
//! it is deployed, but the shell round it is not. Looked for a minute after
//! the app starts and every six hours since, or when asked from the menu,
//! in the latest release published on GitHub, and taken only if signed with
//! the key the app was built to trust (tauri.conf.json's pubkey). Put in
//! while the window is away, so nothing being written is cut short, and the
//! app started again, hidden.

use crate::window;
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::UpdaterExt;

const FIRST: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How long a window that is out is waited for before looking again.
const WAIT: Duration = Duration::from_secs(5 * 60);

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
                // Out and maybe in use: asked again soon, rather than in six hours.
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
    /// Found, but the window is out: not now.
    Later,
    Failed,
}

async fn look(app: &AppHandle, asked: bool) -> Looked {
    let Ok(updater) = app.updater() else {
        return Looked::Failed;
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Looked::Latest,
        Err(error) => {
            eprintln!("Memoca: could not look for a new version: {error}");
            return Looked::Failed;
        }
    };
    if window::is_out(app) {
        if !asked {
            return Looked::Later;
        }
        // Asked for: put away first, its draft kept by the page.
        window::hide(app);
        std::thread::sleep(Duration::from_millis(1500));
    }
    say(app, &format!("{} を入れています…", update.version));
    match update.download_and_install(|_, _| {}, || {}).await {
        // On Windows the installer has taken over, and closes the app itself.
        Ok(()) => app.restart(),
        Err(error) => {
            eprintln!("Memoca: could not put in {}: {error}", update.version);
            say(app, "更新できませんでした");
            Looked::Failed
        }
    }
}
