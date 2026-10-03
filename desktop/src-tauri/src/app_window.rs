//! Memoca itself, in a window of its own: the notes, as in the browser, for
//! when the quick note's window is too small. Opened from the menu bar
//! icon's menu (or the tray's), or by a note just saved in the quick note;
//! made when opened and gone when closed, kept as big and where it was left
//! (tauri-plugin-window-state). While it is open, Memoca is an app in the
//! Dock and in ⌘Tab on a Mac, as any other with a window.
//!
//! It is shown as the quick note's is (window.rs): the same site, user
//! agent, bridge and WebView2 arguments, and so the same sign-in. Other
//! sites open in the browser; files the page saves go to Downloads.

use crate::{sign_in, window};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use url::Url;

pub const LABEL: &str = "app";

/// What is kept of the window when it closes: its size and place, and
/// whether it filled the screen.
pub const KEPT: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/// Memoca's pages but those only the browser goes through to sign the app
/// in (src/app/desktop): /desktop/sign-in and /desktop/handoff.
fn is_app_page(url: &Url) -> bool {
    window::is_memoca(url) && !matches!(url.path(), "/desktop/sign-in" | "/desktop/handoff")
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Whether a window is this one.
pub fn is_label(label: &str) -> bool {
    label == LABEL
}

/// Whether the window is open.
pub fn is_open(app: &AppHandle) -> bool {
    window(app).is_some()
}

/// Whether the window is the one in use.
pub fn is_in_use(app: &AppHandle) -> bool {
    window(app).is_some_and(|window| window.is_focused().unwrap_or(false))
}

/// Opens the window on Memoca's notes, or brings it forward as it is.
pub fn open(app: &AppHandle) {
    if let Some(window) = window(app) {
        bring_out(&window);
    } else if let Err(error) = create(app, window::origin().join("/app").unwrap()) {
        eprintln!("Memoca: could not open its window: {error}");
    }
}

/// Opens one of Memoca's pages in the window: a note just saved, from the
/// quick note. A note, in a window already on the notes, is moved to as
/// the page moves to one (src/components/notes/quick-entry.tsx), rather
/// than loaded again, which would close the vault.
pub fn open_at(app: &AppHandle, url: Url) {
    let Some(window) = window(app) else {
        if let Err(error) = create(app, url) {
            eprintln!("Memoca: could not open its window: {error}");
        }
        return;
    };
    let note = url
        .query_pairs()
        .find(|(key, _)| key == "n")
        .map(|(_, value)| value.into_owned());
    let on_notes = window
        .url()
        .is_ok_and(|at| window::is_memoca(&at) && at.path().starts_with("/app"));
    match note {
        Some(note) if on_notes && url.path() == "/app" => {
            let message = serde_json::json!({ "type": "memoca:open-note", "noteId": note });
            let _ = window.eval(format!(
                "window.postMessage({message}, window.location.origin)"
            ));
        }
        _ => {
            let _ = window.navigate(url);
        }
    }
    bring_out(&window);
}

/// Sends the window, if open, to one of Memoca's pages.
pub fn go(app: &AppHandle, url: Url) {
    if let Some(window) = window(app) {
        let _ = window.navigate(url);
    }
}

/// Closes the window, if open, keeping its size and place.
pub fn close(app: &AppHandle) {
    if let Some(window) = window(app) {
        let _ = window.close();
    }
}

fn bring_out(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Where each file the page saves is going: a Mac does not say once it is
/// there (tauri's DownloadEvent::Finished).
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, PathBuf>>);

fn create(app: &AppHandle, url: Url) -> tauri::Result<()> {
    let (guard, opener, saver, handle) = (app.clone(), app.clone(), app.clone(), app.clone());
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Memoca")
        .inner_size(1180.0, 800.0)
        .min_inner_size(480.0, 400.0)
        .center()
        // Shown once the plugin has put it where it was left.
        .visible(false)
        .user_agent(&window::user_agent())
        .initialization_script(window::bridge())
        // The page's own: files dropped into a note, blocks dragged in it.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            sign_in::on_navigation(&guard, LABEL, url);
            if is_app_page(url) {
                return true;
            }
            window::open_outside(&guard, url);
            false
        })
        // A link opened in a new window (target=_blank, window.open) goes
        // to the browser.
        .on_new_window(move |url, _| {
            window::open_outside(&opener, &url);
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| saved(&saver, event));
    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args(&window::browser_args());
    let window = builder.build()?;

    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            // Kept now, not only when the app quits: an update starts it again.
            let _ = handle.save_window_state(KEPT);
            // Back to the menu bar alone.
            #[cfg(target_os = "macos")]
            let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    });
    bring_out(&window);
    Ok(())
}

/// A file the page saves (a note as PDF, an attachment): into Downloads,
/// under its own name, numbered if one is there already (as wry and
/// WebView2 have it), and shown there once it is.
fn saved(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
    let downloads = app.state::<Downloads>();
    match event {
        DownloadEvent::Requested { url, destination } => {
            downloads
                .0
                .lock()
                .unwrap()
                .insert(url.to_string(), destination.clone());
        }
        DownloadEvent::Finished { url, path, success } => {
            let going = downloads.0.lock().unwrap().remove(url.as_str());
            if let (true, Some(path)) = (success, path.or(going)) {
                let _ = app.opener().reveal_item_in_dir(path);
            }
        }
        _ => {}
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(path: &str) -> Url {
        window::origin().join(path).unwrap()
    }

    #[test]
    fn shows_memocas_pages_but_the_browsers_own() {
        assert!(is_app_page(&page("/app")));
        assert!(is_app_page(&page("/app?n=abc")));
        assert!(is_app_page(&page("/sign-in?next=%2Fapp")));
        assert!(is_app_page(&page("/desktop/complete?to=app")));
        assert!(is_app_page(&page("/quick")));
        assert!(!is_app_page(&page("/desktop/sign-in")));
        assert!(!is_app_page(&page("/desktop/handoff")));
        assert!(!is_app_page(
            &Url::parse("https://accounts.google.com/").unwrap()
        ));
        assert!(!is_app_page(
            &Url::parse("https://example.com/app").unwrap()
        ));
    }
}
