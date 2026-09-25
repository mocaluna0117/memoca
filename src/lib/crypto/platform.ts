/**
 * What this device calls the check behind a passkey, for button and message
 * copy. A web page cannot tell Face ID from Touch ID, so Apple phones and
 * tablets get both names; everything unknown is plainly a passkey.
 */
export function unlockMethodName(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  touchPoints: number = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "Face ID / Touch ID";
  // iPadOS reports itself as a Mac; only the touch screen gives it away.
  if (/Macintosh/.test(userAgent)) return touchPoints > 1 ? "Face ID / Touch ID" : "Touch ID";
  if (/Android/.test(userAgent)) return "指紋・顔認証";
  if (/Windows/.test(userAgent)) return "Windows Hello";
  return "パスキー";
}

/**
 * Joins a method name and the words after it the way Japanese is set: no
 * space after Japanese text, one after a Latin name such as "Touch ID".
 */
export function withMethod(method: string, rest: string): string {
  return /[A-Za-z0-9]$/.test(method) ? `${method} ${rest}` : `${method}${rest}`;
}

/**
 * A name for this device in the passkey list, so entries from different
 * devices can be told apart.
 */
export function deviceLabel(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  touchPoints: number = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /CriOS|Chrome\//.test(userAgent)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const device = /iPhone|iPod/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)
      ? "iPad"
      : /Macintosh/.test(userAgent)
        ? "Mac"
        : /Android/.test(userAgent)
          ? "Android"
          : /Windows/.test(userAgent)
            ? "Windows"
            : null;
  if (!device) return "不明な端末";
  return browser ? `${device}（${browser}）` : device;
}
