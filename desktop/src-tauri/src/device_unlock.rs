//! Opening the vault with the computer's own fingerprint or face check, in
//! place of its password (src/lib/vault/device-unlock.ts): a secret of this
//! computer's, handed to the page once the person has proved themselves,
//! which the page turns into a key for a copy of the vault key it keeps on
//! this device alone. Not a passkey: the app is not signed by Apple, so a
//! passkey in its window cannot be had (docs/DESKTOP.md).
//!
//! - Mac: Touch ID (or the Mac's password, if Touch ID will not do), asked by
//!   the app through LocalAuthentication; the secret is 32 random bytes kept
//!   in the login keychain. The check is the app's own: anything running as
//!   the person could read the keychain item without it, as it could read
//!   what else the person keeps there.
//! - Windows: a Windows Hello key of the app's (in the TPM where there is
//!   one), whose signature over a fixed text is the secret: none without
//!   Windows Hello's own check, and nothing kept beside it.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// How the computer checks the person, as the page names it.
#[tauri::command]
pub async fn device_unlock_kind() -> Option<&'static str> {
    tauri::async_runtime::spawn_blocking(platform::kind)
        .await
        .ok()
        .flatten()
}

/// The computer's secret, once the person has proved themselves: made the
/// first time (`create`), and the same ever after. An error the page shows
/// as the unlock not going through ("cancelled" when the person said no).
#[tauri::command]
pub async fn device_unlock_secret(create: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || platform::secret(create))
        .await
        .map_err(|error| error.to_string())?
        .map(|secret| STANDARD.encode(secret))
}

#[cfg(target_os = "macos")]
mod platform {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use security_framework::passwords::{get_generic_password, set_generic_password};
    use std::sync::mpsc;

    const SERVICE: &str = "io.github.mocaluna0117.memoca.vault-unlock";
    const ACCOUNT: &str = "secret";
    /// LAErrorUserCancel, LAErrorAppCancel, LAErrorSystemCancel.
    const CANCELLED: [isize; 3] = [-2, -9, -4];

    pub fn kind() -> Option<&'static str> {
        let context = unsafe { LAContext::new() };
        unsafe {
            context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
        }
        .ok()
        .map(|_| "touchId")
    }

    /// Touch ID, or the Mac's password if Touch ID will not do.
    fn prove() -> Result<(), String> {
        let context = unsafe { LAContext::new() };
        let (tx, rx) = mpsc::channel();
        let reply = RcBlock::new(move |ok: Bool, error: *mut NSError| {
            let outcome = if ok.as_bool() {
                Ok(())
            } else {
                // SAFETY: the error LocalAuthentication hands over, if any, for this call.
                let code = unsafe { error.as_ref() }.map(|error| error.code());
                Err(match code {
                    Some(code) if CANCELLED.contains(&code) => "cancelled".to_string(),
                    Some(code) => format!("touch-id-failed ({code})"),
                    None => "touch-id-failed".to_string(),
                })
            };
            let _ = tx.send(outcome);
        });
        let reason = NSString::from_str("金庫を開く");
        unsafe {
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &reason,
                &reply,
            )
        };
        rx.recv().map_err(|error| error.to_string())?
    }

    pub fn secret(create: bool) -> Result<Vec<u8>, String> {
        prove()?;
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(secret) if secret.len() == 32 => Ok(secret),
            _ if create => {
                let mut secret = vec![0u8; 32];
                getrandom::fill(&mut secret).map_err(|error| error.to_string())?;
                set_generic_password(SERVICE, ACCOUNT, &secret)
                    .map_err(|error| error.to_string())?;
                Ok(secret)
            }
            _ => Err("no-secret".into()),
        }
    }
}

#[cfg(windows)]
mod platform {
    use sha2::{Digest, Sha256};
    use windows::core::HSTRING;
    use windows::Security::Credentials::{
        KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::{BinaryStringEncoding, CryptographicBuffer};

    const NAME: &str = "Memoca vault unlock";
    /// What the key signs: always this, so its signature is always the same.
    const CHALLENGE: &str = "memoca-vault-unlock-v1";

    pub fn kind() -> Option<&'static str> {
        KeyCredentialManager::IsSupportedAsync()
            .and_then(|asked| asked.get())
            .ok()
            .filter(|supported| *supported)
            .map(|_| "windowsHello")
    }

    fn status(status: KeyCredentialStatus) -> String {
        if status == KeyCredentialStatus::UserCanceled {
            "cancelled".into()
        } else {
            format!("windows-hello-failed ({})", status.0)
        }
    }

    fn key(create: bool) -> Result<KeyCredential, String> {
        let name = HSTRING::from(NAME);
        let found = KeyCredentialManager::OpenAsync(&name)
            .and_then(|asked| asked.get())
            .map_err(|error| error.to_string())?;
        let found_status = found.Status().map_err(|error| error.to_string())?;
        if found_status == KeyCredentialStatus::Success {
            return found.Credential().map_err(|error| error.to_string());
        }
        if !create || found_status != KeyCredentialStatus::NotFound {
            return Err(if create {
                status(found_status)
            } else {
                "no-secret".into()
            });
        }
        let made = KeyCredentialManager::RequestCreateAsync(
            &name,
            KeyCredentialCreationOption::FailIfExists,
        )
        .and_then(|asked| asked.get())
        .map_err(|error| error.to_string())?;
        let made_status = made.Status().map_err(|error| error.to_string())?;
        if made_status != KeyCredentialStatus::Success {
            return Err(status(made_status));
        }
        made.Credential().map_err(|error| error.to_string())
    }

    pub fn secret(create: bool) -> Result<Vec<u8>, String> {
        let key = key(create)?;
        let challenge = CryptographicBuffer::ConvertStringToBinary(
            &HSTRING::from(CHALLENGE),
            BinaryStringEncoding::Utf8,
        )
        .map_err(|error| error.to_string())?;
        // Windows Hello asks here: the key signs only for the person.
        let signed = key
            .RequestSignAsync(&challenge)
            .and_then(|asked| asked.get())
            .map_err(|error| error.to_string())?;
        let signed_status = signed.Status().map_err(|error| error.to_string())?;
        if signed_status != KeyCredentialStatus::Success {
            return Err(status(signed_status));
        }
        let buffer = signed.Result().map_err(|error| error.to_string())?;
        let mut bytes = windows::core::Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(&buffer, &mut bytes)
            .map_err(|error| error.to_string())?;
        // RSA with PKCS #1 v1.5, as Windows Hello signs: the same signature
        // each time, hashed down to the secret.
        Ok(Sha256::digest(&*bytes).to_vec())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn kind() -> Option<&'static str> {
        None
    }

    pub fn secret(_create: bool) -> Result<Vec<u8>, String> {
        Err("unsupported".into())
    }
}
