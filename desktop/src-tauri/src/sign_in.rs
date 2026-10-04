//! Signing the window in (src/lib/auth/handoff.ts). Google turns away a
//! sign-in inside an app's own window, so it is done in the browser:
//!
//! 1. begin_sign_in makes a state, and a secret of this app's alone (the
//!    verifier), and opens the browser at /desktop/sign-in with the state
//!    and the verifier's hash (the challenge). The page in the window shows
//!    a few letters made from the challenge, which the browser shows too.
//! 2. The browser signs in, and hands back a code made for that challenge,
//!    by memoca://auth?code=&state= (on_link), or pasted into the window
//!    (complete_sign_in).
//! 3. For the sign-in it started, and within ten minutes, the app sends the
//!    window to /desktop/complete, and hands that page the code with the
//!    verifier (take_sign_in), which Memoca takes for a session of the
//!    window's own. Neither is in any address, and a code is good only with
//!    the verifier, which never leaves the app but for that page.
//!
//! The quick note's window and Memoca's own (app_window.rs) are one sign-in:
//! the code is taken in the one that started it, and the other is loaded
//! again once that one has moved on from taking it.

use crate::{app_window, window};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// How long a sign-in started waits for its code.
const WAIT: Duration = Duration::from_secs(10 * 60);

/// How long a code waits for the page the window was sent to.
const HANDING: Duration = Duration::from_secs(60);

struct Started {
    state: String,
    verifier: String,
    /// The window it was started in: the one to take the code.
    window: String,
    at: Instant,
}

/// The sign-in started, if any: one at a time, the latest.
#[derive(Default)]
pub struct Pending(Mutex<Option<Started>>);

impl Pending {
    fn start(&self, state: String, verifier: String, window: String) {
        *self.0.lock().unwrap() = Some(Started {
            state,
            verifier,
            window,
            at: Instant::now(),
        });
    }

    /// The verifier of the sign-in started, for a link back from the
    /// browser: if the link is that sign-in's, and not too late. It is taken
    /// with it: the link is that sign-in's end.
    fn take_for(&self, state: &str) -> Option<(String, String)> {
        let mut pending = self.0.lock().unwrap();
        let fresh = pending.as_ref().is_some_and(|started| {
            started.at.elapsed() < WAIT && same(state.as_bytes(), started.state.as_bytes())
        });
        if fresh {
            pending
                .take()
                .map(|started| (started.verifier, started.window))
        } else {
            None
        }
    }

    /// The verifier of the sign-in started, not too late, for a code pasted
    /// in. It stays: a code mistyped, or from an older page, is turned away
    /// by Memoca, and the right one can be pasted after it.
    fn verifier(&self) -> Option<String> {
        let pending = self.0.lock().unwrap();
        pending
            .as_ref()
            .filter(|started| started.at.elapsed() < WAIT)
            .map(|started| started.verifier.clone())
    }
}

/// The window sent to take a code, until it moves on from that page.
#[derive(Default)]
pub struct Taking(Mutex<Option<String>>);

/// A window moving to `url`: one moving on from taking a code (signed in,
/// or to try again), and the other window is loaded again, signed in with
/// it. Any other move is let be.
pub fn on_navigation(app: &AppHandle, window: &str, url: &Url) {
    if url.path() == "/desktop/complete" {
        return;
    }
    let taking = app.state::<Taking>();
    {
        let mut taking = taking.0.lock().unwrap();
        if taking.as_deref() != Some(window) {
            return;
        }
        *taking = None;
    }
    // After this move is let go on with.
    let (app, from_app) = (app.clone(), app_window::is_label(window));
    tauri::async_runtime::spawn(async move {
        if from_app {
            window::reload(&app);
        } else {
            app_window::go(&app, window::origin().join("/app").unwrap());
        }
    });
}

/// What /desktop/complete takes: the code, and the verifier it goes with.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Handoff {
    code: String,
    verifier: String,
}

/// The code the window was just sent to take, if any: handed over once.
#[derive(Default)]
pub struct Ready(Mutex<Option<(Handoff, Instant)>>);

