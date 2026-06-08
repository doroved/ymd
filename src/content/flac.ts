/**
 * FLAC demuxer (MP4 → native FLAC) + Vorbis Comments / PICTURE encoder
 */

interface Mp4Box {
  type: string;
  start: number;
  size: number;
  dataStart: number;
}

function readUint32(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] << 24) |
    (buf[offset + 1] << 16) |
    (buf[offset + 2] << 8) |
    buf[offset + 3]
  );
}

function readUint64(buf: Uint8Array, offset: number): number {
  const hi = readUint32(buf, offset);
  const lo = readUint32(buf, offset + 4);
  return hi * 4294967296 + lo;
}

function* walkBoxes(buf: Uint8Array, start: number, end: number): Generator<Mp4Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32(buf, offset);
    const type = String.fromCharCode(...buf.slice(offset + 4, offset + 8));
    let dataStart = offset + 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(readUint64(buf, offset + 8));
      dataStart = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8 || offset + size > end) break;
    yield { type, start: offset, size, dataStart };
    offset += size;
  }
}

function findBox(buf: Uint8Array, start: number, end: number, target: string): Mp4Box | null {
  for (const box of walkBoxes(buf, start, end)) {
    if (box.type === target) return box;
    const childStart = box.dataStart + (isFullBox(box.type) ? 4 : 0);
    if (childStart < box.start + box.size) {
      const inner = findBox(buf, childStart, box.start + box.size, target);
      if (inner) return inner;
    }
  }
  return null;
}

function isFullBox(type: string): boolean {
  const fullBoxes = [
    "mvhd", "tkhd", "mdhd", "hdlr", "vmhd", "smhd", "dref", "stsd",
    "stts", "stsc", "stsz", "stco", "co64", "esds", "dfLa",
  ];
  return fullBoxes.includes(type);
}

function findAllBoxes(buf: Uint8Array, start: number, end: number, target: string): Mp4Box[] {
  const results: Mp4Box[] = [];
  for (const box of walkBoxes(buf, start, end)) {
    if (box.type === target) results.push(box);
    const childStart = box.dataStart + (isFullBox(box.type) ? 4 : 0);
    if (childStart < box.start + box.size) {
      results.push(...findAllBoxes(buf, childStart, box.start + box.size, target));
    }
  }
  return results;
}

// ── FLAC metadata block helpers ─────────────────────────────────────

function buildMetadataBlockHeader(blockType: number, dataLength: number, isLast: boolean): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = (isLast ? 0x80 : 0x00) | (blockType & 0x7f);
  header[1] = (dataLength >> 16) & 0xff;
  header[2] = (dataLength >> 8) & 0xff;
  header[3] = dataLength & 0xff;
  return header;
}

function encodeVorbisCommentField(field: string, value: string): Uint8Array {
  const comment = `${field}=${value}`;
  const bytes = new TextEncoder().encode(comment);
  const leLen = new Uint8Array(4);
  leLen[0] = bytes.length & 0xff;
  leLen[1] = (bytes.length >> 8) & 0xff;
  leLen[2] = (bytes.length >> 16) & 0xff;
  leLen[3] = (bytes.length >> 24) & 0xff;
  const result = new Uint8Array(4 + bytes.length);
  result.set(leLen, 0);
  result.set(bytes, 4);
  return result;
}

export function buildVorbisCommentBlock(comments: Record<string, string>): Uint8Array {
  const vendor = new TextEncoder().encode("YandexMusicDownloader");
  const vendorLen = new Uint8Array(4);
  const vLen = vendor.length;
  vendorLen[0] = vLen & 0xff;
  vendorLen[1] = (vLen >> 8) & 0xff;
  vendorLen[2] = (vLen >> 16) & 0xff;
  vendorLen[3] = (vLen >> 24) & 0xff;

  const entries = Object.entries(comments).filter(([, v]) => v);
  const countBuf = new Uint8Array(4);
  countBuf[0] = entries.length & 0xff;
  countBuf[1] = (entries.length >> 8) & 0xff;
  countBuf[2] = (entries.length >> 16) & 0xff;
  countBuf[3] = (entries.length >> 24) & 0xff;

  const commentBuffers = entries.map(([k, v]) => encodeVorbisCommentField(k, v));
  const totalCommentSize = commentBuffers.reduce((sum, b) => sum + b.length, 0);

  const data = new Uint8Array(4 + vendor.length + 4 + totalCommentSize);
  let offset = 0;
  data.set(vendorLen, offset); offset += 4;
  data.set(vendor, offset); offset += vendor.length;
  data.set(countBuf, offset); offset += 4;
  for (const cb of commentBuffers) {
    data.set(cb, offset);
    offset += cb.length;
  }

  const header = buildMetadataBlockHeader(4, data.length, false);
  const block = new Uint8Array(header.length + data.length);
  block.set(header, 0);
  block.set(data, header.length);
  return block;
}

