import type { Doc } from "../_generated/dataModel";

/**
 * What kind of folder a folder is, as the app has it now. Inbox and the
 * templates' folder are the app's own (never trashed, nor locked). The
 * days' notes' folder ("journal") was one too, until 今日のメモ was taken out
 * of the app: it is any other folder now, its notes kept in it. Its rows
 * keep the old kind (an old app on a device may still make one), read as
 * none.
 */
export function systemOf(folder: { system: Doc<"folders">["system"] }): "inbox" | "templates" | null {
  return folder.system === "journal" ? null : folder.system;
}
