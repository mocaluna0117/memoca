//! The quick note's window: one, small, frameless and above the others,
//! loaded when the app starts and hidden until it is called for. It shows
//! Memoca's quick note (and its sign-in) and nothing else: any other page
//! opens in the browser.

use crate::screen::{self, Area};
use crate::settings::{Corner, Store};
use crate::{activation, app_window, sign_in};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::utils::config::BackgroundThrottlingPolicy;
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

/// What the window's WebView2 is started with: what wry starts it with
/// when given nothing, and what is asked for in
/// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS. WebView2 is documented to add
/// that to an app's own, but does not with wry's (nor the policy in the
/// registry): it is how the window's checks open its debugging port
/// (scripts/check-windows.ps1).
#[cfg(target_os = "windows")]
pub fn browser_args() -> String {
    // wry's, for a window that may play sound unasked (Tauri's default).
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --autoplay-policy=no-user-gesture-required",
    );
    if let Ok(more) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        eprintln!("Memoca: WebView2 also started with {more}");
        args.push(' ');
        args.push_str(&more);
    }
    args
}

/// What the window tells the site it is: the engine it is (Safari's on a
/// Mac, Edge's on Windows), and the shell (src/lib/quick/shell.ts reads it
/// before any script runs).
pub fn user_agent() -> String {
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
/// on Memoca's pages only, in this window and Memoca's own (app_window.rs).
pub fn bridge() -> String {
    format!(
        r#"(() => {{
  if (location.origin !== {origin:?}) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  Object.defineProperty(window, "memocaShell", {{
    value: Object.freeze({{
      hide: () => void invoke("hide"),
      openExternal: (url) => void invoke("open_external", {{ url: String(url) }}),
      openApp: (url) => void invoke("open_app", {{ url: String(url) }}),
      showQuick: () => void invoke("show_quick"),
      showApp: () => void invoke("show_app"),
      copyImages: (images) =>
        invoke("copy_images", {{ images: Array.from(images, ({{ name, data }}) => ({{ name: String(name), data: String(data) }})) }}),
      deviceUnlock: Object.freeze({{
        kind: () => invoke("device_unlock_kind"),
        secret: (create) => invoke("device_unlock_secret", {{ create: Boolean(create) }}),
      }}),
      beginSignIn: () => invoke("begin_sign_in"),
      completeSignIn: (code) => invoke("complete_sign_in", {{ code: String(code) }}),
      takeSignIn: () => invoke("take_sign_in"),
      reminders: Object.freeze({{
        state: () => invoke("reminders_state"),
        turnOn: () => invoke("reminders_turn_on"),
        turnOff: () => invoke("reminders_turn_off"),
        set: (list) =>
          void invoke("set_reminders", {{
            reminders: Array.from(list, ({{ key, at, title, body }}) => ({{ key: String(key), at: Number(at), title: String(title), body: String(body) }})),
          }}).catch(() => undefined),
      }}),
      hotkeys: Object.freeze({{
        get: () => invoke("hotkeys_get"),
        set: (which, keys) => invoke("hotkeys_set", {{ which: String(which), keys: String(keys) }}),
        recording: (on) => invoke("hotkeys_recording", {{ on: Boolean(on) }}),
      }}),
      signOut: () => invoke("sign_out_app"),
      platform: {platform:?},
    }}),
  }});
}})();"#,
        origin = origin().origin().ascii_serialization(),
        platform = PLATFORM
    )
}

