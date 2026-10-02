//! The quick note's window: one, small, frameless and above the others,
//! loaded when the app starts and hidden until it is called for. It shows
//! Memoca's quick note (and its sign-in) and nothing else: any other page
//! opens in the browser.

use crate::screen::{self, Area};
use crate::settings::{Corner, Store};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

pub const LABEL: &str = "quick";

/// Where Memoca is. A build for development can be pointed elsewhere
/// (MEMOCA_ORIGIN=http://localhost:3100); a release never is.
pub fn origin() -> Url {
    #[cfg(debug_assertions)]
    if let Some(url) = std::env::var("MEMOCA_ORIGIN")
        .ok()
        .and_then(|value| Url::parse(&value).ok())
    {
        return url;
    }
    Url::parse("https://memoca-app.vercel.app").unwrap()
}

/// Whether an address is one of Memoca's own pages.
pub fn is_memoca(url: &Url) -> bool {
    url.origin() == origin().origin()
}

/// The pages the window shows: the quick note, signing in, taking the code
/// the app hands over (sign_in.rs), and signing out. The rest of Memoca opens in the
/// browser, where it has room.
fn is_windows_page(url: &Url) -> bool {
    is_memoca(url)
        && matches!(
            url.path(),
            "/quick" | "/sign-in" | "/desktop/complete" | "/desktop/sign-out"
        )
}

fn quick_url() -> Url {
    origin().join("/quick?window=1").unwrap()
}

/// The system, as the site is told it (src/lib/quick/shell.ts): "macos" or "windows".
pub const PLATFORM: &str = if cfg!(target_os = "windows") {
    "windows"
} else {
    "macos"
};

/// What the window tells the site it is: the engine it is (Safari's on a
/// Mac, Edge's on Windows), and the shell (src/lib/quick/shell.ts reads it
/// before any script runs).
fn user_agent() -> String {
    let engine = if cfg!(target_os = "windows") {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
    } else {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    };
    format!(
        "{engine} MemocaShell/{} ({PLATFORM})",
        env!("CARGO_PKG_VERSION")
    )
}

/// What the page is given as `window.memocaShell` (src/lib/quick/shell.ts),
/// on Memoca's pages only.
fn bridge() -> String {
    format!(
        r#"(() => {{
  if (location.origin !== {origin:?}) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  Object.defineProperty(window, "memocaShell", {{
    value: Object.freeze({{
      hide: () => void invoke("hide"),
      openExternal: (url) => void invoke("open_external", {{ url: String(url) }}),
      beginSignIn: () => invoke("begin_sign_in"),
      completeSignIn: (code) => invoke("complete_sign_in", {{ code: String(code) }}),
      takeSignIn: () => invoke("take_sign_in"),
      platform: {platform:?},
    }}),
  }});
}})();"#,
        origin = origin().origin().ascii_serialization(),
        platform = PLATFORM
    )
}

/// Opens a web address in the browser; anything else is let go.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Whether the window may load `url`: its own pages only. Any other web
/// address opens in the browser instead. (A move within a page, as Next
/// makes between its pages, is no load: the pages the window shows link
/// nowhere else.)
fn may_go(app: &AppHandle, url: &Url) -> bool {
    if is_windows_page(url) {
        return true;
    }
    open_outside(app, url);
    false
}

/// When the window's page was last loaded: one older than this is loaded
/// again as it comes out, rather than shown as it was (a version of the
/// site long gone, a sign-in long out of date).
pub struct Loaded(Mutex<Instant>);

