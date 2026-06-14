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

// ── MP4 sample tables helpers ───────────────────────────────────────

function readSampleSizes(stszBox: Mp4Box, buf: Uint8Array): number[] | null {
  const data = buf.slice(stszBox.dataStart + 4, stszBox.start + stszBox.size);
  if (data.length < 8) return null;
  const sampleSize = readUint32(data, 0);
  const sampleCount = readUint32(data, 4);

  if (sampleCount === 0) return [];

  if (sampleSize !== 0) {
    return Array.from({ length: sampleCount }, () => sampleSize);
  }

  const sizes: number[] = [];
  let offset = 8;
  for (let i = 0; i < sampleCount; i++) {
    if (offset + 4 > data.length) break;
    sizes.push(readUint32(data, offset));
    offset += 4;
  }
  return sizes;
}

function readSampleChunks(stscBox: Mp4Box, buf: Uint8Array): { firstChunk: number; samplesPerChunk: number }[] {
  const data = buf.slice(stscBox.dataStart + 4, stscBox.start + stscBox.size);
  if (data.length < 4) return [];
  const entryCount = readUint32(data, 0);
  const entries: { firstChunk: number; samplesPerChunk: number }[] = [];
  let offset = 4;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 12 > data.length) break;
    const firstChunk = readUint32(data, offset);
    const samplesPerChunk = readUint32(data, offset + 4);
    // skip sample description index
    offset += 12;
    entries.push({ firstChunk, samplesPerChunk });
  }
  return entries;
}

function readChunkOffsets(co64Box: Mp4Box, buf: Uint8Array): number[] {
  const data = buf.slice(co64Box.dataStart + 4, co64Box.start + co64Box.size);
  if (data.length < 4) return [];
  const entryCount = readUint32(data, 0);
  const offsets: number[] = [];
  let offset = 4;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 8 > data.length) break;
    offsets.push(readUint64(data, offset));
    offset += 8;
  }
  return offsets;
}

function readChunkOffsets32(stcoBox: Mp4Box, buf: Uint8Array): number[] {
  const data = buf.slice(stcoBox.dataStart + 4, stcoBox.start + stcoBox.size);
  if (data.length < 4) return [];
  const entryCount = readUint32(data, 0);
  const offsets: number[] = [];
  let offset = 4;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 4 > data.length) break;
    offsets.push(readUint32(data, offset));
    offset += 4;
  }
  return offsets;
}

function getSamplesPerChunk(chunkNumber: number, entries: { firstChunk: number; samplesPerChunk: number }[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (chunkNumber >= entries[i].firstChunk) {
      return entries[i].samplesPerChunk;
    }
  }
  return entries[0]?.samplesPerChunk ?? 0;
}

function extractAudioFrames(buf: Uint8Array, mdat: Mp4Box): Uint8Array {
  const stszBox = findBox(buf, 0, buf.length, "stsz");
  const stscBox = findBox(buf, 0, buf.length, "stsc");
  const co64Box = findBox(buf, 0, buf.length, "co64");
  const stcoBox = findBox(buf, 0, buf.length, "stco");

  if (!stszBox || !stscBox || (!co64Box && !stcoBox)) {
    console.warn("[YMD FLAC] Sample tables missing, falling back to raw mdat");
    return buf.slice(mdat.dataStart, mdat.start + mdat.size);
  }

  const sampleSizes = readSampleSizes(stszBox, buf);
  const chunkEntries = readSampleChunks(stscBox, buf);
  const chunkOffsets = co64Box ? readChunkOffsets(co64Box, buf) : readChunkOffsets32(stcoBox!, buf);

  if (!sampleSizes || sampleSizes.length === 0 || chunkOffsets.length === 0 || chunkEntries.length === 0) {
    console.warn("[YMD FLAC] Incomplete sample tables, falling back to raw mdat");
    return buf.slice(mdat.dataStart, mdat.start + mdat.size);
  }

  let totalFrameSize = 0;
  for (const size of sampleSizes) totalFrameSize += size;

  if (totalFrameSize === 0) {
    console.warn("[YMD FLAC] Total sample size is zero, falling back to raw mdat");
    return buf.slice(mdat.dataStart, mdat.start + mdat.size);
  }

  const frames = new Uint8Array(totalFrameSize);
  let writeOffset = 0;
  let sampleIndex = 0;

  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length && sampleIndex < sampleSizes.length; chunkIndex++) {
    const chunkOffset = chunkOffsets[chunkIndex];
    const chunkNumber = chunkIndex + 1;
    const samplesInThisChunk = getSamplesPerChunk(chunkNumber, chunkEntries);

    if (chunkOffset + (samplesInThisChunk > 0 ? sampleSizes[sampleIndex] : 0) > buf.length) {
      console.warn(`[YMD FLAC] Chunk ${chunkNumber} offset out of bounds`);
      break;
    }

    let chunkReadOffset = chunkOffset;
    for (let i = 0; i < samplesInThisChunk && sampleIndex < sampleSizes.length; i++, sampleIndex++) {
      const sampleSize = sampleSizes[sampleIndex];
      if (chunkReadOffset + sampleSize > buf.length) {
        console.warn(`[YMD FLAC] Sample ${sampleIndex} exceeds buffer, truncating`);
        break;
      }
      frames.set(buf.slice(chunkReadOffset, chunkReadOffset + sampleSize), writeOffset);
      chunkReadOffset += sampleSize;
      writeOffset += sampleSize;
    }
  }

  if (writeOffset !== totalFrameSize) {
    console.warn(`[YMD FLAC] Extracted ${writeOffset} bytes, expected ${totalFrameSize}`);
  }

  return frames.slice(0, writeOffset);
}

