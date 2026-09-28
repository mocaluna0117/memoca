//! Screens and the pointer, in points: macOS's own measure, the same on a
//! Retina screen as on any other. Tauri hands them over in pixels, each
//! scaled differently (tao, platform_impl/macos): the pointer by the main
//! screen's scale, a screen's place and size by its own, the menu bar icon
//! by its screen's. Looking a screen up by a point wants points. Mixed, a
//! hot corner works only at the top left of a Retina screen, and the window
//! comes out on the wrong screen.

use tauri::{AppHandle, Monitor, PhysicalPosition, PhysicalSize};

/// A rectangle, in points, its top left corner at the top left of the main screen.
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
    /// What the menu bar and the Dock leave.
    pub usable: Area,
    /// Pixels to a point.
    pub scale: f64,
}

/// Where the pointer is.
pub fn pointer(app: &AppHandle) -> Option<(f64, f64)> {
    let at = app.cursor_position().ok()?;
    let main = app.primary_monitor().ok().flatten()?.scale_factor();
    Some((at.x / main, at.y / main))
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

/// The screen the pointer is on (the main one, if it cannot be told), and where the pointer is.
pub fn at_pointer(app: &AppHandle) -> Option<(Screen, (f64, f64))> {
    let (x, y) = pointer(app)?;
    let monitor = app
        .monitor_from_point(x, y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    Some((screen(monitor), (x, y)))
}