impl Ready {
    fn put(&self, handoff: Handoff) {
        *self.0.lock().unwrap() = Some((handoff, Instant::now()));
    }

    fn take(&self) -> Option<Handoff> {
        self.0
            .lock()
            .unwrap()
            .take()
            .filter(|(_, at)| at.elapsed() < HANDING)
            .map(|(handoff, _)| handoff)
    }
}

/// Compares two secrets in the same time however much of them is alike.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |left, (x, y)| left | (x ^ y)) == 0
}

/// 32 random bytes, as base64url: a state, or a verifier.
fn random() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("no random numbers from the system");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The challenge for a verifier: its SHA-256, as base64url (RFC 7636, S256).
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The few letters both the window and the browser show for a sign-in: the
/// first eight hex digits of the challenge's SHA-256, as 1A2B-3C4D
/// (handoffCheck in src/lib/auth/handoff.ts makes them the same way).
fn check_text(challenge: &str) -> String {
    let hash = Sha256::digest(challenge.as_bytes());
    let hex: String = hash[..4].iter().map(|byte| format!("{byte:02X}")).collect();
    format!("{}-{}", &hex[..4], &hex[4..])
}

/// Where the browser signs in for this app.
fn sign_in_url(origin: &Url, state: &str, challenge: &str) -> Url {
    let mut url = origin.join("/desktop/sign-in").unwrap();
    url.query_pairs_mut()
        .append_pair("state", state)
        .append_pair("challenge", challenge);
    url
}

/// Whether a text is a code as Memoca makes them: 32 letters and digits.
fn is_code(code: &str) -> bool {
    code.len() == 32 && code.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// The code and the state in memoca://auth?code=&state=, when it is one.
fn parse_link(url: &Url) -> Option<(String, String)> {
    if url.scheme() != "memoca" || url.host_str() != Some("auth") {
        return None;
    }
    let find = |key: &str| {
        url.query_pairs()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
    };
    let (code, state) = (find("code")?, find("state")?);
    is_code(&code).then_some((code, state))
}

/// Starts signing in, in the browser: the few letters the browser will show for it.
#[tauri::command]
pub fn begin_sign_in(
    app: AppHandle,
    window: WebviewWindow,
    pending: State<'_, Pending>,
) -> Result<String, String> {
    let state = random();
    let verifier = random();
    let challenge = challenge(&verifier);
    let url = sign_in_url(&window::origin(), &state, &challenge);
    pending.start(state, verifier, window.label().into());
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(check_text(&challenge))
}

/// A code pasted into the window: taken for the sign-in started, if any.
#[tauri::command]
pub fn complete_sign_in(app: AppHandle, window: WebviewWindow, code: String) -> &'static str {
    let code = code.trim();
    if !is_code(code) {
        return "not-started";
    }
    match app.state::<Pending>().verifier() {
        Some(verifier) => {
            complete(&app, code, verifier, window.label());
            "ok"
        }
        None => "not-started",
    }
}

/// What /desktop/complete takes, once, just after the window is sent there.
#[tauri::command]
pub fn take_sign_in(ready: State<'_, Ready>) -> Option<Handoff> {
    ready.take()
}

/// memoca://auth?code=&state=, from the browser: taken for the sign-in
/// started, if it is that one's. One for another (an older page's) brings
/// the window out, to start again; any other link is let go.
pub fn on_link(app: &AppHandle, url: &Url) {
    let Some((code, state)) = parse_link(url) else {
        return;
    };
    match app.state::<Pending>().take_for(&state) {
        Some((verifier, window)) => complete(app, &code, verifier, &window),
        None => window::show(app, window::Place::Cursor),
    }
}

