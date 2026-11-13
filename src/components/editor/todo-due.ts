import { type ExtensionOptions, createExtension } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type * as Y from "yjs";
import {
  BUCKETS,
  BUCKET_LABEL,
  type Bucket,
  TODO_DUE,
  bucketOf,
  dueOf,
  formatDue,
  readDue,
} from "@/lib/quick/todo-due";

/** Asked for an item's due to be picked: its block id, and where its button is on screen. */
export type OnPick = (id: string, at: DOMRect) => void;

/** What the Todo's dues are, the time they are read at (for 今日 and 期限切れ), and who picks one. */
type DueState = { dues: ReadonlyMap<string, string>; now: number; onPick: OnPick };

export const todoDueKey = new PluginKey<DueState>("memocaTodoDue");

/**
 * A meta asking the Todo to put its items in order of their dues: as a due
 * is set (once its picker is put away, not while it is open beside the
 * item), not as anything is typed.
 */
export const TODO_SORT = "memocaTodoSort";

/**
 * The list put in order of its dues, as they are in `map` now (told with
 * it: the map's own telling comes a moment after its change).
 */
export function sortTodo(view: EditorView, map: Y.Map<string>): void {
  const dues = new Map(Object.entries(map.toJSON() as Record<string, string>));
  view.dispatch(view.state.tr.setMeta(todoDueKey, { dues }).setMeta(TODO_SORT, true));
}

/** Each item's due by its block id, as the Todo's editor has them now: none without the plugin. */
export const duesIn = (state: EditorState): ReadonlyMap<string, string> | undefined =>
  todoDueKey.getState(state)?.dues;

/**
 * Enter pressed in an item (todo-only), as the list was then: the new item
 * it makes beside it is given its day (see madeBeside). Kept a moment, for
 * the change Enter makes, however it makes it (BlockNote's split, or the
 * Todo's own Enter in an item with details or at an item's start).
 */
const entered = new WeakMap<EditorView, { id: string; doc: Node; at: number }>();
const ENTERED_FOR_MS = 1000;

/** Enter pressed in the item of this block id. */
export function enteredIn(view: EditorView, id: string): void {
  entered.set(view, { id, doc: view.state.doc, at: Date.now() });
}

/** The time a new item is given, on the day of the item it was made from: the end of that day. */
export const MADE_AT_TIME = "23:59";

/** The list's items, as its blocks are, in order. */
function itemsOf(doc: Node): { id: string; node: Node }[] {
  const found: { id: string; node: Node }[] = [];
  doc.firstChild?.forEach((node) => {
    const id = node.attrs.id as string | undefined;
    if (id) found.push({ id, node });
  });
  return found;
}

/**
 * The item Enter made beside the item it was pressed in (after it, or, at
 * its start, above it), not there before: its id, or null where there is
 * no one such (the item gone, or Enter made none).
 */
export function madeBeside(before: Node, now: Node, from: string): string | null {
  const was = new Set(itemsOf(before).map((item) => item.id));
  const list = itemsOf(now);
  const at = list.findIndex((item) => item.id === from);
  if (at < 0) return null;
  const made = [list[at - 1], list[at + 1]].filter(
    (item): item is { id: string; node: Node } => item !== undefined && !was.has(item.id) && !isChecked(item.node),
  );
  return made.length === 1 ? made[0]!.id : null;
}

/** How often the headings are read again, while the Todo is on screen: 今日 becomes 期限切れ. */
const EVERY_MS = 60_000;

const CALENDAR =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';

const isChecked = (container: Node) =>
  container.firstChild?.type.name === "checkListItem" && container.firstChild.attrs.checked === true;

/** The button at an item's right: its due, to change, or (none yet) a calendar, to give it one. */
function dueButton(id: string, label: string, kind: Bucket | "done" | "add", onPick: OnPick) {
  return () => {
    const button = document.createElement("button");
    button.type = "button";
    button.contentEditable = "false";
    button.className = `todo-due todo-due-${kind}`;
    button.dataset.todoDue = id;
    if (label) {
      button.textContent = label;
      button.setAttribute("aria-label", `期日 ${label}（変える）`);
    } else {
      button.innerHTML = CALENDAR;
      button.setAttribute("aria-label", "期日を付ける");
    }
    // The caret stays where it is, and the keyboard up.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onPick(id, button.getBoundingClientRect());
    });
    return button;
  };
}

/** Where the caret is, among the list's items: the index of the one it is in (in its details, too). */
function caretIndex(state: EditorState): number {
  const { $from } = state.selection;
  return $from.depth >= 2 ? $from.index(1) : -1;
}

/**
 * The Todo's dues on screen: at each item's right, its due ("11/13(金)
 * 23:59"), red when it is late and orange today, or, on the caret's item
 * and one the pointer is over, a calendar to give it one; and over the
 * items to do, headings by their dues (期限切れ, 今日, 明日, 今週, それ以降,
 * 期日なし), once any has one. An item not where its due would put it (one
 * just written, under one with a due) goes under the heading above it,
 * rather than one of its own, until the list is put in order.
 */
