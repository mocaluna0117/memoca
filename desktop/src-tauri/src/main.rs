//! Memoca's desktop app (docs/DESKTOP.md): a light shell around the site's
//! quick note. It stays in the menu bar with one window, hidden and loaded
//! ahead, which the hotkey, the menu bar icon or a hot corner brings out.
//! The page is the site itself (https://memoca-app.vercel.app/quick);
//! nothing of the app's is bundled here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod corner;
mod screen;
mod settings;
mod shortcut;
mod sign_in;
mod tray;
mod window;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

fn main() {
    let app = tauri::Builder::default()
        // First: a second launch shows this one's window instead, and hands
        // over the link it was opened with.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            for arg in args.iter().skip(1) {
                if let Ok(url) = url::Url::parse(arg) {
                    sign_in::on_link(app, &url);
                }
            }
            window::show(app, window::Place::Cursor);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(sign_in::Pending::default())
        .manage(sign_in::Ready::default())
        // The keys the window types with: ⌘C, ⌘V, ⌘Z and the rest are the
        // menu's on a Mac. No 終了 here: ⌘Q quits from the menu bar icon's
        // menu, not by a slip in the window.
        .menu(|app| {
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
                ],
            )
        })
        .invoke_handler(tauri::generate_handler![
            commands::hide,
            commands::open_external,
            sign_in::begin_sign_in,
            sign_in::complete_sign_in,
            sign_in::take_sign_in,
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
                        .remote(format!("{}*", window::origin()))
                        .permission("core:window:allow-start-dragging")
                        .permission("allow-hide")
                        .permission("allow-open-external")
                        .permission("allow-begin-sign-in")
                        .permission("allow-complete-sign-in")
                        .permission("allow-take-sign-in"),
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

            // Started by hand for the first time: shown, to sign in. Later
            // it waits, hidden, for the hotkey.
            if first_run && !std::env::args().any(|arg| arg == "--hidden") {
                window::show(app.handle(), window::Place::Cursor);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Memoca");

    app.run(|app, event| {
        // Opened again from Finder or Launchpad while running.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            window::show(app, window::Place::Cursor);
        }
        // Its one window is hidden, never closed: the app goes on until
        // 終了 in the menu bar icon's menu.
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}
