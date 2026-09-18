/**
 * Reading lookup for Japanese text, off the main thread.
 *
 * A plain classic worker on purpose. It is served straight from `public/` and
 * pulls kuromoji in with `importScripts`, so no bundler transform sits between
 * this file and the browser. Turbopack's `new Worker(new URL(...))` handling
 * produced a worker that failed at startup with "Missing worker bootstrap
 * config", and a search feature is not worth a dependency on that working.
 *
 * Protocol (see src/lib/search/yomi.ts for the typed client):
 *   in   { type: "warm",     id }
 *        { type: "readings", id, texts: string[] }
 *   out  { type: "ready",    id }
 *        { type: "readings", id, readings: string[] }
 *        { type: "error",    id, message }
 */

/* global kuromoji */
importScripts("/kuromoji/kuromoji.js");

let tokenizer = null;
let building = null;

function build() {
  if (tokenizer) return Promise.resolve(tokenizer);
  if (!building) {
    building = new Promise((resolve, reject) => {
      // A root-relative path, never an absolute URL: kuromoji joins this with
      // each filename and then collapses repeated slashes, which turns
      // "https://host" into "https:/host" and quietly 404s. Relative keeps it
      // on our own origin anyway, so the service worker can cache it and
      // reading search keeps working with no network.
      kuromoji.builder({ dicPath: "/kuromoji" }).build((error, built) => {
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