/// Opens a web address in the browser; anything else is let go.
pub fn open_outside(app: &AppHandle, url: &Url) {
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
/// again as it is put away, out of sight, rather than kept as it was (a
/// version of the site long gone, a sign-in long out of date). Not as it
/// comes out: loaded again then, it took no click and no key for some
/// seconds (on a machine short of memory, longer), just as it was wanted.
pub struct Loaded(Mutex<Instant>);

/// Whether Memoca's own window (app_window.rs) was in use when this one
/// came out: then the keyboard goes back to it as this one is put away.
pub struct CameFromApp(AtomicBool);

const STALE: Duration = Duration::from_secs(12 * 60 * 60);

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let (guard, opener) = (app.clone(), app.clone());
    // As big as it was last put away, or as it starts.
    let (width, height) = app.state::<Store>().get().size.unwrap_or((420.0, 360.0));
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(quick_url()))
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
        // Kept running, if slowed, while put away: WebKit otherwise suspends
        // a hidden window's page a few minutes on, and this one, made first,
        // is often the one that syncs (the site's lib/sync/engine.ts).
        .background_throttling(BackgroundThrottlingPolicy::Throttle)
        .user_agent(&user_agent())
        .initialization_script(bridge())
        // The page's own: images dropped into the quick note.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            sign_in::on_navigation(&guard, LABEL, url);
            may_go(&guard, url)
        })
        // A link opened in a new window (target=_blank, window.open) goes
        // to the browser, rather than nowhere.
        .on_new_window(move |url, _| {
            open_outside(&opener, &url);
            NewWindowResponse::Deny
        });
    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args(&browser_args());
    let window = builder.build()?;
    app.manage(Loaded(Mutex::new(Instant::now())));
    app.manage(CameFromApp(AtomicBool::new(false)));
    #[cfg(target_os = "windows")]
    out_of_alt_tab(&window);

    let handle = app.clone();
    window.on_window_event(move |event| match event {
        // Put away when another app is clicked, unless pinned. On Windows,
        // not as its edge is dragged to resize it (see after_focus_lost).
        WindowEvent::Focused(false) if !handle.state::<Store>().get().pinned => {
            #[cfg(target_os = "windows")]
            after_focus_lost(&handle);
            #[cfg(target_os = "macos")]
            if !in_modal() {
                hide(&handle);
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            hide(&handle);
        }
        // ⌘W, say: put away, never closed, so it stays loaded.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(&handle);
        }
        _ => {}
    });
    Ok(())
}

/// Whether a panel the window opened is up, the app waiting on it: the
/// files to choose an image from (the page's 「画像を追加」, which WebKit
/// shows as a panel of its own, NSOpenPanel's runModal). It takes the
/// keyboard from the window; put away then, with the app hidden, the window
/// went with the panel still waiting, out of sight, and came out the next
/// time under it, taking no click until it was answered.
#[cfg(target_os = "macos")]
fn in_modal() -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    NSApplication::sharedApplication(mtm).modalWindow().is_some()
}

/// What to do, the window having lost the keyboard, from what the system
/// says now: whether the window is still the one in front, whether a mouse
/// button is held, and whether the pointer is at the window's edge.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum FocusLost {
    /// Another app has the keyboard: put away.
    Hide,
    /// A drag under way (its edge, to resize it): looked at again when it is let go.
    Wait,
    /// Still the window in front (its own frame took the keyboard, as a drag
    /// of its edge does on Windows): the keyboard back to the page.
    Refocus,
}

/// See [`FocusLost`].
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn focus_lost(in_front: bool, owned: bool, held: bool, at_edge: bool) -> FocusLost {
    // A window of its own in front (the files to choose an image from):
    // looked at again once it is answered, the window then in front again.
    if owned {
        return FocusLost::Wait;
    }
    match (in_front, held, at_edge) {
        (_, true, true) | (true, true, false) => FocusLost::Wait,
        (true, false, _) => FocusLost::Refocus,
        _ => FocusLost::Hide,
    }
}

/// How far out from the window the pointer may be and still be at its edge:
/// the frameless window's resize border lies in its shadow, outside it.
#[cfg(target_os = "windows")]
const EDGE_PX: i32 = 16;

