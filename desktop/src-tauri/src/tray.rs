//! The menu bar icon: a click brings the window out under it, or puts it
//! away; its menu (a right click) has the rest.

use crate::settings::{Corner, Store};
use crate::updater::{self, VersionItem};
use crate::window;
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
    let pin = CheckMenuItem::with_id(
        app,
        "pin",
        "ピン留め（ほかをクリックしても隠さない）",
        true,
        settings.pinned,
        None::<&str>,
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
    let hotkey = MenuItem::with_id(
        app,
        "settings",
        "ホットキーを変える（設定ファイルを開く）…",
        true,
        None::<&str>,
    )?;
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
    app.manage(VersionItem(version));

    TrayIconBuilder::with_id("memoca")
        .icon(icon()?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Memoca")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| chosen(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                window::toggle(tray.app_handle(), window::Place::Tray(rect));
            }
        })
        .build(app)?;
    Ok(())
}

fn chosen(app: &AppHandle, id: &str) {
    match id {
        "show" => window::show(app, window::Place::Cursor),
        "pin" => app
            .state::<Store>()
            .update(|settings| settings.pinned = !settings.pinned),
        "settings" => {
            let path = app.state::<Store>().path().clone();
            let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
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
