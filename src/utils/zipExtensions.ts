import * as fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// archiver v8 exports named classes (ZipArchive, TarArchive, etc.)
// but @types/archiver still describes the v7 API, so we use `any` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ZipArchive } = require("archiver") as any;

const chromeDir = Bun.pathToFileURL("extension/chrome/").pathname;
const firefoxDir = Bun.pathToFileURL("extension/firefox/").pathname;
const releaseDir = Bun.pathToFileURL("extension/releases/").pathname;

fs.mkdirSync(releaseDir, { recursive: true });

function zipDirectory(source: string, out: string): void {
  const output = fs.createWriteStream(out);
  const archive = new ZipArchive({
    zlib: { level: 9 },
  });

  output.on("close", () => {
    const archiveSize = (archive.pointer() / 1024).toFixed(2);
    const archiveName = out.substring(out.lastIndexOf("/") + 1);

    const formattedPath = `\x1b[38;5;250mextension/releases/\x1b[0m${archiveName}`;
    const formattedSize = `\x1b[38;5;250m${archiveSize} kB\x1b[0m`;

    console.log(`${formattedPath}\t${formattedSize}`);
  });

  archive.on("error", (err: Error) => {
    throw err;
  });

  archive.pipe(output);
  archive.directory(source, false);
  archive.finalize();
}

async function getVersion(manifestPath: string): Promise<string> {
  const file = Bun.file(manifestPath);
  const manifest = await file.json();
  return manifest.version;
}

async function createZips(): Promise<void> {
  const chromeVersion = await getVersion("extension/chrome/manifest.json");
  const firefoxVersion = await getVersion("extension/firefox/manifest.json");

  const chromeZip = `${releaseDir}ymd-chrome-v${chromeVersion}.zip`;
  const firefoxZip = `${releaseDir}ymd-firefox-v${firefoxVersion}.zip`;

  zipDirectory(chromeDir, chromeZip);
  zipDirectory(firefoxDir, firefoxZip);
}

createZips().catch(console.error);
