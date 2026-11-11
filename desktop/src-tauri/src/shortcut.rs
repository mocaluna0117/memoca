//! The hotkeys: the quick note's, ⌘⇧M unless settings.json says otherwise,
//! which brings its window out or puts it away; and Memoca's own window's,
//! which does the same with that one. Its ⌘⇧M is the quick note's until the
//! quick note's is changed: then it is Memoca's. Changed in Memoca's
//! settings page (src/components/settings/desktop-hotkeys.tsx), at once, or
//! in the file by hand, from the next start.

use crate::settings::{Store, DEFAULT_APP_SHORTCUT, DEFAULT_SHORTCUT};
use crate::{app_window, window};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Both registered, as the settings have them: whether each took (one the
/// same as the quick note's is left to it, and counts as taken).
pub fn register(app: &AppHandle) -> (bool, bool) {
    let settings = app.state::<Store>().get();
    let quick = parse(&settings.shortcut, DEFAULT_SHORTCUT);
    let memoca = parse(&settings.app_shortcut, DEFAULT_APP_SHORTCUT);
    let quick_took = on(app, quick, &settings.shortcut, |app| {
        window::toggle(app, window::Place::Cursor)
    });
    // The same keys as the quick note's: theirs.
    let memoca_took =
        memoca.id() == quick.id() || on(app, memoca, &settings.app_shortcut, toggle_app);
    (quick_took, memoca_took)
}

/// Held while the hotkeys are let go of and registered again: one change
/// at a time (the page's keys recorded, and the recording over, come together).
static CHANGING: Mutex<()> = Mutex::new(());

fn let_go(app: &AppHandle) {
    if let Err(error) = app.global_shortcut().unregister_all() {
        eprintln!("Memoca: could not let go of the hotkeys: {error}");
    }
}

/// Registered again, as the settings have them now.
fn again(app: &AppHandle) -> (bool, bool) {
    let _one = CHANGING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let_go(app);
    register(app)
}

/// The hotkey written, or the default if it is not one.
fn parse(wanted: &str, default: &str) -> Shortcut {
    wanted.parse().unwrap_or_else(|error| {
        eprintln!("Memoca: the hotkey {wanted:?} is not one ({error}); using {default}");
        default.parse().unwrap()
    })
}

fn on(app: &AppHandle, shortcut: Shortcut, wanted: &str, pressed: fn(&AppHandle)) -> bool {
    let registered = app
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                pressed(app);
            }
        });
    // Taken by another app: the menu bar icon still brings the window out.
    match registered {
        Ok(()) => true,
        Err(error) => {
            eprintln!("Memoca: could not register the hotkey {wanted:?}: {error}");
            false
        }
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

/// A hotkey as the settings page asks for one, or why it will not do: not
/// one at all ("invalid"), or one that would take keys typed everywhere
/// ("needsModifier": a key alone, or with Shift alone, but for F1 to F24).
fn check(keys: &str) -> Result<Shortcut, &'static str> {
    let shortcut: Shortcut = keys.parse().map_err(|_| "invalid")?;
    let held = Modifiers::ALT | Modifiers::CONTROL | Modifiers::SUPER | Modifiers::META;
    let name = format!("{:?}", shortcut.key);
    let function_key = name
        .strip_prefix('F')
        .and_then(|number| number.parse::<u8>().ok())
        .is_some_and(|number| (1..=24).contains(&number));
    if !shortcut.mods.intersects(held) && !function_key {
        return Err("needsModifier");
    }
    Ok(shortcut)
}

/// The hotkeys as the settings page shows them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    quick: String,
    app: String,
    quick_default: &'static str,
    app_default: &'static str,
}

fn current(app: &AppHandle) -> Hotkeys {
    let settings = app.state::<Store>().get();
    Hotkeys {
        quick: settings.shortcut,
        app: settings.app_shortcut,
        quick_default: DEFAULT_SHORTCUT,
        app_default: DEFAULT_APP_SHORTCUT,
    }
}

#[tauri::command]
pub fn hotkeys_get(app: AppHandle) -> Hotkeys {
    current(&app)
}

