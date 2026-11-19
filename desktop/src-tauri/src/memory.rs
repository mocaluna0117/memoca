//! The computer's memory running short: Memoca's own window let go of while
//! it is put away, and made again once there is room.
//!
//! The window is kept made and hidden, to come out at once (app_window.rs).
//! Its page holds a few hundred megabytes. On a computer short of memory (a
//! Mac of 8 GB, a video call on), what the system has to put aside to make
//! room is read back as it is used: typing into the quick note stopped for
//! a moment now and then while Memoca's other window, unseen, kept its
//! share. Let go of, it is made again when it is opened, a second or two
//! later than at once.
//!
//! macOS says how short it is (kern.memorystatus_vm_pressure_level): short
//! (its warning) is common on such a Mac, even with little open, so the
//! window is let go of then only once it has been put away for a while;
//! very short, sooner. Elsewhere it is kept as before.
//!
//! The quick note's window, which is never let go of, is loaded again out
//! of sight instead, sooner than its usual 12 hours while memory is short:
//! a page kept for hours holds two or three times what a fresh one does.

use crate::settings::Store;
use crate::{app_window, window};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// How short of memory the computer is, as the system says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pressure {
    Normal,
    Warning,
    Critical,
}

/// How often the system is asked.
const EVERY: Duration = Duration::from_secs(30);
/// How long the window is to have been put away before it is let go of,
/// memory short: long enough not to take it from someone going back and
/// forth between it and other apps.
const PUT_AWAY_FOR: Duration = Duration::from_secs(10 * 60);
/// The same, memory very short.
const PUT_AWAY_FOR_CRITICAL: Duration = Duration::from_secs(60);
/// How long memory is to have been enough again before the window, let go
/// of, is made again, hidden.
const ENOUGH_FOR: Duration = Duration::from_secs(5 * 60);
/// The quick note's window, put away this long, memory short, is loaded
/// again if its page is older than QUICK_LOADED_FOR: what a page kept for
/// hours comes to hold let go of (92 MB fresh; 240 to 320 MB after days).
/// Its usual time is 12 hours (window.rs).
const QUICK_PUT_AWAY_FOR: Duration = Duration::from_secs(10 * 60);
const QUICK_LOADED_FOR: Duration = Duration::from_secs(2 * 60 * 60);

