"use client";

import {
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
  usePortalElement,
  useUIMode,
} from "@blocknote/react";
import { ALargeSmall } from "lucide-react";
import { FONT_SIZES } from "@/components/editor/font-size";

/**
 * 文字の大きさ, in the toolbar shown for text selected: the text made smaller
 * or larger (see fontSize), or back to the size it is.
 */
export function FontSizeButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const uiMode = useUIMode();
  const portalElement = usePortalElement();
  const size = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current.isEditable || !("fontSize" in current.schema.styleSchema)) return undefined;
      const blocks = current.getSelection()?.blocks || [current.getTextCursorPosition().block];
      // Text with nothing to size (an image, a table's cells as a whole): none.
      if (!blocks.some((block) => Array.isArray(block.content))) return undefined;
      const active = (current.getActiveStyles() as { fontSize?: string }).fontSize;
      return active ?? null;
    },
  });
  if (size === undefined) return null;

  const choose = (value: string | null) => {
    const styles = editor as unknown as {
      addStyles: (styles: Record<string, string>) => void;
      removeStyles: (styles: Record<string, string>) => void;
    };
    if (value) styles.addStyles({ fontSize: value });
    else styles.removeStyles({ fontSize: "" });
    editor.focus();
  };

  return (
    <Components.Generic.Menu.Root
      // As BlockNote's colours: in the editor's own layer, and on a phone
      // without taking the keyboard away.
      portalElement={portalElement}
      preventFocusOnOpen={uiMode === "mobile"}
    >
      <Components.Generic.Menu.Trigger>
        <Components.FormattingToolbar.Button
          className="bn-button"
          data-test="fontSize"
          label="文字の大きさ"
          mainTooltip="文字の大きさ"
          icon={<ALargeSmall className="size-4" />}
        />
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="bn-menu-dropdown">
        {FONT_SIZES.map(({ value, label }) => (
          <Components.Generic.Menu.Item
            key={label}
            data-test={`font-size-${value ?? "default"}`}
            checked={size === value}
            onClick={() => choose(value)}
          >
            <span style={value ? { fontSize: value } : undefined}>{label}</span>
          </Components.Generic.Menu.Item>
        ))}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}
