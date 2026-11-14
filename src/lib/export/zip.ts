/**
 * A ZIP archive of files kept as they are (stored, not compressed): what a
 * note's export is put in. Images and PDFs are compressed already, and a
 * note's text is small, so compressing would save little and take long on a
 * phone. Names are UTF-8 (flag bit 11), as Japanese ones need, which every
 * current unzipper reads.
 */

/**
 * A file to put in. A Blob (an image, a video) is put in as it is, read only
 * to be checked (its CRC), a piece at a time: read whole, an export of every
 * note held each file twice in memory, as bytes and again in the archive.
 */
export type ZipEntry = { path: string; data: Uint8Array | Blob; modified?: Date };

/** How much of a file is read at a time for its CRC, with a pause between for the page. */
const PIECE = 4 * 1024 * 1024;

/** A CRC carried on over more bytes: start with 0xffffffff, finish with ^ 0xffffffff >>> 0. */
function crcOn(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return crc;
}

/** A file's CRC, a piece at a time, the page given a turn between pieces. */
async function crcOf(data: Uint8Array | Blob): Promise<number> {
  let crc = 0xffffffff;
  if (isBytes(data)) {
    for (let at = 0; at < data.length; at += PIECE) {
      crc = crcOn(crc, data.subarray(at, at + PIECE));
      if (at + PIECE < data.length) await turn();
    }
  } else {
    for (let at = 0; at < data.size; at += PIECE) {
      crc = crcOn(crc, new Uint8Array(await data.slice(at, at + PIECE).arrayBuffer()));
      await turn();
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Bytes, not a Blob: told apart without instanceof, which another realm's bytes fail (a test's). */
const isBytes = (data: Uint8Array | Blob): data is Uint8Array => ArrayBuffer.isView(data);
const sizeOf = (data: Uint8Array | Blob) => (isBytes(data) ? data.length : data.size);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  return (crcOn(0xffffffff, data) ^ 0xffffffff) >>> 0;
}

/** A date and time as MS-DOS keeps them, which a ZIP's entries carry. */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const UTF8 = 0x0800;

/**
 * The name again, as Info-ZIP's Unicode Path field: for unzippers that do
 * not read flag bit 11 (the unzip a Mac comes with), which would show a
 * Japanese name garbled.
 */
function unicodePath(name: Uint8Array): Uint8Array {
  const field = new DataView(new ArrayBuffer(9 + name.length));
  field.setUint16(0, 0x7075, true);
  field.setUint16(2, 5 + name.length, true);
  field.setUint8(4, 1);
  field.setUint32(5, crc32(name), true);
  const bytes = new Uint8Array(field.buffer);
  bytes.set(name, 9);
  return bytes;
}

/** The archive of these files, in this order. */
export async function zip(entries: ZipEntry[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const extra = unicodePath(name);
    const crc = await crcOf(entry.data);
    const { time, date } = dosTime(entry.modified ?? new Date());
    const size = sizeOf(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, UTF8, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, extra.length, true);
    parts.push(
      local.buffer,
      name,
      extra as Uint8Array<ArrayBuffer>,
      entry.data as Uint8Array<ArrayBuffer> | Blob,
    );

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // version made by
    header.setUint16(6, 20, true); // version needed
    header.setUint16(8, UTF8, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, date, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint16(30, extra.length, true);
    header.setUint32(42, offset, true);
    const record = new Uint8Array(46 + name.length + extra.length);
    record.set(new Uint8Array(header.buffer), 0);
    record.set(name, 46);
    record.set(extra, 46 + name.length);
    central.push(record);

    offset += 30 + name.length + extra.length + size;
  }

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...(central as Uint8Array<ArrayBuffer>[]), end.buffer], {
    type: "application/zip",
  });
}
