/**
 * Track download orchestration: fetch metadata, stream, decrypt, tag, and dispatch
 */
import type { StorageConfig, StreamInfo, BulkContext } from "./types.ts";
import { apiCall, getStreamUrl } from "./api.ts";
import { decryptAesCtr } from "./crypto.ts";
import { demuxMp4FlacToFlac, buildVorbisCommentBlock } from "./flac.ts";
import { tagMp3 } from "./mp3.ts";
import { sanitizeFilename, getFileExtension, buildFolderPath } from "./utils.ts";
import { triggerDownload } from "./save.ts";

async function fetchTrackMetadata(trackId: string): Promise<any> {
  const apiResponse = await apiCall(
    "https://api.music.yandex.ru/tracks",
    `trackIds=${trackId}&removeDuplicates=false&withProgress=true`
  );
  if (!apiResponse || !apiResponse[0]) {
    throw new Error(`API Metadata extraction failed for track ${trackId}`);
  }
  return apiResponse[0];
}

async function fetchWithProgress(
  url: string,
  onProgress?: (percent: number) => void
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  const contentLength = parseInt(response.headers.get("Content-Length") || "0", 10);

  if (!contentLength || !response.body) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.round((received / contentLength) * 100));
  }

  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

async function fetchCover(coverRawUri: string | undefined, coverSize: string): Promise<ArrayBuffer | null> {
  if (!coverRawUri) return null;
  const coverCleanUrl = (
    coverRawUri.startsWith("http") ? coverRawUri : `https://${coverRawUri}`
  ).replace("%%", coverSize);
  return fetch(coverCleanUrl)
    .then((res) => res.arrayBuffer())
    .catch(() => null);
}

function extractMetadata(trackData: any, fallbackPosition: number) {
  const title: string = trackData.title || "Unknown Track";
  const artist: string =
    trackData.artists?.map((a: any) => a.name).join(", ") || "Unknown Artist";
  const albumData: any = trackData.albums?.[0] || null;
  const album: string = albumData?.title || "";
  const year: string = albumData?.year || "";
  const position: number = albumData?.trackPosition?.index || fallbackPosition;
  const genre: string = albumData?.genre || "";
  const publisher: string =
    albumData?.labels?.map((l: any) => l.name).join(", ") || "";

  const trackNumber: string = albumData?.trackPosition
    ? `${albumData.trackPosition.index}/${albumData.trackCount}`
    : fallbackPosition > 0
      ? `${fallbackPosition}`
      : "";

  const coverRawUri: string | undefined =
    trackData.coverUri || albumData?.coverUri || trackData.ogImage;

  return { title, artist, album, year, position, genre, publisher, trackNumber, coverRawUri };
}

