//! The Todo's reminders on this computer (docs/DESKTOP.md): those the
//! server keeps for the account (convex/reminders.ts), handed over by the
//! quick note's page as they change (src/components/notes/todo-notify.tsx),
//! and shown by the computer's own notifications at their times. The page
//! cannot show them itself (its window has no Web Push), and is slowed while
//! put away: the times are kept here.
//!
//! The clock is looked at every half minute at the most, not slept on until
//! a time (a Mac asleep does not count the time it sleeps): one due while
//! the computer slept comes as it wakes, if not too long after, and an item
//! with several due by then is told of once. Whether this computer shows
//! them is the person's choice (settings.json's `reminders`, set from the
//! page's bell), and the system's (its notification settings).

use crate::settings::Store;
use crate::window;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Window};

/// A reminder as the server keeps it (convex/reminders.ts `list`).
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Reminder {
    /// The item's block id and which of its times: "<id>:<timing>".
    pub key: String,
    /// When, in milliseconds since 1970.
    pub at: i64,
    pub title: String,
    pub body: String,
}

/// The most kept, as the server keeps (the soonest).
const MAX: usize = 500;
const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 400;

/// One gone from the list at about its time was most likely just sent by
/// the server, which takes each away as it sends it (to the account's
/// phones, say): shown here all the same, if within this of its time.
const SENT_MS: i64 = 60_000;

/// How late one is still shown: the computer asleep, or Memoca not running,
/// at its time. Older, it is let go.
const LATE_MS: i64 = 12 * 60 * 60 * 1000;

/// The longest the clock goes unlooked at.
const TICK_MS: i64 = 30_000;

/// The reminders to come, and those shown (each key, with the time it was
/// shown for: the server may list it a moment longer, its clock behind this
/// computer's).
#[derive(Debug, Default)]
pub struct Schedule {
    list: Vec<Reminder>,
    shown: HashMap<String, i64>,
}

/// The item a reminder is of: its key without the time.
fn item_of(key: &str) -> &str {
    key.rsplit_once(':').map_or(key, |(item, _)| item)
}

fn clipped(text: &str, most: usize) -> String {
    text.chars().take(most).collect()
}

impl Schedule {
    /// The list as the page has it now, in place of the one before: those
    /// shown already left out, and any gone from it just at its time kept.
    pub fn replace(&mut self, new: Vec<Reminder>, now: i64) {
        let mut next: Vec<Reminder> = Vec::new();
        for reminder in new {
            let shown = self.shown.get(&reminder.key) == Some(&reminder.at);
            if !shown && !next.iter().any(|each| each.key == reminder.key) {
                next.push(Reminder {
                    title: clipped(&reminder.title, MAX_TITLE),
                    body: clipped(&reminder.body, MAX_BODY),
                    ..reminder
                });
            }
        }
        for old in self.list.drain(..) {
            if old.at <= now + SENT_MS && !next.iter().any(|each| each.key == old.key) {
                next.push(old);
            }
        }
        next.sort_by_key(|each| each.at);
        next.truncate(MAX);
        self.list = next;
        self.prune(now);
    }

    /// None to come: turned off, or signed out.
    pub fn clear(&mut self) {
        self.list.clear();
    }

    /// Those due, taken off the list and to be shown: of an item's, only the
    /// latest due (one asleep through its evening's and its morning's is
    /// told of once), and none too late.
    pub fn take_due(&mut self, now: i64) -> Vec<Reminder> {
        let (due, rest): (Vec<Reminder>, Vec<Reminder>) = std::mem::take(&mut self.list)
            .into_iter()
            .partition(|each| each.at <= now);
        self.list = rest;
        let mut latest: HashMap<String, Reminder> = HashMap::new();
        for reminder in due {
            self.shown.insert(reminder.key.clone(), reminder.at);
            if now - reminder.at > LATE_MS {
                continue;
            }
            let item = item_of(&reminder.key).to_string();
            if latest.get(&item).is_none_or(|kept| kept.at < reminder.at) {
                latest.insert(item, reminder);
            }
        }
        self.prune(now);
        let mut shown: Vec<Reminder> = latest.into_values().collect();
        shown.sort_by_key(|each| each.at);
        shown
    }

