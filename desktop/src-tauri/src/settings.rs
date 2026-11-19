//! What the person chose, kept in settings.json in the app's configuration
//! folder (~/Library/Application Support/io.github.mocaluna0117.memoca on a
//! Mac, %APPDATA%\io.github.mocaluna0117.memoca on Windows): the hotkeys,
//! which are changed there (the menu opens the file), the hot corner and
//! whether the window is pinned, which the menu sets, and the window's size
//! and, pinned, where it was, which the window keeps as it is put away.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The hotkey unless the file says otherwise: ⌘⇧M on a Mac, Ctrl+Shift+M elsewhere.
pub const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+M";

/// Memoca's own window's hotkey unless the file says otherwise: the same
/// keys as the quick note's, and so taken by it, until that is changed.
pub const DEFAULT_APP_SHORTCUT: &str = "CmdOrCtrl+Shift+M";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The hotkey, as Tauri writes one ("CmdOrCtrl+Shift+M").
    pub shortcut: String,
    /// The hotkey for Memoca's own window (app_window.rs).
    pub app_shortcut: String,
    /// The corner the pointer is held in to bring the window out; none by default.
    pub hot_corner: Option<Corner>,
    /// The quick note's window kept out when another app is clicked, rather
    /// than put away.
    pub pinned: bool,
    /// Memoca's own window kept out when another app is clicked, and as
    /// the quick note is put away (app_window.rs, window.rs); put away then,
    /// as the quick note's is, if not. Kept out unless chosen otherwise, as
    /// it always was before it could be.
    pub app_pinned: bool,
    /// Memoca's own window, kept out (`app_pinned`), above the others, as
    /// the quick note's is: not left behind the app clicked. Off unless
    /// chosen (0.4.18); `app_pinned` was on in every 0.4.17 file, chosen
    /// or not, so it could not be taken to mean this.
    pub app_on_top: bool,
    /// Memoca's own window let go of, put away a while, while the computer
    /// is short of memory, and made again when opened (memory.rs). On
    /// unless chosen otherwise: kept made, to come out at once, if not.
    pub let_go_when_short: bool,
    /// The window's size as it was last put away, in points (logical pixels).
    pub size: Option<(f64, f64)>,
    /// Where a pinned window was last put away, in points: it comes out there.
    pub position: Option<(f64, f64)>,
    /// The Todo's reminders shown on this computer (reminders.rs): set from
    /// the page's bell, not here.
    pub reminders: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.into(),
            app_shortcut: DEFAULT_APP_SHORTCUT.into(),
            hot_corner: None,
            pinned: false,
            app_pinned: true,
            app_on_top: false,
            let_go_when_short: true,
            size: None,
            position: None,
            reminders: false,
        }
    }
}

/// What the settings page turns on and off (commands::setting_get and
/// setting_set), as it names each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Switch {
    /// The quick note's window pinned ("quickPinned").
    QuickPinned,
    /// Memoca's own window pinned ("appPinned").
    AppPinned,
    /// Memoca's own window above the others ("appOnTop").
    AppOnTop,
    /// Memoca's own window let go of while memory is short ("letGoWhenShort").
    LetGoWhenShort,
}

impl Switch {
    pub fn named(name: &str) -> Result<Switch, String> {
        match name {
            "quickPinned" => Ok(Switch::QuickPinned),
            "appPinned" => Ok(Switch::AppPinned),
            "appOnTop" => Ok(Switch::AppOnTop),
            "letGoWhenShort" => Ok(Switch::LetGoWhenShort),
            other => Err(format!("no setting {other:?}")),
        }
    }

    pub fn of(self, settings: &Settings) -> bool {
        match self {
            Switch::QuickPinned => settings.pinned,
            Switch::AppPinned => settings.app_pinned,
            Switch::AppOnTop => settings.app_on_top,
            Switch::LetGoWhenShort => settings.let_go_when_short,
        }
    }

    pub fn set(self, settings: &mut Settings, on: bool) {
        match self {
            Switch::QuickPinned => settings.pinned = on,
            Switch::AppPinned => settings.app_pinned = on,
            Switch::AppOnTop => settings.app_on_top = on,
            Switch::LetGoWhenShort => settings.let_go_when_short = on,
        }
    }
}

/// How Memoca's own window takes another app being clicked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppWindow {
    /// Put away, as the quick note is (not kept out).
    Hide,
    /// Left behind the app clicked, as any window: as it always was.
    Behind,
    /// Kept above the others (ピン留め, as the quick note's).
    OnTop,
}

impl Settings {
    /// How Memoca's own window takes another app being clicked: on top only
    /// when kept out too (put away, it is not out to be on top).
    pub fn app_window(&self) -> AppWindow {
        match (self.app_pinned, self.app_on_top) {
            (false, _) => AppWindow::Hide,
            (true, false) => AppWindow::Behind,
            (true, true) => AppWindow::OnTop,
        }
    }
}

/// The settings, and where they are kept.
pub struct Store {
    path: PathBuf,
    settings: Mutex<Settings>,
}

