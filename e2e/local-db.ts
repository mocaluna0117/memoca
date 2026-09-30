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

/** Empties one of the app's IndexedDB tables, as a device that never had its rows would be. */
export async function clearTable(page: Page, table: string): Promise<void> {
  await page.evaluate(async (name) => {
    const databases = await indexedDB.databases();
    const found = databases.find((entry) => entry.name?.startsWith("memoca"));
    if (!found?.name) return;
    const opened = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(found.name!);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = opened.transaction(name, "readwrite");
      transaction.objectStore(name).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    opened.close();
  }, table);
}

/**
 * Changes a row of one of the app's IndexedDB tables in place, as a sync
 * from elsewhere might have left it. The page shows it once reloaded: the
 * app's own live queries do not see a change made around them.
 */
export async function patchRow(
  page: Page,
  table: string,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    async ({ name, key, patch }) => {
      const databases = await indexedDB.databases();
      const found = databases.find((entry) => entry.name?.startsWith("memoca"));
      if (!found?.name) return;
      const opened = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(found.name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = opened.transaction(name, "readwrite");
        const store = transaction.objectStore(name);
        const read = store.get(key);
        read.onsuccess = () => store.put({ ...read.result, ...patch });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      opened.close();
    },
    { name: table, key, patch },
  );
}
