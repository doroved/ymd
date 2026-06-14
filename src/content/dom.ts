/**
 * DOM injection: track download buttons and header "download all" button
 */
import type { ExtractedTrackMeta, BulkTrackItem, BulkContext } from "./types.ts";
import { enqueueDownload } from "./queue.ts";
import { downloadBulk } from "./bulk.ts";
import { fetchPlaylistAlbumTracks, exportTrackList } from "./export.ts";

function extractTrackMeta(el: Element): ExtractedTrackMeta | null {
  const trackLink = el.querySelector('a[href*="/track/"]');
  const href = trackLink?.getAttribute("href") || "";
  const trackId =
    href.match(/\/track\/(\d+)/)?.[1] ||
    el.getAttribute("track-id") ||
    el.getAttribute("data-track-id");

  const positionText =
    el.querySelector("div[class*='PlayButtonWithPosition_root']")?.textContent || "0";
  const position = parseInt(positionText, 10) || 0;
  return trackId ? { trackId, position } : null;
}

async function fetchTracksFromAPI(): Promise<BulkTrackItem[] | null> {
  const result = await fetchPlaylistAlbumTracks();
  return result?.items || null;
}

function extractPlayerBarTrackId(): string | null {
  const descriptionDiv = document.querySelector(
    "div[class*='PlayerBarDesktopWithBackgroundProgressBar_description']"
  );
  if (!descriptionDiv) return null;
  const link = descriptionDiv.querySelector('a[href*="/track/"]');
  if (!link) return null;
  const href = link.getAttribute("href") || "";
  return href.match(/\/track\/(\d+)/)?.[1] || null;
}

