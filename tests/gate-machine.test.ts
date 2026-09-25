import { describe, expect, test } from "vitest";
import {
  type GateContext,
  type GateEvent,
  type GateState,
  type GateView,
  dismissResult,
  gateReducer,
  holdsOpen,
  isCreation,
  startGate,
} from "@/lib/vault/gate-machine";
import type { VaultPurpose } from "@/lib/vault/purpose";

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  availability: "exists",
  online: true,
  unlocked: false,
  passkeyReady: false,
  ...over,
});
const at = (view: GateView): GateState => ({ view, notice: null });

const open: VaultPurpose = { kind: "open", from: "note" };
const lockNote: VaultPurpose = { kind: "lockNote", title: "メモ" };
const unlockNote: VaultPurpose = { kind: "unlockNote", title: "メモ" };
const lockFolder: VaultPurpose = { kind: "lockFolder", folderId: "f", name: "仕事" };

describe("where the prompt starts", () => {
  test("with the vault open, only what needs a yes shows anything", () => {
    expect(startGate(open, ctx({ unlocked: true }))).toEqual({ immediate: true });
    expect(startGate(lockNote, ctx({ unlocked: true }))).toEqual({ immediate: true });
    expect(startGate(unlockNote, ctx({ unlocked: true }))).toEqual({ view: "confirm" });
    expect(startGate(lockFolder, ctx({ unlocked: true }))).toEqual({ view: "confirm" });
  });

  test("an existing vault is opened, never created", () => {
    expect(startGate(lockNote, ctx())).toEqual({ view: "password" });
    expect(startGate(lockNote, ctx({ passkeyReady: true }))).toEqual({ view: "passkey" });
    expect(startGate({ kind: "setup" }, ctx())).toEqual({ view: "password" });
  });

  test("not knowing yet is loading online and a dead end offline, never creation", () => {
    expect(startGate(lockNote, ctx({ availability: "unknown" }))).toEqual({ view: "loading" });
    expect(startGate(lockNote, ctx({ availability: "unknown", online: false }))).toEqual({
      view: "offline",
    });
  });

  test("only the server saying there is no vault leads to creating one", () => {
    expect(startGate(lockFolder, ctx({ availability: "none" }))).toEqual({ view: "create" });
  });
});

describe("moving between screens", () => {
  test("loading follows the record as it arrives", () => {
    expect(gateReducer(at("loading"), { type: "context", ctx: ctx() }).view).toBe("password");
    expect(
      gateReducer(at("loading"), { type: "context", ctx: ctx({ availability: "none" }) }).view,
    ).toBe("create");
    expect(gateReducer(at("loading"), { type: "loadingTimedOut" }).view).toBe("offline");
  });

  test("a vault made on another device while the creation form is open is opened instead", () => {
    const next = gateReducer(at("create"), { type: "context", ctx: ctx() });
    expect(next).toEqual({ view: "password", notice: "createdElsewhere" });
  });

  test("this device's own new vault arriving mid-creation does not interrupt it", () => {
    const creating = gateReducer(at("create"), { type: "setupStarted" });
    expect(creating.view).toBe("creating");
    // Convex applies the query update before the mutation resolves.
    expect(gateReducer(creating, { type: "context", ctx: ctx() }).view).toBe("creating");
    expect(gateReducer(creating, { type: "setupSucceeded" }).view).toBe("createKey");
  });

  test("the server saying a vault already exists sends creation to the password", () => {
    const creating = at("creating");
    expect(gateReducer(creating, { type: "setupAlready" })).toEqual({
      view: "password",
      notice: "alreadyExists",
    });
    expect(gateReducer(creating, { type: "setupFailed" }).view).toBe("create");
  });

  test("passkey support found late switches an untouched password screen to the passkey", () => {
    const ready = ctx({ passkeyReady: true });
    expect(gateReducer(at("password"), { type: "context", ctx: ready }).view).toBe("passkey");
    // Not when the person picked the password, or the passkey just failed.
    const picked = gateReducer(at("passkey"), { type: "usePassword" });
    expect(gateReducer(picked, { type: "context", ctx: ready }).view).toBe("password");
    const failed = gateReducer(at("passkey"), { type: "passkeyFailed" });
    expect(gateReducer(failed, { type: "context", ctx: ready }).view).toBe("password");
  });

  test("a passkey that gives nothing usable falls back to the password", () => {
    expect(gateReducer(at("passkey"), { type: "passkeyFailed" }).view).toBe("password");
  });

  test("the vault closing during a confirmation has to be opened again", () => {
    expect(gateReducer(at("confirm"), { type: "context", ctx: ctx() }).view).toBe("password");
  });

  test("opening with the recovery key offers a new password", () => {
    expect(gateReducer(at("recovery"), { type: "openedWithRecovery" }).view).toBe("recovered");
  });
});

describe("closing the prompt", () => {
  test("means 'not now' until the vault is open or has just been made", () => {
    for (const view of ["loading", "offline", "confirm", "passkey", "password", "recovery", "create"] as const) {
      expect(dismissResult(view), view).toBe("cancelled");
    }
    expect(dismissResult("recovered")).toBe("ok");
    expect(dismissResult("createPasskey")).toBe("ok");
  });

  test("is refused while a vault is being made or its key is on screen", () => {
    expect(holdsOpen("creating")).toBe(true);
    expect(holdsOpen("createKey")).toBe(true);
    expect(holdsOpen("password")).toBe(false);
  });
});

describe("the rule that protects an existing vault", () => {
  const events: GateEvent[] = [
    { type: "context", ctx: ctx() },
    { type: "context", ctx: ctx({ passkeyReady: true }) },
    { type: "context", ctx: ctx({ online: false }) },
    { type: "context", ctx: ctx({ unlocked: true }) },
    { type: "loadingTimedOut" },
    { type: "usePassword" },
    { type: "useRecovery" },
    { type: "usePasskey" },
    { type: "passkeyFailed" },
    { type: "openedWithRecovery" },
    { type: "setupStarted" },
    { type: "setupSucceeded" },
    { type: "setupAlready" },
    { type: "setupFailed" },
    { type: "keyConfirmed", passkeyOffer: true },
  ];
  const starts: GateView[] = ["loading", "offline", "passkey", "password", "recovery", "confirm"];

  test("no sequence of events from an opening screen reaches creation", () => {
    // Every state reachable from every screen an existing vault can start
    // on, by any events, visited once each. The record only ever says the
    // vault exists, so creation must never be among them.
    const key = (state: GateState) => `${state.view}|${state.notice}|${state.chosen ?? false}`;
    const seen = new Set<string>();
    const queue = starts.map(at);
    while (queue.length > 0) {
      const state = queue.shift()!;
      if (seen.has(key(state))) continue;
      seen.add(key(state));
      expect(isCreation(state.view), key(state)).toBe(false);
      for (const event of events) queue.push(gateReducer(state, event));
    }
    expect(seen.size).toBeGreaterThan(starts.length);
  });
});