function decorate(state: EditorState): DecorationSet {
  const own = todoDueKey.getState(state);
  const group = state.doc.firstChild;
  if (!own || !group) return DecorationSet.empty;
  const now = new Date(own.now);
  const caret = caretIndex(state);
  const items: { node: Node; pos: number; id: string; due: string | null; done: boolean }[] = [];
  group.forEach((node, offset) => {
    const id = node.attrs.id as string | undefined;
    if (!id) return;
    const due = own.dues.get(id) ?? null;
    items.push({ node, pos: 1 + offset, id, due: readDue(due) ? due : null, done: isChecked(node) });
  });
  const headed = items.some((item) => !item.done && item.due);
  // Each item's heading, by its due; and the soonest of those after it, to
  // tell one not where its due would put it.
  const ranks = items.map((item) => (item.done ? Number.POSITIVE_INFINITY : BUCKETS.indexOf(bucketOf(item.due, now))));
  const soonestAfter = ranks.map(() => Number.POSITIVE_INFINITY);
  for (let at = items.length - 2; at >= 0; at -= 1) soonestAfter[at] = Math.min(ranks[at + 1]!, soonestAfter[at + 1]!);
  const decorations: Decoration[] = [];
  let shown = -1;
  for (const [index, item] of items.entries()) {
    const end = item.pos + item.node.nodeSize;
    const classes: string[] = [];
    const attrs: Record<string, string> = {};
    const rank = ranks[index]!;
    // Before one due sooner: not in place yet, under the heading above it.
    if (!item.done && headed && rank <= soonestAfter[index]! && rank > shown) {
      shown = rank;
      const bucket = BUCKETS[rank]!;
      attrs["data-todo-group"] = BUCKET_LABEL[bucket];
      classes.push("todo-group", `todo-group-${bucket}`);
    }
    if (index === caret && !item.done) classes.push("todo-caret");
    if (item.due) classes.push(readDue(item.due)!.time ? "todo-has-time" : "todo-has-due");
    if (classes.length > 0) decorations.push(Decoration.node(item.pos, end, { ...attrs, class: classes.join(" ") }));
    if (!item.due && item.done) continue;
    const label = item.due ? formatDue(item.due, now) : "";
    const kind = item.due ? (item.done ? "done" : bucketOf(item.due, now)) : "add";
    decorations.push(
      Decoration.widget(item.pos + 1, dueButton(item.id, label, kind, own.onPick), {
        side: -1,
        key: `due:${item.id}:${kind}:${label}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * The Todo's dues (lib/quick/todo-due), kept in `map` (the Todo's own
 * document's, by block id) and shown by the items they are of; `onPick`
 * opens the picker for one. The map's changes, this device's and another's,
 * are shown as they come.
 */
export const todoDue = createExtension(({ editor, options }: ExtensionOptions<{ map: Y.Map<string>; onPick: OnPick }>) => {
  const { map, onPick } = options;
  const read = () => new Map(Object.entries(map.toJSON() as Record<string, string>));
  return {
    key: "memocaTodoDue",
    mount: ({ signal }) => {
      const view = () => editor.prosemirrorView;
      const tell = (meta: Partial<DueState>) => {
        const current = view();
        if (current && !signal.aborted) current.dispatch(current.state.tr.setMeta(todoDueKey, meta));
      };
      // After the change (Yjs's own, as another device's comes in), not in it.
      let due: ReturnType<typeof setTimeout> | null = null;
      const changed = () => {
        if (due) return;
        due = setTimeout(() => {
          due = null;
          tell({ dues: read() });
        }, 0);
      };
      map.observe(changed);
      const again = () => {
        if (document.visibilityState === "visible") tell({ now: Date.now() });
      };
      const timer = setInterval(again, EVERY_MS);
      document.addEventListener("visibilitychange", again);
      signal.addEventListener("abort", () => {
        map.unobserve(changed);
        if (due) clearTimeout(due);
        clearInterval(timer);
        document.removeEventListener("visibilitychange", again);
      });
    },
    prosemirrorPlugins: [
      new Plugin<DueState>({
        key: todoDueKey,
        state: {
          init: () => ({ dues: read(), now: Date.now(), onPick }),
          apply: (tr, value) => {
            const meta = tr.getMeta(todoDueKey) as Partial<DueState> | undefined;
            return meta ? { ...value, ...meta } : value;
          },
        },
        props: { decorations: (state) => decorate(state) },
        // An item made by Enter in one with a due: that day's, at its end
        // (23:59), so it stays under the heading it was made under (今日,
        // 明日…) once the list is put in order, not going to 期日なし.
        view: () => ({
          update: (current) => {
            const last = entered.get(current);
            if (!last || current.state.doc === last.doc) return;
            if (Date.now() - last.at > ENTERED_FOR_MS) {
              entered.delete(current);
              return;
            }
            const made = madeBeside(last.doc, current.state.doc, last.id);
            if (!made) return;
            entered.delete(current);
            const source = itemsOf(current.state.doc).find((item) => item.id === last.id);
            const due = readDue(map.get(last.id));
            if (!source || isChecked(source.node) || !due || map.has(made)) return;
            const give = () => map.set(made, dueOf(due.day, MADE_AT_TIME));
            if (map.doc) map.doc.transact(give, TODO_DUE);
            else give();
          },
        }),
      }),
    ],
  };
});
