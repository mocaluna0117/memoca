import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * A stand-in for ConvexReactClient that routes queries and mutations by their
 * function name ("vault:lockNote") to handlers the test provides.
 *
 * Every call is recorded, so a test can assert what reached the server as
 * well as what the client did with the answer. A call with no handler fails
 * loudly rather than resolving to undefined and hiding a missing case.
 */
export function fakeConvex(handlers: Record<string, Handler> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let connected = true;

  const run = async (reference: unknown, args: Record<string, unknown> = {}) => {
    const name = getFunctionName(reference as never);
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`fakeConvex: no handler for ${name}`);
    return handler(args);
  };

  const client = {
    query: run,
    mutation: run,
    action: run,
    connectionState: () => ({
      isWebSocketConnected: connected,
      hasInflightRequests: false,
      timeOfOldestInflightRequest: null,
      hasEverConnected: true,
      connectionCount: 1,
      connectionRetries: 0,
      inflightMutations: 0,
      inflightActions: 0,
    }),
  };

  return {
    client: client as unknown as ConvexReactClient,
    calls,
    handlers,
    /** Calls made to one function, in order. */
    callsTo: (name: string) => calls.filter((call) => call.name === name),
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}
