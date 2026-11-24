import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SearchHit } from "@/lib/search/engine";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  /** The search asked for last, and what it finds. */
  asked: "",
  hits: [] as SearchHit[],
}));

vi.mock("@/lib/hooks/use-search", () => ({
  useSearch: (query: string) => {
    h.asked = query;
    return { hits: query.trim() ? h.hits : [], total: 3, locked: { count: 0, open: false } };
  },
}));
vi.mock("@/lib/hooks/use-yomi", () => ({
  useYomi: () => ({ on: false, busy: false, progress: null, turnOn: vi.fn(), turnOff: vi.fn() }),
}));
vi.mock("@/lib/hooks/workspace", () => ({ useWorkspace: () => ({ navigate: h.navigate }) }));
vi.mock("@/components/shell/app-shell", () => ({ MobileHeader: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import SearchView from "@/components/views/search-view";
import { forgetSearchHistory, rememberSearch, searchHistory } from "@/lib/search/history";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit: SearchHit = {
  noteId: "n1",
  title: "買い物リスト",
  locked: false,
  folderName: "",
  updatedAt: 0,
  standIn: "",
  matchedIn: "title",
  snippet: { text: "", highlights: [] },
};

let host: HTMLDivElement;
let root: Root;

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<SearchView />));
}

beforeEach(() => {
  forgetSearchHistory();
  localStorage.clear();
  h.navigate.mockReset();
  h.hits = [hit];
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const field = () => host.querySelector<HTMLInputElement>('input[aria-label="検索"]')!;
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);
async function type(value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("recent searches on the search page", () => {
  test("a note opened from a search keeps the search; Enter does too", async () => {
    await render();
    await type("買い物");
    await act(async () => button("買い物リスト")!.click());
    expect(h.navigate).toHaveBeenCalledWith({ folderId: null, pinned: false, noteId: "n1" });
    expect(searchHistory()).toEqual(["買い物"]);

    await type("牛乳");
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(searchHistory()).toEqual(["牛乳", "買い物"]);
  });

  test("what is typed on the way is not kept", async () => {
    await render();
    await type("か");
    await type("かい");
    await type("");
    expect(searchHistory()).toEqual([]);
    expect(host.textContent).not.toContain("最近の検索");
  });

  test("shown while the field is empty; one pressed is searched again", async () => {
    rememberSearch("旅行");
    rememberSearch("買い物");
    await render();
    expect(host.textContent).toContain("最近の検索");
    const shown = [...host.querySelectorAll('[aria-labelledby="search-history"] li')].map((li) => li.textContent);
    expect(shown).toEqual(["買い物", "旅行"]);

    await act(async () => button("旅行")!.click());
    expect(field().value).toBe("旅行");
    expect(h.asked).toBe("旅行");
    // Searching, the results in its place.
    expect(host.textContent).not.toContain("最近の検索");
  });

  test("one taken away by its ×, or all of them", async () => {
    rememberSearch("旅行");
    rememberSearch("買い物");
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="「旅行」を履歴から消す"]')!.click());
    expect(searchHistory()).toEqual(["買い物"]);
    await act(async () => button("すべて消す")!.click());
    expect(searchHistory()).toEqual([]);
    expect(host.textContent).not.toContain("最近の検索");
  });
});