/// On Windows, a drag of the frameless window's edge, to resize it, takes the
/// keyboard from the page into the frame: told as the window losing it,
/// which put the window away at once and the drag with it. Looked at a
/// moment after, then, and again until the drag is let go: put away only if
/// another app has the keyboard (see [`focus_lost`]).
#[cfg(target_os = "windows")]
fn after_focus_lost(app: &AppHandle) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetWindow, GW_OWNER,
    };

    // One look at a time: told again during the drag, the look under way goes on.
    static LOOKING: AtomicBool = AtomicBool::new(false);
    if LOOKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let looking = app.clone();
    let spawned = std::thread::Builder::new()
        .name("focus-lost".into())
        .spawn(move || {
            let app = looking;
            struct Done;
            impl Drop for Done {
                fn drop(&mut self) {
                    LOOKING.store(false, Ordering::SeqCst);
                }
            }
            let _done = Done;
            // A moment for the system to settle which window has the keyboard.
            std::thread::sleep(Duration::from_millis(120));
            loop {
                let Some(window) = window(&app) else { return };
                if !window.is_visible().unwrap_or(false) {
                    return;
                }
                let ours = window.hwnd().ok().map(|hwnd| hwnd.0 as isize);
                // SAFETY: plain reads of the system's state, no pointers kept.
                let front = unsafe { GetForegroundWindow() };
                let in_front = front as isize;
                // The window in front one of this one's own: the files to
                // choose an image from, which took the keyboard. Put away
                // then, the window went behind its own panel.
                let owner = if front.is_null() { 0 } else { (unsafe { GetWindow(front, GW_OWNER) }) as isize };
                let held = unsafe {
                    // The physical buttons, as GetAsyncKeyState reads them: either, for buttons swapped.
                    (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0
                        || (GetAsyncKeyState(VK_RBUTTON as i32) as u16 & 0x8000) != 0
                };
                let mut point = POINT { x: 0, y: 0 };
                let pointer = unsafe { GetCursorPos(&mut point) } != 0;
                let at_edge = pointer
                    && match (window.outer_position(), window.outer_size()) {
                        (Ok(at), Ok(size)) => {
                            point.x >= at.x - EDGE_PX
                                && point.y >= at.y - EDGE_PX
                                && point.x <= at.x + size.width as i32 + EDGE_PX
                                && point.y <= at.y + size.height as i32 + EDGE_PX
                        }
                        _ => false,
                    };
                match focus_lost(ours == Some(in_front), owner != 0 && ours == Some(owner), held, at_edge) {
                    FocusLost::Wait => std::thread::sleep(Duration::from_millis(50)),
                    FocusLost::Refocus => {
                        let _ = app.run_on_main_thread(move || {
                            let _ = window.set_focus();
                        });
                        return;
                    }
                    FocusLost::Hide => {
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || hide(&handle));
                        return;
                    }
                }
            }
        });
    if spawned.is_err() {
        LOOKING.store(false, Ordering::SeqCst);
        hide(app);
    }
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

/// Whether a window of `size` with its top left at `at` (points) has enough
/// of its top on one of `screens` to be seen and moved by it: its header,
/// which it is dragged by.
fn seen_on(at: (f64, f64), size: (f64, f64), screens: &[Area]) -> bool {
    const ENOUGH: f64 = 40.0;
    let (left, top) = at;
    let (right, header) = (left + size.0, top + ENOUGH.min(size.1));
    screens.iter().any(|screen| {
        let wide = right.min(screen.x + screen.width) - left.max(screen.x);
        let tall = header.min(screen.y + screen.height) - top.max(screen.y);
        wide >= ENOUGH && tall >= ENOUGH.min(size.1) / 2.0
    })
}

