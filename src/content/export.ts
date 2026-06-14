/**
 * Export album/playlist track list to TXT via Yandex Music API
 */
import type { BulkContext, BulkTrackItem } from "./types.ts";
import { triggerDownload } from "./save.ts";
import { getApiZone } from "./utils.ts";

export interface FetchedTracksResult {
  items: BulkTrackItem[];
  context: BulkContext;
}

interface TrackInfo {
  artist: string;
  title: string;
}

function sanitizeFilename(name: string): string {
  return name.replace(
    /[?:;"<>/\\|*]|^\s+|[\u200B-\u200D\uFEFF]/gi,
    (char) => (char === " " ? "" : "_")
  );
}

function extractTrackInfo(trackData: any): TrackInfo {
  const title: string = trackData?.title || "Unknown Title";
  const artist: string =
    trackData?.artists?.map((a: any) => a.name).join(", ") || "Unknown Artist";
  return { artist, title };
}

function formatTrackList(tracks: TrackInfo[]): string {
  return tracks.map((t) => `${t.artist} — ${t.title}`).join("\n") + "\n";
}

async function fetchJson(url: string): Promise<any> {
  return fetch(url, { credentials: "include" })
    .then((r) => r.json())
    .catch(() => null);
}

async function fetchPlaylistTracks(
  apiUrl: string,
  title: string
): Promise<FetchedTracksResult | null> {
  const items: BulkTrackItem[] = [];
  let page = 0;
  let totalPages = 1;

  do {
    const res = await fetchJson(`${apiUrl}${apiUrl.includes("?") ? "&" : "?"}page=${page}`);
    if (!res?.result?.tracks) return null;

    const result = res.result;
    const tracks = result.tracks;
    tracks.forEach((t: any) => {
      items.push({
        trackId: t.track?.id || t.id,
        position: items.length + 1,
        trackData: t.track || t,
        bulkContext: { type: "playlist", title },
      });
    });

    const pager = result.pager;
    if (pager && pager.total && pager.perPage) {
      totalPages = Math.ceil(pager.total / pager.perPage);
    }
    page++;
  } while (page < totalPages);

  return { items, context: { type: "playlist", title } };
}

async function fetchAlbumTracks(
  albumId: string
): Promise<FetchedTracksResult | null> {
  const apiHost = getApiZone();
  const baseUrl = `https://${apiHost}/albums/${albumId}/with-tracks?resumeStream=false&richTracks=true&withListeningFinished=true`;
  const res = await fetchJson(baseUrl);
  if (!res?.result) return null;

  const result = res.result;
  const title: string = result.title || "Unknown Album";
  const items: BulkTrackItem[] = [];

  if (Array.isArray(result.volumes)) {
    result.volumes.forEach((volume: any) => {
      if (Array.isArray(volume)) {
        volume.forEach((t: any) => {
          items.push({
            trackId: t.id,
            position: items.length + 1,
            trackData: t,
            bulkContext: { type: "album", title },
          });
        });
      }
    });
  }

  // Some album responses use a pager with a single flat track list
  if (items.length === 0 && Array.isArray(result.tracks)) {
    result.tracks.forEach((t: any) => {
      items.push({
        trackId: t.id,
        position: items.length + 1,
        trackData: t,
        bulkContext: { type: "album", title },
      });
    });
  }

  if (items.length === 0) return null;
  return { items, context: { type: "album", title } };
}

export async function fetchPlaylistAlbumTracks(): Promise<FetchedTracksResult | null> {
  const path = window.location.pathname;
  const apiHost = getApiZone();

  const playlistUserMatch = path.match(/\/users\/([^/]+)\/playlists\/(\d+)/i);
  if (playlistUserMatch) {
    const user = playlistUserMatch[1];
    const kind = playlistUserMatch[2];
    const apiUrl = `https://${apiHost}/users/${user}/playlists/${kind}?resumeStream=false&richTracks=true`;
    const titleRes = await fetchJson(apiUrl);
    const title: string = titleRes?.result?.title || "Unknown Playlist";
    return fetchPlaylistTracks(apiUrl, title);
  }

  const playlistIdMatch = path.match(/\/playlists\/([^/]+)/i);
  if (playlistIdMatch) {
    const playlistId = playlistIdMatch[1];
    const apiUrl = `https://${apiHost}/playlist/${playlistId}?resumeStream=false&richTracks=true`;
    const titleRes = await fetchJson(apiUrl);
    const title: string = titleRes?.result?.title || "Unknown Playlist";
    return fetchPlaylistTracks(apiUrl, title);
  }

  const albumMatch = path.match(/\/album\/(\d+)/i);
  if (albumMatch) {
    return fetchAlbumTracks(albumMatch[1]);
  }

  return null;
}

export async function exportTrackList(): Promise<void> {
  const result = await fetchPlaylistAlbumTracks();
  if (!result || result.items.length === 0) {
    alert(
      "Не удалось получить список треков. Пожалуйста, убедитесь, что вы на странице плейлиста или альбома."
    );
    return;
  }

  const tracks = result.items.map((item) => extractTrackInfo(item.trackData));
  const text = formatTrackList(tracks);
  const filename = `${sanitizeFilename(result.context.title)}.txt`;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