/// What the system says now: None where it cannot be asked.
#[cfg(target_os = "macos")]
pub fn pressure() -> Option<Pressure> {
    use std::ffi::{c_char, c_int, c_void};
    extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
    }
    let mut level: c_int = 0;
    let mut size = std::mem::size_of::<c_int>();
    let name = c"kern.memorystatus_vm_pressure_level";
    // SAFETY: a valid C string, and room for the int the call writes.
    let read = unsafe {
        sysctlbyname(
            name.as_ptr(),
            (&mut level as *mut c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (read == 0).then(|| level_of(level))
}

#[cfg(not(target_os = "macos"))]
pub fn pressure() -> Option<Pressure> {
    None
}

/// The system's level as a pressure: 1 normal, 2 warning, 4 critical.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn level_of(level: i32) -> Pressure {
    match level {
        level if level >= 4 => Pressure::Critical,
        2 | 3 => Pressure::Warning,
        _ => Pressure::Normal,
    }
}

/// Whether the window, put away `put_away_for` (None: out, or not made), is
/// to be let go of now: never if the settings say not to (`allowed`).
fn lets_go(allowed: bool, pressure: Pressure, put_away_for: Option<Duration>) -> bool {
    if !allowed {
        return false;
    }
    let wanted = match pressure {
        Pressure::Normal => return false,
        Pressure::Warning => PUT_AWAY_FOR,
        Pressure::Critical => PUT_AWAY_FOR_CRITICAL,
    };
    put_away_for.is_some_and(|away| away >= wanted)
}

/// Whether the window, let go of here, is to be made again: memory enough
/// for a while, or letting it go turned off since.
fn makes_again(allowed: bool, let_go: bool, enough_for: Option<Duration>) -> bool {
    let_go && (!allowed || enough_for.is_some_and(|enough| enough >= ENOUGH_FOR))
}

/// Whether the quick note's window, put away `put_away_for` (None: out),
/// its page loaded `loaded_for` ago, is to be loaded again now.
fn refreshes_quick(pressure: Pressure, put_away_for: Option<Duration>, loaded_for: Duration) -> bool {
    pressure != Pressure::Normal
        && put_away_for.is_some_and(|away| away >= QUICK_PUT_AWAY_FOR)
        && loaded_for >= QUICK_LOADED_FOR
}

/// Asks the system every half minute, for as long as the app runs.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut enough_since: Option<Instant> = None;
        loop {
            std::thread::sleep(EVERY);
            let Some(now) = pressure() else {
                // Not to be asked here (not a Mac): nothing more to do.
                return;
            };
            if now == Pressure::Normal {
                enough_since.get_or_insert_with(Instant::now);
            } else {
                enough_since = None;
            }
            // The settings page's 「メモリが足りないとき、手放す」.
            let allowed = app.state::<Store>().get().let_go_when_short;
            if lets_go(allowed, now, app_window::put_away_for()) {
                app_window::let_go(&app);
            } else if makes_again(
                allowed,
                app_window::was_let_go(),
                enough_since.map(|at| at.elapsed()),
            ) {
                app_window::make_again(&app);
            }
            if refreshes_quick(now, window::put_away_for(), window::loaded_for(&app)) {
                window::refresh_put_away(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn the_systems_levels_are_read_as_it_means_them() {
        assert_eq!(level_of(1), Pressure::Normal);
        assert_eq!(level_of(2), Pressure::Warning);
        assert_eq!(level_of(4), Pressure::Critical);
        assert_eq!(level_of(0), Pressure::Normal);
    }

    #[test]
    fn memory_short_the_window_goes_once_put_away_a_while() {
        assert!(!lets_go(true, Pressure::Warning, Some(9 * MINUTE)));
        assert!(lets_go(true, Pressure::Warning, Some(10 * MINUTE)));
        // Very short: sooner.
        assert!(!lets_go(true, Pressure::Critical, Some(MINUTE / 2)));
        assert!(lets_go(true, Pressure::Critical, Some(MINUTE)));
    }

    #[test]
    fn turned_off_in_the_settings_the_window_is_kept_and_made_again() {
        assert!(!lets_go(false, Pressure::Critical, Some(60 * MINUTE)));
        // Let go of before it was turned off: made again, memory short or not.
        assert!(makes_again(false, true, None));
        assert!(!makes_again(false, false, None));
    }

    #[test]
    fn out_or_memory_enough_the_window_stays() {
        assert!(!lets_go(true, Pressure::Critical, None));
        assert!(!lets_go(true, Pressure::Normal, Some(60 * MINUTE)));
    }

    #[test]
    fn the_quick_note_loaded_again_put_away_a_while_memory_short_its_page_old() {
        let hour = 60 * MINUTE;
        assert!(refreshes_quick(Pressure::Warning, Some(10 * MINUTE), 2 * hour));
        // Its page fresh enough, put away a moment, out, or memory enough: not.
        assert!(!refreshes_quick(Pressure::Warning, Some(10 * MINUTE), hour));
        assert!(!refreshes_quick(Pressure::Warning, Some(5 * MINUTE), 3 * hour));
        assert!(!refreshes_quick(Pressure::Critical, None, 3 * hour));
        assert!(!refreshes_quick(Pressure::Normal, Some(60 * MINUTE), 10 * hour));
    }

    #[test]
    fn made_again_only_if_let_go_here_and_memory_enough_a_while() {
        assert!(makes_again(true, true, Some(5 * MINUTE)));
        assert!(!makes_again(true, true, Some(4 * MINUTE)));
        assert!(!makes_again(true, true, None));
        // Gone on signing out, or never let go of: not made by this.
        assert!(!makes_again(true, false, Some(60 * MINUTE)));
    }
}
