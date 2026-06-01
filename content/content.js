/**
 * Yandex Music Downloader - Content Script (API-based approach)
 * Extremely fast, reliable, and efficient. No iframes, no DOM scraping.
 */

(() => {
  const queue = [];
  let activeDownloads = 0;
  const MAX_CONCURRENT = 7;

  /**
   * Helper to perform Yandex Music REST API requests in the page context
   */
  const apiCall = async (endpoint, body) => {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
        "x-yandex-music-without-invocation-info": "1",
        "X-Requested-With": "XMLHttpRequest"
      },
      credentials: "include",
      body
    }).then(res => res.json()).catch(() => null);
  };

  /**
   * Generates signed URL and fetches MP3 download stream URL
   */
  const getStreamUrl = async (trackId, quality) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signString = `${timestamp}${trackId}${quality}mp3raw`;
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("7tvSmFbyf5hJnIHhCimDDD"),
      { name: "HMAC", hash: { name: "SHA-256" } },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signString));
    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer))).replace(/=+$/, "");
    const signUrl = `https://api.music.yandex.ru/get-file-info?ts=${timestamp}&trackId=${trackId}&quality=${quality}&codecs=mp3&transports=raw&sign=${encodeURIComponent(signature)}`;

    const info = await chrome.runtime.sendMessage({
      message: "downloadInfo",
      url: signUrl,
      headers: {
        "x-yandex-music-client": "YandexMusicWebNext/1.0.0",
        "x-yandex-music-without-invocation-info": "1",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://music.yandex.ru/"
      }
    });
    return info?.downloadInfo?.url ? decodeURIComponent(info.downloadInfo.url) : null;
  };

  /**
   * Downloads a single track: gets metadata, signs URL, tags ID3, and saves file
   */
  const downloadTrack = async (trackId, fallbackPosition, preFetchedMetadata = null, bulkContext = null) => {
    const config = await chrome.storage.local.get(["quality", "tags", "folder", "path", "position", "cover"]);
    const quality = config.quality || "hq";
    const coverSize = config.cover || "400x400";

    let trackData = preFetchedMetadata;
    if (!trackData) {
      const apiResponse = await apiCall("https://api.music.yandex.ru/tracks", `trackIds=${trackId}&removeDuplicates=false&withProgress=true`);
      if (!apiResponse || !apiResponse[0]) throw new Error(`API Metadata extraction failed for track ${trackId}`);
      trackData = apiResponse[0];
    }

    const title = trackData.title || "Unknown Track";
    const artist = trackData.artists?.map(a => a.name).join(", ") || "Unknown Artist";
    const albumData = trackData.albums?.[0] || null;
    const album = albumData?.title || "";
    const year = albumData?.year || "";
    const position = albumData?.trackPosition?.index || fallbackPosition;
    const genre = albumData?.genre || "";
    const publisher = albumData?.labels?.map(l => l.name).join(", ") || "";

    const trackNumber = albumData?.trackPosition
      ? `${albumData.trackPosition.index}/${albumData.trackCount}`
      : (fallbackPosition > 0 ? `${fallbackPosition}` : "");

    const directMp3Url = await getStreamUrl(trackId, quality);
    if (!directMp3Url) throw new Error("Could not retrieve Yandex MP3 stream URL");

    const mp3Buffer = await fetch(directMp3Url).then(res => res.arrayBuffer());
    let coverBuffer = null;
    const coverRawUri = trackData.coverUri || albumData?.coverUri || trackData.ogImage;

    if (coverRawUri) {
      const coverCleanUrl = (coverRawUri.startsWith("http") ? coverRawUri : `https://${coverRawUri}`).replace("%%", coverSize);
      coverBuffer = await fetch(coverCleanUrl).then(res => res.arrayBuffer()).catch(() => null);
    }

    const writer = new browserId3Writer(mp3Buffer);
    writer.setFrame("TIT2", title)
          .setFrame("TPE1", [artist])
          .setFrame("TPE2", artist)
          .setFrame("TALB", album)
          .setFrame("TYER", year);

    if (genre) try { writer.setFrame("TCON", [genre]); } catch {}
    if (trackNumber) try { writer.setFrame("TRCK", trackNumber); } catch {}
    if (publisher) try { writer.setFrame("TPUB", publisher); } catch {}
    if (coverBuffer) {
      try {
        writer.setFrame("APIC", { type: 3, data: coverBuffer, description: "" });
      } catch {}
    }

    if (config.tags !== false) writer.addTag();

    // Sanitize file and directory paths
    const cleanFilename = `${artist} - ${title}`.replace(/[?:;"<>\/\\|*]|^\s+|[\u200B-\u200D\uFEFF]/gi, char => char === " " ? "" : "_") + ".mp3";
    const positionPrefix = (config.position === true && bulkContext && position > 0) ? `${position}. ` : "";

    let finalFolder = "";
    if (config.folder === true && config.path) {
      const basePath = config.path.trim().replace(/[?:;"<>\/\\|*]/gi, "_");
      if (bulkContext) {
        const cleanContextTitle = bulkContext.title.trim().replace(/[?:;"<>\/\\|*]/gi, "_");
        if (bulkContext.type === "playlist") {
          finalFolder = `${basePath}/playlists/${cleanContextTitle}/`;
        } else if (bulkContext.type === "album") {
          finalFolder = `${basePath}/albums/${cleanContextTitle}/`;
        }
      } else {
        finalFolder = `${basePath}/tracks/`;
      }
    }

    const filename = `${finalFolder}${positionPrefix}${cleanFilename}`;

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ message: "download", url: writer.getURL(), filename }, resolve);
    });
  };

  /**
   * Triggers single enqueued download tasks matching the max concurrency threshold
   */
  const processQueue = async () => {
    if (activeDownloads >= MAX_CONCURRENT || queue.length === 0) return;
    activeDownloads++;
    const { trackId, position, resolve, reject } = queue.shift();
    try {
      await downloadTrack(trackId, position);
      resolve();
    } catch (e) {
      reject(e);
    } finally {
      activeDownloads--;
      processQueue();
    }
  };

  const enqueueDownload = (trackId, position) => {
    return new Promise((resolve, reject) => {
      queue.push({ trackId, position, resolve, reject });
      processQueue();
    });
  };

  /**
   * Downloads tracks sequentially with a 1000ms delay to prevent DDoS blocks
   * Supports cancellation token checking
   */
  const downloadBulk = async (tracks, progressCallback, checkCancelled) => {
    for (let i = 0; i < tracks.length; i++) {
      if (checkCancelled && checkCancelled()) {
        console.log("Bulk download cancelled by user.");
        break;
      }
      const item = tracks[i];
      if (progressCallback) progressCallback(i + 1, tracks.length, item.trackData?.title || "Unknown");
      try {
        await downloadTrack(item.trackId, item.position, item.trackData, item.bulkContext);
      } catch (e) {
        console.error(e);
      }
      if (i < tracks.length - 1) {
        // Safe chunked delay of 1000ms with check for cancellation every 100ms
        for (let delay = 0; delay < 1000; delay += 100) {
          if (checkCancelled && checkCancelled()) break;
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }
  };

  /**
   * Extracts track identifiers from DOM container elements
   */
  const extractTrackMeta = (el) => {
    const trackLink = el.querySelector('a[href*="/track/"]');
    const href = trackLink?.getAttribute('href') || '';
    const trackId = href.split('/track/')[1]?.split('/')[0] || el.getAttribute('track-id') || el.getAttribute('data-track-id');
    const positionText = el.querySelector("div[class*='PlayButtonWithPosition_root']")?.textContent || "0";
    const position = parseInt(positionText, 10) || 0;
    return trackId ? { trackId, position } : null;
  };

  /**
   * Direct REST API queries for full track playlist/album metadata
   */
  const fetchTracksFromAPI = async () => {
    const path = window.location.pathname;

    // 1. Playlists by User & Kind (e.g. /users/mts-music/playlists/1460)
    const playlistUserMatch = path.match(/\/users\/([^/]+)\/playlists\/(\d+)/i);
    if (playlistUserMatch) {
      const user = playlistUserMatch[1];
      const kind = playlistUserMatch[2];
      const res = await fetch(`https://api.music.yandex.ru/users/${user}/playlists/${kind}?resumeStream=false&richTracks=true`, {
        credentials: "include"
      }).then(r => r.json()).catch(() => null);

      if (res?.result?.tracks) {
        const playlistTitle = res.result.title || "Unknown Playlist";
        return res.result.tracks.map((t, idx) => ({
          trackId: t.track.id,
          position: idx + 1,
          trackData: t.track,
          bulkContext: { type: "playlist", title: playlistTitle }
        }));
      }
    }

    // 2. Playlists by ID (e.g. /playlists/ar.ce76914c-4acf-4572-9100-a4d399894dc9)
    const playlistIdMatch = path.match(/\/playlists\/([^/]+)/i);
    if (playlistIdMatch) {
      const playlistId = playlistIdMatch[1];
      const res = await fetch(`https://api.music.yandex.ru/playlist/${playlistId}?resumeStream=false&richTracks=true`, {
        credentials: "include"
      }).then(r => r.json()).catch(() => null);

      if (res?.result?.tracks) {
        const playlistTitle = res.result.title || "Unknown Playlist";
        return res.result.tracks.map((t, idx) => ({
          trackId: t.track.id,
          position: idx + 1,
          trackData: t.track,
          bulkContext: { type: "playlist", title: playlistTitle }
        }));
      }
    }

    // 3. Albums (e.g. /album/42104500)
    const albumMatch = path.match(/\/album\/(\d+)/i);
    if (albumMatch) {
      const albumId = albumMatch[1];
      const res = await fetch(`https://api.music.yandex.ru/albums/${albumId}/with-tracks?resumeStream=false&richTracks=true&withListeningFinished=true`, {
        credentials: "include"
      }).then(r => r.json()).catch(() => null);

      if (res?.result?.volumes) {
        const albumTitle = res.result.title || "Unknown Album";
        const tracks = [];
        let position = 1;
        res.result.volumes.forEach(volume => {
          if (Array.isArray(volume)) {
            volume.forEach(t => {
              tracks.push({
                trackId: t.id,
                position: position++,
                trackData: t,
                bulkContext: { type: "album", title: albumTitle }
              });
            });
          }
        });
        return tracks;
      }
    }

    return null;
  };

  /**
   * Injects yellow circular download button into track container
   */
  const injectTrackButton = (container) => {
    const controls = container.querySelector("div[class*='ControlsBar_root'], div[class*='PlayerBarDesktop_meta']");
    if (!controls || controls.querySelector("._yamusic_save_next")) return;

    const buttons = controls.querySelectorAll("button");
    if (buttons.length < 2 || buttons[1].disabled) return;

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("_yamusic_save_next");
    button.title = "Скачать";

    const originalHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';
    button.innerHTML = originalHTML;

    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (button.disabled) return;
      button.disabled = true;

      const meta = extractTrackMeta(container);
      if (meta) {
        try {
          // 1. Показываем вращающийся лоадер
          button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

          await enqueueDownload(meta.trackId, meta.position);

          // 2. Показываем галочку при успехе
          button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        } catch (err) {
          console.error("Download failed for track:", err);
          button.innerHTML = originalHTML;
          button.disabled = false;
          return;
        }
      } else {
        button.disabled = false;
        return;
      }

      // 3. Возвращаем исходную иконку через 2 секунды
      setTimeout(() => {
        button.innerHTML = originalHTML;
        button.disabled = false;
      }, 2000);
    });

    controls.insertBefore(button, buttons[0]);
  };

  /**
   * Injects page header download button onto playlist/album pages
   */
  const injectHeaderButton = (container) => {
    if (container.querySelector("._yamusic_save_next")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("_yamusic_save_next");
    button.title = "Скачать всё";
    button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';

    let isDownloading = false;
    let isFetchingTracks = false;
    let cancelRequested = false;
    let currentStatusText = "";

    const originalHTML = button.innerHTML;
    const originalTitle = button.title;

    const updateStatus = (text, isProgress = true) => {
      currentStatusText = text;
      if (isProgress) {
        button.classList.add("_downloading");
        isDownloading = true;
        // Если идет загрузка списка по API или пользователь не навел курсор, обновляем текст прогресса
        if (isFetchingTracks || !button.matches(':hover')) {
          button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>${text}</span>`;
        }
      } else {
        button.innerHTML = originalHTML;
        button.title = originalTitle;
        button.classList.remove("_downloading");
        isDownloading = false;
        cancelRequested = false;
        isFetchingTracks = false;
        button.style.backgroundColor = "";
        button.style.color = "";
      }
    };

    // При наведении показываем возможность отмены
    button.addEventListener("mouseenter", () => {
      if (isDownloading && !cancelRequested && !isFetchingTracks) {
        button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect></svg><span>Прервать?</span>`;
        button.style.backgroundColor = "#ff4444";
        button.style.color = "#ffffff";
        button.title = "Нажмите, чтобы остановить загрузку";
      }
    });

    // Возвращаем прогресс при уходе курсора
    button.addEventListener("mouseleave", () => {
      if (isDownloading) {
        button.style.backgroundColor = "";
        button.style.color = "";
        if (cancelRequested) {
          button.innerHTML = `<span>Остановка...</span>`;
          button.title = "Загрузка останавливается...";
        } else {
          const textToShow = isFetchingTracks ? "Загрузка..." : currentStatusText;
          button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>${textToShow}</span>`;
        }
      }
    });

    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (isDownloading) {
        if (isFetchingTracks) return; // Игнорируем клики во время первичного запроса к API
        if (confirm("Вы действительно хотите остановить загрузку плейлиста/альбома?")) {
          cancelRequested = true;
          button.innerHTML = `<span>Остановка...</span>`;
          button.style.backgroundColor = "";
          button.style.color = "";
          button.title = "Загрузка останавливается...";
        }
        return;
      }

      try {
        isFetchingTracks = true;
        updateStatus("Загрузка...");

        const tracks = await fetchTracksFromAPI();
        isFetchingTracks = false;

        if (!tracks || tracks.length === 0) {
          alert("Не удалось загрузить треки по API. Пожалуйста, убедитесь, что вы авторизованы.");
          updateStatus("", false);
          return;
        }

        updateStatus(`0/${tracks.length}`);
        await downloadBulk(tracks, (current, total, title) => {
          updateStatus(`${current}/${total}`);
          button.title = `Скачивание: ${title} (${current} из ${total})`;
        }, () => cancelRequested);

        button.style.backgroundColor = "";
        button.style.color = "";

        if (cancelRequested) {
          button.classList.add("_downloading");
          button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><span>Прервано</span>`;
          button.title = "Загрузка была остановлена пользователем";
          setTimeout(() => updateStatus("", false), 2000);
        } else {
          button.classList.add("_downloading");
          button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Готово!</span>`;
          setTimeout(() => updateStatus("", false), 3000);
        }

      } catch (err) {
        button.style.backgroundColor = "";
        button.style.color = "";
        console.error("Bulk download failed:", err);
        alert(`Ошибка скачивания: ${err.message || err}`);
        updateStatus("", false);
      }
    });

    container.prepend(button);
  };

  /**
   * Scans DOM for track listings and page headers to inject downloader buttons
   */
  const scan = () => {
    // 1. Одиночные треки
    document.querySelectorAll('.d-track:not(._ym_ready), .track:not(._ym_ready), div[class*="Track_root"]:not(._ym_ready)').forEach(track => {
      track.classList.add('_ym_ready');
      injectTrackButton(track);
    });

    // 2. Элементы управления в шапках плейлистов/альбомов
    const headerSelectors = 'div[class*="CommonPageHeader_controls__"], div[class*="PageHeaderPlaylist_mainControls"]';

    const header = document.querySelector(headerSelectors);
    if (header && !header.classList.contains('_ym_ready_hdr')) {
      header.classList.add('_ym_ready_hdr');
      injectHeaderButton(header);
    }
  };

  const init = () => {
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
