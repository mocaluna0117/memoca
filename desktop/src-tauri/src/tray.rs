//! The menu bar icon: a click brings the window out under it, or puts it
//! away; its menu (a right click) has the rest.

use crate::settings::{Corner, Settings, Store};
use crate::updater::{self, VersionItem};
use crate::{app_window, window};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

/// The corners offered, as the menu names them.
const CORNERS: [(Option<Corner>, &str, &str); 5] = [
    (None, "corner:none", "なし"),
    (Some(Corner::TopLeft), "corner:top-left", "左上"),
    (Some(Corner::TopRight), "corner:top-right", "右上"),
    (Some(Corner::BottomLeft), "corner:bottom-left", "左下"),
    (Some(Corner::BottomRight), "corner:bottom-right", "右下"),
];

/// The corner items, to tick the one chosen.
struct CornerItems(Vec<(Option<Corner>, CheckMenuItem<Wry>)>);

/// The item that starts the app at login, ticked as the system has it.
struct AtLogin(CheckMenuItem<Wry>);

/// The items that keep a window out (ピン留め), ticked as the settings have them.
struct PinItems {
    quick: CheckMenuItem<Wry>,
    app: CheckMenuItem<Wry>,
}

/// Which window is pinned: the quick note's, or Memoca's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pin {
    Quick,
    App,
}

impl Pin {
    /// As the page names it ("quick", or "app"); the quick note's if it says
    /// none, as the site of 0.4.16 does.
    pub fn named(which: Option<&str>) -> Result<Pin, String> {
        match which {
            None | Some("quick") => Ok(Pin::Quick),
            Some("app") => Ok(Pin::App),
            Some(other) => Err(format!("no window {other:?}")),
        }
    }

    pub fn of(self, settings: &Settings) -> bool {
        match self {
            Pin::Quick => settings.pinned,
            Pin::App => settings.app_pinned,
        }
    }
}

/// Pins a window, or not: from the menu, or from Memoca's settings page
/// (commands::pinned_set). Its item ticked as it now is.
pub fn set_pinned(app: &AppHandle, which: Pin, on: bool) {
    app.state::<Store>().update(|settings| match which {
        Pin::Quick => settings.pinned = on,
        Pin::App => settings.app_pinned = on,
    });
    if let Some(items) = app.try_state::<PinItems>() {
        let item = match which {
            Pin::Quick => &items.quick,
            Pin::App => &items.app,
        };
        let _ = item.set_checked(on);
    }
}

/// The icon's clicks so far: when it was last right-clicked, and whether
/// the left click under way is one with Control held.
#[derive(Default)]
struct Clicks(Mutex<ClicksSeen>);

#[derive(Default)]
struct ClicksSeen {
    right: Option<Instant>,
    left_for_menu: bool,
}

/// How long after a right click a left one is taken as part of it.
const RIGHT_CLICK: Duration = Duration::from_millis(1000);

/// Whether Control is held: on a Mac, a click with it is a right click.
#[cfg(target_os = "macos")]
fn control_held() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }
    // kCGEventSourceStateCombinedSessionState, kCGEventFlagMaskControl.
    const COMBINED_SESSION: i32 = 0;
    const CONTROL: u64 = 1 << 18;
    // SAFETY: reads the keyboard's state; takes and keeps nothing.
    unsafe { CGEventSourceFlagsState(COMBINED_SESSION) & CONTROL != 0 }
}

#[cfg(not(target_os = "macos"))]
fn control_held() -> bool {
    false
}

