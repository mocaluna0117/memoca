"use client";

import { uuidv7 } from "uuidv7";
import { db } from "@/lib/db";
import { notifyOutboxChanged } from "./signal";

export type QueuedOp = {
  opId: string;
  kind: string;
  entityId: string;
  payload: Record<string, unknown>;
};

/**
 * Queues a write for the server without blocking the UI on it.
 *
 * Local state has already changed by the time this is called, so an offline
 * device behaves exactly like an online one; the queue just drains later.
 */
export async function enqueue(op: Omit<QueuedOp, "opId"> & { opId?: string }): Promise<string> {
  const opId = op.opId ?? uuidv7();
  await db().outbox.put({
    opId,
    kind: op.kind,
    entityId: op.entityId,
    payload: { ...op.payload, opId },
    createdAt: Date.now(),
    attempts: 0,
  });
  notifyOutboxChanged();
  return opId;
}

export async function pendingCount(): Promise<number> {
  return db().outbox.count();
}
