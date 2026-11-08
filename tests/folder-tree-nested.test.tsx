import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { type TreeRow, nested } from "@/components/folders/folder-tree";
import type { FolderNode, Note } from "@/lib/types";

const folder = (folderId: string, depth: number): FolderNode =>
  ({ folderId, depth, name: folderId, parentId: null, children: [] }) as unknown as FolderNode;
const note = (noteId: string, depth: number): TreeRow => ({
  kind: "note",
  note: { noteId } as unknown as Note,
  depth,
});

/** Each element of the tree as `key > key > …` down to the rows rendered. */
function paths(nodes: ReactNode[], prefix = ""): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (!isValidElement(node)) continue;
    const element = node as ReactElement<{ children?: ReactNode; "data-row"?: string }>;
    if (element.props["data-row"]) {
      out.push(`${prefix}${element.props["data-row"]}`);
      continue;
    }
    const key = element.key ?? (element.type === "div" && element.props.children ? "sticky" : "?");
    const children = element.props.children;
    const list = Array.isArray(children) ? children.flat() : [children];
    out.push(...paths(list, `${prefix}${key} > `));
  }
  return out;
}

const render = (row: TreeRow) => {
  const id = row.kind === "folder" ? row.node.folderId : row.note.noteId;
  return <span key={id} data-row={id} />;
};

describe("the folder tree's rows, grouped by folder", () => {
  test("a closed folder's row is in the same group and sticky wrapper as an open one's", () => {
    const closed = paths(nested([{ kind: "folder", node: folder("A", 0) }], render));
    const open = paths(
      nested([{ kind: "folder", node: folder("A", 0) }, note("n1", 1)], render),
    );
    // Opened, the row keeps its place in the tree: React keeps the element,
    // and focus (or a rename in progress) on it.
    expect(closed).toEqual(["inside/A > sticky > A"]);
    expect(open).toEqual(["inside/A > sticky > A", "inside/A > n1"]);
  });

  test("folders inside folders, each in its own group; notes at the top level bare", () => {
    const rows: TreeRow[] = [
      { kind: "folder", node: folder("A", 0) },
      { kind: "folder", node: folder("B", 1) },
      note("n1", 2),
      { kind: "folder", node: folder("C", 0) },
      note("top", 0),
    ];
    expect(paths(nested(rows, render))).toEqual([
      "inside/A > sticky > A",
      "inside/A > inside/B > sticky > B",
      "inside/A > inside/B > n1",
      "inside/C > sticky > C",
      "top",
    ]);
  });
});
