"use client";

import { uuidv4 } from "uuidv7";
import * as Y from "yjs";
import { bodyFragment } from "@/lib/sync/ydoc";

/** BlockNote's default props for a paragraph, which it writes out every time. */
const PARAGRAPH_PROPS = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
} as const;

/**
 * BlockNote's props for an image, all but its url and name, as it writes
 * them out: no width set (null) shows it at its own, within the note's.
 */
const IMAGE_PROPS = {
  textAlignment: "left",
  backgroundColor: "default",
  caption: "",
  showPreview: true,
  previewWidth: null,
} as const;

/**
 * What an image of a quick note is put in its body by, until it is saved:
 * the draft's image of that key (lib/quick/draft), there being no note yet
 * for it to go up into. Saved, the note has the image's own `memoca://`
 * reference in its place (see copyQuickBody).
 */
const QUICK_IMAGE = "memoca-quick://image/";

/** An image of the draft's, as its block in the quick note's body refers to it. */
export const quickImageRef = (key: string) => `${QUICK_IMAGE}${encodeURIComponent(key)}`;

/** The draft's image a block refers to, if it refers to one. */
export function quickImageKey(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(QUICK_IMAGE)) return null;
  try {
    return decodeURIComponent(url.slice(QUICK_IMAGE.length)) || null;
  } catch {
    return null;
  }
}

/** Every image block of a body, however far in (in a toggle, under a list's item). */
function imageBlocks(node: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] {
  const found: Y.XmlElement[] = [];
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === "image") found.push(child);
    else found.push(...imageBlocks(child));
  }
  return found;
}

/** The block of this id in a body, however far in, if it is there. */
export function blockOf(doc: Y.Doc, blockId: string): Y.XmlElement | null {
  const find = (node: Y.XmlFragment | Y.XmlElement): Y.XmlElement | null => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "blockContainer" && child.getAttribute("id") === blockId) return child;
      const inner = find(child);
      if (inner) return inner;
    }
    return null;
  };
  return find(bodyFragment(doc));
}

/**
 * Gives the image block of this id the reference it shows its image by, as
 * its image is made ready (its name too, if it has none): whether there was
 * one to give it to (taken out meanwhile, there is not).
 */
export function setImageUrl(doc: Y.Doc, blockId: string, url: string, name: string): boolean {
  const container = blockOf(doc, blockId);
  const block = container?.get(0);
  const image = block instanceof Y.XmlElement && block.nodeName === "image" ? block : null;
  if (!image) return false;
  doc.transact(() => {
    if (image.getAttribute("url") !== url) image.setAttribute("url", url);
    if (!image.getAttribute("name")) image.setAttribute("name", name);
  });
  return true;
}

/**
 * The draft's images a quick note's body shows, in the order it shows them,
 * each once: what the draft keeps, and what a save sends up.
 */
