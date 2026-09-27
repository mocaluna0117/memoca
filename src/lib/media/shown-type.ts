/**
 * What this tab may show a file as, straight from its URL: images, videos,
 * sound, PDF and plain text, none of which runs a script. A locked note
 * takes files of any type, and one of another (a web page, an SVG), opened
 * as it is, would run as a page of this app, with the app's data and the
 * open vault's window within its reach: it is handed out as bytes to
 * download instead. So is anything fetched from elsewhere, whatever type it
 * says it is.
 */
const SHOWN_AS_IS =
  /^(?:image\/(?:png|jpeg|gif|webp|avif|heic|heif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)(?:\s*;.*)?$/i;

/** The type a file of this tab's is given: its own when safe to show, bytes to download otherwise. */
export const shownType = (type: string) =>
  SHOWN_AS_IS.test(type) ? type : "application/octet-stream";
