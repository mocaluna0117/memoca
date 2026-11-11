/**
 * The app's looks: its colours, light and dark, the roundness of its corners
 * and its letters (globals.css, under [data-style]), chosen in the settings
 * for the account (convex users.settings.style) and kept on the device too,
 * to be put on the page before it is first drawn (STYLE_SCRIPT), signed out
 * and offline as well.
 */

export const STYLES = [
  {
    id: "stylish",
    label: "スタイリッシュ",
    description: "白と黒で、すっきり",
  },
  {
    id: "cute",
    label: "かわいい",
    description: "淡いピンクとラベンダー、丸い文字",
  },
  {
    id: "natural",
    label: "ナチュラル",
    description: "生成りの紙に、セージグリーン",
  },
  {
    id: "fresh",
    label: "さわやか",
    description: "白と水色、青緑",
  },
  {
    id: "retro",
    label: "レトロ",
    description: "クリーム色の紙に、茶色のインク",
  },
] as const;

export type StyleId = (typeof STYLES)[number]["id"];

export const DEFAULT_STYLE: StyleId = "stylish";

/** Where the device keeps the look it shows. */
export const STYLE_KEY = "memoca:style";
/**
 * A look chosen on this device that the account has not been told of yet
 * (chosen offline, say): sent again, and the account's not taken over it,
 * until it has.
 */
export const STYLE_SENT_KEY = "memoca:style-sent";

export function isStyle(value: unknown): value is StyleId {
  return typeof value === "string" && STYLES.some((style) => style.id === value);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage refused: the look holds for this page only.
  }
}

/** The look this device shows. */
export const styleHere = (): StyleId => {
  const kept = read(STYLE_KEY);
  return isStyle(kept) ? kept : DEFAULT_STYLE;
};

/** A look chosen here, not yet heard of by the account. */
export const styleUnsent = (): StyleId | null => {
  const sent = read(STYLE_SENT_KEY);
  return isStyle(sent) ? sent : null;
};

export function markStyleUnsent(style: StyleId | null): void {
  write(STYLE_SENT_KEY, style);
}

/** Said in the page as the look changes, for what shows it (the settings' choice). */
export const STYLE_CHANGED = "memoca:style-changed";

/**
 * Puts a look on the page, and keeps it on the device: its attribute on
 * <html> (none for the first, whose colours are the page's own), and the
 * browser's bar coloured as the page is.
 */
export function applyStyle(style: StyleId): void {
  const root = document.documentElement;
  if (style === DEFAULT_STYLE) delete root.dataset.style;
  else root.dataset.style = style;
  write(STYLE_KEY, style);
  paintBar();
  window.dispatchEvent(new Event(STYLE_CHANGED));
}

/** The browser's bar (a phone's, an installed app's title bar) in the page's background. */
export function paintBar(): void {
  const background = getComputedStyle(document.body).backgroundColor;
  if (!background) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = background;
  }
}

/**
 * Run in <head>, before the page is drawn: the look the device keeps, so a
 * page never shows the first look and then another.
 */
export const STYLE_SCRIPT = `try{var s=localStorage.getItem(${JSON.stringify(STYLE_KEY)});if(s&&s!==${JSON.stringify(
  DEFAULT_STYLE,
)}&&${JSON.stringify(STYLES.map((style) => style.id))}.indexOf(s)>=0)document.documentElement.dataset.style=s}catch(e){}`;
