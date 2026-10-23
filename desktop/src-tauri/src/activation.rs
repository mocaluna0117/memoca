//! Memoca's own window brought out in front with the app active, on a Mac,
//! and looked at again after. Since macOS 14, being made active is a
//! request the system may refuse (an app taking the keyboard from the one
//! in use); a window of a hidden app is not seen at all, nor is one on
//! another desktop. So the window is shown in one turn of the main thread
//! and the app asked to be made active; then, on later turns, the app is
//! looked at and asked again a few times, and what was seen is said in the
//! log (`open /Applications/Memoca.app --stderr ~/memoca.log` keeps it).
//! What a look does, given what it sees, is decided apart from AppKit, and
//! tested.
//!
//! A bringing out or putting away of either window begins a generation:
//! the looks of an older one do nothing, so a window put away stays away,
//! and the quick note brought out meanwhile keeps the keyboard.
//!
//! The window comes out on the desktop (Space) in use, wherever it was
//! last: a window put away is still the desktop's it was on, and the
//! system, showing it and making the app active, went there first.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// When the app is looked at after the window is shown, counted from the
/// show. At the first `ASKS` looks it is asked again if it is not active;
/// the last only says what it saw.
pub const LOOKS: [Duration; 5] = [
    Duration::ZERO,
    Duration::from_millis(50),
    Duration::from_millis(150),
    Duration::from_millis(400),
    Duration::from_millis(800),
];
const ASKS: usize = 4;

/// Which bringing out or putting away is the latest.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// A new bringing out or putting away: the looks of any before are over.
pub fn begin() -> u64 {
    GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Whether `generation` is still the latest.
pub fn is_current(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

/// What the system says of the app and the window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Seen {
    /// The app hidden (put away, or ⌘H): none of its windows are seen.
    pub app_hidden: bool,
    /// The app the one in use.
    pub app_active: bool,
    /// The window ordered in: not put away, not in the Dock.
    pub visible: bool,
    /// The window the app's key one, which takes the keyboard.
    pub key: bool,
    /// The window on the desktop (Space) shown.
    pub on_active_space: bool,
    /// The window in the Dock.
    pub minimized: bool,
}

impl Seen {
    /// Whether the window is the one in use: the app active, the window its
    /// key one, and on the desktop shown. One key on another desktop is
    /// brought over, not put away unseen.
    pub fn in_use(self) -> bool {
        self.app_active && self.key && self.on_active_space
    }
}

/// What one look does.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Unhide the app, without making it active: a hidden app's windows are not seen.
    pub unhide: bool,
    /// Order the window in front and make it key (makeKeyAndOrderFront).
    pub order_front: bool,
    /// Ask the system to make the app active.
    pub activate: bool,
    /// Still not active once asked: order the window in front regardless,
    /// so it is at least seen above the app in use.
    pub regardless: bool,
    /// Look again at the next of `LOOKS`.
    pub again: bool,
}