impl Store {
    pub fn get(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    /// Changes the settings, and writes them to the file: to the file as it
    /// is now, so a hotkey written into it since the app started is kept.
    /// A file that cannot be read is left alone for the person to put
    /// right; the change holds until the app quits.
    pub fn update(&self, change: impl FnOnce(&mut Settings)) {
        let mut settings = self.settings.lock().unwrap();
        match read(&self.path) {
            Read::Found(on_disk) => *settings = on_disk,
            Read::Missing => {}
            Read::Unreadable(error) => {
                eprintln!(
                    "Memoca: {} is not readable ({error}); not saving",
                    self.path.display()
                );
                change(&mut settings);
                return;
            }
        }
        change(&mut settings);
        if let Err(error) = write(&self.path, &settings) {
            eprintln!("Memoca: could not save {}: {error}", self.path.display());
        }
    }
}

enum Read {
    Found(Settings),
    Missing,
    Unreadable(String),
}

fn read(path: &PathBuf) -> Read {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(settings) => Read::Found(settings),
            Err(error) => Read::Unreadable(error.to_string()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Read::Missing,
        Err(error) => Read::Unreadable(error.to_string()),
    }
}

fn write(path: &PathBuf, settings: &Settings) -> std::io::Result<()> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(settings)? + "\n")
}

/// Reads the settings into the app's state. True on the first run, when
/// there is no file: it is written then, so there is one to edit. One that
/// cannot be read is used as the defaults, and left as it is.
pub fn init(app: &AppHandle) -> tauri::Result<bool> {
    let path = app.path().app_config_dir()?.join("settings.json");
    let (settings, first_run) = match read(&path) {
        Read::Found(settings) => (settings, false),
        Read::Missing => (Settings::default(), true),
        Read::Unreadable(error) => {
            eprintln!(
                "Memoca: {} is not readable ({error}); using defaults",
                path.display()
            );
            (Settings::default(), false)
        }
    };
    if first_run {
        if let Err(error) = write(&path, &settings) {
            eprintln!("Memoca: could not save {}: {error}", path.display());
        }
    }
    app.manage(Store {
        path,
        settings: Mutex::new(settings),
    });
    Ok(first_run)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &std::path::Path) -> Store {
        Store {
            path: dir.join("settings.json"),
            settings: Mutex::new(Settings::default()),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("memoca-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_change_from_the_menu_keeps_a_hotkey_written_into_the_file_since() {
        let dir = scratch("keep");
        let store = store(&dir);
        std::fs::write(&store.path, r#"{ "shortcut": "Ctrl+Shift+Space" }"#).unwrap();
        store.update(|settings| settings.pinned = true);
        let Read::Found(saved) = read(&store.path) else {
            panic!("not saved")
        };
        assert_eq!(saved.shortcut, "Ctrl+Shift+Space");
        assert_eq!(saved.app_shortcut, DEFAULT_APP_SHORTCUT);
        assert!(saved.pinned);
        assert_eq!(saved.hot_corner, None);
        // A file from before these could be chosen: as they were.
        assert!(saved.app_pinned);
        assert!(!saved.app_on_top);
        assert!(saved.let_go_when_short);
        assert_eq!(saved.app_window(), AppWindow::Behind);
    }

    #[test]
    fn memocas_own_window_hidden_left_behind_or_on_top() {
        let with = |app_pinned, app_on_top| Settings {
            app_pinned,
            app_on_top,
            ..Settings::default()
        };
        assert_eq!(with(false, false).app_window(), AppWindow::Hide);
        assert_eq!(with(false, true).app_window(), AppWindow::Hide);
        assert_eq!(with(true, false).app_window(), AppWindow::Behind);
        assert_eq!(with(true, true).app_window(), AppWindow::OnTop);
    }

    #[test]
    fn each_switch_as_the_settings_page_names_it() {
        let mut settings = Settings::default();
        for (name, switch) in [
            ("quickPinned", Switch::QuickPinned),
            ("appPinned", Switch::AppPinned),
            ("appOnTop", Switch::AppOnTop),
            ("letGoWhenShort", Switch::LetGoWhenShort),
        ] {
            assert_eq!(Switch::named(name), Ok(switch));
            switch.set(&mut settings, true);
            assert!(switch.of(&settings));
            switch.set(&mut settings, false);
            assert!(!switch.of(&settings));
        }
        assert!(Switch::named("pinned").is_err());
    }

    #[test]
    fn a_file_that_cannot_be_read_is_left_as_it_is() {
        let dir = scratch("broken");
        let store = store(&dir);
        std::fs::write(&store.path, "{ shortcut: oops").unwrap();
        store.update(|settings| settings.pinned = true);
        assert_eq!(
            std::fs::read_to_string(&store.path).unwrap(),
            "{ shortcut: oops"
        );
        // The change holds meanwhile.
        assert!(store.get().pinned);
    }

    #[test]
    fn with_no_file_the_change_writes_one() {
        let dir = scratch("missing");
        let store = store(&dir);
        store.update(|settings| settings.hot_corner = Some(Corner::TopRight));
        let Read::Found(saved) = read(&store.path) else {
            panic!("not saved")
        };
        assert_eq!(saved.hot_corner, Some(Corner::TopRight));
        assert_eq!(saved.shortcut, DEFAULT_SHORTCUT);
    }
}
