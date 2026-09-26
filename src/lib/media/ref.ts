/** Block content stores this, not a signed URL, so links survive re-encryption. */
export const REF_PREFIX = "memoca://att/";

export const refFor = (attachmentId: string) => `${REF_PREFIX}${attachmentId}`;
export const idFromRef = (ref: string) =>
  ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : null;
