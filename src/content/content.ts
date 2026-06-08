/**
 * Yandex Music Downloader - Content Script Entry Point
 */
import { scanPage } from "./dom.ts";

(() => {
  const init = (): void => {
    scanPage();
    const observer = new MutationObserver(scanPage);
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
