/**
 * Bulk download logic for albums and playlists
 */
import type { BulkTrackItem, ProgressCallback, CheckCancelledFn } from "./types.ts";
import { downloadTrack } from "./download.ts";

export async function downloadBulk(
  tracks: BulkTrackItem[],
  progressCallback?: ProgressCallback | null,
  checkCancelled?: CheckCancelledFn | null,
  onTrackProgress?: ((percent: number) => void) | null
): Promise<void> {
  for (let i = 0; i < tracks.length; i++) {
    if (checkCancelled && checkCancelled()) {
      console.log("Bulk download cancelled by user.");
      break;
    }
    const item = tracks[i];
    if (progressCallback)
      progressCallback(i + 1, tracks.length, item.trackData?.title || "Unknown");
    try {
      await downloadTrack(
        item.trackId,
        item.position,
        item.trackData,
        item.bulkContext,
        onTrackProgress || undefined
      );
    } catch (e) {
      console.error(e);
    }
    if (i < tracks.length - 1) {
      for (let delay = 0; delay < 1000; delay += 100) {
        if (checkCancelled && checkCancelled()) break;
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
  }
}