// ── FLAC SEEKTABLE helper ───────────────────────────────────────────

function parseStreamInfo(streamInfo: Uint8Array): { minBlockSize: number; maxBlockSize: number; minFrameSize: number; maxFrameSize: number; sampleRate: number; channels: number; bitsPerSample: number; totalSamples: number; md5: Uint8Array } {
  const view = new DataView(streamInfo.buffer, streamInfo.byteOffset, streamInfo.byteLength);

  const minBlockSize = view.getUint16(0, false);
  const maxBlockSize = view.getUint16(2, false);

  const minFrameSize = ((view.getUint32(4, false) >> 8) & 0xffffff);
  const maxFrameSize = ((view.getUint32(7, false) >> 8) & 0xffffff);

  const raw = readUint64(streamInfo, 10);
  const sampleRate = Number(raw >> 44) & 0x1fffff;
  const channels = Number((raw >> 41) & 0x7) + 1;
  const bitsPerSample = Number((raw >> 36) & 0x1f) + 1;
  const totalSamples = Number(raw & 0xfffffffff);

  const md5 = streamInfo.slice(18, 34);

  return { minBlockSize, maxBlockSize, minFrameSize, maxFrameSize, sampleRate, channels, bitsPerSample, totalSamples, md5 };
}

function buildSeekTable(frames: Uint8Array, sampleRate: number, minBlockSize: number, totalSamples: number): Uint8Array {
  const seekPoints: { sampleNumber: number; offset: number; samplesInFrame: number }[] = [];

  const numSeekPoints = Math.max(2, Math.floor(totalSamples / (sampleRate * 10)));
  const targetInterval = Math.floor(totalSamples / numSeekPoints);

  let offset = 0;
  let currentSample = 0;

  seekPoints.push({ sampleNumber: 0, offset: 0, samplesInFrame: minBlockSize });

  while (offset < frames.length) {
    const frameStart = offset;
    const syncCode = (frames[offset] << 6) | (frames[offset + 1] >> 2);
    if (syncCode !== 0x3ffe) break;

    const blockSizeBits = ((frames[offset + 2] >> 4) & 0x0f);
    const sampleRateBits = (frames[offset + 2] & 0x0f);

    let blockSize: number;
    if (blockSizeBits === 1) blockSize = 192;
    else if (blockSizeBits >= 2 && blockSizeBits <= 5) blockSize = 576 * Math.pow(2, blockSizeBits - 2);
    else if (blockSizeBits === 6) blockSize = frames[offset + 5] + 1;
    else if (blockSizeBits === 7) blockSize = (frames[offset + 5] << 8) + frames[offset + 6] + 1;
    else break;

    let frameHeaderSize = 5;
    if (blockSizeBits === 6) frameHeaderSize = 6;
    else if (blockSizeBits === 7) frameHeaderSize = 7;

    const sampleRateFromHeader = (() => {
      if (sampleRateBits === 0x0c) return 8000;
      if (sampleRateBits === 0x0d) return 16000;
      if (sampleRateBits === 0x0e) return 22050;
      if (sampleRateBits === 0x0f) return 24000;
      if (sampleRateBits === 0x10) return 32000;
      if (sampleRateBits === 0x11) return 44100;
      if (sampleRateBits === 0x12) return 48000;
      if (sampleRateBits === 0x13) return 96000;
      if (sampleRateBits === 0x14) return 88200;
      if (sampleRateBits === 0x15) return 176400;
      if (sampleRateBits === 0x16) return 192000;
      return sampleRate;
    })();

    let nextFrameOffset = frameStart + frameHeaderSize + blockSize + 2;
    while (nextFrameOffset + 2 <= frames.length) {
      const sync = (frames[nextFrameOffset] << 6) | (frames[nextFrameOffset + 1] >> 2);
      if (sync === 0x3ffe) break;
      nextFrameOffset++;
    }

    if (nextFrameOffset > frames.length) nextFrameOffset = frames.length;

    if (currentSample > 0 && currentSample % targetInterval < blockSize && seekPoints.length < numSeekPoints) {
      seekPoints.push({
        sampleNumber: currentSample,
        offset: frameStart,
        samplesInFrame: blockSize,
      });
    }

    offset = nextFrameOffset;
    currentSample += blockSize;

    if (currentSample >= totalSamples) break;
  }

  seekPoints.push({ sampleNumber: 0xffffffffffffffff, offset: 0, samplesInFrame: 0 });

  const pointSize = 8 + 8 + 2;
  const data = new Uint8Array(seekPoints.length * pointSize);
  const view = new DataView(data.buffer);

  for (let i = 0; i < seekPoints.length; i++) {
    const p = seekPoints[i];
    view.setBigUint64(i * pointSize, BigInt.asUintN(64, BigInt(p.sampleNumber)), false);
    view.setBigUint64(i * pointSize + 8, BigInt.asUintN(64, BigInt(p.offset)), false);
    view.setUint16(i * pointSize + 16, p.samplesInFrame, false);
  }

  const header = buildMetadataBlockHeader(3, data.length, false);
  const block = new Uint8Array(header.length + data.length);
  block.set(header, 0);
  block.set(data, header.length);
  return block;
}

