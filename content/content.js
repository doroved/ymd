/**
 * Yandex Music Downloader - Content Script
 * Handles page scanning, button injection, DOM metadata parsing, ID3 tagging, and queueing downloads.
 * Beautifully refactored to be clean, readable, and performant.
 */

(() => {
  const browserApi = globalThis.browser || globalThis.chrome;

  /**
   * Helper class to manage extension local storage.
   */
  class StorageHelper {
    static get(keys) {
      return new Promise((resolve) => {
        browserApi.storage.local.get(keys, (result) => {
          resolve(result);
        });
      });
    }
  }

  /**
   * Helper class to sanitize file and folder names.
   */
  class PathSanitizer {
    static sanitize(name) {
      // Remove illegal characters for OS file paths: ? : ; " < > / \ | *
      // Also removes zero-width spaces
      return name.replace(/[?:;"<>\/\\|*]|^\s+|[\u200B-\u200D\uFEFF]/gi, (char) => {
        if (char === " " || char.match(/[\u200B-\u200D\uFEFF]/)) {
          return "";
        }
        return "_";
      });
    }
  }

  /**
   * Helper class to generate HMAC-SHA256 signatures for Yandex Music API.
   */
  class SignatureGenerator {
    static #HMAC_SALT = "7tvSmFbyf5hJnIHhCimDDD";

    /**
     * Generates signed URL to fetch track stream info
     * @param {string} trackId Unique identifier of the track
     * @param {string} quality Audio quality ('lq' or 'hq')
     */
    static async generate(trackId, quality) {
      const timestamp = Math.floor(Date.now() / 1000);
      const signString = `${timestamp}${trackId}${quality}mp3raw`;

      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(SignatureGenerator.#HMAC_SALT),
        { name: "HMAC", hash: { name: "SHA-256" } },
        false,
        ["sign"]
      );

      const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signString));
      const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer))).replace(/=+$/, "");

      const encodedCodecs = encodeURIComponent("mp3");
      const url = `https://api.music.yandex.ru/get-file-info?ts=${timestamp}&trackId=${trackId}&quality=${quality}&codecs=${encodedCodecs}&transports=raw&sign=${encodeURIComponent(signature)}`;

      return { timestamp, signature, url };
    }
  }

  /**
   * Extracts minimal identifiers from Yandex Music track DOM elements.
   */
  class DOMMetadataExtractor {
    /**
     * Parses track DOM element to find track ID and default position
     * @param {HTMLElement} element Track DOM container
     */
    static extract(element) {
      let trackId = null;
      let position = 0;

      // 1. Extract position in playlist from DOM
      try {
        const posText = element.querySelector("div[class*='PlayButtonWithPosition_root']")?.textContent || "0";
        position = parseInt(posText, 10) || 0;
      } catch (e) {
        position = 0;
      }

      // 2. Extract track ID from any link containing "/track/" inside container
      try {
        const links = element.querySelectorAll("a");
        for (const link of links) {
          const href = link.getAttribute("href") || "";
          if (href.includes("/track/")) {
            // Href format is usually /album/123/track/456 or /track/456
            const parts = href.split("/");
            const trackIdx = parts.indexOf("track");
            if (trackIdx !== -1 && parts[trackIdx + 1]) {
              trackId = parts[trackIdx + 1];
              break;
            }
          }
        }
      } catch (e) {
        console.error("DOM trackId extraction failed:", e);
      }

      // Fallback: search track-id attribute if page elements are heavily customized
      if (!trackId) {
        trackId = element.getAttribute("track-id") || element.getAttribute("data-track-id");
      }

      return trackId ? { trackId, position } : null;
    }
  }

  /**
   * Manages downloading queue to fetch data, generate ID3 tags, and trigger browser downloads.
   */
  class DownloadQueue {
    static #MAX_CONCURRENT_DOWNLOADS = 7;
    #activeCount = 0;
    #queue = [];

    /**
     * Adds track to download queue or triggers immediate execution if under threshold
     */
    enqueue(buttonElement, trackId, position) {
      this.#activeCount += 1;

      if (this.#activeCount > DownloadQueue.#MAX_CONCURRENT_DOWNLOADS) {
        this.#queue.push([buttonElement, trackId, position]);
      } else {
        this.#processDownload(buttonElement, trackId, position);
      }
    }

    /**
     * Orchestrates track download: gets API metadata, signs request, fetches MP3, gets cover, writes ID3 tags, saves file.
     */
    async #processDownload(buttonElement, trackId, fallbackPosition) {
      const config = await StorageHelper.get(["quality", "tags", "folder", "path", "position", "cover"]);
      const quality = config.quality || "hq";
      const coverSize = config.cover || "400x400";

      try {
        // 1. Fetch precise metadata via official api.music.yandex.ru/tracks.
        // Doing the fetch directly in the Content Script context automatically inherits
        // the user's authorized session cookies (like Session_id) for same-site API requests.
        const metadataUrl = "https://api.music.yandex.ru/tracks";
        const metadataBody = `trackIds=${trackId}&removeDuplicates=false&withProgress=true`;

        const apiResponse = await fetch(metadataUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
            "x-yandex-music-without-invocation-info": "1",
            "X-Requested-With": "XMLHttpRequest"
          },
          credentials: "include",
          body: metadataBody
        }).then(res => res.json()).catch(err => {
          console.error("Direct metadata fetch error:", err);
          return null;
        });

        if (!apiResponse || !Array.isArray(apiResponse) || apiResponse.length === 0) {
          throw new Error(`Failed to fetch API metadata for track ${trackId}`);
        }

        const trackData = apiResponse[0];

        const title = trackData.title || "Unknown Track";
        const artist = Array.isArray(trackData.artists)
          ? trackData.artists.map(a => a.name).join(", ")
          : "Unknown Artist";

        const albumData = (Array.isArray(trackData.albums) && trackData.albums.length > 0)
          ? trackData.albums[0]
          : null;

        const album = albumData ? albumData.title : "";
        const year = albumData ? (albumData.year || "") : "";
        const position = (albumData && albumData.trackPosition)
          ? (albumData.trackPosition.index || fallbackPosition)
          : fallbackPosition;

        const genre = albumData ? (albumData.genre || "") : "";
        const publisher = (albumData && Array.isArray(albumData.labels) && albumData.labels.length > 0)
          ? (albumData.labels[0].name || "")
          : "";

        let trackNumber = "";
        if (albumData && albumData.trackPosition) {
          const index = albumData.trackPosition.index || fallbackPosition;
          const total = albumData.trackCount;
          trackNumber = (index && total) ? `${index}/${total}` : `${index || ""}`;
        } else if (fallbackPosition > 0) {
          trackNumber = `${fallbackPosition}`;
        }

        // 2. Generate signed stream info URL
        const signData = await SignatureGenerator.generate(trackId, quality);
        const headers = {
          "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
          "x-yandex-music-without-invocation-info": "1",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": "https://music.yandex.ru/"
        };

        // 3. Fetch stream URL via background script proxy
        const info = await browserApi.runtime.sendMessage({
          message: "downloadInfo",
          url: signData.url,
          headers
        });

        if (!info || !info.downloadInfo?.url) {
          throw new Error("Failed to retrieve stream URL from Yandex API");
        }

        const directMp3Url = decodeURIComponent(info.downloadInfo.url);

        // 4. Fetch direct MP3 buffer in memory
        const mp3Buffer = await fetch(directMp3Url).then(res => res.arrayBuffer());

        // 5. Fetch artwork if available in API response
        let coverBuffer = null;
        const coverRawUri = trackData.coverUri || (albumData ? albumData.coverUri : null) || (trackData.ogImage ? trackData.ogImage : null);

        if (coverRawUri) {
          // Normalize uri prefix format: add https:// if missing, and replace %% template with user quality choice
          let coverCleanUrl = coverRawUri.startsWith("http") ? coverRawUri : `https://${coverRawUri}`;
          coverCleanUrl = coverCleanUrl.replace("%%", coverSize);

          try {
            coverBuffer = await fetch(coverCleanUrl).then(res => res.arrayBuffer());
          } catch (e) {
            console.warn("Could not download album cover art:", e);
          }
        }

        // 6. Write ID3 Tags using browserId3Writer
        const writer = new browserId3Writer(mp3Buffer);
        writer.setFrame("TIT2", title)
              .setFrame("TPE1", [artist])
              .setFrame("TPE2", artist)
              .setFrame("TALB", album)
              .setFrame("TYER", year);

        if (genre) {
          try {
            writer.setFrame("TCON", [genre]);
          } catch (e) {
            console.error("Failed to inject TCON (genre) frame:", e);
          }
        }

        if (trackNumber) {
          try {
            writer.setFrame("TRCK", trackNumber);
          } catch (e) {
            console.error("Failed to inject TRCK (track number) frame:", e);
          }
        }

        if (publisher) {
          try {
            writer.setFrame("TPUB", publisher);
          } catch (e) {
            console.error("Failed to inject TPUB (publisher/label) frame:", e);
          }
        }

        if (coverBuffer) {
          try {
            writer.setFrame("APIC", {
              type: 3, // Cover front
              data: coverBuffer,
              description: ""
            });
          } catch (e) {
            console.error("Failed to inject cover art frame into ID3 tags:", e);
          }
        }

        if (config.tags === true) {
          writer.addTag();
        }

        // 7. Structure final clean filename and trigger Chrome Download API
        const cleanFilename = PathSanitizer.sanitize(`${artist} - ${title}.mp3`);
        const structuredFilename = this.#formatFilename(cleanFilename, position, config);

        this.#triggerSystemDownload(writer.getURL(), structuredFilename, trackId);

      } catch (err) {
        console.error(`Download process failed for track ${trackId}:`, err);
        this.#onDownloadComplete(trackId);
      }
    }

    #formatFilename(filename, position, config) {
      const positionPrefix = (config.position === true && position > 0) ? `${position}. ` : "";
      if (config.folder === true && config.path?.length > 0) {
        return `${config.path}/${positionPrefix}${filename}`;
      }
      return `${positionPrefix}${filename}`;
    }

    #triggerSystemDownload(blobUrl, filename, trackId) {
      browserApi.runtime.sendMessage({
        message: "download",
        url: blobUrl,
        filename: filename
      }, (response) => {
        if (response?.status === "done") {
          this.#activeCount -= 1;
          this.#onDownloadComplete(trackId);
        }
      });
    }

    #onDownloadComplete(trackId) {
      // Process next item in download queue
      if (this.#queue.length > 0) {
        const nextItem = this.#queue.shift();
        this.enqueue(...nextItem);
      }
    }
  }

  /**
   * UI Manager that creates and binds event handlers for the download buttons.
   */
  class DownloadButton {
    /**
     * Creates new DOM element for download button and inserts it into track controls container
     * @param {HTMLElement} container Track controls DOM container
     */
    static create(container) {
      if (container.querySelector("._yamusic_save_next")) {
        return null; // Button already exists
      }

      const buttons = container.querySelectorAll("button");
      if (buttons.length < 2 || buttons[1].disabled) {
        return null;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.classList.add("_yamusic_save_next");
      button.title = "Скачать";
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';

      // Insert download button before the first control button
      container.insertBefore(button, buttons[0]);
      return button;
    }

    /**
     * Creates new DOM element for page header download button and appends it at the end
     * @param {HTMLElement} container Header controls DOM container
     */
    static createHeader(container) {
      if (container.querySelector("._yamusic_save_next")) {
        return null; // Button already exists
      }

      const button = document.createElement("button");
      button.type = "button";
      button.classList.add("_yamusic_save_next");
      button.title = "Скачать всё";
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';

      // Append to the very end
      container.appendChild(button);
      return button;
    }

    /**
     * Binds click event handler on download button
     */
    static bind(buttonElement, metadataExtractor, queueInstance) {
      buttonElement.addEventListener("click", function(event) {
        event.stopPropagation();
        event.preventDefault();

        // Simple throttle to prevent accidental rapid double clicks
        if (this.alreadyCalled) {
          setTimeout(() => {
            this.alreadyCalled = false;
          }, 10000);
          return true;
        }
        this.alreadyCalled = true;

        // Perform health check and then enqueue download
        browserApi.runtime.sendMessage({ message: "check" }, (checkResponse) => {
          if (checkResponse?.status === true) {
            // Background is not ready or failed authentication
            return;
          }

          const metadata = metadataExtractor();
          if (metadata) {
            queueInstance.enqueue(
              buttonElement,
              metadata.trackId,
              metadata.position
            );
          }
        });
      });
    }
  }

  /**
   * Continuously scans the Yandex Music page DOM looking for tracks container elements.
   */
  class TrackScanner {
    // Selectors for tracks in lists (new, old interfaces) and players bar
    static #TRACK_SELECTORS = '.d-track, .track, div[class*="Track_root"], section[class*="PlayerBarDesktop_root"]';

    // Selectors for playlist/album controls in headers
    static #HEADER_SELECTOR = 'div[class*="CommonPageHeader_controls__"], div[class*="PageHeaderPlaylist_mainControls__"], div[class*="PageHeaderAlbumControls_controls__"]';

    static scan(queueInstance) {
      // 1. Scan tracks
      const trackContainers = document.querySelectorAll(TrackScanner.#TRACK_SELECTORS);
      for (const container of trackContainers) {
        if (container.tagName === "DIV" || container.tagName === "SECTION") {
          TrackScanner.#injectButtonIfReady(container, queueInstance);
        }
      }

      // 2. Scan header controls (for album/playlist "Download All" button)
      const headerControls = document.querySelectorAll(TrackScanner.#HEADER_SELECTOR);
      for (const header of headerControls) {
        TrackScanner.#injectHeaderButtonIfReady(header, queueInstance);
      }
    }

    static #injectButtonIfReady(container, queueInstance) {
      if (container.classList.contains("_yamusic_ready") || !container) {
        return;
      }
      container.classList.add("_yamusic_ready");

      // Search for controls container to host our download button
      const controlsContainer = container.querySelector("div[class*='ControlsBar_root'], div[class*='PlayerBarDesktop_meta']");
      if (!controlsContainer) return;

      const button = DownloadButton.create(controlsContainer);
      if (button && DOMMetadataExtractor.extract(container)) {
        // Successfully created button and track metadata is valid -> bind click handlers
        DownloadButton.bind(button, () => DOMMetadataExtractor.extract(container), queueInstance);
      }
    }

    static #injectHeaderButtonIfReady(headerContainer, queueInstance) {
      if (headerContainer.classList.contains("_yamusic_ready_header") || !headerContainer) {
        return;
      }
      headerContainer.classList.add("_yamusic_ready_header");

      const button = DownloadButton.createHeader(headerContainer);
      if (button) {
        // Simple click handler for the Download All button placeholder
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          event.preventDefault();

          console.log("Album/playlist download triggered! (Will implement later)");
        });
      }
    }
  }



  /**
   * Entry Point Class.
   */
  class YandexMusicDownloader {
    #queue = new DownloadQueue();

    #initObserver = () => {
      // Perform initial scanning
      TrackScanner.scan(this.#queue);

      // Setup dynamic MutationObserver to inject buttons on list scrolling and lazy load
      const observer = new MutationObserver(() => {
        TrackScanner.scan(this.#queue);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    };

    launch() {
      document.addEventListener("DOMContentLoaded", () => this.#initObserver());
    }
  }

  // Run the application
  const app = new YandexMusicDownloader();
  app.launch();
})();
