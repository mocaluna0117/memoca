//! What the page may ask of the app (capabilities/quick.json), besides
//! signing in (sign_in.rs), in the quick note's window and Memoca's own.

use crate::{app_window, window};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Esc, ×, or saved: the window is put away.
#[tauri::command]
pub fn hide(app: AppHandle) {
    window::hide(&app);
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
