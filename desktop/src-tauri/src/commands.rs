//! What the page may ask of the app (capabilities/quick.json), besides
//! signing in (sign_in.rs).

use crate::window;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Esc, ×, or saved: the window is put away.
#[tauri::command]
pub fn hide(app: AppHandle) {
    window::hide(&app);
}

/// Opens one of Memoca's pages (a note just saved, say) in the browser: the
/// window is the quick note's alone. Only Memoca's, so a page cannot have
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
