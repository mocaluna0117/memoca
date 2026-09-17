import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/** Release quota held by uploads that never finished. */
crons.interval(
  "release abandoned uploads",
  { hours: 1 },
  internal.attachments.reapReservations,
);

/** Delete trashed items past their owner's retention window. */
crons.cron("purge expired trash", "15 18 * * *", internal.trash.purgeExpired);

/** Delete attachments no block has referenced for 30 days. */
crons.cron(
  "sweep unreferenced attachments",
  "45 18 * * *",
  internal.attachments.sweepUnreferenced,
);

/** Drop tombstones older than any plausible offline client. */
crons.cron("drop old tombstones", "30 19 * * 0", internal.trash.dropOldTombstones);

/** Ground-truth pass over stored files, catching anything the above missed. */
crons.cron(
  "reconcile file storage",
  "0 20 * * 0",
  internal.attachments.reconcileStorage,
  {},
);

export default crons;
