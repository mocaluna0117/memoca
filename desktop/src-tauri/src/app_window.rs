//! Memoca itself, in a window of its own: the notes, as in the browser, for
//! when the quick note's window is too small. Opened from the menu bar
//! icon's menu (or the tray's), or by a note just saved in the quick note;
//! kept as big and where it was left (tauri-plugin-window-state). While it
//! is out, Memoca is an app in the Dock and in ⌘Tab on a Mac, as any other
//! with a window.
//!
//! Made, hidden, soon after the app starts ([`prepare`]), and hidden, not
//! closed, when closed: out at once when opened, its notes loaded and its
//! vault as it was. Gone only on signing out (and made again on signing
//! in), as what it held was the account's.
//!
//! It is shown as the quick note's is (window.rs): the same site, user
//! agent, bridge and WebView2 arguments, and so the same sign-in. Other
//! sites open in the browser; files the page saves go to Downloads.

use crate::{sign_in, window};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Whether the window is out (made but hidden is not).
pub fn is_shown(app: &AppHandle) -> bool {
    window(app).is_some_and(|window| window.is_visible().unwrap_or(false))
}

/// How long after the app starts the window is made, hidden: after the
/// quick note's, which is wanted first. MEMOCA_PREPARE_AFTER_MS says
/// otherwise: CI puts it off, to have the window made when it is opened
/// (scripts/check-windows.ps1).
fn prepared_after() -> std::time::Duration {
    std::env::var("MEMOCA_PREPARE_AFTER_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .map(std::time::Duration::from_millis)
        .unwrap_or(std::time::Duration::from_secs(3))
}

/// Makes the window, hidden, on the notes, a moment from now: for it to come
/// out at once when it is opened. (Opened before then, it is made there.)
pub fn prepare(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(prepared_after());
        if window(&app).is_none() {
            make(&app, window::origin().join("/app").unwrap(), false);
        }
    });
}

/// Whether the window is the one in use.
pub fn is_in_use(app: &AppHandle) -> bool {
    window(app).is_some_and(|window| window.is_focused().unwrap_or(false))
}

/// Opens the window on Memoca's notes, or brings it forward as it is.
pub fn open(app: &AppHandle) {
    if let Some(window) = window(app) {
        bring_out(&window);
    } else {
        make_apart(app, window::origin().join("/app").unwrap(), true);
    }
}