/// What look `number` (an index of `LOOKS`) does, seeing `seen`. `stale`:
/// the window was put away, or brought out again, since. `was_active`: an
/// earlier look saw the app active; inactive again now, the person has
/// moved on, and is not taken back.
pub fn follow_up(seen: Seen, number: usize, stale: bool, was_active: bool) -> Plan {
    if stale || seen.in_use() || (was_active && !seen.app_active) {
        return Plan::default();
    }
    let again = number + 1 < LOOKS.len();
    if number >= ASKS {
        return Plan {
            again,
            ..Plan::default()
        };
    }
    if seen.app_active {
        // Ours already. Still coming out of the Dock, or on another desktop:
        // ordered in front again. Another window of Memoca's chosen (the
        // quick note clicked, say): left to it.
        let order_front = seen.minimized || !seen.on_active_space;
        return Plan {
            order_front,
            again: again && order_front,
            ..Plan::default()
        };
    }
    Plan {
        unhide: seen.app_hidden,
        order_front: true,
        activate: true,
        regardless: true,
        again,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{begin, follow_up, is_current, Seen, LOOKS};
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSWindow, NSWindowCollectionBehavior,
        NSWindowStyleMask,
    };
    use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};
    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;
    use tauri::{ActivationPolicy, Manager, WebviewWindow};

    /// What the window's collection behavior is made as it comes out, from
    /// what it is and whether the window fills the screen: moved to the
    /// desktop in use (MoveToActiveSpace), rather than the system going to
    /// the one it was last on. Said to be full-screen capable, unless it
    /// says otherwise already: a window that says nothing is left to
    /// AppKit's inference, which is not to be counted on once it says this
    /// much (the green button still makes it full screen). One on every
    /// desktop already (CanJoinAllSpaces: the quick note's) needs no moving;
    /// one in full screen is on a desktop of its own, gone to as before.
    fn on_the_desktop_in_use(
        behavior: NSWindowCollectionBehavior,
        full_screen: bool,
    ) -> NSWindowCollectionBehavior {
        if behavior.contains(NSWindowCollectionBehavior::CanJoinAllSpaces) {
            return behavior;
        }
        if full_screen {
            return behavior - NSWindowCollectionBehavior::MoveToActiveSpace;
        }
        let full_screen_said = NSWindowCollectionBehavior::FullScreenPrimary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::FullScreenNone;
        let mut wanted = behavior | NSWindowCollectionBehavior::MoveToActiveSpace;
        if !wanted.intersects(full_screen_said) {
            wanted |= NSWindowCollectionBehavior::FullScreenPrimary;
        }
        wanted
    }

    /// Makes the window come out on the desktop in use: the hotkey pressed
    /// on desktop B shows it on B, though it was last out on A. Done before
    /// it is shown and the app asked to be made active, either of which
    /// would otherwise take the person to A. One still out on another
    /// desktop is taken in first, to come out here as one put away does
    /// (rather than counted on to move when the app is made active, which
    /// may be refused). What the behavior is now, for the log.
    fn to_the_desktop_in_use(w: &NSWindow) -> NSWindowCollectionBehavior {
        let full_screen = w.styleMask().contains(NSWindowStyleMask::FullScreen);
        let behavior = w.collectionBehavior();
        let wanted = on_the_desktop_in_use(behavior, full_screen);
        if wanted != behavior {
            w.setCollectionBehavior(wanted);
        }
        if !full_screen && w.isVisible() && !w.isOnActiveSpace() {
            w.orderOut(None);
        }
        wanted
    }

    /// macOS 14 or later, where `activate` is: on 11 to 13 (the least the
    /// app runs on, tauri.conf.json) the message is unknown, and would
    /// abort the app.
    fn has_activate() -> bool {
        static YES: OnceLock<bool> = OnceLock::new();
        *YES.get_or_init(|| {
            NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
                majorVersion: 14,
                minorVersion: 0,
                patchVersion: 0,
            })
        })
    }

    /// Asks the system to make the app active: the old way, which still
    /// works on 26 and is the one apps report working from a hotkey, and
    /// the way 14 added. Both, as neither is promised to work.
    fn ask_active(ns_app: &NSApplication) {
        // Apple says gone in 27: activate() is sent too, where it is.
        #[allow(deprecated)]
        ns_app.activateIgnoringOtherApps(true);
        if has_activate() {
            ns_app.activate();
        }
    }

    /// The window's NSWindow: on the main thread, and only while the window
    /// is still there (tauri's `ns_window` aborts on one being destroyed).
    fn ns_window(window: &WebviewWindow, _mtm: MainThreadMarker) -> Option<Retained<NSWindow>> {
        window.app_handle().get_webview_window(window.label())?;
        let ptr = window.ns_window().ok()?;
        // SAFETY: the window's own NSWindow, handed over autoreleased, on the
        // main thread: retained here for as long as it is looked at.
        unsafe { Retained::retain(ptr.cast::<NSWindow>()) }
    }

    /// What the system says of the app and the window: on the main thread
    /// only; None elsewhere, where it cannot be read.
    pub fn seen(window: &WebviewWindow) -> Option<Seen> {
        let mtm = MainThreadMarker::new()?;
        let ns_app = NSApplication::sharedApplication(mtm);
        let w = ns_window(window, mtm)?;
        Some(Seen {
            app_hidden: ns_app.isHidden(),
            app_active: ns_app.isActive(),
            visible: w.isVisible(),
            key: w.isKeyWindow(),
            on_active_space: w.isOnActiveSpace(),
            minimized: w.isMiniaturized(),
        })
    }

    /// Brings the window out, from any thread: in one turn of the main
    /// thread, an app in the Dock (Regular), unhidden, the window out of the
    /// Dock, shown and asked to be made active, with the key press or click
    /// that asked for it; then looked at on later turns (`look_later`).
    pub fn bring_out(window: &WebviewWindow) {
        let generation = begin();
        let app = window.app_handle().clone();
        let (handle, shown) = (app.clone(), window.clone());
        // Inline on the main thread (the hotkey, a menu, a command), queued
        // from the thread that makes the window (app_window::make).
        let _ = app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let ns_app = NSApplication::sharedApplication(mtm);
            let in_dock = ns_app.activationPolicy() == NSApplicationActivationPolicy::Regular;
            let _ = handle.set_activation_policy(ActivationPolicy::Regular);
            // Put away, the app was hidden: a hidden app's window is not
            // seen, and tao asks nothing for one.
            if ns_app.isHidden() {
                ns_app.unhideWithoutActivation();
            }
            let behavior = ns_window(&shown, mtm).map(|w| to_the_desktop_in_use(&w));
            let _ = shown.unminimize();
            let _ = shown.show();
            ask_active(&ns_app);
            let desktops = behavior.map_or("unknown".into(), |b| {
                let moves = b.contains(NSWindowCollectionBehavior::MoveToActiveSpace);
                format!("{:#x}, MoveToActiveSpace: {moves}", b.0)
            });
            eprintln!(
                "Memoca: window out (in the Dock before: {in_dock}; collectionBehavior {desktops}): {:?}",
                seen(&shown)
            );
        });
        look_later(window.clone(), generation);
    }

    enum Looked {
        Done,
        Again { active: bool },
    }

    /// Looks at the app on later turns of the main thread, at `LOOKS`:
    /// posted from a thread of its own, so that each is a turn of its own
    /// (from the main thread the task would run inline, in the same turn as
    /// the show).
    fn look_later(window: WebviewWindow, generation: u64) {
        std::thread::spawn(move || {
            let app = window.app_handle().clone();
            let mut was_active = false;
            let mut slept = Duration::ZERO;
            for (number, at) in LOOKS.iter().enumerate() {
                std::thread::sleep(at.saturating_sub(slept));
                slept = *at;
                let (tx, rx) = mpsc::channel();
                let window = window.clone();
                let posted = app.run_on_main_thread(move || {
                    let _ = tx.send(look(&window, number, generation, was_active));
                });
                if posted.is_err() {
                    return;
                }
                match rx.recv() {
                    Ok(Looked::Again { active }) => was_active |= active,
                    _ => return,
                }
            }
        });
    }

    /// One look, on the main thread: what is seen, said in the log, and done.
    fn look(window: &WebviewWindow, number: usize, generation: u64, was_active: bool) -> Looked {
        let Some(mtm) = MainThreadMarker::new() else {
            return Looked::Done;
        };
        // Gone: signed out meanwhile.
        let Some(seen) = seen(window) else {
            return Looked::Done;
        };
        let plan = follow_up(seen, number, !is_current(generation), was_active);
        eprintln!(
            "Memoca: window look {number} at +{} ms: {seen:?} -> {plan:?}",
            LOOKS[number].as_millis()
        );
        let ns_app = NSApplication::sharedApplication(mtm);
        let Some(w) = ns_window(window, mtm) else {
            return Looked::Done;
        };
        if plan.unhide {
            ns_app.unhideWithoutActivation();
        }
        if plan.order_front {
            // Still on another desktop (moved there meanwhile, say): brought here.
            to_the_desktop_in_use(&w);
            w.makeKeyAndOrderFront(None);
        }
        if plan.activate {
            ask_active(&ns_app);
        }
        // Refused, the window is at least put above the app in use (not
        // key: a click on it is what makes the app active).
        if plan.regardless && !ns_app.isActive() {
            w.orderFrontRegardless();
        }
        if plan.again {
            Looked::Again {
                active: seen.app_active,
            }
        } else {
            Looked::Done
        }
    }

    #[cfg(test)]
    mod tests {
        use super::on_the_desktop_in_use;
        use objc2_app_kit::NSWindowCollectionBehavior as B;

        #[test]
        fn moves_to_the_desktop_in_use_and_can_still_fill_the_screen() {
            let wanted = B::MoveToActiveSpace | B::FullScreenPrimary;
            assert_eq!(on_the_desktop_in_use(B::Default, false), wanted);
            // Once is enough.
            assert_eq!(on_the_desktop_in_use(wanted, false), wanted);
        }

        #[test]
        fn what_it_says_already_is_kept() {
            let auxiliary = B::FullScreenAuxiliary | B::Managed;
            assert_eq!(
                on_the_desktop_in_use(auxiliary, false),
                auxiliary | B::MoveToActiveSpace
            );
            let never_full = B::FullScreenNone;
            assert_eq!(
                on_the_desktop_in_use(never_full, false),
                never_full | B::MoveToActiveSpace
            );
        }

        #[test]
        fn one_on_every_desktop_is_left_as_it_is() {
            let quick = B::CanJoinAllSpaces | B::FullScreenAuxiliary;
            assert_eq!(on_the_desktop_in_use(quick, false), quick);
            assert_eq!(
                on_the_desktop_in_use(B::CanJoinAllSpaces, true),
                B::CanJoinAllSpaces
            );
        }

        #[test]
        fn one_in_full_screen_is_gone_to_as_before() {
            let moved = B::MoveToActiveSpace | B::FullScreenPrimary;
            assert_eq!(on_the_desktop_in_use(moved, true), B::FullScreenPrimary);
            assert_eq!(on_the_desktop_in_use(B::Default, true), B::Default);
            // Out of full screen again: moved once more.
            assert_eq!(on_the_desktop_in_use(B::FullScreenPrimary, false), moved);
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn in_use() -> Seen {
        Seen {
            app_active: true,
            visible: true,
            key: true,
            on_active_space: true,
            ..Seen::default()
        }
    }

    fn behind() -> Seen {
        Seen {
            visible: true,
            on_active_space: true,
            ..Seen::default()
        }
    }

    #[test]
    fn nothing_to_do_once_active_key_and_on_this_desktop() {
        assert_eq!(follow_up(in_use(), 0, false, false), Plan::default());
    }

    #[test]
    fn a_window_key_on_another_desktop_is_not_in_use_and_is_brought_over() {
        let away = Seen {
            on_active_space: false,
            ..in_use()
        };
        assert!(!away.in_use());
        let plan = follow_up(away, 1, false, false);
        assert!(plan.order_front && plan.again && !plan.activate && !plan.regardless);
    }

    #[test]
    fn stale_does_nothing_and_a_new_beginning_makes_the_last_stale() {
        let hidden = Seen {
            app_hidden: true,
            ..Seen::default()
        };
        assert_eq!(follow_up(hidden, 0, true, false), Plan::default());
        let first = begin();
        let second = begin();
        assert!(!is_current(first));
        assert!(is_current(second));
    }

    #[test]
    fn a_hidden_app_is_unhidden_and_asked() {
        let hidden = Seen {
            app_hidden: true,
            ..Seen::default()
        };
        assert_eq!(
            follow_up(hidden, 0, false, false),
            Plan {
                unhide: true,
                order_front: true,
                activate: true,
                regardless: true,
                again: true,
            }
        );
    }

    #[test]
    fn visible_but_inactive_is_asked_and_put_in_front_regardless() {
        assert_eq!(
            follow_up(behind(), 1, false, false),
            Plan {
                unhide: false,
                order_front: true,
                activate: true,
                regardless: true,
                again: true,
            }
        );
    }

    #[test]
    fn active_but_still_in_the_dock_is_ordered_front_again() {
        let coming = Seen {
            app_active: true,
            minimized: true,
            on_active_space: true,
            ..Seen::default()
        };
        assert_eq!(
            follow_up(coming, 1, false, false),
            Plan {
                order_front: true,
                again: true,
                ..Plan::default()
            }
        );
    }

    #[test]
    fn another_window_of_memocas_chosen_is_left_to_it() {
        let other = Seen {
            app_active: true,
            visible: true,
            key: false,
            on_active_space: true,
            ..Seen::default()
        };
        assert_eq!(follow_up(other, 1, false, false), Plan::default());
    }

    #[test]
    fn moved_on_is_not_taken_back() {
        assert_eq!(follow_up(behind(), 2, false, true), Plan::default());
        // Still active and only not key: as before, left alone.
        let other = Seen {
            app_active: true,
            ..behind()
        };
        assert_eq!(follow_up(other, 2, false, true), Plan::default());
    }

    #[test]
    fn the_last_look_only_looks() {
        assert_eq!(follow_up(behind(), ASKS, false, false), Plan::default());
        assert!(follow_up(behind(), ASKS - 1, false, false).again);
        assert_eq!(LOOKS.len(), ASKS + 1);
        assert_eq!(LOOKS[0], Duration::ZERO);
        assert!(LOOKS.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
