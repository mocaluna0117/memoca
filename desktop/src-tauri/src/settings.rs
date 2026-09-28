//! What the person chose, kept in settings.json in the app's configuration
//! folder (~/Library/Application Support/io.github.mocaluna0117.memoca):
//! the hotkey, which is changed there (the menu opens the file), the hot
//! corner and whether the window is pinned, which the menu sets.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The hotkey unless the file says otherwise: ⌘⇧M on a Mac, Ctrl+Shift+M elsewhere.
pub const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+M";

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
    /// The corner the pointer is held in to bring the window out; none by default.
    pub hot_corner: Option<Corner>,
    /// Kept out when another app is clicked, rather than put away.
    pub pinned: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.into(),
            hot_corner: None,
            pinned: false,
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

    pub fn path(&self) -> &PathBuf {
        &self.path
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
        std::fs::write(store.path(), r#"{ "shortcut": "Ctrl+Shift+Space" }"#).unwrap();
        store.update(|settings| settings.pinned = true);
        let Read::Found(saved) = read(store.path()) else {
            panic!("not saved")
        };
        assert_eq!(saved.shortcut, "Ctrl+Shift+Space");
        assert!(saved.pinned);
        assert_eq!(saved.hot_corner, None);
    }

    #[test]
    fn a_file_that_cannot_be_read_is_left_as_it_is() {
        let dir = scratch("broken");
        let store = store(&dir);
        std::fs::write(store.path(), "{ shortcut: oops").unwrap();
        store.update(|settings| settings.pinned = true);
        assert_eq!(
            std::fs::read_to_string(store.path()).unwrap(),
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
        let Read::Found(saved) = read(store.path()) else {
            panic!("not saved")
        };
        assert_eq!(saved.hot_corner, Some(Corner::TopRight));
        assert_eq!(saved.shortcut, DEFAULT_SHORTCUT);
    }
}