export async function downloadTrack(
  trackId: string,
  fallbackPosition: number,
  preFetchedMetadata: any = null,
  bulkContext: BulkContext | null = null,
  onProgress?: (percent: number) => void
): Promise<void> {
  const config: StorageConfig = await chrome.storage.local.get([
    "quality", "format", "tags", "folder", "path", "position", "cover",
  ]);
  const format = config.format || "mp3";
  const coverSize = config.cover || "400x400";

  const trackData = preFetchedMetadata || (await fetchTrackMetadata(trackId));
  const meta = extractMetadata(trackData, fallbackPosition);

  const streamInfo = await getStreamUrl(trackId, format, config.quality || "hq");
  if (!streamInfo) {
    throw new Error("Could not retrieve Yandex stream URL");
  }

  // Fetch audio with progress
  let audioBuffer: ArrayBuffer;
  if (streamInfo.transport === "encraw" && streamInfo.key) {
    const encrypted = await fetchWithProgress(streamInfo.url, onProgress);
    audioBuffer = await decryptAesCtr(encrypted, streamInfo.key);
  } else {
    audioBuffer = await fetchWithProgress(streamInfo.url, onProgress);
  }

  // Fetch cover
  const coverBuffer = await fetchCover(meta.coverRawUri, coverSize);

  // Determine actual output format
  const isFlac = streamInfo.codec === "flac-mp4" || streamInfo.codec === "flac";
  const actualFormat = isFlac ? "flac" : "mp3";
  const ext = getFileExtension(format, streamInfo.codec);

  let blobUrl: string;

  if (isFlac) {
    // Demux MP4 → FLAC
    let flacBuffer = demuxMp4FlacToFlac(audioBuffer, coverBuffer);

    // Inject Vorbis Comments if tags enabled
    if (config.tags !== false) {
      const vorbisBlock = buildVorbisCommentBlock({
        TITLE: meta.title,
        ARTIST: meta.artist,
        ALBUM: meta.album,
        DATE: meta.year,
        GENRE: meta.genre,
        TRACKNUMBER: meta.trackNumber,
        ORGANIZATION: meta.publisher,
      });
      // Insert after STREAMINFO (first block) and before audio frames
      flacBuffer = insertVorbisCommentBlock(flacBuffer, vorbisBlock);
    }

    const blob = new Blob([flacBuffer], { type: "audio/flac" });
    blobUrl = URL.createObjectURL(blob);
  } else {
    // MP3 path
    blobUrl = tagMp3(
      audioBuffer,
      {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        year: meta.year,
        genre: meta.genre,
        trackNumber: meta.trackNumber,
        publisher: meta.publisher,
        coverBuffer,
      },
      config.tags !== false
    );
  }

  // Build filename
  const cleanFilename = `${sanitizeFilename(meta.artist)} - ${sanitizeFilename(meta.title)}${ext}`;
  const positionPrefix =
    config.position === true && bulkContext && meta.position > 0
      ? `${meta.position}. `
      : "";

  let finalFolder = "";
  if (config.folder === true && config.path) {
    finalFolder = buildFolderPath(config.path, bulkContext);
  }

  const filename = `${finalFolder}${positionPrefix}${cleanFilename}`;

  if (isFlac) {
    // Download FLAC directly from content script (MV3 blob scope fix)
    triggerDownload(blobUrl, filename);
    return;
  }

  // MP3: send to service worker
  return new Promise<void>((resolve) => {
    chrome.runtime.sendMessage(
      { message: "download", url: blobUrl, filename },
      () => {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        resolve();
      }
    );
  });
}

function insertVorbisCommentBlock(flacBuffer: ArrayBuffer, vorbisBlock: Uint8Array): ArrayBuffer {
  const buf = new Uint8Array(flacBuffer);
  // Skip "fLaC" magic
  let offset = 4;
  // Walk metadata blocks to find where they end
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const isLast = (buf[offset] & 0x80) !== 0;
    const blockSize = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    if (isLast) {
      // Insert our block before this last one, and mark this one as not-last
      const lastBlockData = buf.slice(offset, offset + 4 + blockSize);
      lastBlockData[0] &= 0x7f; // clear last flag
      const newBlock = new Uint8Array(vorbisBlock.length);
      newBlock.set(vorbisBlock);
      newBlock[0] |= 0x80; // mark as last

      const before = buf.slice(0, offset);
      const after = buf.slice(offset + 4 + blockSize);
      const result = new Uint8Array(before.length + lastBlockData.length + newBlock.length + after.length);
      let pos = 0;
      result.set(before, pos); pos += before.length;
      result.set(lastBlockData, pos); pos += lastBlockData.length;
      result.set(newBlock, pos); pos += newBlock.length;
      result.set(after, pos);
      return result.buffer;
    }
    offset += 4 + blockSize;
  }
  // If no last block found, append at end
  const result = new Uint8Array(buf.length + vorbisBlock.length);
  result.set(buf, 0);
  vorbisBlock[0] |= 0x80;
  result.set(vorbisBlock, buf.length);
  return result.buffer;
}