/// One of the hotkeys changed (`which`: "quick" or "app"), kept and
/// registered at once; or, if it will not do, left as it was, and why:
/// "invalid", "needsModifier", "same" (the other's keys, which one of them
/// would then never have), or "taken" (another app has them).
#[tauri::command]
pub async fn hotkeys_set(app: AppHandle, which: String, keys: String) -> Result<Hotkeys, String> {
    let quick = match which.as_str() {
        "quick" => true,
        "app" => false,
        _ => return Err("invalid".into()),
    };
    let wanted = check(&keys).map_err(String::from)?;
    let _one = CHANGING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = app.state::<Store>().get();
    let quick_keys = parse(&before.shortcut, DEFAULT_SHORTCUT);
    let app_keys = parse(&before.app_shortcut, DEFAULT_APP_SHORTCUT);
    // Memoca's own already the quick note's (as both start): the quick
    // note's may have them back.
    let same = if quick {
        wanted.id() == app_keys.id() && app_keys.id() != quick_keys.id()
    } else {
        wanted.id() == quick_keys.id()
    };
    if same {
        return Err("same".into());
    }
    let store = app.state::<Store>();
    store.update(|settings| {
        if quick {
            settings.shortcut = keys.clone();
        } else {
            settings.app_shortcut = keys.clone();
        }
    });
    let_go(&app);
    let (quick_took, app_took) = register(&app);
    if !(if quick { quick_took } else { app_took }) {
        store.update(|settings| {
            settings.shortcut = before.shortcut.clone();
            settings.app_shortcut = before.app_shortcut.clone();
        });
        let_go(&app);
        register(&app);
        return Err("taken".into());
    }
    Ok(current(&app))
}

/// Each time the hotkeys are let go of for the page to record keys.
static RECORDING: AtomicU64 = AtomicU64::new(0);

/// How long they are let go of at most: a page gone while recording does
/// not leave the app without them.
const RECORDING_MOST: Duration = Duration::from_secs(60);

/// The page recording new keys: the hotkeys let go of meanwhile, as the
/// system would otherwise take the keys before the page saw them (the
/// quick note's own, pressed to be recorded again, say); and back after.
#[tauri::command]
pub fn hotkeys_recording(app: AppHandle, on: bool) {
    let time = RECORDING.fetch_add(1, Ordering::SeqCst) + 1;
    if !on {
        again(&app);
        return;
    }
    {
        let _one = CHANGING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let_go(&app);
    }
    let _ = std::thread::Builder::new()
        .name("hotkeys-back".into())
        .spawn(move || {
            std::thread::sleep(RECORDING_MOST);
            if RECORDING.load(Ordering::SeqCst) == time {
                RECORDING.fetch_add(1, Ordering::SeqCst);
                again(&app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn a_hotkey_with_a_key_held_will_do() {
        assert!(check("CmdOrCtrl+Shift+M").is_ok());
        assert!(check("CmdOrCtrl+M").is_ok());
        assert!(check("Alt+Space").is_ok());
        assert!(check("Ctrl+Shift+ArrowUp").is_ok());
        assert!(check("Super+Digit1").is_ok());
    }

    #[test]
    fn a_key_alone_or_with_shift_alone_would_take_what_is_typed() {
        assert_eq!(check("M").unwrap_err(), "needsModifier");
        assert_eq!(check("Shift+M").unwrap_err(), "needsModifier");
        assert_eq!(check("Space").unwrap_err(), "needsModifier");
    }

    #[test]
    fn a_function_key_will_do_alone() {
        assert!(check("F13").is_ok());
        assert!(check("Shift+F5").is_ok());
    }

    #[test]
    fn what_is_not_a_hotkey_is_said_to_be_none() {
        assert_eq!(check("").unwrap_err(), "invalid");
        assert_eq!(check("CmdOrCtrl+").unwrap_err(), "invalid");
        assert_eq!(check("CmdOrCtrl+Nothing").unwrap_err(), "invalid");
        assert_eq!(check("CmdOrCtrl+M+K").unwrap_err(), "invalid");
    }
}
