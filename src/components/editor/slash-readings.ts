/**
 * How each of the / menu's items is read, in hiragana, with a few other
 * names it goes by: for the menu to narrow as it is typed with the input
 * method still on. BlockNote's Japanese names are in kanji and katakana
 * alone (見出し, 箇条書き, 画像): /みだし, as it stands before it is turned
 * into 見出し (and, typed fast, when it is never turned), found nothing.
 * By the item's key, or by its title where it has none (the columns').
 */
const READINGS: Record<string, readonly string[]> = {
  heading: ["みだし"],
  heading_2: ["みだし"],
  heading_3: ["みだし"],
  heading_4: ["みだし"],
  heading_5: ["みだし"],
  heading_6: ["みだし"],
  toggle_heading: ["おりたたみ", "とぐる", "みだし"],
  toggle_heading_2: ["おりたたみ", "とぐる", "みだし"],
  toggle_heading_3: ["おりたたみ", "とぐる", "みだし"],
  quote: ["いんよう"],
  numbered_list: ["ばんごう", "りすと"],
  bullet_list: ["かじょうがき", "りすと"],
  check_list: ["ちぇっく", "りすと", "todo", "やること"],
  toggle_list: ["おりたたみ", "とぐる", "りすと"],
  paragraph: ["ひょうじゅん", "てきすと"],
  code_block: ["こーど"],
  page_break: ["かいぺーじ", "くぎり"],
  table: ["ひょう", "てーぶる"],
  image: ["がぞう", "写真", "しゃしん"],
  video: ["びでお", "動画", "どうが"],
  audio: ["おーでぃお", "音声", "おんせい"],
  file: ["ふぁいる"],
  emoji: ["えもじ"],
  divider: ["くぎり", "区切り線", "線", "せん"],
  二列: ["にれつ", "列", "れつ", "からむ", "カラム"],
  三列: ["さんれつ", "列", "れつ", "からむ", "カラム"],
};

/** The items, each with its readings among its other names. */
export function withReadings<T extends { title: string; key?: string; aliases?: readonly string[] }>(
  items: T[],
): T[] {
  return items.map((item) => {
    const readings = READINGS[item.key ?? ""] ?? READINGS[item.title];
    return readings ? { ...item, aliases: [...(item.aliases ?? []), ...readings] } : item;
  });
}