/// Sends the window the sign-in was started in to take the code (the quick
/// note's, if Memoca's own has closed since), and keeps it, with the
/// verifier, for that page to be handed. Taken in Memoca's own, the page
/// goes on to the notes (`to=app`), rather than to the quick note.
fn complete(app: &AppHandle, code: &str, verifier: String, started_in: &str) {
    app.state::<Ready>().put(Handoff {
        code: code.into(),
        verifier,
    });
    let page = window::origin().join("/desktop/complete").unwrap();
    if app_window::is_label(started_in) && app_window::is_shown(app) {
        *app.state::<Taking>().0.lock().unwrap() = Some(started_in.into());
        app_window::open_at(
            app,
            window::origin().join("/desktop/complete?to=app").unwrap(),
        );
    } else {
        *app.state::<Taking>().0.lock().unwrap() = Some(window::LABEL.into());
        window::go(app, page);
        window::show(app, window::Place::Cursor);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_the_verifiers_sha256_as_rfc_7636_writes_it() {
        // RFC 7636, appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn the_letters_shown_are_the_first_of_the_challenges_sha256() {
        // SHA-256("abc") = ba7816bf…, as tests/handoff.test.ts has it too.
        assert_eq!(check_text("abc"), "BA78-16BF");
    }

    #[test]
    fn a_state_and_a_verifier_are_32_random_bytes_as_base64url() {
        let (a, b) = (random(), random());
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert!(a
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
    }

    #[test]
    fn the_browser_is_given_the_state_and_the_challenge_and_never_the_verifier() {
        let url = sign_in_url(
            &Url::parse("https://memoca-app.vercel.app").unwrap(),
            "the-state",
            "the-challenge",
        );
        assert_eq!(
            url.as_str(),
            "https://memoca-app.vercel.app/desktop/sign-in?state=the-state&challenge=the-challenge"
        );
    }

    #[test]
    fn a_code_is_32_letters_and_digits() {
        assert!(is_code(&("Ab3".repeat(10) + "Zz")));
        assert!(!is_code("short"));
        assert!(!is_code(&"a".repeat(31)));
        assert!(!is_code(&format!("{}-", "a".repeat(31))));
    }

    #[test]
    fn a_link_back_is_memoca_auth_with_a_code_and_a_state() {
        let code = "A".repeat(32);
        let link = |text: &str| parse_link(&Url::parse(text).unwrap());
        assert_eq!(
            link(&format!("memoca://auth?code={code}&state=s1")),
            Some((code.clone(), "s1".into()))
        );
        assert_eq!(link(&format!("memoca://other?code={code}&state=s1")), None);
        assert_eq!(link(&format!("https://auth?code={code}&state=s1")), None);
        assert_eq!(link(&format!("memoca://auth?code={code}")), None);
        assert_eq!(link("memoca://auth?code=short&state=s1"), None);
    }

    fn started(state: &str, ago: Duration) -> Pending {
        Pending(Mutex::new(Some(Started {
            state: state.into(),
            verifier: "the-verifier".into(),
            window: "quick".into(),
            at: Instant::now() - ago,
        })))
    }

    #[test]
    fn a_link_back_ends_the_sign_in_it_is_for_and_no_other() {
        let pending = started("mine", Duration::ZERO);
        assert_eq!(pending.take_for("another"), None);
        assert_eq!(
            pending.take_for("mine"),
            Some(("the-verifier".into(), "quick".into()))
        );
        assert_eq!(pending.take_for("mine"), None);
        assert_eq!(started("mine", WAIT).take_for("mine"), None);
    }

    #[test]
    fn a_code_pasted_is_for_the_sign_in_started_which_stays_for_another_try() {
        let pending = started("mine", Duration::ZERO);
        assert_eq!(pending.verifier().as_deref(), Some("the-verifier"));
        assert_eq!(pending.verifier().as_deref(), Some("the-verifier"));
        assert_eq!(started("mine", WAIT).verifier(), None);
        assert_eq!(Pending::default().verifier(), None);
    }

    #[test]
    fn the_page_is_handed_the_code_once_and_only_just_after() {
        let handoff = Handoff {
            code: "c".into(),
            verifier: "v".into(),
        };
        let ready = Ready::default();
        assert_eq!(ready.take(), None);
        ready.put(handoff.clone());
        assert_eq!(ready.take(), Some(handoff.clone()));
        assert_eq!(ready.take(), None);
        *ready.0.lock().unwrap() = Some((handoff, Instant::now() - HANDING));
        assert_eq!(ready.take(), None);
    }
}