    /// The soonest to come, if any.
    pub fn next_at(&self) -> Option<i64> {
        self.list.iter().map(|each| each.at).min()
    }

    fn prune(&mut self, now: i64) {
        self.shown.retain(|_, at| now - *at <= LATE_MS + SENT_MS);
        self.list.retain(|each| now - each.at <= LATE_MS);
    }
}

/// The schedule, and a word to the clock's thread that it changed.
#[derive(Default)]
pub struct Reminders {
    schedule: Mutex<Schedule>,
    changed: Condvar,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// Starts keeping the times: with the app, so a reminder clicked can bring
/// out the Todo.
pub fn start(app: &AppHandle) {
    app.manage(Reminders::default());
    platform::init(app);
    let app = app.clone();
    let started = std::thread::Builder::new()
        .name("reminders".into())
        .spawn(move || watch(app));
    if let Err(error) = started {
        eprintln!("Memoca: could not keep the Todo's reminders: {error}");
    }
}

fn watch(app: AppHandle) {
    let reminders = app.state::<Reminders>();
    let mut schedule = reminders.schedule.lock().unwrap();
    loop {
        let now = now_ms();
        let due = schedule.take_due(now);
        if !due.is_empty() {
            drop(schedule);
            for reminder in &due {
                platform::show(&app, reminder);
            }
            schedule = reminders.schedule.lock().unwrap();
            continue;
        }
        let wait = schedule
            .next_at()
            .map_or(TICK_MS, |at| (at - now).clamp(1, TICK_MS));
        schedule = reminders
            .changed
            .wait_timeout(schedule, Duration::from_millis(wait as u64))
            .unwrap()
            .0;
    }
}

fn change(app: &AppHandle, change: impl FnOnce(&mut Schedule)) {
    let Some(reminders) = app.try_state::<Reminders>() else {
        return;
    };
    change(&mut reminders.schedule.lock().unwrap());
    reminders.changed.notify_all();
}

/// None shown here any more, until turned on again: turned off from the
/// page, or signed out (tray.rs).
pub fn turn_off(app: &AppHandle) {
    app.state::<Store>()
        .update(|settings| settings.reminders = false);
    change(app, Schedule::clear);
}

/// Opens the Todo, from a reminder clicked.
fn open_todo(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || window::show_todo(&handle));
}

/// What the system allows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    /// Notifications shown.
    Allowed,
    /// Not asked yet, or asked and not answered.
    NotAsked,
    /// Turned off in the system's settings.
    Denied,
    /// None for this app: a Mac's, run from elsewhere than an Applications folder, say.
    Unsupported,
}

/// What the page's bell shows: "on", "off", "blocked" (chosen, but the
/// system will not show them), or "unsupported".
fn state(chosen: bool, permission: Permission) -> &'static str {
    match (permission, chosen) {
        (Permission::Unsupported, _) => "unsupported",
        (_, false) => "off",
        (Permission::Allowed, true) => "on",
        _ => "blocked",
    }
}

/// Where this computer stands (src/lib/quick/shell.ts `reminders.state`).
#[tauri::command]
pub async fn reminders_state(app: AppHandle) -> &'static str {
    let permission = tauri::async_runtime::spawn_blocking(platform::permission)
        .await
        .unwrap_or(Permission::Unsupported);
    state(app.state::<Store>().get().reminders, permission)
}

/// Turned on from the page's bell: the system asked (once; a Mac shows its
/// question), and the choice kept whatever it answers, so that allowing
/// them in the system's settings later is enough.
#[tauri::command]
pub async fn reminders_turn_on(app: AppHandle) -> &'static str {
    let permission = tauri::async_runtime::spawn_blocking(platform::ask)
        .await
        .unwrap_or(Permission::Unsupported);
    if permission != Permission::Unsupported {
        app.state::<Store>()
            .update(|settings| settings.reminders = true);
    }
    state(app.state::<Store>().get().reminders, permission)
}

