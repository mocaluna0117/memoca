//! The hotkeys, as settings.json says (read at start): the quick note's,
//! ⌘⇧M unless it says otherwise, which brings its window out or puts it
//! away; and Memoca's own window's, which does the same with that one. Its
//! ⌘⇧M is the quick note's until the quick note's is changed: then it is
//! Memoca's.

use crate::settings::{Store, DEFAULT_APP_SHORTCUT, DEFAULT_SHORTCUT};
use crate::{app_window, window};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub fn register(app: &AppHandle) {
    let settings = app.state::<Store>().get();
    let quick = parse(&settings.shortcut, DEFAULT_SHORTCUT);
    let memoca = parse(&settings.app_shortcut, DEFAULT_APP_SHORTCUT);
    on(app, quick, &settings.shortcut, |app| {
        window::toggle(app, window::Place::Cursor)
    });
    // The same keys as the quick note's: theirs.
    if memoca.id() != quick.id() {
        on(app, memoca, &settings.app_shortcut, toggle_app);
    }
}

/// The hotkey written, or the default if it is not one.
fn parse(wanted: &str, default: &str) -> Shortcut {
    wanted.parse().unwrap_or_else(|error| {
        eprintln!("Memoca: the hotkey {wanted:?} is not one ({error}); using {default}");
        default.parse().unwrap()
    })
}

fn on(app: &AppHandle, shortcut: Shortcut, wanted: &str, pressed: fn(&AppHandle)) {
    let registered = app
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                pressed(app);
            }
        });
    // Taken by another app: the menu bar icon still brings the window out.
    if let Err(error) = registered {
        eprintln!("Memoca: could not register the hotkey {wanted:?}: {error}");
    }
}

/// Memoca's own window out and in front, or, if it is the one in use, put away.
fn toggle_app(app: &AppHandle) {
    if app_window::is_in_use(app) {
        app_window::hide(app);
    } else {
        app_window::open(app);
    }
}
