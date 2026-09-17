import type { Folder, FolderNode, Note } from "@/lib/types";
import { sortByKey } from "@/lib/sortkey";

/**
 * Folders whose own `deletedAt` is set, plus everything beneath them.
 *
 * Deletion is stored on one row and inherited, so trashing a folder is a single
 * write and a note someone created inside it while offline is not orphaned: it
 * simply shows up in the trash with its folder and comes back on restore.
 */
export function trashedFolderIds(folders: Folder[]): Set<string> {
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  const trashed = new Set<string>();
  const resolve = (id: string, seen: Set<string>): boolean => {
    if (trashed.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) return false;
    const result =
      folder.deletedAt !== null ||
      (folder.parentId !== null && resolve(folder.parentId, seen));
    if (result) trashed.add(id);
    return result;
  };
  for (const folder of folders) resolve(folder.folderId, new Set());
  return trashed;
}

/** Folders that are locked themselves or sit inside a locked folder. */
export function lockedFolderIds(folders: Folder[]): Set<string> {
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  const locked = new Set<string>();
  const resolve = (id: string, seen: Set<string>): boolean => {
    if (locked.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) return false;
    const result =
      folder.locked || (folder.parentId !== null && resolve(folder.parentId, seen));
    if (result) locked.add(id);
    return result;
  };
  for (const folder of folders) resolve(folder.folderId, new Set());
  return locked;
}

export function buildTree(folders: Folder[]): FolderNode[] {
  const live = folders.filter((f) => !f.purged);
  const trashed = trashedFolderIds(live);
  const locked = lockedFolderIds(live);
  const visible = live.filter((f) => !trashed.has(f.folderId));

  const byParent = new Map<string | null, Folder[]>();
  for (const folder of visible) {
    const bucket = byParent.get(folder.parentId) ?? [];
    bucket.push(folder);
    byParent.set(folder.parentId, bucket);
  }

  const build = (parentId: string | null, depth: number, seen: Set<string>): FolderNode[] =>
    sortByKey(byParent.get(parentId) ?? [])
      .filter((folder) => !seen.has(folder.folderId))
      .map((folder) => {
        const nextSeen = new Set(seen).add(folder.folderId);
        return {
          ...folder,
          depth,
          inLockedTree: locked.has(folder.folderId),
          children: build(folder.folderId, depth + 1, nextSeen),
        };
      });

  const roots = build(null, 0, new Set());
  // The Inbox always sits at the top, whatever its sort key says.
  return [
    ...roots.filter((f) => f.system === "inbox"),
    ...roots.filter((f) => f.system !== "inbox"),
  ];
}

export function flattenTree(
  nodes: FolderNode[],
  expanded: Set<string>,
): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (list: FolderNode[]) => {
    for (const node of list) {
      out.push(node);
      if (expanded.has(node.folderId)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Every folder id inside `rootId`, including itself. */
export function subtreeIds(folders: Folder[], rootId: string): string[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const bucket = byParent.get(folder.parentId) ?? [];
    bucket.push(folder);
    byParent.set(folder.parentId, bucket);
  }
  const out: string[] = [];
  const queue = [rootId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    out.push(current);
    for (const child of byParent.get(current) ?? []) {
      if (seen.has(child.folderId)) continue;
      seen.add(child.folderId);
      queue.push(child.folderId);
    }
  }
  return out;
}

/** Notes hidden from normal views because they or their folder are trashed. */
export function visibleNotes(notes: Note[], trashedFolders: Set<string>): Note[] {
  return notes.filter(
    (note) =>
      !note.purged &&
      note.deletedAt === null &&
      (note.folderId === null || !trashedFolders.has(note.folderId)),
  );
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** Refuses a drag that would put a folder inside its own subtree. */
export function canMoveFolder(
  folders: Folder[],
  folderId: string,
  targetParentId: string | null,
): boolean {
  if (folderId === targetParentId) return false;
  if (targetParentId === null) return true;
  return !subtreeIds(folders, folderId).includes(targetParentId);
}

/** The ordered siblings of a folder, including the folder itself. */
export function siblingsOf(tree: FolderNode[], folderId: string): FolderNode[] {
  const search = (nodes: FolderNode[]): FolderNode[] | null => {
    if (nodes.some((node) => node.folderId === folderId)) return nodes;
    for (const node of nodes) {
      const found = search(node.children);
      if (found) return found;
    }
    return null;
  };
  return search(tree) ?? [];
}

/** Finds a node anywhere in the tree. */
export function findNode(tree: FolderNode[], folderId: string): FolderNode | null {
  for (const node of tree) {
    if (node.folderId === folderId) return node;
    const inner = findNode(node.children, folderId);
    if (inner) return inner;
  }
  return null;
}