const STALE: Duration = Duration::from_secs(12 * 60 * 60);

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let (guard, opener) = (app.clone(), app.clone());
    // As big as it was last put away, or as it starts.
    let (width, height) = app.state::<Store>().get().size.unwrap_or((420.0, 360.0));
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(quick_url()))
        .title("Memoca")
        .inner_size(width.max(320.0), height.max(240.0))
        .min_inner_size(320.0, 240.0)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .minimizable(false)
        .visible(false)
        .user_agent(&user_agent())
        .initialization_script(bridge())
        .on_navigation(move |url| may_go(&guard, url))
        // A link opened in a new window (target=_blank, window.open) goes
        // to the browser, rather than nowhere.
        .on_new_window(move |url, _| {
            open_outside(&opener, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    app.manage(Loaded(Mutex::new(Instant::now())));
    #[cfg(target_os = "windows")]
    out_of_alt_tab(&window);

    let handle = app.clone();
    window.on_window_event(move |event| match event {
        // Put away when another app is clicked, unless pinned.
        WindowEvent::Focused(false) if !handle.state::<Store>().get().pinned => hide(&handle),
        // ⌘W, say: put away, never closed, so it stays loaded.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(&handle);
        }
        _ => {}
    });
    Ok(())
}

/// Keeps the window out of Alt-Tab, as it is out of the taskbar: a tool
/// window, called by its hotkey or the tray icon, never switched to.
#[cfg(target_os = "windows")]
fn out_of_alt_tab(window: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    // SAFETY: the window's own handle, on the thread that made it.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let style = (style | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    }
}

/// Where the window comes out.
pub enum Place {
    /// At the top of the screen the pointer is on, in the middle.
    Cursor,
    /// By the menu bar icon (where it is, in its screen's pixels): under it
    /// at the top of the screen, above it at the foot (a taskbar's tray).
    Tray(Rect),
    /// In a corner of the screen the pointer is on.
    Corner(Corner),
}

/// Where the window's top left corner goes, in points: `size` is the
/// window's, `usable` what the screen's menu bar and Dock (or taskbar)
/// leave, `icon` the menu bar (or tray) icon's place. Kept on the screen,
/// whatever the icon's.
fn spot(place: &Place, size: (f64, f64), usable: Area, icon: Option<Area>) -> (f64, f64) {
    let (width, height) = size;
    let margin = 12.0;
    let (left, top) = (usable.x, usable.y);
    let (right, bottom) = (usable.x + usable.width, usable.y + usable.height);
    let (x, y) = match (place, icon) {
        (Place::Tray(_), Some(icon)) => {
            let x = icon.x + icon.width / 2.0 - width / 2.0;
            // An icon in the lower half is in a taskbar at the foot of the screen.
            let low = icon.y + icon.height / 2.0 > usable.y + usable.height / 2.0;
            let y = if low {
                icon.y - height - 4.0
            } else {
                icon.y + icon.height + 4.0
            };
            (x, y)
        }
        (Place::Corner(Corner::TopLeft), _) => (left + margin, top + margin),
        (Place::Corner(Corner::TopRight), _) => (right - width - margin, top + margin),
        (Place::Corner(Corner::BottomLeft), _) => (left + margin, bottom - height - margin),
        (Place::Corner(Corner::BottomRight), _) => {
            (right - width - margin, bottom - height - margin)
        }
        _ => (
            left + (usable.width - width) / 2.0,
            top + usable.height / 8.0,
        ),
    };
    (
        x.clamp(left, (right - width).max(left)),
        y.clamp(top, (bottom - height).max(top)),
    )
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn place(app: &AppHandle, window: &WebviewWindow, place: &Place) {
    let (Ok(size), Ok(scale)) = (window.outer_size(), window.scale_factor()) else {
        return;
    };
    let Some((screen, _)) = screen::at_pointer(app) else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    // The icon was just clicked: it is on the screen the pointer is on.
    let icon = match place {
        Place::Tray(rect) => {
            let at = rect.position.to_logical::<f64>(screen.scale);
            let span = rect.size.to_logical::<f64>(screen.scale);
            Some(Area {
                x: at.x,
                y: at.y,
                width: span.width,
                height: span.height,
            })
        }
        _ => None,
    };
    let (x, y) = spot(place, (size.width, size.height), screen.usable, icon);
    let _ = window.set_position(screen::position(x, y, screen.scale));
}

/// Brings the window out at `where_`, to type in at once. One already out
/// (pinned, say, and moved by hand) stays where it is.
pub fn show(app: &AppHandle, where_: Place) {
    let Some(window) = window(app) else { return };
    if !window.is_visible().unwrap_or(false) {
        let settings = app.state::<Store>().get();
        match settings.position {
            // Pinned, it comes out where it was left.
            Some((x, y)) if settings.pinned => {
                let _ = window.set_position(LogicalPosition::new(x, y));
            }
            _ => place(app, &window, &where_),
        }
        // Loaded long ago: loaded again on the way out.
        let loaded = app.state::<Loaded>();
        let mut at = loaded.0.lock().unwrap();
        if at.elapsed() >= STALE {
            *at = Instant::now();
            let _ = window.navigate(quick_url());
        }
    }
    // After the move, which macOS makes when it next can: not first seen
    // where it was last.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let _ = handle.show();
        let _ = window.show();
        let _ = window.set_focus();
    });
}

/// Puts the window away, as it is, and hands the keyboard back to the app
/// in use before: what was being written is kept as a draft by the page.
/// The page is told, so it can load a new version of the site while out of
/// sight.
pub fn hide(app: &AppHandle) {
    let Some(window) = window(app) else { return };
    if window.is_visible().unwrap_or(false) {
        remember(app, &window);
        let _ = window.hide();
        #[cfg(target_os = "macos")]
        let _ = app.hide();
        let _ = window.eval("window.dispatchEvent(new Event('memoca-shell-hidden'))");
    }
}

