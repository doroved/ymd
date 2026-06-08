/**
 * Download queue manager
 */
import type { QueueItem } from "./types.ts";
import { downloadTrack } from "./download.ts";

const queue: QueueItem[] = [];
let activeDownloads = 0;
const MAX_CONCURRENT = 7;

async function processQueue(): Promise<void> {
  if (activeDownloads >= MAX_CONCURRENT || queue.length === 0) return;
  activeDownloads++;
  const { trackId, position, resolve, reject, onProgress } = queue.shift()!;
  try {
    await downloadTrack(trackId, position, null, null, onProgress);
    resolve();
  } catch (e) {
    reject(e);
  } finally {
    activeDownloads--;
    processQueue();
  }
}

export function enqueueDownload(
  trackId: string,
  position: number,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queue.push({ trackId, position, resolve, reject, onProgress });
    processQueue();
  });
}
