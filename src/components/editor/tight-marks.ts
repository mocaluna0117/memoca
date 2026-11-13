import { createStyleSpecFromTipTapMark, defaultStyleSpecs } from "@blocknote/core";

/** A typing or pasting rule of tiptap's, as far as it is touched here. */
interface Rule {
  handler: (props: { match: RegExpMatchArray }) => unknown;
}

/** A tiptap mark, as far as it is touched here. */
interface RuledMark {
  name: string;
  extend(config: {
    addInputRules(this: { parent?: () => Rule[] }): Rule[];
    addPasteRules(this: { parent?: () => Rule[] }): Rule[];
  }): RuledMark;
}

/**
 * Whether what a rule found between its signs begins or ends with a space:
 * the " 3 " of 2 * 3 * 4, the ".txt " of ls *.txt *.md. The text between
 * is the last group of each of tiptap's rules for these marks.
 */
export function looseMatch(match: ArrayLike<string | undefined>): boolean {
  const inner = match[match.length - 1];
  return typeof inner === "string" && (/^\s/.test(inner) || /\s$/.test(inner));
}

/** The rules, each doing nothing for a loose match (null: tiptap goes on as if it had not matched). */
const tightened = (rules: Rule[] | undefined): Rule[] =>
  (rules ?? []).map((rule) => {
    const handler = rule.handler;
    rule.handler = (props) => (looseMatch(props.match) ? null : handler(props));
    return rule;
  });

function tight<Spec extends { implementation: { mark: unknown } }>(spec: Spec): Spec {
  const mark = spec.implementation.mark as RuledMark;
  const made = mark.extend({
    addInputRules() {
      return tightened(this.parent?.());
    },
    addPasteRules() {
      return tightened(this.parent?.());
    },
  });
  return createStyleSpecFromTipTapMark(made as never, "boolean") as unknown as Spec;
}

/**
 * BlockNote's bold, italic and strike, with their typed (and pasted)
 * notations, **太字**, *斜体*, _斜体_ and ~~消す~~, taken as Markdown takes
 * them: only with text right inside the signs. tiptap's own rules take
 * anything between two of a sign, spaces and all: 2 * 3 * 4 lost both its
 * asterisks and had " 3 " in italics as the second was typed, and so
 * ls *.txt *.md, SELECT * FROM a; SELECT * FROM b, a _ b _ c, pasted or
 * typed.
 */
export const tightStyleSpecs = {
  bold: tight(defaultStyleSpecs.bold),
  italic: tight(defaultStyleSpecs.italic),
  strike: tight(defaultStyleSpecs.strike),
};
