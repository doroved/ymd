/**
 * MP3 tagging wrapper around browserId3Writer
 */

declare const browserId3Writer: new (buffer: ArrayBuffer) => {
  setFrame(name: string, value: any): any;
  addTag(): void;
  getURL(): string;
};

export function tagMp3(
  mp3Buffer: ArrayBuffer,
  metadata: {
    title: string;
    artist: string;
    album: string;
    year: string;
    genre: string;
    trackNumber: string;
    publisher: string;
    coverBuffer: ArrayBuffer | null;
  },
  withTags: boolean
): string {
  const writer = new browserId3Writer(mp3Buffer);
  writer
    .setFrame("TIT2", metadata.title)
    .setFrame("TPE1", [metadata.artist])
    .setFrame("TPE2", metadata.artist)
    .setFrame("TALB", metadata.album)
    .setFrame("TYER", metadata.year);

  if (metadata.genre) {
    try { writer.setFrame("TCON", [metadata.genre]); } catch (_e) { /* ignore */ }
  }
  if (metadata.trackNumber) {
    try { writer.setFrame("TRCK", metadata.trackNumber); } catch (_e) { /* ignore */ }
  }
  if (metadata.publisher) {
    try { writer.setFrame("TPUB", metadata.publisher); } catch (_e) { /* ignore */ }
  }
  if (metadata.coverBuffer) {
    try {
      writer.setFrame("APIC", {
        type: 3,
        data: metadata.coverBuffer,
        description: "",
      });
    } catch (_e) { /* ignore */ }
  }

  if (withTags) writer.addTag();
  return writer.getURL();
}