export function buildPictureBlock(mimeType: string, imageData: ArrayBuffer): Uint8Array {
  const mimeBytes = new TextEncoder().encode(mimeType);
  const descBytes = new TextEncoder().encode("");
  const img = new Uint8Array(imageData);

  const dataLen =
    4 + 4 + mimeBytes.length +
    4 + descBytes.length +
    4 + 4 + 4 + 4 +
    4 + img.length;

  const data = new Uint8Array(dataLen);
  const view = new DataView(data.buffer);
  let off = 0;

  view.setUint32(off, 3, false); off += 4;
  view.setUint32(off, mimeBytes.length, false); off += 4;
  data.set(mimeBytes, off); off += mimeBytes.length;
  view.setUint32(off, descBytes.length, false); off += 4;
  data.set(descBytes, off); off += descBytes.length;
  view.setUint32(off, 0, false); off += 4;
  view.setUint32(off, 0, false); off += 4;
  view.setUint32(off, 0, false); off += 4;
  view.setUint32(off, 0, false); off += 4;
  view.setUint32(off, img.length, false); off += 4;
  data.set(img, off); off += img.length;

  const header = buildMetadataBlockHeader(6, data.length, false);
  const block = new Uint8Array(header.length + data.length);
  block.set(header, 0);
  block.set(data, header.length);
  return block;
}

// ── dfLa finder inside fLaC AudioSampleEntry ────────────────────────

function findDflaInFlacEntry(buf: Uint8Array, flacEntry: Mp4Box): Mp4Box | null {
  const dflaSig = [0x64, 0x66, 0x4c, 0x61];
  const searchStart = flacEntry.dataStart;
  const searchEnd = flacEntry.start + flacEntry.size;

  for (let i = searchStart; i <= searchEnd - 8; i++) {
    if (
      buf[i + 4] === dflaSig[0] &&
      buf[i + 5] === dflaSig[1] &&
      buf[i + 6] === dflaSig[2] &&
      buf[i + 7] === dflaSig[3]
    ) {
      const size = readUint32(buf, i);
      if (size >= 8 && i + size <= searchEnd) {
        return { type: "dfLa", start: i, size, dataStart: i + 8 };
      }
    }
  }
  return null;
}

// ── MP4 → FLAC demuxer ──────────────────────────────────────────────

export function demuxMp4FlacToFlac(
  mp4Buffer: ArrayBuffer,
  coverBuffer: ArrayBuffer | null
): ArrayBuffer {
  const buf = new Uint8Array(mp4Buffer);
  const totalSize = buf.length;

  const mdatBoxes = findAllBoxes(buf, 0, totalSize, "mdat");
  if (mdatBoxes.length === 0) throw new Error("MP4 demux: mdat box not found");
  const mdat = mdatBoxes[0];

  const stsdBox = findBox(buf, 0, totalSize, "stsd");
  if (!stsdBox) throw new Error("MP4 demux: stsd box not found");

  const stsdDataStart = stsdBox.dataStart + 4;
  const entryCount = readUint32(buf, stsdDataStart);
  if (entryCount === 0) throw new Error("MP4 demux: no sample entries");

  let flacEntry: Mp4Box | null = null;
  for (const box of walkBoxes(buf, stsdDataStart + 4, stsdBox.start + stsdBox.size)) {
    if (box.type === "fLaC") { flacEntry = box; break; }
  }

  if (!flacEntry) throw new Error("MP4 demux: fLaC sample entry not found");

  const dflaBox = findDflaInFlacEntry(buf, flacEntry);
  if (!dflaBox) throw new Error("MP4 demux: dfLa box not found");

  const dflaDataStart = dflaBox.dataStart + 4;
  const dflaData = buf.slice(dflaDataStart, dflaBox.start + dflaBox.size);

  const metadataBlocks: Uint8Array[] = [];
  let offset = 0;
  while (offset < dflaData.length) {
    if (offset + 4 > dflaData.length) break;
    const isLast = (dflaData[offset] & 0x80) !== 0;
    const blockSize = (dflaData[offset + 1] << 16) | (dflaData[offset + 2] << 8) | dflaData[offset + 3];
    if (offset + 4 + blockSize > dflaData.length) break;
    const block = dflaData.slice(offset, offset + 4 + blockSize);
    metadataBlocks.push(block);
    offset += 4 + blockSize;
    if (isLast) break;
  }

  if (metadataBlocks.length === 0) throw new Error("MP4 demux: no FLAC metadata blocks");

  const lastOriginal = metadataBlocks[metadataBlocks.length - 1];
  lastOriginal[0] &= 0x7f;

  const frames = buf.slice(mdat.dataStart, mdat.start + mdat.size);

  const magic = new TextEncoder().encode("fLaC");
  const parts: Uint8Array[] = [magic, ...metadataBlocks];

  if (coverBuffer) {
    const pictureBlock = buildPictureBlock(detectMimeType(coverBuffer), coverBuffer);
    pictureBlock[0] |= 0x80;
    parts.push(pictureBlock);
  } else {
    lastOriginal[0] |= 0x80;
  }

  parts.push(frames);

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const output = new Uint8Array(totalLen);
  let outOffset = 0;
  for (const p of parts) {
    output.set(p, outOffset);
    outOffset += p.length;
  }

  return output.buffer;
}

function detectMimeType(buffer: ArrayBuffer): string {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "image/jpeg";
}
