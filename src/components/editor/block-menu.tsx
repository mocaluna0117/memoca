"use client";

import type { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  DragHandleMenu,
  SideMenu,
  type SideMenuProps,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
} from "@blocknote/react";
import type { EditorView } from "prosemirror-view";
import { type ReactNode, useEffect } from "react";
import {
  chooseBlocks,
  copyChosen,
  duplicateChosen,
  removeChosen,
} from "@/components/editor/block-select";

/**
 * The block whose handle was clicked, chosen while its menu is open (with
 * the others chosen, if it is one of them), as Notion has it: what the menu
 * does, it does to them.
 */
function ChooseOnOpen({ blockId }: { blockId: string }) {
  const editor = useBlockNoteEditor();
  useEffect(() => {
    const view = editor.prosemirrorView;
    if (view) chooseBlocks(view, blockId);
  }, [editor, blockId]);
  return null;
}

/** An item of the menu that acts on the blocks chosen. */
function ChosenItem({
  children,
  run,
}: {
  children: ReactNode;
  run: (editor: BlockNoteEditor, view: EditorView) => void;
}) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as BlockNoteEditor;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        const view = editor.prosemirrorView;
        if (view) run(editor, view);
      }}
    >
      {children}
    </Components.Generic.Menu.Item>
  );
}

/** BlockNote's menu of a block's handle, with 複製 and コピー, and 削除 of all the blocks chosen. */
function MemocaDragHandleMenu() {
  const dict = useDictionary();
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });
  return (
    <DragHandleMenu>
      {block ? <ChooseOnOpen blockId={block.id} /> : null}
      <ChosenItem run={duplicateChosen}>複製</ChosenItem>
      <ChosenItem run={(each, view) => copyChosen(each, view)}>コピー</ChosenItem>
      <ChosenItem run={removeChosen}>{dict.drag_handle.delete_menuitem}</ChosenItem>
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
    </DragHandleMenu>
  );
}

/** BlockNote's side menu (+ and the handle), the handle's menu Memoca's. */
export function MemocaSideMenu(props: SideMenuProps) {
  return <SideMenu {...props} dragHandleMenu={MemocaDragHandleMenu} />;
}
