/**
 * Yandex Music Downloader - Content Script
 * Экстремально оптимизированная, легковесная и консолидированная реализация.
 * БЕЗ классов, БЕЗ лишнего бойлерплейта, БЕЗ дублирования кода. Чисто функциональный стиль.
 */

(() => {
  const queue = [];
  let activeDownloads = 0;
  const MAX_CONCURRENT = 7;

  /**
   * Хелпер для выполнения запросов к REST API Яндекс Музыки в контексте страницы
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
   * Генерирует подпись и запрашивает прямую ссылку на MP3-поток
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
   * Скачивает один трек: получает метаданные, подписывает URL, внедряет ID3-теги и сохраняет файл
   */
  const downloadTrack = async (trackId, fallbackPosition, preFetchedMetadata = null) => {
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
    const publisher = albumData?.labels?.[0]?.name || "";

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

    // Санитизация имен файлов и путей
    const cleanFilename = `${artist} - ${title}`.replace(/[?:;"<>\/\\|*]|^\s+|[\u200B-\u200D\uFEFF]/gi, char => char === " " ? "" : "_") + ".mp3";
    const positionPrefix = (config.position === true && position > 0) ? `${position}. ` : "";
    const filename = (config.folder === true && config.path)
      ? `${config.path}/${positionPrefix}${cleanFilename}`
      : `${positionPrefix}${cleanFilename}`;

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ message: "download", url: writer.getURL(), filename }, resolve);
    });
  };

  /**
   * Управляет очередью загрузок с соблюдением порога многопоточности
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
   * Загружает список треков последовательно с задержкой 1000мс для предотвращения капчи/блокировок
   */
  const downloadBulk = async (tracks, progressCallback) => {
    const trackIds = tracks.map(t => t.trackId);
    const batchSize = 150;
    let allMetadata = [];

    for (let i = 0; i < trackIds.length; i += batchSize) {
      const batchIds = trackIds.slice(i, i + batchSize);
      const apiResponse = await apiCall("https://api.music.yandex.ru/tracks", `trackIds=${batchIds.join(",")}&removeDuplicates=false&withProgress=true`);
      if (Array.isArray(apiResponse)) allMetadata = allMetadata.concat(apiResponse);
    }

    const metadataMap = new Map(allMetadata.filter(t => t?.id).map(t => [String(t.id), t]));

    for (let i = 0; i < tracks.length; i++) {
      const item = tracks[i];
      const trackData = metadataMap.get(String(item.trackId));
      if (progressCallback) progressCallback(i + 1, tracks.length, trackData?.title || "Unknown");
      try {
        await downloadTrack(item.trackId, item.position, trackData);
      } catch (e) {
        console.error(e);
      }
      if (i < tracks.length - 1) await new Promise(r => setTimeout(r, 1000));
    }
  };

  /**
   * Извлекает идентификаторы треков из DOM-контейнеров
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
   * Внедряет желтую круглую кнопку скачивания в контейнер трека
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
    button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';

    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (button.disabled) return;
      button.disabled = true;

      const meta = extractTrackMeta(container);
      if (meta) {
        try {
          await enqueueDownload(meta.trackId, meta.position);
        } catch (err) {
          console.error(err);
        }
      }
      setTimeout(() => button.disabled = false, 1000);
    });

    controls.insertBefore(button, buttons[0]);
  };

  /**
   * Внедряет кнопку группового скачивания в заголовок плейлиста/альбома
   */
  const injectHeaderButton = (container) => {
    if (container.querySelector("._yamusic_save_next")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("_yamusic_save_next");
    button.title = "Скачать всё";
    button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';

    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (button.classList.contains("_downloading")) return;

      const originalHTML = button.innerHTML;
      const originalTitle = button.title;

      const updateStatus = (text, isProgress = true) => {
        if (isProgress) {
          button.classList.add("_downloading");
          button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>${text}</span>`;
        } else {
          button.innerHTML = originalHTML;
          button.title = originalTitle;
          button.classList.remove("_downloading");
        }
      };

      try {
        updateStatus("Загрузка...");

        const url = window.location.href;
        if (!url.includes('/playlists/') && !url.includes('/album/')) {
          alert('Пожалуйста, запустите на странице плейлиста или альбома');
          updateStatus("", false);
          return;
        }

        const iframe = document.createElement("iframe");
        iframe.src = url;
        iframe.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100000px;border:none;z-index:99999;visibility:hidden;pointer-events:none;";
        document.body.appendChild(iframe);

        await new Promise(resolve => {
          iframe.onload = resolve;
          setTimeout(resolve, 15000);
        });

        updateStatus("Анализ...");
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) throw new Error("No access to iframe document");

        let lastCount = 0, stableCount = 0, attempts = 0;
        const trackSelector = '.d-track, .track, div[class*="Track_root"]';

        while (stableCount < 3 && attempts < 15) {
          const currentCount = iframeDoc.querySelectorAll(trackSelector).length;
          if (currentCount === lastCount && currentCount > 0) stableCount++;
          else { stableCount = 0; lastCount = currentCount; }
          attempts++;
          await new Promise(r => setTimeout(r, 1000));
        }

        const trackElements = iframeDoc.querySelectorAll(trackSelector);
        if (trackElements.length === 0) {
          iframe.remove();
          alert("Не удалось найти треки на странице.");
          updateStatus("", false);
          return;
        }

        const collectedTracks = [];
        trackElements.forEach((el, idx) => {
          const meta = extractTrackMeta(el);
          if (meta) collectedTracks.push({ trackId: meta.trackId, position: meta.position || (idx + 1) });
        });

        iframe.remove();
        if (collectedTracks.length === 0) {
          alert("Не удалось извлечь идентификаторы треков.");
          updateStatus("", false);
          return;
        }

        updateStatus("Метаданные...");
        await downloadBulk(collectedTracks, (current, total, title) => {
          updateStatus(`${current}/${total}`);
          button.title = `Скачивание: ${title} (${current} из ${total})`;
        });

        button.classList.add("_downloading");
        button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Готово!</span>`;
        setTimeout(() => updateStatus("", false), 3000);

      } catch (err) {
        console.error("Bulk download failed:", err);
        alert(`Ошибка скачивания: ${err.message || err}`);
        updateStatus("", false);
      }
    });

    container.appendChild(button);
  };

  /**
   * Сканирует DOM на наличие списков треков и заголовков страниц для внедрения кнопок
   */
  const scan = () => {
    // 1. Одиночные треки
    document.querySelectorAll('.d-track:not(._ym_ready), .track:not(._ym_ready), div[class*="Track_root"]:not(._ym_ready)').forEach(track => {
      track.classList.add('_ym_ready');
      injectTrackButton(track);
    });

    // 2. Элементы управления в шапках плейлистов/альбомов (ищет PageHeaderBase_controls и др.)
    document.querySelectorAll('div[class*="PageHeaderBase_controls"]:not(._ym_ready_hdr), div[class*="CommonPageHeader_controls"]:not(._ym_ready_hdr), div[class*="PageHeaderPlaylist_mainControls"]:not(._ym_ready_hdr), div[class*="PageHeaderAlbumControls_controls"]:not(._ym_ready_hdr)').forEach(header => {
      header.classList.add('_ym_ready_hdr');
      injectHeaderButton(header);
    });
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
