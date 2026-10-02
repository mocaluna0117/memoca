import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { ja as blocknoteJa } from "@blocknote/core/locales";
import { locales as multiColumnLocales, withMultiColumn } from "@blocknote/xl-multi-column";
import { memocaFileBlock } from "@/components/editor/pdf-file-block";

/**
 * BlockNote's blocks, with a file block that shows a PDF's pages (see
 * memocaFileBlock), and columns: blocks side by side, in a row of two or
 * more (BlockNote's multi-column, GPL-3.0). A note's, and a template's made
 * without an editor on screen (lib/templates).
 */
export const SCHEMA = withMultiColumn(
  BlockNoteSchema.create({
    blockSpecs: { ...defaultBlockSpecs, file: memocaFileBlock() },
  }),
);

/** BlockNote's words, and its columns', in Japanese. */
export const DICTIONARY = { ...blocknoteJa, multi_column: multiColumnLocales.ja };
