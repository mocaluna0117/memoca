"use client";

import { formatBytes } from "@/lib/bytes";
import { t } from "@/lib/i18n/ja";
import { QuotaError, UnsupportedFileError } from "./attachments";
import { UnsupportedImageError } from "./compress";

/** A size limit as it is said: "5 MB", not "5.0 MB". */
export function formatLimit(bytes: number): string {
  return formatBytes(bytes).replace(/\.0 /, " ");
}

/** Says a file is over the limit for one file of its kind. */
export function tooLargeMessage(kind: "image" | "video" | "other", limit: number): string {
  const said = formatLimit(limit);
  if (kind === "image") return t.quota.imageTooLarge(said);
  if (kind === "video") return t.quota.videoTooLarge(said);
  return t.quota.fileTooLarge(said);
}

/** What to say when a file cannot be added to a note, and why. */
export function uploadRefusal(error: unknown): string {
  if (error instanceof UnsupportedImageError) {
    return error.heic ? t.quota.heicUnreadable : t.quota.unsupportedImage;
  }
  if (error instanceof UnsupportedFileError) return t.quota.unsupportedFile;
  if (error instanceof QuotaError) {
    if (error.message === "tooLarge" && error.limit !== undefined) {
      return tooLargeMessage(error.kind ?? "other", error.limit);
    }
    return t.quota.exceeded;
  }
  return "追加できませんでした";
}
