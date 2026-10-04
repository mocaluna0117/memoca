//! Images copied from a note, put on the clipboard as files, as Finder or
//! Explorer puts the files copied there: for another app (a chat, a mail)
//! to paste all of, where a page can put only one image there
//! (src/components/editor/plain-copy.ts).
//!
//! The files are written to a folder of the app's caches, emptied at each
//! copy and when the app starts: what a locked note shows is kept on disk,
//! read as it is, only until the next copy.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// An image as the page sends it: the name to give its file, its bytes base64.
#[derive(Deserialize)]
pub struct Image {
    name: String,
    data: String,
}

/// The most images one copy puts there.
const MAX_IMAGES: usize = 100;

fn folder(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("clipboard"))
}

/// Empties the folder: when the app starts, files of a copy before are not kept.
pub fn clear(app: &AppHandle) {
    if let Some(folder) = folder(app) {
        let _ = std::fs::remove_dir_all(folder);
    }
}

#[tauri::command]
pub async fn copy_images(app: AppHandle, images: Vec<Image>) -> Result<(), String> {
    if images.is_empty() || images.len() > MAX_IMAGES {
        return Err(format!("1 to {MAX_IMAGES} images"));
    }
    let folder = folder(&app).ok_or("no folder for the files")?;
    tauri::async_runtime::spawn_blocking(move || {
        let paths = write(&folder, &images)?;
        platform::put(&paths)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Writes each image to the folder, emptied first, under a name of its own.
fn write(folder: &Path, images: &[Image]) -> Result<Vec<PathBuf>, String> {
    let _ = std::fs::remove_dir_all(folder);
    std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    let mut taken = HashSet::new();
    let mut paths = Vec::with_capacity(images.len());
    for (index, image) in images.iter().enumerate() {
        let bytes = STANDARD
            .decode(&image.data)
            .map_err(|error| error.to_string())?;
        let path = folder.join(unique(&file_name(&image.name, index), &mut taken));
        std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
        paths.push(path);
    }
    Ok(paths)
}

/// The name as a file may have it: no folders, nothing Windows refuses, not
/// too long; 画像-n.png if nothing is left.
fn file_name(name: &str, index: usize) -> String {
    let kept: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect();
    let kept = kept
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' ']);
    let (stem, ext) = match kept.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, ext),
        _ => (kept, "png"),
    };
    let stem: String = stem.chars().take(80).collect();
    let ext: String = ext.chars().take(8).collect();
    if stem.trim().is_empty() {
        format!("画像-{}.{ext}", index + 1)
    } else {
        format!("{}.{ext}", stem.trim())
    }
}

/// The name, or the name with (2), (3)… if an image before has it already.
fn unique(name: &str, taken: &mut HashSet<String>) -> String {
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let mut candidate = name.to_string();
    let mut count = 1;
    while !taken.insert(candidate.to_lowercase()) {
        count += 1;
        candidate = format!("{stem} ({count}).{ext}");
    }
    candidate
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use std::path::PathBuf;

    /// The files' addresses, as Finder's ⌘C puts them.
    pub fn put(paths: &[PathBuf]) -> Result<(), String> {
        let urls = paths
            .iter()
            .map(|path| {
                let path = path.to_str().ok_or("a path that is not text")?;
                let url = NSURL::fileURLWithPath(&NSString::from_str(path));
                Ok(ProtocolObject::from_retained(url))
            })
            .collect::<Result<Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>>, String>>()?;
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        if board.writeObjects(&NSArray::from_retained_slice(&urls)) {
            Ok(())
        } else {
            Err("the clipboard took nothing".into())
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr;
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, POINT};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::DROPFILES;

    /// Memory the clipboard takes over once given it, holding `bytes`.
    unsafe fn global(bytes: &[u8]) -> Result<HGLOBAL, String> {
        let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if memory.is_null() {
            return Err("no memory for the clipboard".into());
        }
        let at = GlobalLock(memory) as *mut u8;
        if at.is_null() {
            GlobalFree(memory);
            return Err("no memory for the clipboard".into());
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), at, bytes.len());
        GlobalUnlock(memory);
        Ok(memory)
    }

    /// The files, as Explorer's Ctrl+C puts them (CF_HDROP), to be copied.
    pub fn put(paths: &[PathBuf]) -> Result<(), String> {
        let mut names: Vec<u16> = Vec::new();
        for path in paths {
            names.extend(path.as_os_str().encode_wide());
            names.push(0);
        }
        names.push(0);
        let header = DROPFILES {
            pFiles: size_of::<DROPFILES>() as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: 0,
            fWide: 1,
        };
        let mut drop = Vec::with_capacity(size_of::<DROPFILES>() + names.len() * 2);
        // SAFETY: DROPFILES is plain data, read as its bytes.
        drop.extend_from_slice(unsafe {
            std::slice::from_raw_parts(
                (&header as *const DROPFILES).cast::<u8>(),
                size_of::<DROPFILES>(),
            )
        });
        for unit in names {
            drop.extend_from_slice(&unit.to_ne_bytes());
        }
        let effect: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
        // SAFETY: the clipboard is opened, written and closed here, each
        // memory handed to it once it has it, freed here if it did not.
        unsafe {
            // Another app may have it open a moment: tried again.
            let mut opened = false;
            for _ in 0..10 {
                if OpenClipboard(ptr::null_mut()) != 0 {
                    opened = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            if !opened {
                return Err("the clipboard is in use".into());
            }
            EmptyClipboard();
            let result = (|| {
                let files = global(&drop)?;
                if SetClipboardData(CF_HDROP as u32, files as HANDLE).is_null() {
                    GlobalFree(files);
                    return Err("the clipboard took nothing".to_string());
                }
                // Copied, not moved, when pasted in Explorer (DROPEFFECT_COPY).
                let format = RegisterClipboardFormatW(effect.as_ptr());
                if format != 0 {
                    let copy = global(&1u32.to_ne_bytes())?;
                    if SetClipboardData(format, copy as HANDLE).is_null() {
                        GlobalFree(copy);
                    }
                }
                Ok(())
            })();
            CloseClipboard();
            result
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use std::path::PathBuf;

    pub fn put(_paths: &[PathBuf]) -> Result<(), String> {
        Err("not on this system".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_file_may_have() {
        assert_eq!(file_name("図.jpg", 0), "図.jpg");
        assert_eq!(file_name("../a/b:c?.png", 0), "abc.png");
        assert_eq!(file_name("", 2), "画像-3.png");
        assert_eq!(file_name(".png", 0), "png.png");
        assert_eq!(file_name("名前", 0), "名前.png");
    }

    #[test]
    fn the_same_name_twice_is_told_apart() {
        let mut taken = HashSet::new();
        assert_eq!(unique("a.png", &mut taken), "a.png");
        assert_eq!(unique("A.png", &mut taken), "A (2).png");
        assert_eq!(unique("a.png", &mut taken), "a (3).png");
    }

    #[test]
    fn writes_each_and_empties_the_folder_first() {
        let folder = std::env::temp_dir().join(format!("memoca-clipboard-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("old.png"), b"old").unwrap();
        let images = [
            Image {
                name: "a.png".into(),
                data: STANDARD.encode(b"one"),
            },
            Image {
                name: "a.png".into(),
                data: STANDARD.encode(b"two"),
            },
        ];
        let paths = write(&folder, &images).unwrap();
        assert_eq!(paths, [folder.join("a.png"), folder.join("a (2).png")]);
        assert_eq!(std::fs::read(&paths[1]).unwrap(), b"two");
        assert!(!folder.join("old.png").exists());
        std::fs::remove_dir_all(folder).unwrap();
    }
}
