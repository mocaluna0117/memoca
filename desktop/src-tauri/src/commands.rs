//! What the page may ask of the app (capabilities/quick.json), besides
//! signing in (sign_in.rs), in the quick note's window and Memoca's own.

use crate::settings::{Store, Switch};
use crate::tray;
use crate::{app_window, reminders, window};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Esc, ×, or saved: the window the page is in is put away (Memoca's own,
/// by its Esc, from 0.4.17; the quick note's before).
#[tauri::command]
pub fn hide(app: AppHandle, webview: WebviewWindow) {
    if app_window::is_label(webview.label()) {
        app_window::hide(&app);
    } else {
        window::hide(&app);
    }
}

/// Opens one of Memoca's pages in the browser (a note just saved, from an
/// earlier version of the site, which knows no open_app). Only Memoca's, so a page cannot have
/// the app open anything else.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|error| error.to_string())?;
    if !window::is_memoca(&url) {
        return Err("only Memoca's pages open from here".into());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// Opens one of Memoca's pages (a note just saved in the quick note) in
/// Memoca's own window. Only Memoca's.
#[tauri::command]
pub fn open_app(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|error| error.to_string())?;
    if !window::is_memoca(&url) {
        return Err("only Memoca's pages open from here".into());
    }
    app_window::open_at(&app, url);
    Ok(())
}

/// Memoca's own window, asked for from the quick note (its 「Memoca を開く」):
/// the quick note is put away, its draft kept, and the window opened on the
/// notes, or brought forward as it was, so its vault stays open.
#[tauri::command]
pub fn show_app(app: AppHandle) {
    window::put_away(&app);
    app_window::open(&app);
}

/// The quick note, asked for from Memoca's own window (its ⚡ and Q): this
/// app's, rather than a window of the page's.
#[tauri::command]
pub fn show_quick(app: AppHandle) {
    window::show(&app, window::Place::Cursor);
}

/// Signing out from the app's menu, once the page has made sure (the
/// unsent asked about first, src/components/desktop/sign-out.tsx): Memoca's
/// own window goes, with its vault, and is made again on signing in
/// (sign_in.rs); the account's reminders are no longer shown here, turned
/// on again by whoever signs in. Done by the menu itself before the page
/// asked, they stayed gone when the answer was not to sign out.
#[tauri::command]
pub fn sign_out_app(app: AppHandle) {
    app_window::discard(&app);
    reminders::turn_off(&app);
}

/// Whether the quick note's window is pinned: kept out when another app is
/// clicked, and put away by one press of its hotkey (window.rs). For the
/// settings page of 0.4.16; later ones ask [`setting_get`].
#[tauri::command]
pub fn pinned_get(app: AppHandle) -> bool {
    Switch::QuickPinned.of(&app.state::<Store>().get())
}

/// Pins the quick note's window, or not, from the settings page of 0.4.16:
/// the menu's item ticked to match. What it is after.
#[tauri::command]
pub fn pinned_set(app: AppHandle, on: bool) -> bool {
    setting_set(app, "quickPinned".into(), on).unwrap_or(false)
}

/// One of the settings the settings page turns on and off, as it names it
/// ([`Switch`]): the windows pinned, and Memoca's own let go of while
/// memory is short.
#[tauri::command]
pub fn setting_get(app: AppHandle, name: String) -> Result<bool, String> {
    Ok(Switch::named(&name)?.of(&app.state::<Store>().get()))
}

/// Turns one of them on or off: the menu's item ticked to match. What it is
/// after. Memoca's own window, let go of for memory, is made again at once
/// as that is turned off, to come out at once as it is then kept.
#[tauri::command]
pub fn setting_set(app: AppHandle, name: String, on: bool) -> Result<bool, String> {
    let switch = Switch::named(&name)?;
    tray::set_switch(&app, switch, on);
    if switch == Switch::LetGoWhenShort && !on {
        // Off the main thread, as the window is made (app_window.rs).
        let maker = app.clone();
        std::thread::spawn(move || app_window::make_again(&maker));
    }
    Ok(switch.of(&app.state::<Store>().get()))
}
