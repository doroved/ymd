/**
 * Utility helpers
 */

export function getApiZone(): string {
  const host = typeof location !== "undefined" ? location.host : "";
  const match = host.match(/music\.ya(?:ndex|ndex)\.([a-z]+)/i);
  return match?.[1] ? `api.music.yandex.${match[1]}` : "api.music.yandex.ru";
}

export function getMusicOrigin(): string {
  const host = typeof location !== "undefined" ? location.host : "music.yandex.ru";
  return `https://${host}`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(
    /[?:;"<>/\\|*]|^\s+|[\u200B-\u200D\uFEFF]/gi,
    (char) => (char === " " ? "" : "_")
  );
}

export function getFileExtension(format: string, actualCodec?: string): string {
  if (actualCodec === "flac-mp4" || actualCodec === "flac") return ".flac";
  if (format === "flac" && (!actualCodec || actualCodec.includes("flac"))) return ".flac";
  return ".mp3";
}

export function buildFolderPath(
  configPath: string,
  bulkContext: { type: string; title: string } | null
): string {
  const basePath = configPath.trim().replace(/[?:;"<>/\\|*]/gi, "_");
  if (!bulkContext) return `${basePath}/tracks/`;

  const cleanTitle = bulkContext.title.trim().replace(/[?:;"<>/\\|*]/gi, "_");
  if (bulkContext.type === "playlist") {
    return `${basePath}/playlists/${cleanTitle}/`;
  }
  if (bulkContext.type === "album") {
    return `${basePath}/albums/${cleanTitle}/`;
  }
  return `${basePath}/tracks/`;
}
