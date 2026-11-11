/**
 * The desktop app's hotkeys (desktop/src-tauri/src/shortcut.rs), as its
 * settings.json writes them ("CmdOrCtrl+Shift+M"): made from keys pressed
 * in the settings page, and shown as the computer marks them (⌘⇧M on a
 * Mac, Ctrl+Shift+M on Windows).
 */

export type HotkeyPlatform = "macos" | "windows";

/** The keys pressed, as a keyboard event has them. */
export type PressedKeys = {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^Fn(Lock)?$|^CapsLock$/;

/**
 * The hotkey the keys pressed make, or null for a modifier alone (the key
 * itself still to come). The key by where it is on the keyboard (its
 * `code`), as the app's hotkeys go, whatever the layout or the input
 * method makes of it. ⌘ on a Mac and Ctrl on Windows are written as
 * CmdOrCtrl, as the app's own default is.
 */
export function hotkeyFromEvent(event: PressedKeys, platform: HotkeyPlatform): string | null {
  if (!event.code || MODIFIER_CODES.test(event.code)) return null;
  const key = event.code.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, "");
  const mac = platform === "macos";
  const held = [
    (mac ? event.metaKey : event.ctrlKey) && "CmdOrCtrl",
    mac && event.ctrlKey && "Ctrl",
    !mac && event.metaKey && "Super",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
  ].filter((each): each is string => typeof each === "string");
  return [...held, key].join("+");
}

type Held = "cmd" | "ctrl" | "alt" | "shift";

/** A modifier as written (in any of the ways Tauri takes), or null for the key. */
function heldOf(token: string, platform: HotkeyPlatform): Held | null {
  switch (token.toUpperCase()) {
    case "COMMANDORCONTROL":
    case "COMMANDORCTRL":
    case "CMDORCTRL":
    case "CMDORCONTROL":
      return platform === "macos" ? "cmd" : "ctrl";
    case "COMMAND":
    case "CMD":
    case "SUPER":
      return "cmd";
    case "CONTROL":
    case "CTRL":
      return "ctrl";
    case "OPTION":
    case "ALT":
      return "alt";
    case "SHIFT":
      return "shift";
    default:
      return null;
  }
}

const ARROWS: Record<string, string> = { UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→" };

/** The key as it is marked: M for KeyM, 1 for Digit1, ↑ for ArrowUp. */
function keyShown(token: string): string {
  const upper = token.toUpperCase();
  const letter = /^(?:KEY)?([A-Z])$/.exec(upper);
  if (letter) return letter[1]!;
  const digit = /^(?:DIGIT)?(\d)$/.exec(upper);
  if (digit) return digit[1]!;
  const arrow = /^(?:ARROW)?(UP|DOWN|LEFT|RIGHT)$/.exec(upper);
  if (arrow) return ARROWS[arrow[1]!]!;
  return token;
}

/** The order a Mac shows its modifiers in, and Windows'. */
const MAC_ORDER: Held[] = ["ctrl", "alt", "shift", "cmd"];
const MAC_MARK: Record<Held, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const WINDOWS_ORDER: Held[] = ["ctrl", "alt", "shift", "cmd"];
const WINDOWS_MARK: Record<Held, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Win" };

/** A hotkey as the computer marks it: "⌘⇧M", or "Ctrl+Shift+M". */
export function formatHotkey(keys: string, platform: HotkeyPlatform): string {
  const held = new Set<Held>();
  let key = "";
  for (const token of keys.split("+").map((each) => each.trim())) {
    if (!token) continue;
    const modifier = heldOf(token, platform);
    if (modifier) held.add(modifier);
    else key = keyShown(token);
  }
  if (platform === "macos") {
    return MAC_ORDER.filter((each) => held.has(each)).map((each) => MAC_MARK[each]).join("") + key;
  }
  return [...WINDOWS_ORDER.filter((each) => held.has(each)).map((each) => WINDOWS_MARK[each]), key].join("+");
}

/** Whether two hotkeys are the same keys, however each is written. */
export function sameHotkey(a: string, b: string, platform: HotkeyPlatform): boolean {
  return formatHotkey(a, platform).toUpperCase() === formatHotkey(b, platform).toUpperCase();
}
