//! Memoca's desktop app (docs/DESKTOP.md): a light shell around the site's
//! quick note, for a Mac and Windows. It stays in the menu bar (the tray,
//! on Windows) with one window, hidden and loaded ahead, which the hotkey,
//! the icon or a hot corner brings out; and Memoca itself in a window of
//! its own, opened from the icon's menu (app_window.rs).
//! The page is the site itself (https://memoca-app.vercel.app/quick);
//! nothing of the app's is bundled here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_window;
mod commands;
mod corner;
mod screen;
mod settings;
mod shortcut;
mod sign_in;
mod tray;
mod updater;
mod window;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;

/// The keys the windows type with: ⌘C, ⌘V, ⌘Z and the rest are the menu's
/// on a Mac, as are ⌘W (the quick note's put away, Memoca's closed) and ⌘M.
/// No 終了 here: Memoca quits from the menu bar icon's menu, not by a slip
/// in a window. Not on Windows, where an app's menu is a bar across its
/// window, and the keys work without one.
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Memoca",
                true,
                &[&PredefinedMenuItem::hide(app, Some("Memoca を隠す"))?],
            )?,
            &Submenu::with_items(
                app,
                "編集",
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some("取り消す"))?,
                    &PredefinedMenuItem::redo(app, Some("やり直す"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some("カット"))?,
                    &PredefinedMenuItem::copy(app, Some("コピー"))?,
                    &PredefinedMenuItem::paste(app, Some("ペースト"))?,
                    &PredefinedMenuItem::select_all(app, Some("すべてを選択"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "ウインドウ",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, Some("しまう"))?,
                    &PredefinedMenuItem::close_window(app, Some("閉じる"))?,
                ],
            )?,
        ],
    )
}

fn main() {
    let builder = tauri::Builder::default()
        // First: a second launch shows this one's window instead (Memoca's
        // own, launched with --app), and hands over the link it was opened with.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            for arg in args.iter().skip(1) {
                if let Ok(url) = url::Url::parse(arg) {
                    sign_in::on_link(app, &url);
                }
            }
            if args.iter().any(|arg| arg == "--app") {
                app_window::open(app);
            } else {
                window::show(app, window::Place::Cursor);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Started at login (the menu's ログイン時に起動), hidden.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Memoca's own window as big and where it was left; the quick
        // note's is put where it is called for (window.rs).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[window::LABEL])
                .with_state_flags(app_window::KEPT)
                .build(),
        )
        .manage(sign_in::Pending::default())
        .manage(sign_in::Ready::default())
        .manage(sign_in::Taking::default())
        .manage(app_window::Downloads::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    #[cfg(not(target_os = "macos"))]
    let _ = app_menu;
    let app = builder
        .invoke_handler(tauri::generate_handler![
            commands::hide,
            commands::open_external,
            sign_in::begin_sign_in,
            sign_in::complete_sign_in,
            sign_in::take_sign_in,
            commands::open_app,
            commands::show_quick,
        ])
        .setup(|app| {
            // A menu bar app: no Dock icon, and not in ⌘Tab.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // A build for development pointed at a local site (window::origin)
            // lets that site's pages ask what the release lets Memoca's ask.
            #[cfg(debug_assertions)]
            if !window::origin()
                .as_str()
                .starts_with("https://memoca-app.vercel.app")
            {
                app.add_capability(
                    tauri::ipc::CapabilityBuilder::new("quick-local")
                        .window(window::LABEL)
                        .window(app_window::LABEL)
                        .remote(format!("{}*", window::origin()))
                        .permission("core:window:allow-start-dragging")
                        .permission("allow-hide")
                        .permission("allow-open-external")
                        .permission("allow-begin-sign-in")
                        .permission("allow-complete-sign-in")
                        .permission("allow-take-sign-in")
                        .permission("allow-open-app")
                        .permission("allow-show-quick"),
                )?;
            }

            let first_run = settings::init(app.handle())?;
            window::create(app.handle())?;
            tray::create(app.handle())?;
            shortcut::register(app.handle());
            corner::watch(app.handle().clone());

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    sign_in::on_link(&handle, &url);
                }
            });
            // Started by a link (Windows starts the app with it when it is
            // not running): taken as one that arrives while it is.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    sign_in::on_link(app.handle(), &url);
                }
            }

            if first_run {
                // A quick note to hand from the moment the computer is on;
                // the menu's ログイン時に起動 takes it off.
                if let Err(error) = app.autolaunch().enable() {
                    eprintln!("Memoca: could not start at login: {error}");
                }
            }
            updater::watch(app.handle().clone());

            // Started by hand for the first time: shown, to sign in. Later
            // it waits, hidden, for the hotkey.
            if first_run && !std::env::args().any(|arg| arg == "--hidden") {
                window::show(app.handle(), window::Place::Cursor);
            }
            if std::env::args().any(|arg| arg == "--app") {
                app_window::open(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Memoca");

    app.run(|app, event| {
        // Opened again from Finder or Launchpad while running, or its icon
        // in the Dock clicked: Memoca's own window, if open.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            if app_window::is_open(app) {
                app_window::open(app);
            } else {
                window::show(app, window::Place::Cursor);
            }
        }
        // The quick note's window is hidden, never closed, and Memoca's own
        // closing leaves the app: it goes on until 終了 in the menu bar
        // icon's menu.
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}