/// Keeps the window's size, and where it is if pinned, for the next time it
/// comes out (after a restart too).
fn remember(app: &AppHandle, window: &WebviewWindow) {
    let (Ok(scale), Ok(size), Ok(at)) = (
        window.scale_factor(),
        window.inner_size(),
        window.outer_position(),
    ) else {
        return;
    };
    let size: LogicalSize<f64> = size.to_logical(scale);
    let at: LogicalPosition<f64> = at.to_logical(scale);
    let store = app.state::<Store>();
    let before = store.get();
    let position = before.pinned.then_some((at.x, at.y));
    if before.size != Some((size.width, size.height)) || before.position != position {
        store.update(|settings| {
            settings.size = Some((size.width, size.height));
            settings.position = position;
        });
    }
}

/// Whether the window is out.
pub fn is_out(app: &AppHandle) -> bool {
    window(app).is_some_and(|window| window.is_visible().unwrap_or(false))
}

/// Brings the window out, or puts it away if it is out and in use.
pub fn toggle(app: &AppHandle, where_: Place) {
    let Some(window) = window(app) else { return };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        hide(app);
    } else {
        show(app, where_);
    }
}

/// Loads the window's page again: the quick note.
pub fn reload(app: &AppHandle) {
    if let Some(window) = window(app) {
        *app.state::<Loaded>().0.lock().unwrap() = Instant::now();
        let _ = window.navigate(quick_url());
    }
}

/// Sends the window to one of its own pages.
pub fn go(app: &AppHandle, url: Url) {
    if let Some(window) = window(app) {
        let _ = window.navigate(url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Area = Area {
        x: 0.0,
        y: 25.0,
        width: 1440.0,
        height: 850.0,
    };
    const WINDOW: (f64, f64) = (420.0, 360.0);

    #[test]
    fn the_window_comes_out_high_in_the_middle_or_in_its_corner() {
        assert_eq!(
            spot(&Place::Cursor, WINDOW, SCREEN, None),
            (510.0, 25.0 + 850.0 / 8.0)
        );
        assert_eq!(
            spot(&Place::Corner(Corner::TopLeft), WINDOW, SCREEN, None),
            (12.0, 37.0)
        );
        assert_eq!(
            spot(&Place::Corner(Corner::BottomRight), WINDOW, SCREEN, None),
            (1440.0 - 420.0 - 12.0, 875.0 - 360.0 - 12.0)
        );
    }

    #[test]
    fn under_the_menu_bar_icon_and_kept_on_the_screen() {
        let rect = Rect::default();
        let icon = |x| Area {
            x,
            y: 0.0,
            width: 30.0,
            height: 24.0,
        };
        // Below the menu bar, where the screen's usable part starts.
        assert_eq!(
            spot(&Place::Tray(rect), WINDOW, SCREEN, Some(icon(700.0))),
            (715.0 - 210.0, 28.0)
        );
        // An icon at the screen's right edge: the window stays on the screen.
        assert_eq!(
            spot(&Place::Tray(rect), WINDOW, SCREEN, Some(icon(1420.0))).0,
            1440.0 - 420.0
        );
    }

    #[test]
    fn above_a_tray_icon_at_the_foot_of_the_screen() {
        // Windows: the taskbar at the foot, under what the screen leaves.
        let screen = Area {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1032.0,
        };
        let icon = Area {
            x: 1700.0,
            y: 1040.0,
            width: 24.0,
            height: 32.0,
        };
        // Above the icon, kept within what the screen leaves: its right edge
        // and the top of the taskbar.
        assert_eq!(
            spot(&Place::Tray(Rect::default()), WINDOW, screen, Some(icon)),
            (1920.0 - 420.0, 1032.0 - 360.0)
        );
    }

    #[test]
    fn on_a_second_screen_counts_from_where_that_screen_is() {
        let right = Area {
            x: 1440.0,
            y: 0.0,
            width: 1920.0,
            height: 1055.0,
        };
        assert_eq!(
            spot(&Place::Corner(Corner::TopLeft), WINDOW, right, None),
            (1452.0, 12.0)
        );
    }

    #[test]
    fn shows_its_own_pages_only() {
        let page = |path: &str| origin().join(path).unwrap();
        assert!(is_windows_page(&page("/quick?window=1")));
        assert!(is_windows_page(&page("/sign-in?next=%2Fquick")));
        assert!(is_windows_page(&page("/desktop/complete")));
        assert!(is_windows_page(&page("/desktop/sign-out")));
        assert!(!is_windows_page(&page("/desktop/handoff")));
        assert!(!is_windows_page(&page("/app")));
        assert!(!is_windows_page(&page("/")));
        assert!(!is_windows_page(&page("/terms")));
        assert!(!is_windows_page(
            &Url::parse("https://evil.example/quick").unwrap()
        ));
    }
}
