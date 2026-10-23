import zlib from 'node:zlib';

// Test-only ZIP writer. Produces archives shaped like Playwright's (deflate, data descriptors,
// Unix attributes) and lets a test corrupt any field the reader must check.

export type ZipEntry = {
  name: string;
  data: string | Buffer;
  /** Stored instead of deflated. */
  store?: boolean;
  /** Overrides written into the central directory (and local header where the field exists there). */
  method?: number;
  flags?: number;
  crc?: number;
  declaredSize?: number;
  /** Raw name bytes in the central directory, e.g. with NUL or `..`. */
  rawName?: Buffer;
  /** Different name in the local header only. */
  localName?: string;
  /** Unix mode in the external attributes (e.g. 0o120777 for a symlink). */
  mode?: number;
};

export type ZipOptions = {
  /** Archive comment appended after the EOCD record. */
  comment?: string;
  /** Overrides the EOCD entry counts (e.g. 0xffff for a ZIP64 marker). */
  entryCount?: number;
  /** Overrides the central directory offset. */
  cdOffset?: number;
};

export function writeZip(entries: ZipEntry[], options: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const store = entry.store ?? false;
    const body = store ? data : zlib.deflateRawSync(data);
    const name = entry.rawName ?? Buffer.from(entry.name);
    const localName = entry.localName !== undefined ? Buffer.from(entry.localName) : name;
    const method = entry.method ?? (store ? 0 : 8);
    const flags = (entry.flags ?? 0) | 0x0808; // data descriptor + UTF-8 names, like Playwright's yazl output
    const crc = entry.crc ?? zlib.crc32(data);
    const size = entry.declaredSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(localName.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(size >>> 0, 12);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(size >>> 0, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);

    locals.push(local, localName, body, descriptor);
    central.push(header, name);
    offset += 30 + localName.length + body.length + 16;
  }
  const cd = Buffer.concat(central);
  const comment = Buffer.from(options.comment ?? '');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.entryCount ?? entries.length, 8);
  eocd.writeUInt16LE(options.entryCount ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(options.cdOffset ?? offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}
