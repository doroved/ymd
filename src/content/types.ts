/**
 * Shared types for YMD content script modules
 */

export interface QueueItem {
  trackId: string;
  position: number;
  resolve: () => void;
  reject: (reason?: any) => void;
  onProgress?: (percent: number) => void;
}

export interface BulkTrackItem {
  trackId: string;
  position: number;
  trackData?: any;
  bulkContext?: BulkContext | null;
}

export interface BulkContext {
  type: "playlist" | "album";
  title: string;
}

export interface StorageConfig {
  quality?: string;
  format?: string;
  tags?: boolean;
  folder?: boolean;
  path?: string;
  position?: boolean;
  cover?: string;
}

export type ProgressCallback = (current: number, total: number, title: string) => void;
export type CheckCancelledFn = () => boolean;

export interface StreamInfo {
  url: string;
  codec: string;
  key?: string;
  transport: string;
}

export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  year: string;
  position: number;
  genre: string;
  publisher: string;
  trackNumber: string;
  coverRawUri?: string;
}

export interface ExtractedTrackMeta {
  trackId: string;
  position: number;
}
