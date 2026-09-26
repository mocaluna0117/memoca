import { type VaultPurpose, needsConfirmation } from "./purpose";

/**
 * Which screen the vault prompt shows, as a pure function of what is known.
 *
 * Kept apart from the component so the rules can be tested exhaustively. The
 * one that matters most: once a vault is known to exist, no sequence of events
 * leads to the screens that create one. Offering to create a second vault is
 * how an account could end up locking notes under a key that is never saved.
 */
export type GateView =
  | "loading"
  | "offline"
  | "confirm"
  | "passkey"
  | "password"
  | "recovery"
  | "recovered"
  | "create"
  | "creating"
  | "createKey"
  | "createPasskey"
  /** Opened with the password in a browser with no passkey of its own yet. */
  | "offerPasskey";

export type GateContext = {
  availability: "unknown" | "none" | "exists";
  online: boolean;
  unlocked: boolean;
  /**
   * This browser has registered or used one of the vault's passkeys, and has
   * a platform authenticator. A passkey that lives only on another device, or
   * in another browser, does not count: offering it first led to the
   * browser's own "no passkey on this device" sheet.
   */
  passkeyReady: boolean;
};

export type GateStart = { view: GateView } | { immediate: true };

export function startGate(purpose: VaultPurpose, ctx: GateContext): GateStart {
  if (ctx.unlocked) {
    return needsConfirmation(purpose) ? { view: "confirm" } : { immediate: true };
  }
  return { view: viewFor(ctx) };
}

function viewFor(ctx: GateContext): GateView {
  if (ctx.availability === "unknown") return ctx.online ? "loading" : "offline";
  if (ctx.availability === "none") return "create";
  return ctx.passkeyReady ? "passkey" : "password";
}

export type GateEvent =
  /** The vault record, the network or passkey support changed. */
  | { type: "context"; ctx: GateContext }
  /** Nothing arrived within the loading grace period. */
  | { type: "loadingTimedOut" }
  | { type: "usePassword" }
  | { type: "useRecovery" }
  | { type: "usePasskey" }
  /**
   * The passkey gave no usable secret, so the password is the way in.
   * `notFound`: tried in a browser with no passkey known to be its own, and
   * it came to nothing, most likely because there is none here.
   */
  | { type: "passkeyFailed"; notFound?: boolean }
  /** The password opened it; `offer` when this browser could add a passkey. */
  | { type: "openedWithPassword"; offer: boolean }
  | { type: "openedWithRecovery" }
  | { type: "setupStarted" }
  | { type: "setupSucceeded" }
  | { type: "setupAlready" }
  | { type: "setupFailed" }
  | { type: "keyConfirmed"; passkeyOffer: boolean };

export type GateState = {
  view: GateView;
  notice: GateNotice | null;
  /** The person picked this way in themselves, so it is not switched under them. */
  chosen?: boolean;
};

/** Something the new screen has to explain, set by the move that led to it. */
export type GateNotice = "createdElsewhere" | "alreadyExists" | "passkeyNotFound";

const CREATION: readonly GateView[] = ["create", "creating", "createKey", "createPasskey"];

export function gateReducer(state: GateState, event: GateEvent): GateState {
  const { view } = state;
  switch (event.type) {
    case "context": {
      const { ctx } = event;
      // Waiting screens follow the facts as they arrive.
      if (view === "loading" || view === "offline") {
        if (ctx.unlocked) return state;
        return { view: viewFor(ctx), notice: null };
      }
      // The vault closed (it timed out) while asking to confirm: it has to be
      // opened again before whatever was confirmed can happen.
      if (view === "confirm" && !ctx.unlocked) return { view: viewFor(ctx), notice: null };
      // Passkey support is detected asynchronously. If it turns up after the
      // password screen was picked for want of it, and nobody chose that
      // screen, offer the passkey after all.
      if (view === "password" && ctx.passkeyReady && !state.chosen && state.notice === null) {
        return { view: "passkey", notice: null };
      }
      // The creation form was open when a vault appeared from another device:
      // that vault is now the one to open.
      if (view === "create" && ctx.availability === "exists") {
        return { view: ctx.passkeyReady ? "passkey" : "password", notice: "createdElsewhere" };
      }
      // Everything else, including a creation in flight, whose own vault
      // arriving must not be mistaken for someone else's, stays put.
      return state;
    }
    case "loadingTimedOut":
      return view === "loading" ? { view: "offline", notice: null } : state;
    case "usePassword":
      return view === "passkey" || view === "recovery"
        ? { view: "password", notice: null, chosen: true }
        : state;
    case "useRecovery":
      return view === "passkey" || view === "password"
        ? { view: "recovery", notice: null, chosen: true }
        : state;
    case "usePasskey":
      return view === "password" || view === "recovery"
        ? { view: "passkey", notice: null, chosen: true }
        : state;
    case "passkeyFailed":
      // Not a choice, but the passkey has just failed: do not offer it again.
      return view === "passkey"
        ? { view: "password", notice: event.notFound ? "passkeyNotFound" : null, chosen: true }
        : state;
    case "openedWithPassword":
      return view === "password" && event.offer ? { view: "offerPasskey", notice: null } : state;
    case "openedWithRecovery":
      return view === "recovery" ? { view: "recovered", notice: null } : state;
    case "setupStarted":
      return view === "create" ? { view: "creating", notice: null } : state;
    case "setupSucceeded":
      return view === "creating" ? { view: "createKey", notice: null } : state;
    case "setupAlready":
      return view === "creating" ? { view: "password", notice: "alreadyExists" } : state;
    case "setupFailed":
      return view === "creating" ? { view: "create", notice: null } : state;
    case "keyConfirmed":
      if (view !== "createKey") return state;
      return event.passkeyOffer ? { view: "createPasskey", notice: null } : state;
  }
}

/**
 * What closing the prompt from this screen means. On most screens it is "not
 * now", but once the vault has been opened or just created, it is open, and
 * whatever asked for it can go ahead.
 */
export function dismissResult(view: GateView): "ok" | "cancelled" {
  return view === "recovered" || view === "createPasskey" || view === "offerPasskey"
    ? "ok"
    : "cancelled";
}

/**
 * Screens that must not be closed: a key is being derived or saved, or a
 * one-time recovery key is on screen and has not been confirmed.
 */
export function holdsOpen(view: GateView): boolean {
  return view === "creating" || view === "createKey";
}

export function isCreation(view: GateView): boolean {
  return CREATION.includes(view);
}