export function injectPlayerBarButton(): void {
  const containers = document.querySelectorAll(
    "div[class*='PlayerBarDesktopWithBackgroundProgressBar_meta'], div[class*='PlayerBarMobile_infoButtons']"
  );

  containers.forEach((container) => {
    if (container.querySelector(".__ymd_download_player")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("__ymd_download", "__ymd_download_player");
    button.title = "Скачать текущий трек";

    const originalHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';
    button.innerHTML = originalHTML;

    button.addEventListener("click", async (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (button.disabled) return;
      button.disabled = true;

      const trackId = extractPlayerBarTrackId();
      if (!trackId) {
        button.disabled = false;
        return;
      }

      try {
        button.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" stroke-width="4" opacity="0.3"/><circle class="ymd-progress" cx="18" cy="18" r="16" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="0, 100"/></svg>';

        await enqueueDownload(trackId, 0, (percent: number) => {
          const circle = button.querySelector(".ymd-progress");
          if (circle) {
            circle.setAttribute("stroke-dasharray", `${percent}, 100`);
          }
        });

        button.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      } catch (err) {
        console.error("Player bar download failed:", err);
        button.innerHTML = originalHTML;
        button.disabled = false;
        return;
      }

      setTimeout(() => {
        button.innerHTML = originalHTML;
        button.disabled = false;
      }, 2000);
    });

    container.prepend(button);
    injectDonateButton(container, button);
  });
}

export function injectTrackButton(container: Element): void {
  const controls = container.querySelector(
    "div[class*='ControlsBar_root'], div[class*='PlayerBarDesktop_meta']"
  );
  if (!controls || controls.querySelector(".__ymd_download")) return;

  const buttons = controls.querySelectorAll("button");
  if (buttons.length < 2 || (buttons[1] as HTMLButtonElement).disabled) return;

  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("__ymd_download");
  button.title = "Скачать";

  const originalHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';
  button.innerHTML = originalHTML;

  button.addEventListener("click", async (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (button.disabled) return;
    button.disabled = true;

    const meta = extractTrackMeta(container);
    if (meta) {
      try {
        button.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" stroke-width="4" opacity="0.3"/><circle class="ymd-progress" cx="18" cy="18" r="16" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="0, 100"/></svg>';

        await enqueueDownload(meta.trackId, meta.position, (percent: number) => {
          const circle = button.querySelector(".ymd-progress");
          if (circle) {
            circle.setAttribute("stroke-dasharray", `${percent}, 100`);
          }
        });

        button.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
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

    setTimeout(() => {
      button.innerHTML = originalHTML;
      button.disabled = false;
    }, 2000);
  });

  controls.insertBefore(button, buttons[0]);
}

export function injectHeaderButton(container: Element): void {
  if (container.querySelector(".__ymd_download")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("__ymd_download");
  button.title = "Скачать всё";
  button.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';

  let isDownloading = false;
  let isFetchingTracks = false;
  let cancelRequested = false;
  let isHovered = false;
  let currentTrackNum = 0;
  let totalTracksNum = 0;

  const originalHTML = button.innerHTML;
  const originalTitle = button.title;

  const updateStatus = (_text: string, isProgress = true): void => {
    if (isProgress) {
      button.classList.add("_downloading");
      isDownloading = true;
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

  button.addEventListener("mouseenter", () => {
    isHovered = true;
    if (isDownloading && !cancelRequested && !isFetchingTracks) {
      button.style.backgroundColor = "#ff4444";
      button.style.color = "#ffffff";
      button.title = "Нажмите, чтобы остановить загрузку";
      const count = button.querySelector(".ymd-count");
      if (count) count.textContent = "Прервать?";
    }
  });

  button.addEventListener("mouseleave", () => {
    isHovered = false;
    if (isDownloading) {
      button.style.backgroundColor = "";
      button.style.color = "";
      const count = button.querySelector(".ymd-count");
      if (count && !cancelRequested) {
        count.textContent = `${currentTrackNum}/${totalTracksNum}`;
      }
      if (cancelRequested) {
        if (count) count.textContent = "Остановка...";
        button.title = "Загрузка останавливается...";
      }
    }
  });

  button.addEventListener("click", async (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (isDownloading) {
      if (isFetchingTracks) return;
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
      button.classList.add("_downloading");
      isDownloading = true;

      const tracks = await fetchTracksFromAPI();
      isFetchingTracks = false;

      if (!tracks || tracks.length === 0) {
        alert("Не удалось загрузить треки по API. Пожалуйста, убедитесь, что вы авторизованы.");
        updateStatus("", false);
        return;
      }

      // Build static HTML once, then update only attributes
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" stroke-width="4" opacity="0.3"/><circle class="ymd-progress" cx="18" cy="18" r="16" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="0, 100"/></svg><span class="ymd-count">0/' + tracks.length + '</span>';
      const progressCircle = button.querySelector(".ymd-progress") as SVGCircleElement;
      const countSpan = button.querySelector(".ymd-count") as HTMLSpanElement;

      totalTracksNum = tracks.length;
      currentTrackNum = 0;

      const updateButtonUI = (current: number, total: number, percent: number) => {
        currentTrackNum = current;
        if (progressCircle) progressCircle.setAttribute("stroke-dasharray", `${percent}, 100`);
        if (countSpan && !isHovered) countSpan.textContent = `${current}/${total}`;
      };

      updateButtonUI(0, tracks.length, 0);

      await downloadBulk(
        tracks,
        (current: number, total: number, title: string) => {
          updateButtonUI(current, total, 0);
          button.title = `Скачивание: ${title} (${current} из ${total})`;
        },
        () => cancelRequested,
        (percent: number) => {
          updateButtonUI(currentTrackNum, tracks.length, percent);
        }
      );

      button.style.backgroundColor = "";
      button.style.color = "";
      isDownloading = false;

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
      alert(`Ошибка скачивания: ${typeof err === 'object' && err !== null && 'message' in err ? (err as Error).message : String(err)}`);
      updateStatus("", false);
    }
  });

  container.prepend(button);
  injectTelegramButton(container, button);
  injectExportButton(container, button);
}

function injectExportButton(container: Element, afterElement: HTMLElement): void {
  if (container.querySelector(".__ymd_export")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("__ymd_export");
  button.title = "Экспортировать список треков в TXT";

  const originalHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>';
  button.innerHTML = originalHTML;

  button.addEventListener("click", async (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (button.classList.contains("_loading")) return;
    button.classList.add("_loading");

    button.innerHTML =
      '<svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

    try {
      await exportTrackList();
      button.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    } catch (err) {
      console.error("Export failed:", err);
      alert(`Ошибка экспорта: ${err instanceof Error ? err.message : String(err)}`);
      button.innerHTML = originalHTML;
      button.classList.remove("_loading");
      return;
    }

    setTimeout(() => {
      button.innerHTML = originalHTML;
      button.classList.remove("_loading");
    }, 2000);
  });

  afterElement.insertAdjacentElement("afterend", button);
}

function injectTelegramButton(container: Element, afterElement: HTMLElement): void {
  if (container.querySelector(".__ymd_telegram")) return;

  const link = document.createElement("a");
  link.href = "https://t.me/ymdownloader";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.classList.add("__ymd_telegram");
  link.title = "YMD в Telegram";
  link.draggable = false;

  const iconUrl = chrome.runtime.getURL("src/ymd.png");
  const img = document.createElement("img");
  img.src = iconUrl;
  img.alt = "YMD";
  img.draggable = false;
  link.appendChild(img);

  afterElement.insertAdjacentElement("afterend", link);
}

function injectDonateButton(container: Element, afterElement: HTMLElement): void {
  if (container.querySelector(".__ymd_donate")) return;

  const link = document.createElement("a");
  link.href = "https://pay.cloudtips.ru/p/2b4c933e";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.classList.add("__ymd_donate");
  link.title = "Поддержать YMD";
  link.draggable = false;

  const iconUrl = chrome.runtime.getURL("src/donate.png");
  const img = document.createElement("img");
  img.src = iconUrl;
  img.alt = "Donate";
  img.draggable = false;
  link.appendChild(img);

  afterElement.insertAdjacentElement("afterend", link);
}

export function scanPage(): void {
  document
    .querySelectorAll(
      '.d-track:not(._ym_ready), .track:not(._ym_ready), div[class*="Track_root"]:not(._ym_ready)'
    )
    .forEach((track) => {
      track.classList.add("_ym_ready");
      injectTrackButton(track);
    });

  const headerSelectors =
    'div[class*="CommonPageHeader_controls__"], div[class*="PageHeaderPlaylist_mainControls"]';

  const header = document.querySelector(headerSelectors);
  if (header && !header.classList.contains("_ym_ready_hdr")) {
    header.classList.add("_ym_ready_hdr");
    injectHeaderButton(header);
  }

  injectPlayerBarButton();
}
