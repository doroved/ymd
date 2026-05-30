/**
 * Yandex Music Downloader - Background Service Worker
 * Focuses 100% on managing message queues, proxying API requests, and saving files.
 * NO tracking, NO adware, NO dynamic redirect rules.
 */

// Promisified chrome API helper
const promisify = (fn) => {
  return (...args) => new Promise((resolve, reject) => {
    try {
      fn(...args, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(result);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
};

const storage = {
  get: promisify(chrome.storage.local.get.bind(chrome.storage.local)),
  set: promisify(chrome.storage.local.set.bind(chrome.storage.local)),
  remove: promisify(chrome.storage.local.remove.bind(chrome.storage.local)),
  async isEmpty(key) {
    const data = await this.get(key);
    return !data || (typeof data === 'object' && Object.keys(data).length === 0);
  }
};

const tabs = {
  create: promisify(chrome.tabs.create.bind(chrome.tabs))
};

// Initialize default storage configuration
const initDefaultConfig = async () => {
  const defaults = {
    quality: "hq",     // Default to high quality (hq = 320kbps, lq = 128kbps)
    tags: true,        // Save ID3 tags (artwork, title, artists, album)
    folder: false,     // Save to subfolders (структурирование по умолчанию включено!)
    path: "YMDownloader", // Subfolder name
    position: false,    // Prefix filename with track list position (индексация по умолчанию включена!)
    cover: "400x400"   // Cover image resolution
  };

  for (const [key, val] of Object.entries(defaults)) {
    if (await storage.isEmpty(key)) {
      await storage.set({ [key]: val });
    }
  }
};

// Listen for action click to open Yandex Music
chrome.action.onClicked.addListener(() => {
  tabs.create({ url: "https://music.yandex.ru" });
});

// Setup listeners on startup and installation
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
  }
  await initDefaultConfig();
});

chrome.runtime.onStartup.addListener(async () => {
  await initDefaultConfig();
});

// Message listener for content script requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.message === "trackMetadata") {
    // Proxy request to tracks endpoint to fetch precise JSON metadata
    const url = "https://api.music.yandex.ru/tracks";
    const body = `trackIds=${message.trackId}&removeDuplicates=false&withProgress=true`;

    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
        "x-yandex-music-without-invocation-info": "1",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://music.yandex.ru/"
      },
      body: body
    })
      .then(async (response) => {
        if (!response.ok) {
          sendResponse(false);
          return;
        }
        try {
          const json = await response.json();
          sendResponse(json);
        } catch (e) {
          sendResponse(false);
        }
      })
      .catch((err) => {
        console.error("Metadata proxy fetch failed:", err);
        sendResponse(false);
      });

    return true; // Keep channel open
  }

  if (message.message === "downloadInfo") {
    // Proxy Yandex Music API requests to bypass CORS
    fetch(message.url, { headers: message.headers })
      .then(async (response) => {
        if (!response.ok) {
          sendResponse(false);
          return;
        }
        try {
          const json = await response.json();
          sendResponse(json);
        } catch (e) {
          sendResponse({ error: "Invalid JSON response from Yandex API" });
        }
      })
      .catch((err) => {
        console.error("API proxy fetch failed:", err);
        sendResponse(false);
      });

    return true; // Keep message channel open for asynchronous response
  }

  if (message.message === "download") {
    // Initiate system download via chrome.downloads API
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      conflictAction: "overwrite"
    }, () => {
      // In case of filename errors (e.g. invalid chars on specific OS), fallback to random filename
      if (chrome.runtime.lastError) {
        console.warn("Filename download failed, retrying with fallback name. Error:", chrome.runtime.lastError.message);
        const fallbackName = `${Math.floor(Math.random() * 1e15)}.mp3`;

        chrome.downloads.download({
          url: message.url,
          filename: fallbackName,
          conflictAction: "overwrite"
        }, () => {
          sendResponse({ status: "done", message: "100%", url: message.url });
        });
      } else {
        sendResponse({ status: "done", message: "100%", url: message.url });
      }
    });

    return true; // Keep channel open
  }

  if (message.message === "check") {
    // Just a placeholder to ensure communication works
    sendResponse({ status: false });
    return true;
  }
});
