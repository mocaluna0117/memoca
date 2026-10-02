//! Screens and the pointer, in points (logical pixels), all of one screen
//! in one measure.
//!
//! On a Mac, points are macOS's own measure, the same on a Retina screen as
//! on any other. Tauri hands them over in pixels, each scaled differently
//! (tao, platform_impl/macos): the pointer by the main screen's scale, a
//! screen's place and size by its own, the menu bar icon by its screen's.
//! Looking a screen up by a point wants points. Mixed, a hot corner works
//! only at the top left of a Retina screen, and the window comes out on the
//! wrong screen.
//!
//! On Windows the pointer, the screens and the tray icon are all in the
//! screens' own pixels: the screen is found by them as they are, and then
//! all of it is turned into points by that screen's scale, the window put
//! back into pixels by the same (see `position`).

use tauri::{AppHandle, Monitor, PhysicalPosition, PhysicalSize, Position};

/// A rectangle, in points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Area {
    fn from(position: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> Area {
        Area {
            x: position.x as f64 / scale,
            y: position.y as f64 / scale,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
        }
    }
}

/// The screen the pointer is on.
pub struct Screen {
    /// All of it.
    pub whole: Area,
    /// What the menu bar and the Dock (the taskbar, on Windows) leave.
    pub usable: Area,
    /// Pixels to a point.
    pub scale: f64,
}

fn screen(monitor: Monitor) -> Screen {
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    Screen {
        whole: Area::from(*monitor.position(), *monitor.size(), scale),
        usable: Area::from(work.position, work.size, scale),
        scale,
    }
}

/// The screen the pointer is on (the main one, if it cannot be told), and
/// where the pointer is, in that screen's points.
#[cfg(target_os = "macos")]
pub fn at_pointer(app: &AppHandle) -> Option<(Screen, (f64, f64))> {
    let at = app.cursor_position().ok()?;
    let main = app.primary_monitor().ok().flatten()?.scale_factor();
    let (x, y) = (at.x / main, at.y / main);
    let monitor = app
        .monitor_from_point(x, y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    Some((screen(monitor), (x, y)))
}

/// The screen the pointer is on (the main one, if it cannot be told), and
/// where the pointer is, in that screen's points.
#[cfg(not(target_os = "macos"))]
pub fn at_pointer(app: &AppHandle) -> Option<(Screen, (f64, f64))> {
    let at = app.cursor_position().ok()?;
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors
        .into_iter()
        .find(|monitor| contains(*monitor.position(), *monitor.size(), (at.x, at.y)))
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let found = screen(monitor);
    let point = (at.x / found.scale, at.y / found.scale);
    Some((found, point))
}

/// Whether a screen's pixels (its place and size) hold a point in pixels.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn contains(position: PhysicalPosition<i32>, size: PhysicalSize<u32>, point: (f64, f64)) -> bool {
    let (left, top) = (position.x as f64, position.y as f64);
    let (right, bottom) = (left + size.width as f64, top + size.height as f64);
    point.0 >= left && point.0 < right && point.1 >= top && point.1 < bottom
}

/// Where a window goes, from a place in a screen's points: as points on a
/// Mac, in that screen's pixels on Windows.
pub fn position(x: f64, y: f64, scale: f64) -> Position {
    if cfg!(target_os = "macos") {
        Position::Logical(tauri::LogicalPosition::new(x, y))
    } else {
        Position::Physical(PhysicalPosition::new(
            (x * scale).round() as i32,
            (y * scale).round() as i32,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_screen_holds_the_points_of_its_own_pixels_only() {
        let (at, size) = (
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1920, 1080),
        );
        assert!(contains(at, size, (-1.0, 500.0)));
        assert!(contains(at, size, (-1920.0, 0.0)));
        assert!(!contains(at, size, (0.0, 500.0)));
        assert!(!contains(at, size, (-100.0, 1080.0)));
    }

    #[test]
    fn a_place_goes_back_into_the_screens_pixels_on_windows() {
        let at = position(100.5, 20.0, 1.5);
        if cfg!(target_os = "macos") {
            assert_eq!(
                at,
                Position::Logical(tauri::LogicalPosition::new(100.5, 20.0))
            );
        } else {
            assert_eq!(at, Position::Physical(PhysicalPosition::new(151, 30)));
        }
    }
}
