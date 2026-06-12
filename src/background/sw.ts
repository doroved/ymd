/// <reference types="chrome" />

/**
 * Yandex Music Downloader - Background Service Worker
 * Focuses 100% on managing message queues, proxying API requests, and saving files.
 * NO tracking, NO adware, NO dynamic redirect rules.
 */

// ── Message interfaces ──────────────────────────────────────────────

interface TrackMetadataMessage {
  message: "trackMetadata";
  trackId: string;
}

interface DownloadInfoMessage {
  message: "downloadInfo";
  url: string;
  headers: Record<string, string>;
}

interface DownloadMessage {
  message: "download";
  url: string;
  filename: string;
}

interface DownloadBytesMessage {
  message: "downloadBytes";
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

interface CheckMessage {
  message: "check";
}

type ExtensionMessage =
  | TrackMetadataMessage
  | DownloadInfoMessage
  | DownloadMessage
  | DownloadBytesMessage
  | CheckMessage;

// ── Default config ──────────────────────────────────────────────────

interface DefaultConfig {
  quality: string;
  format: string;
  tags: boolean;
  folder: boolean;
  path: string;
  position: boolean;
  cover: string;
}

// ── Promisified chrome API helper ───────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const promisify = <TResult>(fn: (...args: any[]) => void) => {
  return (...args: unknown[]): Promise<TResult> =>
    new Promise((resolve, reject) => {
      try {
        fn(...args, (result: unknown) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(result as TResult);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
};

const storage = {
  get: promisify<Record<string, unknown>>(
    chrome.storage.local.get.bind(chrome.storage.local)
  ),
  set: promisify<void>(chrome.storage.local.set.bind(chrome.storage.local)),
  remove: promisify<void>(
    chrome.storage.local.remove.bind(chrome.storage.local)
  ),
  async isEmpty(key: string): Promise<boolean> {
    const data = await this.get(key);
    return (
      !data || (typeof data === "object" && Object.keys(data).length === 0)
    );
  },
};

const tabs = {
  create: promisify<chrome.tabs.Tab>(
    chrome.tabs.create.bind(chrome.tabs)
  ),
};

// ── Initialize default storage configuration ───────────────────────

const initDefaultConfig = async (): Promise<void> => {
  const defaults: DefaultConfig = {
    quality: "hq",
    format: "mp3",
    tags: true,
    folder: false,
    path: "YMDownloader",
    position: false,
    cover: "400x400",
  };

  for (const [key, val] of Object.entries(defaults)) {
    if (await storage.isEmpty(key)) {
      await storage.set({ [key]: val });
    }
  }
};

// ── Listen for action click to open Yandex Music ────────────────────

chrome.action.onClicked.addListener(() => {
  tabs.create({ url: chrome.runtime.getURL("src/options/options.html") });
});

// ── Filename override bridge for Chrome (UUID blob URL workaround) ──
// When other extensions register onDeterminingFilename and return without
// calling suggest(), Chrome falls back to the blob URL's UUID as filename.
// We persist the real filename keyed by blob URL so our listener can
// suggest the correct name even though item.filename holds the UUID.

const pendingFilenames = new Map<string, string>();

if (chrome.downloads?.onDeterminingFilename && !/firefox/i.test(navigator.userAgent)) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId === chrome.runtime.id) {
      const realName = pendingFilenames.get(item.url) || item.filename;
      suggest({ filename: realName, conflictAction: "overwrite" });
    }
  });
}

// ── Setup listeners on startup and installation ─────────────────────

chrome.runtime.onInstalled.addListener(
  async (details: chrome.runtime.InstalledDetails) => {
    if (details.reason === "install") {
      tabs.create({ url: chrome.runtime.getURL("src/welcome/welcome.html") });
    }
    if (details.reason === "update") {
      tabs.create({ url: chrome.runtime.getURL("src/changelog/changelog.html") });
    }
    await initDefaultConfig();
  }
);