#[tauri::command]
pub fn reminders_turn_off(app: AppHandle) {
    turn_off(&app);
}

/// The account's reminders, from the quick note's page as they change
/// (Memoca's own window's are not listened to: the quick note's is always
/// loaded). Not kept unless turned on.
#[tauri::command]
pub fn set_reminders(app: AppHandle, window: Window, reminders: Vec<Reminder>) {
    if window.label() != window::LABEL || !app.state::<Store>().get().reminders {
        return;
    }
    let now = now_ms();
    change(&app, |schedule| schedule.replace(reminders, now));
}

#[cfg(target_os = "macos")]
mod platform {
    //! The Mac's notifications (UserNotifications): only for an app with a
    //! bundle, as Memoca is once built (`tauri dev` runs one without, and
    //! asking then would end it), and, with an ad-hoc signature, only in an
    //! Applications folder (elsewhere the system refuses it outright).
    use super::{open_todo, Permission, Reminder};
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNErrorCode, UNMutableNotificationContent,
        UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSettings, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::AppHandle;

    /// How long the system's question is waited on: left unanswered, the
    /// bell says to allow them in its settings.
    const ASKED: Duration = Duration::from_secs(30);

    /// The center, for an app run as one (a .app with an identifier): asked
    /// of by a bare binary, it ends the process.
    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier()?;
        if !bundle.bundlePath().to_string().ends_with(".app") {
            return None;
        }
        Some(UNUserNotificationCenter::currentNotificationCenter())
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and the
        // delegate does not implement Drop.
        #[unsafe(super(NSObject))]
        #[name = "MemocaReminderDelegate"]
        #[ivars = AppHandle]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// Shown while Memoca is the app in use (its quick note out) too.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            /// Clicked: the Todo.
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                _response: &UNNotificationResponse,
                handler: &DynBlock<dyn Fn()>,
            ) {
                open_todo(self.ivars());
                handler.call(());
            }
        }
    );

    impl Delegate {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(app);
            // SAFETY: NSObject's init, on a class of its.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn init(app: &AppHandle) {
        let Some(center) = center() else { return };
        let delegate = Delegate::new(app.clone());
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly: this one is the app's for good.
        std::mem::forget(delegate);
    }

    pub fn permission() -> Permission {
        let Some(center) = center() else {
            return Permission::Unsupported;
        };
        let (tx, rx) = mpsc::channel();
        let reply = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: the settings the system hands over, for this call.
            let _ = tx.send(unsafe { settings.as_ref() }.authorizationStatus());
        });
        center.getNotificationSettingsWithCompletionHandler(&reply);
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(status)
                if status == UNAuthorizationStatus::Authorized
                    || status == UNAuthorizationStatus::Provisional
                    || status == UNAuthorizationStatus::Ephemeral =>
            {
                Permission::Allowed
            }
            Ok(UNAuthorizationStatus::Denied) => Permission::Denied,
            _ => Permission::NotAsked,
        }
    }

    pub fn ask() -> Permission {
        let Some(center) = center() else {
            return Permission::Unsupported;
        };
        let (tx, rx) = mpsc::channel();
        let reply = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
            // SAFETY: the error the system hands over, if any, for this call.
            let _ = tx.send(unsafe { error.as_ref() }.map(|error| error.code()));
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &reply,
        );
        if let Ok(Some(code)) = rx.recv_timeout(ASKED) {
            if code == UNErrorCode::NotificationsNotAllowed.0 {
                return Permission::Unsupported;
            }
        }
        permission()
    }

    pub fn show(_app: &AppHandle, reminder: &Reminder) {
        let Some(center) = center() else { return };
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&reminder.title));
        content.setBody(&NSString::from_str(&reminder.body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        content.setThreadIdentifier(&NSString::from_str("todo"));
        // By its key: one shown again (its time moved) takes the place of the one before.
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&reminder.key),
            &content,
            None,
        );
        center.addNotificationRequest_withCompletionHandler(&request, None);
    }
}

