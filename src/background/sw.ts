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

interface CheckMessage {
  message: "check";
}

type ExtensionMessage =
  | TrackMetadataMessage
  | DownloadInfoMessage
  | DownloadMessage
  | CheckMessage;

interface DownloadResponse {
  status: string;
  message: string;
  url: string;
}

// ── Default config ──────────────────────────────────────────────────

interface DefaultConfig {
  quality: string;
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
  tabs.create({ url: "https://music.yandex.ru" });
});

// ── Setup listeners on startup and installation ─────────────────────

chrome.runtime.onInstalled.addListener(
  async (details: chrome.runtime.InstalledDetails) => {
    if (details.reason === "install") {
      tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
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

    if (message.message === "download") {
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
            const fallbackName = `${Math.floor(Math.random() * 1e15)}.mp3`;

            chrome.downloads.download(
              {
                url: message.url,
                filename: fallbackName,
                conflictAction: "overwrite",
              },
              () => {
                const response: DownloadResponse = {
                  status: "done",
                  message: "100%",
                  url: message.url,
                };
                sendResponse(response);
              }
            );
          } else {
            const response: DownloadResponse = {
              status: "done",
              message: "100%",
              url: message.url,
            };
            sendResponse(response);
          }
        }
      );

      return true;
    }

    if (message.message === "check") {
      sendResponse({ status: false });
      return true;
    }

    return undefined;
  }
);