/// The tray icon: on a Mac, a glyph the menu bar colours as it is coloured;
/// on Windows, the app's own icon, which a dark taskbar shows as well as a
/// light one (a black glyph would be lost on it).
fn icon() -> tauri::Result<Image<'static>> {
    if cfg!(target_os = "windows") {
        Image::from_bytes(include_bytes!("../icons/32x32.png"))
    } else {
        Image::from_bytes(include_bytes!("../icons/tray.png"))
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let settings = app.state::<Store>().get();
    let show = MenuItem::with_id(app, "show", "即席メモを開く", true, None::<&str>)?;
    let memoca = MenuItem::with_id(app, "app", "Memoca を開く", true, None::<&str>)?;
    let pin_quick =
        CheckMenuItem::with_id(app, "pin", "即席メモ", true, settings.pinned, None::<&str>)?;
    let pin_app = CheckMenuItem::with_id(
        app,
        "pin-app",
        "Memoca のウィンドウ",
        true,
        settings.app_pinned,
        None::<&str>,
    )?;
    let pin = Submenu::with_items(
        app,
        "ピン留め（ほかをクリックしても隠さない）",
        true,
        &[&pin_quick, &pin_app],
    )?;
    let corners = CORNERS
        .iter()
        .map(|(corner, id, label)| {
            CheckMenuItem::with_id(
                app,
                *id,
                *label,
                true,
                settings.hot_corner == *corner,
                None::<&str>,
            )
            .map(|item| (*corner, item))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let corner_menu = Submenu::with_items(
        app,
        "ホットコーナー",
        true,
        &corners
            .iter()
            .map(|(_, item)| item as &dyn IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;
    let hotkey = MenuItem::with_id(app, "settings", "ホットキーを変える…", true, None::<&str>)?;
    let browser = MenuItem::with_id(
        app,
        "browser",
        "ブラウザで Memoca を開く",
        true,
        None::<&str>,
    )?;
    let reload = MenuItem::with_id(app, "reload", "再読み込み", true, None::<&str>)?;
    let at_login = CheckMenuItem::with_id(
        app,
        "at-login",
        "ログイン時に起動",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "update", "アップデートを確認", true, None::<&str>)?;
    let sign_out = MenuItem::with_id(app, "sign-out", "ログアウト", true, None::<&str>)?;
    let version = MenuItem::with_id(
        app,
        "version",
        format!("バージョン {}", app.package_info().version),
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &memoca,
            &PredefinedMenuItem::separator(app)?,
            &pin,
            &corner_menu,
            &hotkey,
            &PredefinedMenuItem::separator(app)?,
            &browser,
            &reload,
            &sign_out,
            &PredefinedMenuItem::separator(app)?,
            &at_login,
            &update,
            &version,
            &quit,
        ],
    )?;
    app.manage(CornerItems(corners));
    app.manage(AtLogin(at_login));
    app.manage(PinItems {
        quick: pin_quick,
        app: pin_app,
    });
    app.manage(Clicks::default());
    app.manage(VersionItem(version));

    TrayIconBuilder::with_id("memoca")
        .icon(icon()?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Memoca")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| chosen(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| match event {
            // Control held over the icon on a Mac: a click is a right
            // click, for the menu (tray-icon does not take it for one).
            #[cfg(target_os = "macos")]
            TrayIconEvent::Enter { .. } | TrayIconEvent::Move { .. } => {
                let _ = tray.set_show_menu_on_left_click(control_held());
            }
            TrayIconEvent::Click {
                button,
                button_state,
                rect,
                ..
            } => {
                let clicks = tray.app_handle().state::<Clicks>();
                let mut clicks = clicks.0.lock().unwrap();
                match (button, button_state) {
                    (MouseButton::Right, MouseButtonState::Down) => {
                        clicks.right = Some(Instant::now())
                    }
                    (MouseButton::Left, MouseButtonState::Down) => {
                        clicks.left_for_menu = control_held()
                    }
                    (MouseButton::Left, MouseButtonState::Up) => {
                        // Some right clicks (on a trackpad, say) come with a
                        // left one too, or as one with Control held: the
                        // menu's, not the window's.
                        let for_menu = clicks.left_for_menu
                            || clicks.right.is_some_and(|at| at.elapsed() < RIGHT_CLICK);
                        drop(clicks);
                        if !for_menu {
                            window::toggle(tray.app_handle(), window::Place::Tray(rect));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn chosen(app: &AppHandle, id: &str) {
    match id {
        "show" => window::show(app, window::Place::Cursor),
        "app" => app_window::open(app),
        "pin" => set_pinned(app, Pin::Quick, !app.state::<Store>().get().pinned),
        "pin-app" => set_pinned(app, Pin::App, !app.state::<Store>().get().app_pinned),
        // Memoca's settings page, where they are changed at once (the file
        // may still be written by hand: docs/DESKTOP.md).
        "settings" => {
            app_window::open_at(app, window::origin().join("/app/settings#hotkeys").unwrap());
        }
        "browser" => {
            let _ = app.opener().open_url(
                window::origin().join("/app").unwrap().as_str(),
                None::<&str>,
            );
        }
        "reload" => window::reload(app),
        "at-login" => {
            let launch = app.autolaunch();
            let on = launch.is_enabled().unwrap_or(false);
            let done = if on {
                launch.disable()
            } else {
                launch.enable()
            };
            if let Err(error) = done {
                eprintln!("Memoca: could not change starting at login: {error}");
            }
            // As the system has it now, whatever the change came to.
            let _ = app
                .state::<AtLogin>()
                .0
                .set_checked(launch.is_enabled().unwrap_or(on));
        }
        "update" => updater::look_now(app),
        "sign-out" => {
            // The page asks first, if the device has what it alone has; once
            // sure, it has the app let go of Memoca's own window and the
            // account's reminders (commands::sign_out_app).
            window::go(app, window::origin().join("/desktop/sign-out").unwrap());
            window::show(app, window::Place::Cursor);
        }
        "quit" => app.exit(0),
        _ => {
            if let Some((corner, _, _)) = CORNERS.iter().find(|(_, key, _)| *key == id) {
                app.state::<Store>()
                    .update(|settings| settings.hot_corner = *corner);
                // One ticked: the one chosen.
                for (each, item) in &app.state::<CornerItems>().0 {
                    let _ = item.set_checked(each == corner);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_pinned_as_the_page_names_it() {
        // The site of 0.4.16 names none: the quick note's.
        assert_eq!(Pin::named(None), Ok(Pin::Quick));
        assert_eq!(Pin::named(Some("quick")), Ok(Pin::Quick));
        assert_eq!(Pin::named(Some("app")), Ok(Pin::App));
        assert!(Pin::named(Some("other")).is_err());
        let settings = Settings {
            pinned: true,
            app_pinned: false,
            ..Settings::default()
        };
        assert!(Pin::Quick.of(&settings));
        assert!(!Pin::App.of(&settings));
    }
}