#[cfg(windows)]
mod platform {
    //! Windows' own notifications, as the app its installer put in the Start
    //! menu (by the identifier it gives the shortcut).
    use super::{open_todo, Permission, Reminder};
    use tauri::AppHandle;
    use tauri_winrt_notification::{Duration, Sound, Toast};

    pub fn init(_app: &AppHandle) {}

    /// Windows shows them unless told not to, which its own settings say.
    pub fn permission() -> Permission {
        Permission::Allowed
    }

    pub fn ask() -> Permission {
        Permission::Allowed
    }

    /// The app's AppUserModelID: its identifier, as the installer gives its
    /// shortcut; a build run from target\ has no shortcut, and PowerShell's.
    fn app_id(app: &AppHandle) -> String {
        let installed = std::env::current_exe().ok().is_some_and(|exe| {
            !exe.components()
                .any(|part| part.as_os_str().eq_ignore_ascii_case("target"))
        });
        if installed {
            app.config().identifier.clone()
        } else {
            Toast::POWERSHELL_APP_ID.to_string()
        }
    }

    pub fn show(app: &AppHandle, reminder: &Reminder) {
        let handle = app.clone();
        let shown = Toast::new(&app_id(app))
            .title(&reminder.title)
            .text1(&reminder.body)
            .sound(Some(Sound::Reminder))
            .duration(Duration::Short)
            .on_activated(move |_| {
                open_todo(&handle);
                Ok(())
            })
            .show();
        if let Err(error) = shown {
            eprintln!("Memoca: could not show a reminder: {error}");
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::{Permission, Reminder};
    use tauri::AppHandle;

    pub fn init(_app: &AppHandle) {}
    pub fn permission() -> Permission {
        Permission::Unsupported
    }
    pub fn ask() -> Permission {
        Permission::Unsupported
    }
    pub fn show(_app: &AppHandle, _reminder: &Reminder) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    const HOUR: i64 = 60 * MIN;
    const NOW: i64 = 1_800_000_000_000;

    fn reminder(key: &str, at: i64) -> Reminder {
        Reminder {
            key: key.into(),
            at,
            title: "牛乳を買う".into(),
            body: "今日が期日です".into(),
        }
    }

    fn keys(list: &[Reminder]) -> Vec<&str> {
        list.iter().map(|each| each.key.as_str()).collect()
    }

    #[test]
    fn one_is_shown_once_its_time_comes() {
        let mut schedule = Schedule::default();
        schedule.replace(vec![reminder("a:morning", NOW + HOUR)], NOW);
        assert!(schedule.take_due(NOW).is_empty());
        assert_eq!(schedule.next_at(), Some(NOW + HOUR));
        assert_eq!(keys(&schedule.take_due(NOW + HOUR)), ["a:morning"]);
        assert!(schedule.take_due(NOW + HOUR + MIN).is_empty());
        assert_eq!(schedule.next_at(), None);
    }

    #[test]
    fn the_server_listing_one_a_moment_after_it_was_shown_does_not_show_it_again() {
        let mut schedule = Schedule::default();
        schedule.replace(vec![reminder("a:morning", NOW)], NOW - MIN);
        assert_eq!(schedule.take_due(NOW).len(), 1);
        // The server's clock is behind this computer's: it still lists it.
        schedule.replace(vec![reminder("a:morning", NOW)], NOW + 1_000);
        assert!(schedule.take_due(NOW + 2_000).is_empty());
    }

    #[test]
    fn one_gone_from_the_list_at_its_time_is_still_shown() {
        // The server sent it (and took it away) before this computer's clock got there.
        let mut schedule = Schedule::default();
        schedule.replace(vec![reminder("a:atTime", NOW)], NOW - HOUR);
        schedule.replace(vec![], NOW - 2_000);
        assert_eq!(keys(&schedule.take_due(NOW)), ["a:atTime"]);
    }

    #[test]
    fn one_gone_from_the_list_well_ahead_of_its_time_is_not_shown() {
        // Done, or its due changed.
        let mut schedule = Schedule::default();
        schedule.replace(vec![reminder("a:atTime", NOW + HOUR)], NOW);
        schedule.replace(vec![], NOW + MIN);
        assert!(schedule.take_due(NOW + 2 * HOUR).is_empty());
    }

    #[test]
    fn one_moved_comes_at_its_new_time() {
        let mut schedule = Schedule::default();
        schedule.replace(vec![reminder("a:hourBefore", NOW + HOUR)], NOW);
        schedule.replace(vec![reminder("a:hourBefore", NOW + 3 * HOUR)], NOW + MIN);
        assert!(schedule.take_due(NOW + 2 * HOUR).is_empty());
        assert_eq!(keys(&schedule.take_due(NOW + 3 * HOUR)), ["a:hourBefore"]);
    }

    #[test]
    fn one_shown_and_then_moved_later_comes_again() {
        let mut schedule = Schedule::default();
        schedule.replace(vec![reminder("a:atTime", NOW)], NOW - MIN);
        assert_eq!(schedule.take_due(NOW).len(), 1);
        schedule.replace(vec![reminder("a:atTime", NOW + HOUR)], NOW + MIN);
        assert_eq!(keys(&schedule.take_due(NOW + HOUR)), ["a:atTime"]);
    }

    #[test]
    fn waking_after_several_of_an_item_tells_of_the_latest_alone() {
        let mut schedule = Schedule::default();
        schedule.replace(
            vec![
                reminder("a:eve", NOW),
                reminder("a:morning", NOW + 12 * HOUR),
                reminder("b:morning", NOW + 12 * HOUR),
                reminder("a:hourBefore", NOW + 13 * HOUR),
                reminder("a:atTime", NOW + 14 * HOUR),
            ],
            NOW - MIN,
        );
        // Asleep from before the evening's until after the hour before.
        let shown = schedule.take_due(NOW + 13 * HOUR + MIN);
        assert_eq!(keys(&shown), ["b:morning", "a:hourBefore"]);
        assert_eq!(keys(&schedule.take_due(NOW + 14 * HOUR)), ["a:atTime"]);
    }

    #[test]
    fn one_too_late_is_let_go() {
        let mut schedule = Schedule::default();
        schedule.replace(vec![reminder("a:morning", NOW)], NOW - MIN);
        assert!(schedule.take_due(NOW + LATE_MS + MIN).is_empty());
        assert_eq!(schedule.next_at(), None);
    }

    #[test]
    fn cleared_none_come() {
        let mut schedule = Schedule::default();
        schedule.replace(vec![reminder("a:morning", NOW + MIN)], NOW);
        schedule.clear();
        assert!(schedule.take_due(NOW + HOUR).is_empty());
    }

    #[test]
    fn what_is_kept_is_bounded() {
        let mut schedule = Schedule::default();
        let many = (0..MAX as i64 + 20)
            .map(|i| Reminder {
                title: "あ".repeat(500),
                ..reminder(&format!("i{i}:atTime"), NOW + HOUR + i)
            })
            .collect();
        schedule.replace(many, NOW);
        assert_eq!(schedule.list.len(), MAX);
        assert_eq!(schedule.list[0].title.chars().count(), MAX_TITLE);
        assert_eq!(schedule.next_at(), Some(NOW + HOUR));
    }

    #[test]
    fn the_bell_is_told_why_none_would_come() {
        assert_eq!(state(true, Permission::Allowed), "on");
        assert_eq!(state(false, Permission::Allowed), "off");
        assert_eq!(state(true, Permission::Denied), "blocked");
        assert_eq!(state(true, Permission::NotAsked), "blocked");
        assert_eq!(state(true, Permission::Unsupported), "unsupported");
        assert_eq!(state(false, Permission::Unsupported), "unsupported");
    }
}
