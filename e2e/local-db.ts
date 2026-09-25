import type { Page } from "@playwright/test";

/**
 * Reads rows straight out of the app's IndexedDB.
 *
 * Used to check what the device actually stores, for example that a locked
 * note has no plaintext title or body, which the rendered page cannot show.
 */
export async function readTable<T = Record<string, unknown>>(
  page: Page,
  table: string,
): Promise<T[]> {
  return page.evaluate(async (name) => {
    const databases = await indexedDB.databases();
    const found = databases.find((entry) => entry.name?.startsWith("memoca"));
    if (!found?.name) return [];
    const opened = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(found.name!);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!opened.objectStoreNames.contains(name)) {
      opened.close();
      return [];
    }
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = opened.transaction(name, "readonly").objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    opened.close();
    // Byte fields do not survive the trip out of the page; mark their presence.
    return JSON.parse(
      JSON.stringify(rows, (_key, value) =>
        value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? "[bytes]" : value,
      ),
    );
  }, table) as Promise<T[]>;
}
