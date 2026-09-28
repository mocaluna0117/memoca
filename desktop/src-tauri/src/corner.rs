//! A hot corner of Memoca's own (macOS keeps its own for Apple's features):
//! the pointer held in the corner chosen in the menu brings the window out
//! there. Off unless chosen. Looked at ten times a second; the pointer must
//! stay within 2 px of the corner for 0.3 s, and leave it before the corner
//! works again.

use crate::screen::{self, Area};
use crate::settings::{Corner, Store};
use crate::window;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const EVERY: Duration = Duration::from_millis(100);
const HOLD: Duration = Duration::from_millis(300);
const REACH: f64 = 2.0;

/// Whether a point is in a corner of a screen (its position and size), all in points.
fn in_corner(point: (f64, f64), screen: (f64, f64, f64, f64), corner: Corner) -> bool {
    let (x, y) = point;
    let (left, top, width, height) = screen;
    let (right, bottom) = (left + width - 1.0, top + height - 1.0);
    if x < left || x > right || y < top || y > bottom {
        return false;
    }
    let near_left = x - left <= REACH;
    let near_right = right - x <= REACH;
    let near_top = y - top <= REACH;
    let near_bottom = bottom - y <= REACH;
    match corner {
        Corner::TopLeft => near_left && near_top,
        Corner::TopRight => near_right && near_top,
        Corner::BottomLeft => near_left && near_bottom,
        Corner::BottomRight => near_right && near_bottom,
    }
}

/// Where the pointer has been: since when in the corner, and whether the
/// corner is ready to work (it is not again until the pointer has left).
#[derive(Default)]
struct Watch {
    since: Option<Instant>,
    spent: bool,
}

impl Watch {
    /// Whether the window comes out now, the pointer being `inside` the corner or not.
    fn step(&mut self, inside: bool, now: Instant) -> bool {
        if !inside {
            *self = Watch::default();
            return false;
        }
        let since = *self.since.get_or_insert(now);
        if !self.spent && now.duration_since(since) >= HOLD {
            self.spent = true;
            return true;
        }
        false
    }
}

/// Whether the pointer is in `corner` of the screen it is on (screen.rs: in points).
fn pointer_in(app: &AppHandle, corner: Corner) -> bool {
    let Some((screen, point)) = screen::at_pointer(app) else {
        return false;
    };
    let Area {
        x,
        y,
        width,
        height,
    } = screen.whole;
    in_corner(point, (x, y, width, height), corner)
}

/// Watches the pointer for as long as the app runs, while a corner is chosen.
pub fn watch(app: AppHandle) {
    let state = Arc::new(Mutex::new(Watch::default()));
    std::thread::spawn(move || loop {
        std::thread::sleep(EVERY);
        let Some(corner) = app.state::<Store>().get().hot_corner else {
            *state.lock().unwrap() = Watch::default();
            continue;
        };
        // Screens and the pointer are asked for where the app's windows live.
        let (handle, state) = (app.clone(), state.clone());
        let _ = app.run_on_main_thread(move || {
            let inside = pointer_in(&handle, corner);
            if state.lock().unwrap().step(inside, Instant::now()) {
                window::show(&handle, window::Place::Corner(corner));
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: (f64, f64, f64, f64) = (0.0, 0.0, 1440.0, 900.0);

    #[test]
    fn a_corner_is_the_last_2_px_of_both_edges() {
        assert!(in_corner((0.0, 0.0), SCREEN, Corner::TopLeft));
        assert!(in_corner((2.0, 1.0), SCREEN, Corner::TopLeft));
        assert!(!in_corner((3.0, 0.0), SCREEN, Corner::TopLeft));
        assert!(!in_corner((0.0, 0.0), SCREEN, Corner::TopRight));
        assert!(in_corner((1439.0, 0.0), SCREEN, Corner::TopRight));
        assert!(in_corner((0.0, 899.0), SCREEN, Corner::BottomLeft));
        assert!(in_corner((1439.0, 899.0), SCREEN, Corner::BottomRight));
        assert!(!in_corner((1439.0, 896.0), SCREEN, Corner::BottomRight));
    }

    #[test]
    fn a_corner_of_a_second_screen_counts_from_where_that_screen_is() {
        let right = (1440.0, 0.0, 1920.0, 1080.0);
        assert!(in_corner((1440.0, 0.0), right, Corner::TopLeft));
        assert!(!in_corner((0.0, 0.0), right, Corner::TopLeft));
    }

    #[test]
    fn the_pointer_is_held_there_a_moment_and_works_once_until_it_leaves() {
        let start = Instant::now();
        let at = |ms| start + Duration::from_millis(ms);
        let mut watch = Watch::default();
        assert!(!watch.step(true, at(0)));
        assert!(!watch.step(true, at(200)));
        assert!(watch.step(true, at(300)));
        // Still there: not again.
        assert!(!watch.step(true, at(900)));
        // Gone and back: again, once held.
        assert!(!watch.step(false, at(1000)));
        assert!(!watch.step(true, at(1100)));
        assert!(watch.step(true, at(1400)));
        // Passing through is not holding.
        let mut passing = Watch::default();
        assert!(!passing.step(true, at(0)));
        assert!(!passing.step(false, at(100)));
        assert!(!passing.step(true, at(200)));
        assert!(!passing.step(true, at(400)));
    }
}
