import "fake-indexeddb/auto";
import { liveQuery } from "dexie";
import { beforeEach, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";

const body = (noteId: string, links: string[]) => ({
  noteId,
  throughSeq: 0,
  keyEpoch: 0,
  text: "",
  links,
  updatedAt: 0,
});

beforeEach(async () => {
  await resetLocalData();
});

test("the notes linking to one are found by the index of what each links to", async () => {
  await db().bodies.bulkPut([body("a", ["n1"]), body("b", ["n2", "n1"]), body("c", []), body("n1", ["n1"])]);
  const linkers = await db().bodies.where("links").equals("n1").primaryKeys();
  expect([...linkers].sort()).toEqual(["a", "b", "n1"]);
});

test("their query runs again for a body that links here, not for any other written", async () => {
  await db().bodies.bulkPut([body("a", ["n1"])]);
  let runs = 0;
  const sub = liveQuery(async () => {
    runs += 1;
    return db().bodies.where("links").equals("n1").primaryKeys();
  }).subscribe(() => {});
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  await settle();
  const before = runs;
  // Another note typed in: its body written, linking elsewhere.
  await db().bodies.put(body("z", ["n9"]));
  await db().bodies.put({ ...body("z", ["n9"]), text: "more" });
  await settle();
  expect(runs).toBe(before);
  await db().bodies.put(body("y", ["n1"]));
  await settle();
  expect(runs).toBeGreaterThan(before);
  sub.unsubscribe();
});
