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
   * Extracts metadata from Yandex Music track DOM elements.
   */
  class DOMMetadataExtractor {
    /**
     * Parses track DOM element to build metadata object
     * @param {HTMLElement} element Track DOM container
     */
    static extract(element) {
      let trackId, position, title, artists, album, year, coverUrl;

      // 1. Extract position in playlist
      try {
        position = element.querySelector("div[class*='PlayButtonWithPosition_root']")?.textContent || 0;
      } catch (e) {
        position = 0;
      }

      // 2. Extract track ID from track/album link
      try {
        const href = element.querySelector("a[class*='Meta_albumLink__']")?.getAttribute("href");
        if (href) {
          // Expected href format: /album/123/track/456
          trackId = href.split("/")[4];
        }
      } catch (e) {}

      if (!trackId) return null;

      // 3. Extract title
      try {
        title = element.querySelector("span[class*='Meta_title__']")?.textContent?.trim() ||
                element.querySelector("a[class*='Meta_albumLink__']")?.textContent?.trim() || "";
      } catch (e) {
        title = "";
      }

      // 4. Extract artists (join multiple with comma)
      try {
        const artistElements = element.querySelectorAll("span[class*='Meta_artistCaption__']");
        if (artistElements.length > 0) {
          artists = Array.from(artistElements).map(el => el.textContent.trim()).join(", ");
        } else {
          // Fallback to page header artists (e.g. if parsing from bottom player bar)
          const headerArtists = document.querySelectorAll("span[class*='PageHeaderAlbumMeta_artistLabel__']");
          artists = Array.from(headerArtists).map(el => el.textContent.trim()).join(", ");
        }
      } catch (e) {
        artists = "";
      }

      // 5. Extract album title from page header
      try {
        const albumHeaders = document.querySelectorAll("span[class*='PageHeaderTitle_font_short__']");
        album = Array.from(albumHeaders).map(el => el.textContent.trim()).join(" ");
      } catch (e) {
        album = "";
      }

      // 6. Extract album release year from page header
      try {
        year = document.querySelector("div[class*='PageHeaderAlbumMeta_year_dot__']")?.textContent || "";
      } catch (e) {
        year = "";
      }

      // 7. Extract cover image URL
      try {
        const coverImg = element.querySelector("img[class*='PlayButtonWithCover_coverImage__']") ||
                         document.querySelector("img[class*='PageHeaderCover_coverImage__']");
        if (coverImg) {
          coverUrl = coverImg.getAttribute("src");
        }
      } catch (e) {
        coverUrl = "";
      }

      return { trackId, position, title, artist: artists, album, year, coverUrl };
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
    enqueue(buttonElement, trackId, position, title, artist, album, year, coverUrl) {
      this.#activeCount += 1;

      if (this.#activeCount > DownloadQueue.#MAX_CONCURRENT_DOWNLOADS) {
        this.#queue.push([buttonElement, trackId, position, title, artist, album, year, coverUrl]);
      } else {
        this.#processDownload(buttonElement, trackId, position, title, artist, album, year, coverUrl);
      }
    }

    /**
     * Orchestrates track download: gets API url, fetches MP3, gets cover, writes ID3 tags, saves file.
     */
    async #processDownload(buttonElement, trackId, position, title, artist, album, year, coverUrl) {
      const config = await StorageHelper.get(["quality", "tags", "folder", "path", "position", "cover"]);
      const quality = config.quality || "hq";
      const coverSize = config.cover || "400x400";

      try {
        // 1. Generate signed API url
        const signData = await SignatureGenerator.generate(trackId, quality);
        const headers = {
          "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
          "x-yandex-music-without-invocation-info": "1",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": "https://music.yandex.ru/"
        };

        // 2. Fetch download info via background script proxy
        const info = await browserApi.runtime.sendMessage({
          message: "downloadInfo",
          url: signData.url,
          headers
        });

        if (!info || !info.downloadInfo?.url) {
          throw new Error("Failed to retrieve download URL");
        }

        const directMp3Url = decodeURIComponent(info.downloadInfo.url);

        // 3. Prepare nice file name
        const cleanName = PathSanitizer.sanitize(`${artist} - ${title}.mp3`);

        // 4. Fetch direct MP3 buffer
        const mp3Buffer = await fetch(directMp3Url).then(res => res.arrayBuffer());

        // 5. Fetch artwork if cover URL is available
        let coverBuffer = null;
        if (coverUrl) {
          // Replace Yandex image resolution template with user selection (e.g. 100x100 -> 400x400)
          const highResCoverUrl = coverUrl.replace(/100x100|200x200|300x300|400x400/, coverSize);
          try {
            coverBuffer = await fetch(decodeURIComponent(highResCoverUrl)).then(res => res.arrayBuffer());
          } catch (e) {
            console.warn("Could not download high-res album cover", e);
          }
        }

        // 6. Write ID3 Tags using browserId3Writer
        const writer = new browserId3Writer(mp3Buffer);
        writer.setFrame("TIT2", title)
              .setFrame("TPE1", [artist])
              .setFrame("TPE2", artist)
              .setFrame("TALB", album)
              .setFrame("TYER", year);

        if (coverBuffer) {
          try {
            writer.setFrame("APIC", {
              type: 3, // Cover front
              data: coverBuffer,
              description: ""
            });
          } catch (e) {
            console.error("Failed to inject cover art frame into ID3 tags", e);
          }
        }

        if (config.tags === true) {
          writer.addTag();
        }

        // 7. Structure the final filename
        const structuredFilename = this.#formatFilename(cleanName, position, config);

        // 8. Send download request to background script
        this.#triggerSystemDownload(writer.getURL(), structuredFilename, trackId, position, title, artist, album, year, coverUrl);

      } catch (err) {
        console.error(`Download process failed for track ${trackId}:`, err);
        this.#onDownloadComplete(trackId, position, title, artist, album, year, coverUrl);
      }
    }

    #formatFilename(filename, position, config) {
      const positionPrefix = (config.position === true && position > 0) ? `${position}. ` : "";
      if (config.folder === true && config.path?.length > 0) {
        return `${config.path}/${positionPrefix}${filename}`;
      }
      return `${positionPrefix}${filename}`;
    }

    #triggerSystemDownload(blobUrl, filename, trackId, position, title, artist, album, year, coverUrl) {
      browserApi.runtime.sendMessage({
        message: "download",
        url: blobUrl,
        filename: filename
      }, (response) => {
        if (response?.status === "done") {
          this.#activeCount -= 1;
          this.#onDownloadComplete(trackId, position, title, artist, album, year, coverUrl);
        }
      });
    }

    #onDownloadComplete(trackId, position, title, artist, album, year, coverUrl) {
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

      const button = document.createElement("div");
      button.classList.add("_yamusic_save_next");
      button.title = "Скачать";

      const iconUrl = `chrome-extension://${browserApi.runtime.id}/images/save_icon.svg`;
      button.style.backgroundImage = `url('${iconUrl}')`;

      // Insert download button before the first control button
      container.insertBefore(button, buttons[0]);
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
              metadata.position,
              metadata.title,
              metadata.artist,
              metadata.album,
              metadata.year,
              metadata.coverUrl
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

    static scan(queueInstance) {
      const trackContainers = document.querySelectorAll(TrackScanner.#TRACK_SELECTORS);
      for (const container of trackContainers) {
        // Double check tags and inject buttons
        if (container.tagName === "DIV" || container.tagName === "SECTION") {
          TrackScanner.#injectButtonIfReady(container, queueInstance);
        }
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
  }

  /**
   * Handles UI feedback when error messages are received.
   */
  class CrashHandler {
    static handle(message) {
      if (message?.message === "crash") {
        const trackElement = document.querySelector(`[track-id='${message.id}']`);
        if (trackElement) {
          trackElement.innerHTML = `
            <button
              class="button button_round button_action button-play button-play__type_track button_ico"
              id="_yamusic_save_button"
              style="background-color: #ff3333"
              title="Произошла ошибка... Нажмите на иконку, чтобы скачать ещё раз.">
              error
            </button>
          `;
        }
      }
    }
  }

  /**
   * Entry Point Class.
   */
  class YandexMusicPro {
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
      browserApi.runtime.onMessage.addListener(CrashHandler.handle);
    }
  }

  // Run the application
  const app = new YandexMusicPro();
  app.launch();
})();
