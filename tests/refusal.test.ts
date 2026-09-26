import { describe, expect, test } from "vitest";
import { QuotaError, UnsupportedFileError } from "@/lib/media/attachments";
import { UnsupportedImageError } from "@/lib/media/compress";
import { formatLimit, uploadRefusal } from "@/lib/media/refusal";

const MiB = 1024 * 1024;

describe("what is said when a file cannot be added", () => {
  test.each([
    [new UnsupportedImageError("image/heic"), "HEIC 形式の画像は、このブラウザでは読み込めません"],
    [new UnsupportedImageError("IMG_0001.HEIC"), "iPhone や Mac の Safari から追加してください"],
    [new UnsupportedImageError("image/tiff"), "この形式の画像は追加できません"],
    [new UnsupportedFileError("application/pdf"), "この種類のファイルは追加できません"],
    [new QuotaError("tooLarge", 5 * MiB, "image"), "画像が大きすぎて追加できません（1 枚 5 MB まで）"],
    [new QuotaError("tooLarge", 30 * MiB, "video"), "動画が大きすぎて追加できません（1 本 30 MB まで）"],
    [new QuotaError("tooLarge", 30 * MiB, "other"), "ファイルが大きすぎて追加できません（1 つ 30 MB まで）"],
    [new QuotaError("tooLarge"), "保存できる容量を超えました"],
    [new QuotaError("quotaExceeded"), "保存できる容量を超えました"],
    [new Error("disk full"), "追加できませんでした"],
  ])("%s", (error, said) => {
    expect(uploadRefusal(error)).toContain(said);
  });

  test("limits are said the way people say them", () => {
    expect(formatLimit(5 * MiB)).toBe("5 MB");
    expect(formatLimit(2.5 * MiB)).toBe("2.5 MB");
    expect(formatLimit(30 * MiB)).toBe("30 MB");
  });
});
