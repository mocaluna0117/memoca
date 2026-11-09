import { type ExtensionOptions, createExtension } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type * as Y from "yjs";
import { BUCKETS, BUCKET_LABEL, type Bucket, bucketOf, formatDue, readDue } from "@/lib/quick/todo-due";

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
      }),
    ],
  };
});