export function referencedImages(doc: Y.Doc): string[] {
  const keys: string[] = [];
  for (const image of imageBlocks(bodyFragment(doc))) {
    const key = quickImageKey(image.getAttribute("url"));
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The references of a body's images, in the order it shows them, each once: what is saved with it. */
export function imageUrls(doc: Y.Doc): string[] {
  const urls: string[] = [];
  for (const image of imageBlocks(bodyFragment(doc))) {
    const url = image.getAttribute("url");
    if (typeof url === "string" && url !== "" && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** What a quick note is written as: a line of text, or an image by its `memoca://` reference. */
export type QuickPart = { kind: "line"; text: string } | { kind: "image"; url: string; name: string };

/**
 * Adds a block for each part at the end of a note's body, shaped exactly as
 * BlockNote writes one: in the body's one block group, a container with an
 * id of its own, and in it the paragraph (or the image) with all its props.
 * The editor then opens on them as they are, rather than on something it
 * has to repair first.
 */
export function appendBlocks(doc: Y.Doc, parts: QuickPart[]): void {
  if (parts.length === 0) return;
  const fragment = bodyFragment(doc);
  // Made before anything is written, so that failing to make one changes
  // nothing. Not with crypto.randomUUID, which only a secure context has: a
  // phone trying the app over plain http on the LAN would fail here.
  const ids = parts.map(() => uuidv4());
  doc.transact(() => {
    let group = fragment
      .toArray()
      .find(
        (node): node is Y.XmlElement =>
          node instanceof Y.XmlElement && node.nodeName === "blockGroup",
      );
    if (!group) {
      group = new Y.XmlElement("blockGroup");
      fragment.insert(fragment.length, [group]);
    }
    for (const [at, part] of parts.entries()) {
      const container = new Y.XmlElement("blockContainer");
      group.insert(group.length, [container]);
      container.setAttribute("id", ids[at]!);
      if (part.kind === "image") {
        const image = new Y.XmlElement("image");
        container.insert(0, [image]);
        const props = { ...IMAGE_PROPS, name: part.name, url: part.url };
        for (const [name, value] of Object.entries(props)) {
          // A boolean and a null, as BlockNote keeps them: Yjs's typings say strings only.
          image.setAttribute(name, value as string);
        }
        continue;
      }
      const paragraph = new Y.XmlElement("paragraph");
      container.insert(0, [paragraph]);
      for (const [name, value] of Object.entries(PARAGRAPH_PROPS)) {
        paragraph.setAttribute(name, value);
      }
      // An empty paragraph has no text in it at all, as BlockNote leaves it.
      if (part.text.length > 0) {
        const text = new Y.XmlText();
        paragraph.insert(0, [text]);
        text.insert(0, part.text);
      }
    }
  });
}

/**
 * What a quick note's body says, to tell whether it has changed since it was
 * saved: its blocks as XML, their kinds, marks and ids with them. A list
 * made of a line changes it, which the plain text would not show.
 */
export function quickKey(doc: Y.Doc): string {
  return bodyFragment(doc).toString();
}

/** Whether a block holds nothing: a paragraph with no text, or only spaces, and no lines inside it. */
function blank(container: Y.XmlElement): boolean {
  const children = container.toArray();
  if (children.length !== 1) return false;
  const content = children[0];
  if (!(content instanceof Y.XmlElement) || content.nodeName !== "paragraph") return false;
  return content
    .toArray()
    .every((part) => part instanceof Y.XmlText && part.toString().trim() === "");
}

/** Gives the draft's image of this key, wherever the body shows it, the reference it went up as. */
export function setQuickImage(doc: Y.Doc, key: string, ref: string): void {
  for (const image of imageBlocks(bodyFragment(doc))) {
    if (quickImageKey(image.getAttribute("url")) === key) image.setAttribute("url", ref);
  }
}

/**
 * Gives each image of a body that is the draft's (see quickImageRef) the
 * reference it went up as, from `refs` by its key: one with none (not
 * sent, or never made ready) goes, its block with it, and a group of a
 * block's own left empty by that (BlockNote has none empty).
 */
export function putImageRefs(node: Y.XmlFragment | Y.XmlElement, refs: ReadonlyMap<string, string>): void {
  for (const image of imageBlocks(node)) {
    const key = quickImageKey(image.getAttribute("url"));
    if (key === null) continue;
    const ref = refs.get(key);
    if (ref) {
      image.setAttribute("url", ref);
      continue;
    }
    let gone: Y.XmlElement | null = image.parent instanceof Y.XmlElement ? image.parent : null;
    while (gone) {
      const parent = gone.parent;
      if (!(parent instanceof Y.XmlElement)) break;
      parent.delete(parent.toArray().indexOf(gone), 1);
      gone = parent.nodeName === "blockGroup" && parent.length === 0 && parent.parent instanceof Y.XmlElement ? parent : null;
    }
  }
}

/**
 * Writes a quick note's body into a note's, the note's emptied first (saved
 * again, it is written over): each of its blocks as it is, lists, toggles,
 * headings, marks and images with them, and blank lines at either end left
 * out (an editor's body always ends in one). Each image the draft's (see
 * quickImageRef) with the reference it went up as, from `refs` by its key:
 * one with none (not sent, or never made ready) goes. Then `extra` after
 * them. All in one change to the note.
 */
export function copyQuickBody(
  from: Y.Doc,
  into: Y.Doc,
  extra: QuickPart[],
  refs: ReadonlyMap<string, string> = new Map(),
): void {
  const source = bodyFragment(from);
  const target = bodyFragment(into);
  into.transact(() => {
    if (target.length > 0) target.delete(0, target.length);
    target.insert(
      0,
      source.toArray().map((node) => (node as Y.XmlElement | Y.XmlText).clone()),
    );
    putImageRefs(target, refs);
    const group = target
      .toArray()
      .find(
        (node): node is Y.XmlElement =>
          node instanceof Y.XmlElement && node.nodeName === "blockGroup",
      );
    if (group) {
      const at = (index: number) => group.get(index) as unknown;
      while (group.length > 0 && at(0) instanceof Y.XmlElement && blank(at(0) as Y.XmlElement)) {
        group.delete(0, 1);
      }
      while (
        group.length > 0 &&
        at(group.length - 1) instanceof Y.XmlElement &&
        blank(at(group.length - 1) as Y.XmlElement)
      ) {
        group.delete(group.length - 1, 1);
      }
    }
    appendBlocks(into, extra);
  });
}

/** Adds a paragraph for each line at the end of a note's body (see {@link appendBlocks}). */
export function appendParagraphs(doc: Y.Doc, lines: string[]): void {
  appendBlocks(
    doc,
    lines.map((text) => ({ kind: "line", text })),
  );
}

/**
 * A paragraph for each line at the start of a body, before what it holds, in
 * its one block group (see {@link appendBlocks}): what was shared, put above
 * a draft.
 */
export function prependParagraphs(doc: Y.Doc, lines: string[]): void {
  const group = bodyFragment(doc)
    .toArray()
    .find(
      (node): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === "blockGroup",
    );
  if (!group) return appendParagraphs(doc, lines);
  const scratch = new Y.Doc();
  appendParagraphs(scratch, lines);
  const made = (bodyFragment(scratch).get(0) as Y.XmlElement | undefined)?.toArray() ?? [];
  if (made.length === 0) return;
  doc.transact(() => {
    group.insert(
      0,
      made.map((node) => (node as Y.XmlElement).clone()),
    );
  });
}

/**
 * The lines of a body in the shape quick notes wrote before they wrote it as
 * BlockNote does: a bare paragraph per line straight in the body, holding
 * nothing but its text. Null for any other body, an empty one included.
 */
function oldQuickLines(fragment: Y.XmlFragment): string[] | null {
  const nodes = fragment.toArray();
  if (nodes.length === 0) return null;
  const lines: string[] = [];
  for (const node of nodes) {
    if (!(node instanceof Y.XmlElement) || node.nodeName !== "paragraph") return null;
    let line = "";
    for (const part of node.toArray()) {
      if (!(part instanceof Y.XmlText)) return null;
      for (const chunk of part.toDelta() as { insert?: unknown }[]) {
        if (typeof chunk.insert === "string") line += chunk.insert;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Rewrites a body in that old shape as BlockNote writes one, line for line,
 * empty lines included. BlockNote cannot open the old shape as it is: it
 * nests each line inside the one before, and saves that at the first
 * keystroke. Any other body is left as it is, so a body rewritten once is
 * never rewritten again.
 */
export function migrateOldQuickBody(doc: Y.Doc): void {
  const fragment = bodyFragment(doc);
  const lines = oldQuickLines(fragment);
  if (!lines) return;
  const old = fragment.length;
  // One transaction, so that the rewrite is a single edit. The new body is
  // written before the old one goes: a rewrite that fails before it has
  // written anything then leaves the body as it was, not emptied.
  doc.transact(() => {
    appendParagraphs(doc, lines);
    fragment.delete(0, old);
  });
}
