/**
 * Yandex Music API client + stream URL signer
 */
import type { StreamInfo } from "./types.ts";
import { getApiZone, getMusicOrigin } from "./utils.ts";

const SIGN_KEY = "7tvSmFbyf5hJnIHhCimDDD";

export const apiCall = async (endpoint: string, body: string): Promise<any> => {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
      "x-yandex-music-without-invocation-info": "1",
      "X-Requested-With": "XMLHttpRequest",
    },
    credentials: "include",
    body,
  })
    .then((res) => res.json())
    .catch(() => null);
};

async function signRequest(signString: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGN_KEY),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signString));
  return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer))).replace(/=+$/, "");
}

export const getStreamUrl = async (
  trackId: string,
  format: string,
  quality = "hq"
): Promise<StreamInfo | null> => {
  const timestamp = Math.floor(Date.now() / 1000);
  const apiHost = getApiZone();
  const origin = getMusicOrigin();

  if (format === "flac") {
    const signString = `${timestamp}${trackId}losslessflac-mp4raw`;
    const signature = await signRequest(signString);
    const signUrl =
      `https://${apiHost}/get-file-info?ts=${timestamp}&trackId=${trackId}` +
      `&quality=lossless&codecs=flac-mp4&transports=raw&sign=${encodeURIComponent(signature)}`;

    const info: any = await chrome.runtime.sendMessage({
      message: "downloadInfo",
      url: signUrl,
      headers: {
        "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
        "x-yandex-music-without-invocation-info": "1",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${origin}/`,
      },
    });

    if (info?.downloadInfo?.url) {
      return {
        url: decodeURIComponent(info.downloadInfo.url),
        codec: info.downloadInfo.codec || "flac-mp4",
        transport: info.downloadInfo.transport || "raw",
      };
    }

    // Fallback to MP3 if FLAC unavailable
    return getStreamUrl(trackId, "mp3", quality);
  }

  // MP3 path
  const signString = `${timestamp}${trackId}${quality}mp3raw`;
  const signature = await signRequest(signString);
  const signUrl =
    `https://${apiHost}/get-file-info?ts=${timestamp}&trackId=${trackId}` +
    `&quality=${quality}&codecs=mp3&transports=raw&sign=${encodeURIComponent(signature)}`;

  const info: any = await chrome.runtime.sendMessage({
    message: "downloadInfo",
    url: signUrl,
    headers: {
      "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
      "x-yandex-music-without-invocation-info": "1",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${origin}/`,
    },
  });

  if (info?.downloadInfo?.url) {
    return {
      url: decodeURIComponent(info.downloadInfo.url),
      codec: info.downloadInfo.codec || "mp3",
      transport: info.downloadInfo.transport || "raw",
    };
  }

  return null;
};
