/**
 * Reading lookup for Japanese text, off the main thread.
 *
 * A plain classic worker on purpose, outside the app's bundler: Turbopack's
 * `new Worker(new URL(...))` handling produced a worker that failed at startup
 * with "Missing worker bootstrap config". scripts/copy-kuromoji-dict.mjs puts
 * it in one file with kuromoji and the Brotli decoder, beside the dictionary
 * (public/kuromoji/<version>/yomi-worker.js), so that it loads no script of its
 * own: WKWebView (Memoca for Mac) holds a worker to the page's
 * Content-Security-Policy, whose 'strict-dynamic' let no importScripts through,
 * and the worker failed at its first line.
 *
 * Protocol (see src/lib/search/yomi.ts for the typed client):
 *   in   { type: "warm",     id }
 *        { type: "readings", id, texts: string[] }
 *   out  { type: "ready",    id }
 *        { type: "readings", id, readings: string[] }
 *        { type: "error",    id, message }
 */

/* global kuromoji */

// The dictionary is kept nowhere on the device: fetched past the browser's
// HTTP cache (the service worker caches none of it either, src/app/sw.ts), it
// is in this worker's memory only, gone when the page ends the worker.
var plainFetch = self.fetch.bind(self);
self.fetch = function (input, init) {
  return plainFetch(input, { ...init, cache: "no-store" });
};

// Where the dictionary is: beside this file, a path from the root, not a URL
// (see build below).
var DICTIONARY = self.location.pathname.replace(/\/[^/]*$/, "");

let tokenizer = null;
let building = null;

function build() {
  if (tokenizer) return Promise.resolve(tokenizer);
  if (!building) {
    building = new Promise((resolve, reject) => {
      // A root-relative path, never an absolute URL: kuromoji joins this with
      // each filename and then collapses repeated slashes, which turns
      // "https://host" into "https:/host" and quietly 404s. Relative keeps it
      // on our own origin anyway.
      kuromoji.builder({ dicPath: DICTIONARY }).build((error, built) => {
        if (error) {
          building = null;
          reject(error);
          return;
        }
        tokenizer = built;
        resolve(built);
      });
    });
  }
  return building;
}

/**
 * The reading of one string, in katakana. Tokens with no reading of their own
 * (punctuation, latin, digits, unknown words) contribute their surface, so the
 * result stays close to what someone would actually type.
 */
function readingOf(active, text) {
  let out = "";
  for (const token of active.tokenize(text)) {
    out += token.reading || token.surface_form;
  }
  return out;
}

self.onmessage = function (event) {
  const request = event.data;
  build().then(
    function (active) {
      if (request.type === "warm") {
        self.postMessage({ type: "ready", id: request.id });
        return;
      }
      try {
        self.postMessage({
          type: "readings",
          id: request.id,
          readings: request.texts.map(function (text) {
            return readingOf(active, text);
          }),
        });
      } catch (cause) {
        self.postMessage({ type: "error", id: request.id, message: String(cause) });
      }
    },
    function (error) {
      self.postMessage({ type: "error", id: request.id, message: String(error) });
    },
  );
};
