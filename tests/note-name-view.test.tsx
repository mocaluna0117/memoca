import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { NoteName } from "@/components/search/note-name";
import { STAND_IN_CLASS } from "@/lib/note-name";
import type { SearchHit } from "@/lib/search/engine";

const hit = (over: Partial<SearchHit>) => ({ title: "", standIn: "", ...over }) as SearchHit;
const shown = (over: Partial<SearchHit>) => renderToStaticMarkup(<NoteName hit={hit(over)} />);

describe("a found note's name, in ⌘K and on the search page", () => {
  test("a first line standing in for a title is set apart; a title is not", () => {
    expect(shown({ standIn: "牛乳を買う" })).toContain(`class="${STAND_IN_CLASS}"`);
    expect(shown({ standIn: "牛乳を買う" })).toContain(">牛乳を買う<");
    expect(shown({ title: "買い物" })).not.toContain(STAND_IN_CLASS);
    expect(shown({ title: "買い物" })).toContain(">買い物<");
  });

  test("with neither, 無題のメモ, set apart too", () => {
    expect(shown({})).toContain(STAND_IN_CLASS);
    expect(shown({})).toContain(">無題のメモ<");
  });
});
