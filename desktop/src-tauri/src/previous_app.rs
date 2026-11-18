//! The app in use before Memoca, on a Mac: the keyboard is handed back to
//! it as the quick note is put away while Memoca's own window stays out
//! (pinned: window.rs's `hide`). Hiding Memoca would hand it back too, but
//! would take that window with it, left in the Dock and ⌘Tab with nothing
//! seen.
//!
//! Which app that was is followed as the system says each is made active,
//! rather than read as the quick note comes out: it may be clicked into
//! later, pinned and left out, from another app than the one it came out
//! over.

use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
    NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::NSNotification;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicI32, Ordering};

/// The process of the app last made active other than Memoca; 0 for none yet.
static LAST: AtomicI32 = AtomicI32::new(0);

/// Follows which app is made active, from now on: once, as the app starts.
pub fn watch() {
    let own = std::process::id() as i32;
    let workspace = NSWorkspace::sharedWorkspace();
    // The one in front as Memoca starts (it is started in the background,
    // by login or by a click elsewhere).
    if let Some(front) = workspace.frontmostApplication() {
        remember(front.processIdentifier(), own);
    }
    let made_active = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
        // Told just after: the one made active is the one in front.
        if let Some(front) = NSWorkspace::sharedWorkspace().frontmostApplication() {
            remember(front.processIdentifier(), own);
        }
    });
    // SAFETY: no object to match, the block run on the thread that posts
    // (the main one, for the workspace's), and kept for as long as the app
    // runs, as the observer is.
    let observer = unsafe {
        workspace
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                None,
                &made_active,
            )
    };
    std::mem::forget(observer);
}

fn remember(pid: i32, own: i32) {
    if pid > 0 && pid != own {
        LAST.store(pid, Ordering::Relaxed);
    }
}

/// Hands the keyboard back to the app in use before, on the main thread:
/// only while Memoca has it (the quick note did, and was put away), not
/// once another app was clicked. Whether it was asked to.
pub fn give_back() -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    if !ns_app.isActive() {
        return false;
    }
    let pid = LAST.load(Ordering::Relaxed);
    if pid <= 0 {
        return false;
    }
    let Some(before) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
        return false;
    };
    if before.isTerminated() {
        return false;
    }
    // Since macOS 14, an app is made active only if the one in use lets it.
    if crate::activation::has_activate() {
        ns_app.yieldActivationToApplication(&before);
    }
    before.activateWithOptions(NSApplicationActivationOptions::empty())
}