chrome.runtime.onStartup.addListener(async () => {
  await initDefaultConfig();
});

// ── Message listener for content script requests ────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): boolean | undefined => {
    if (message.message === "trackMetadata") {
      const url = "https://api.music.yandex.ru/tracks";
      const body = `trackIds=${message.trackId}&removeDuplicates=false&withProgress=true`;

      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
          "x-yandex-music-without-invocation-info": "1",
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://music.yandex.ru/",
        },
        body: body,
      })
        .then(async (response: Response) => {
          if (!response.ok) {
            sendResponse(false);
            return;
          }
          try {
            const json: unknown = await response.json();
            sendResponse(json);
          } catch (_e) {
            sendResponse(false);
          }
        })
        .catch((err: unknown) => {
          console.error("Metadata proxy fetch failed:", err);
          sendResponse(false);
        });

      return true;
    }

    if (message.message === "downloadInfo") {
      fetch(message.url, { headers: message.headers })
        .then(async (response: Response) => {
          if (!response.ok) {
            sendResponse(false);
            return;
          }
          try {
            const json: unknown = await response.json();
            sendResponse(json);
          } catch (_e) {
            sendResponse({ error: "Invalid JSON response from Yandex API" });
          }
        })
        .catch((err: unknown) => {
          console.error("API proxy fetch failed:", err);
          sendResponse(false);
        });

      return true;
    }

    // Chrome: blob URL from content script (original behavior)
    if (message.message === "download") {
      // Bridge real filename for onDeterminingFilename — Chrome replaces
      // blob URL filename with UUID when other extensions register listeners.
      pendingFilenames.set(message.url, message.filename);

      chrome.downloads.download(
        {
          url: message.url,
          filename: message.filename,
          conflictAction: "overwrite",
        },
        () => {
          if (chrome.runtime.lastError) {
            console.warn(
              "Filename download failed, retrying with fallback name. Error:",
              chrome.runtime.lastError.message
            );
            const ext = message.filename.split(".").pop() || "mp3";
            const fallbackName = `${Math.floor(Math.random() * 1e15)}.${ext}`;

            chrome.downloads.download(
              {
                url: message.url,
                filename: fallbackName,
                conflictAction: "overwrite",
              },
              () => {
                pendingFilenames.delete(message.url);
                sendResponse({ status: "done" });
              }
            );
          } else {
            // Clean up after a delay to ensure onDeterminingFilename fired
            setTimeout(() => pendingFilenames.delete(message.url), 5000);
            sendResponse({ status: "done" });
          }
        }
      );

      return true;
    }

    // Firefox: Uint8Array bytes → background script creates blob URL → download
    if (message.message === "downloadBytes") {
      try {
        const blob = new Blob([message.bytes as unknown as ArrayBuffer], {
          type: message.mimeType,
        });
        const url = URL.createObjectURL(blob);

        chrome.downloads.download(
          {
            url: url,
            filename: message.filename,
            conflictAction: "overwrite",
          },
          () => {
            if (chrome.runtime.lastError) {
              console.warn(
                "Filename download failed, retrying with fallback name. Error:",
                chrome.runtime.lastError.message
              );
              const ext = message.filename.split(".").pop() || "mp3";
              const fallbackName = `${Math.floor(Math.random() * 1e15)}.${ext}`;

              chrome.downloads.download(
                {
                  url: url,
                  filename: fallbackName,
                  conflictAction: "overwrite",
                },
                () => {
                  URL.revokeObjectURL(url);
                  sendResponse({ status: "done" });
                }
              );
            } else {
              URL.revokeObjectURL(url);
              sendResponse({ status: "done" });
            }
          }
        );
      } catch (err) {
        console.error("Download failed:", err);
        sendResponse({ status: "error", message: String(err) });
      }

      return true;
    }

    if (message.message === "check") {
      sendResponse({ status: false });
      return true;
    }

    return undefined;
  }
);
