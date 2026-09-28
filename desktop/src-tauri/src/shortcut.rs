//! The hotkey that brings the window out, or puts it away: ⌘⇧M unless
//! settings.json says otherwise (read at start).

use crate::settings::{Store, DEFAULT_SHORTCUT};
use crate::window;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub fn register(app: &AppHandle) {
    let wanted = app.state::<Store>().get().shortcut;
    let shortcut = wanted.parse::<Shortcut>().unwrap_or_else(|error| {
        eprintln!("Memoca: the hotkey {wanted:?} is not one ({error}); using {DEFAULT_SHORTCUT}");
        DEFAULT_SHORTCUT.parse().unwrap()
    });
    let registered = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                window::toggle(app, window::Place::Cursor);
            }
        });
    // Taken by another app: the menu bar icon still brings the window out.
    if let Err(error) = registered {
        eprintln!("Memoca: could not register the hotkey {wanted:?}: {error}");
    }
}