/// Whether the window, put at `at` (as settings.json keeps it, in points),
/// would be on one of the screens connected now.
fn on_a_screen(app: &AppHandle, window: &WebviewWindow, at: (f64, f64)) -> bool {
    let (Ok(size), Ok(scale)) = (window.outer_size(), window.scale_factor()) else {
        return true;
    };
    let size = size.to_logical::<f64>(scale);
    let screens = screen::all(app);
    // None to be told of: as it was.
    screens.is_empty() || seen_on(at, (size.width, size.height), &screens)
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
    // Any look at Memoca's own window under way is over (activation.rs):
    // this one takes the keyboard.
    activation::begin();
    if !window.is_visible().unwrap_or(false) {
        app.state::<CameFromApp>()
            .0
            .store(app_window::is_in_use(app), Ordering::Relaxed);
        let settings = app.state::<Store>().get();
        match settings.position {
            // Pinned, it comes out where it was left, if that is on a screen
            // still (one taken away since, it would come out where nobody
            // sees it, and take what is typed).
            Some((x, y)) if settings.pinned && on_a_screen(app, &window, (x, y)) => {
                let _ = window.set_position(LogicalPosition::new(x, y));
            }
            _ => place(app, &window, &where_),
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

/// Brings the window out on the Todo: a reminder of its clicked
/// (reminders.rs). The page is told to show it; one about to be loaded
/// again on the way out is loaded on it.
pub fn show_todo(app: &AppHandle) {
    let Some(window) = window(app) else { return };
    let _ = window.eval("window.dispatchEvent(new Event('memoca-shell-open-todo'))");
    show(app, Place::Cursor);
}

/// Puts the window away, as it is, and hands the keyboard back to the app
/// in use before: what was being written is kept as a draft by the page.
/// The page is told, so it can load a new version of the site while out of
/// sight.
pub fn hide(app: &AppHandle) {
    if put_away(app) {
        // Any look at Memoca's own window under way is over (activation.rs).
        activation::begin();
        // On a Mac, the app in use before is the one the keyboard goes back
        // to only once Memoca is hidden: unless Memoca's own window was the
        // one in use before, or is now (clicked, say). Out but not in use,
        // it is put away too, rather than hidden with the app and left in
        // the Dock and ⌘Tab with no window to show.
        #[cfg(target_os = "macos")]
        if !app.state::<CameFromApp>().0.load(Ordering::Relaxed) && !app_window::is_in_use(app) {
            if app_window::is_shown(app) {
                app_window::hide(app);
            } else {
                let _ = app.hide();
            }
        }
    }
}

/// Hides the window, if shown, and no more: for Memoca's own window to come
/// out in its place (commands::show_app). Whether it was shown.
pub fn put_away(app: &AppHandle) -> bool {
    let Some(window) = window(app) else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    remember(app, &window);
    let _ = window.hide();
    // Loaded long ago: loaded again now, out of sight (see Loaded). The page
    // keeps what is written as a draft, stored as it is typed.
    let loaded = app.state::<Loaded>();
    let mut at = loaded.0.lock().unwrap();
    if at.elapsed() >= STALE {
        *at = Instant::now();
        let _ = window.navigate(quick_url());
    } else {
        let _ = window.eval("window.dispatchEvent(new Event('memoca-shell-hidden'))");
    }
    true
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

/// Whether the window is out pinned, and not the one in use: left out
/// aside while something else is done (a new version of the app is put in
/// then, rather than waited for as long as it stays out, which was never).
pub fn is_pinned_aside(app: &AppHandle) -> bool {
    app.state::<Store>().get().pinned
        && window(app).is_some_and(|window| !window.is_focused().unwrap_or(true))
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
mod focus_tests {
    use super::{focus_lost, FocusLost};

    #[test]
    fn another_app_clicked_puts_the_window_away() {
        assert_eq!(focus_lost(false, false, false, false), FocusLost::Hide);
        // Clicked elsewhere, the button not let go yet, away from the window.
        assert_eq!(focus_lost(false, false, true, false), FocusLost::Hide);
        // Let go at the edge, another app in front: away too.
        assert_eq!(focus_lost(false, false, false, true), FocusLost::Hide);
    }

    #[test]
    fn a_panel_of_its_own_in_front_keeps_it_out_until_answered() {
        // The files to choose an image from: not another app's window.
        assert_eq!(focus_lost(false, true, false, false), FocusLost::Wait);
        assert_eq!(focus_lost(false, true, true, false), FocusLost::Wait);
    }

    #[test]
    fn its_edge_dragged_to_resize_it_keeps_it_out() {
        // The frame has the keyboard, the window still in front: until let go, then the page has it back.
        assert_eq!(focus_lost(true, false, true, true), FocusLost::Wait);
        assert_eq!(focus_lost(true, false, true, false), FocusLost::Wait);
        assert_eq!(focus_lost(true, false, false, true), FocusLost::Refocus);
        // Not in front, but the button held at its edge (the drag under way): looked at again when let go.
        assert_eq!(focus_lost(false, false, true, true), FocusLost::Wait);
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
    fn a_pinned_place_is_kept_only_while_a_screen_shows_it() {
        let laptop = Area { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
        let beside = Area { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 };
        // Left on the screen beside, and that screen still there.
        assert!(seen_on((2000.0, 300.0), WINDOW, &[laptop, beside]));
        // That screen taken away: nowhere to be seen.
        assert!(!seen_on((2000.0, 300.0), WINDOW, &[laptop]));
        // Half over the edge, its header in sight: kept where it is.
        assert!(seen_on((1300.0, 100.0), WINDOW, &[laptop]));
        // Its header above the screen's top: out of reach.
        assert!(!seen_on((100.0, -300.0), WINDOW, &[laptop]));
    }

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
