/**
 * Track download orchestration: fetch metadata, stream, decrypt, tag, and dispatch
 */
import type { StorageConfig, StreamInfo, BulkContext } from "./types.ts";
import { apiCall, getStreamUrl } from "./api.ts";
import { demuxMp4FlacToFlac, buildVorbisCommentBlock, buildPictureBlock, insertVorbisCommentAndPicture } from "./flac.ts";
import { tagMp3 } from "./mp3.ts";
import { sanitizeFilename, getFileExtension, buildFolderPath, getApiZone } from "./utils.ts";
import { triggerDownload } from "./save.ts";

function detectMimeType(buffer: ArrayBuffer): string {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "image/jpeg";
}


async function fetchTrackMetadata(trackId: string): Promise<any> {
  const apiHost = getApiZone();
  const apiResponse = await apiCall(
    `https://${apiHost}/tracks`,
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
  const audioBuffer = await fetchWithProgress(streamInfo.url, onProgress);

  // Fetch cover
  const coverBuffer = await fetchCover(meta.coverRawUri, coverSize);

  // Determine actual output format
  const isFlac = streamInfo.codec === "flac-mp4" || streamInfo.codec === "flac";
  const actualFormat = isFlac ? "flac" : "mp3";
  const ext = getFileExtension(format, streamInfo.codec);

  let blobUrl: string;
  let flacBuffer: ArrayBuffer | undefined;

  if (isFlac) {
    // Demux MP4 → FLAC (STREAMINFO + SEEKTABLE)
    flacBuffer = demuxMp4FlacToFlac(audioBuffer);

    // Inject Vorbis Comments and optional cover art
    if (config.tags !== false || coverBuffer) {
      const vorbisBlock = config.tags !== false
        ? buildVorbisCommentBlock({
            TITLE: meta.title,
            ARTIST: meta.artist,
            ALBUM: meta.album,
            DATE: meta.year,
            GENRE: meta.genre,
            TRACKNUMBER: meta.trackNumber,
            ORGANIZATION: meta.publisher,
          })
        : new Uint8Array(0);
      const pictureBlock = coverBuffer
        ? buildPictureBlock(detectMimeType(coverBuffer), coverBuffer)
        : null;

      if (vorbisBlock.length || pictureBlock) {
        flacBuffer = insertVorbisCommentAndPicture(flacBuffer, vorbisBlock, pictureBlock);
      }
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

  const isFirefox = navigator.vendor === "";

  if (isFirefox) {
    // Firefox: Uint8Array + background script (avoids content script restrictions)
    const buffer = isFlac
      ? flacBuffer!
      : await fetch(blobUrl).then((r) => r.arrayBuffer());

    // Deep-clone into a fresh Uint8Array so structured clone in Firefox
    // does not trip over cross-context ArrayBuffer constructors.
    const original = new Uint8Array(buffer);
    const clone = new Uint8Array(original.length);
    clone.set(original);

    chrome.runtime.sendMessage({
      message: "downloadBytes",
      bytes: clone,
      filename,
      mimeType: isFlac ? "audio/flac" : "audio/mpeg",
    });
    return;
  }

  // Chrome:
  // FLAC downloaded directly from content script (blob URL not accessible in SW)
  // MP3 sent to service worker (blob URL, not bytes — Chrome sendMessage limit 64MiB)
  if (isFlac) {
    triggerDownload(blobUrl, filename);
    return;
  }

  // Chrome MP3: send blob URL to service worker
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


