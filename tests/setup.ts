import { webcrypto } from "node:crypto";

// jsdom does not ship WebCrypto; the vault code depends on it.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}
