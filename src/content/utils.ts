/**
 * Utility helpers
 */

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