// ── MP4 → FLAC demuxer ──────────────────────────────────────────────

export function demuxMp4FlacToFlac(
  mp4Buffer: ArrayBuffer
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

  const streamInfo = metadataBlocks[0];
  const info = parseStreamInfo(streamInfo.slice(4));

  const frames = extractAudioFrames(buf, mdat);
  const seekTable = buildSeekTable(frames, info.sampleRate, info.minBlockSize, info.totalSamples);

  const magic = new TextEncoder().encode("fLaC");
  const parts: Uint8Array[] = [magic];

  const streamInfoCopy = new Uint8Array(streamInfo);
  streamInfoCopy[0] &= 0x7f;
  parts.push(streamInfoCopy);

  parts.push(seekTable);

  parts[parts.length - 1][0] |= 0x80;

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

export function insertVorbisCommentAndPicture(
  flacBuffer: ArrayBuffer,
  vorbisBlock: Uint8Array,
  pictureBlock: Uint8Array | null
): ArrayBuffer {
  const buf = new Uint8Array(flacBuffer);

  let offset = 4;
  const metaParts: Uint8Array[] = [];
  let lastMetaEnd = 4;

  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const blockSize = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    if (offset + 4 + blockSize > buf.length) break;
    metaParts.push(buf.slice(offset, offset + 4 + blockSize));
    offset += 4 + blockSize;
    if ((buf[offset - blockSize - 4] & 0x80) !== 0) {
      lastMetaEnd = offset;
      break;
    }
  }

  for (const block of metaParts) block[0] &= 0x7f;

  const newVorbis = new Uint8Array(vorbisBlock.length);
  newVorbis.set(vorbisBlock);
  newVorbis[0] &= 0x7f;

  const newPicture = pictureBlock ? new Uint8Array(pictureBlock.length) : null;
  if (newPicture && pictureBlock) {
    newPicture.set(pictureBlock);
    newPicture[0] &= 0x7f;
  }

  const frames = buf.slice(lastMetaEnd);
  const parts: Uint8Array[] = [buf.slice(0, 4), ...metaParts];

  if (newVorbis.length) parts.push(newVorbis);
  if (newPicture) parts.push(newPicture);
  parts.push(frames);

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }

  const lastMetaBlock = newPicture || newVorbis;
  if (lastMetaBlock.length) {
    const lastMetaOffset = pos - frames.length - lastMetaBlock.length;
    result[lastMetaOffset] |= 0x80;
  } else if (metaParts.length) {
    const lastMetaOffset = pos - frames.length - metaParts[metaParts.length - 1].length;
    result[lastMetaOffset] |= 0x80;
  }

  return result.buffer;
}

function detectMimeType(buffer: ArrayBuffer): string {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "image/jpeg";
}

export { detectMimeType };