/// Opens one of Memoca's pages in the window: a note just saved, from the
/// quick note. A note, in a window already on the notes, is moved to as
/// the page moves to one (src/components/notes/quick-entry.tsx), rather
/// than loaded again, which would close the vault.
pub fn open_at(app: &AppHandle, url: Url) {
    let Some(window) = window(app) else {
        make_apart(app, url, true);
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

/// Sends the window to one of Memoca's pages: made, hidden, there if it is
/// not (signed in, after signing out took it).
pub fn go(app: &AppHandle, url: Url) {
    if let Some(window) = window(app) {
        let _ = window.navigate(url);
    } else {
        make_apart(app, url, false);
    }
}

/// Puts the window away, if out, keeping it as it is for the next time.
pub fn hide(app: &AppHandle) {
    if let Some(window) = window(app) {
        put_away(app, &window);
    }
}

/// Closes the window for good, if made: on signing out, what it holds is
/// the account's.
pub fn discard(app: &AppHandle) {
    if let Some(window) = window(app) {
        let _ = window.destroy();
    }
}

fn bring_out(window: &WebviewWindow) {
    // On a Mac, an app in the Dock and ⌘Tab while it is out.
    #[cfg(target_os = "macos")]
    let _ = window
        .app_handle()
        .set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Hides the window, as closing it does: its size and place kept, the menu
/// bar alone again on a Mac, and the page told (to load a new version of
/// the site out of sight, as the quick note's does).
fn put_away(app: &AppHandle, window: &WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = app.save_window_state(KEPT);
    let _ = window.hide();
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        // The keyboard back to the app in use before, unless the quick note
        // is out and wants it.
        if !window::is_out(app) {
            let _ = app.hide();
        }
    }
    let _ = window.eval("window.dispatchEvent(new Event('memoca-shell-hidden'))");
}

/// Where each file the page saves is going: a Mac does not say once it is
/// there (tauri's DownloadEvent::Finished).
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, PathBuf>>);

/// Whether the window is being made: asked for again meanwhile, it is not
/// made twice.
static MAKING: AtomicBool = AtomicBool::new(false);

/// What was asked of the window while it was being made, the last of it:
/// done once it is. Dropped, a 「Memoca を開く」 pressed while the hidden
/// window was still being made at start showed nothing.
static WANTED: Mutex<Option<(Url, bool)>> = Mutex::new(None);

/// Makes the window, on a thread of its own. On Windows, a window made on
/// the main thread from within a command the page sent, a menu's choice or
/// another event's handler never gets its WebView2, and the whole app
/// stops (tauri's known issue): the quick note's ×, Esc and the menu with
/// it. 0.4.1 did, from 「Memoca を開く」.
fn make_apart(app: &AppHandle, url: Url, shown: bool) {
    let app = app.clone();
    std::thread::spawn(move || make(&app, url, shown));
}

/// Makes the window, here: on a thread other than the main one.
fn make(app: &AppHandle, url: Url, shown: bool) {
    if MAKING.swap(true, Ordering::SeqCst) {
        *WANTED.lock().unwrap() = Some((url, shown));
        return;
    }
    let made = url.clone();
    if window(app).is_none() {
        if let Err(error) = create(app, url, shown) {
            eprintln!("Memoca: could not make its window: {error}");
        }
    }
    MAKING.store(false, Ordering::SeqCst);
    let wanted = WANTED.lock().unwrap().take();
    if let (Some((url, shown)), Some(window)) = (wanted, window(app)) {
        match after_making(&made, &url, shown) {
            AfterMaking::BringOut => bring_out(&window),
            AfterMaking::Open => open_at(app, url),
            AfterMaking::Go => {
                let _ = window.navigate(url);
            }
            AfterMaking::Nothing => {}
        }
    }
}

/// What a request that came while the window was being made on `made`
/// still needs, now that it is.
#[derive(Debug, PartialEq)]
enum AfterMaking {
    /// Only to be brought out: it is on the page asked for.
    BringOut,
    /// Brought out on another page, or a note.
    Open,
    /// Sent to another page, hidden as it is.
    Go,
    /// Hidden, on the page asked for, as it was made.
    Nothing,
}

fn after_making(made: &Url, url: &Url, shown: bool) -> AfterMaking {
    match (shown, url == made) {
        (true, true) => AfterMaking::BringOut,
        (true, false) => AfterMaking::Open,
        (false, false) => AfterMaking::Go,
        (false, true) => AfterMaking::Nothing,
    }
}

/// Makes the window on `url`, brought out if `shown`, else left hidden.
fn create(app: &AppHandle, url: Url, shown: bool) -> tauri::Result<()> {
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

    let closing = window.clone();
    window.on_window_event(move |event| match event {
        // Closed (its button, ⌘W, Alt+F4): hidden, to come out again at once.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            put_away(&handle, &closing);
        }
        WindowEvent::Destroyed => {
            // Kept now, not only when the app quits: an update starts it again.
            let _ = handle.save_window_state(KEPT);
            // Back to the menu bar alone.
            #[cfg(target_os = "macos")]
            let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
        _ => {}
    });
    if shown {
        bring_out(&window);
    }
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

    #[test]
    fn a_request_made_while_the_window_was_being_made_is_done_after() {
        let app = page("/app");
        assert_eq!(after_making(&app, &app, true), AfterMaking::BringOut);
        assert_eq!(
            after_making(&app, &page("/app?n=abc"), true),
            AfterMaking::Open
        );
        assert_eq!(
            after_making(&app, &page("/sign-in"), false),
            AfterMaking::Go
        );
        assert_eq!(after_making(&app, &app, false), AfterMaking::Nothing);
    }
}
