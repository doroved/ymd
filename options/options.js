/**
 * Yandex Music Downloader - Extension Options Page
 * Manages saving and loading user preferences (quality, ID3 tagging, target download folders).
 * Refactored to be clean, readable, and well-structured.
 */

(() => {
  const browserApi = globalThis.browser || globalThis.chrome;

  // DOM Elements cache
  const elements = {
    qualitySelect: document.getElementById("bitrateQuality"),
    tagsCheckbox: document.getElementById("tags"),
    userFolderCheckbox: document.getElementById("userFolder"),
    folderNameInput: document.getElementById("folderName"),
    folderContainer: document.getElementById("folder"),
    positionCheckbox: document.getElementById("position"),
    coverSizeSelect: document.getElementById("coverSize")
  };

  /**
   * Refreshes the options UI state based on values stored in local storage
   */
  function updateSchema(folderName) {
    const name = (folderName || "YMDownloader").trim();
    const schemaElement = document.getElementById("folderSchema");
    if (!schemaElement) return;

    const useIndex = elements.positionCheckbox ? elements.positionCheckbox.checked : false;
    const indexPrefix = useIndex ? "[Индекс]. " : "";

    schemaElement.textContent =
`Downloads/
└── ${name}/
    ├── tracks/ (одиночные файлы)
    │   └── Исполнитель - Трек.mp3
    ├── albums/
    │   └── Название Альбома/
    │       └── ${indexPrefix}Исполнитель - Трек.mp3
    └── playlists/
        └── Название Плейлиста/
            └── ${indexPrefix}Исполнитель - Трек.mp3`;
  }

  function refreshUI() {
    browserApi.storage.local.get(
      ["quality", "tags", "folder", "path", "position", "cover"],
      (config) => {
        elements.qualitySelect.value = config.quality || "hq";
        elements.coverSizeSelect.value = config.cover || "400x400";

        elements.tagsCheckbox.checked = config.tags !== false;
        elements.positionCheckbox.checked = config.position === true;
        elements.userFolderCheckbox.checked = config.folder === true;

        if (config.folder === true) {
          elements.folderNameInput.value = config.path || "";
          elements.folderContainer.style.display = "flex";
          updateSchema(config.path);
        } else {
          elements.folderContainer.style.display = "none";
        }
      }
    );
  }

  /**
   * Binds change and input handlers for all option controls
   */
  function bindEventHandlers() {
    elements.qualitySelect.addEventListener("change", () => {
      browserApi.storage.local.set({ quality: elements.qualitySelect.value });
    });

    elements.coverSizeSelect.addEventListener("change", () => {
      browserApi.storage.local.set({ cover: elements.coverSizeSelect.value });
    });

    elements.tagsCheckbox.addEventListener("change", () => {
      browserApi.storage.local.set({ tags: elements.tagsCheckbox.checked });
    });

    elements.positionCheckbox.addEventListener("change", () => {
      browserApi.storage.local.set({ position: elements.positionCheckbox.checked }, () => {
        updateSchema(elements.folderNameInput.value);
      });
    });

    elements.userFolderCheckbox.addEventListener("change", () => {
      browserApi.storage.local.set({ folder: elements.userFolderCheckbox.checked }, () => {
        refreshUI();
      });
    });

    // Sanitize subfolder name to only allow safe alphanumeric and hyphen/underscore characters
    elements.folderNameInput.addEventListener("input", () => {
      const sanitizedPath = elements.folderNameInput.value.replace(/[^a-z0-9A-Zа-яА-Я\-_]/gi, "");
      browserApi.storage.local.set({ path: sanitizedPath }, () => {
        updateSchema(sanitizedPath);
      });
    });
  }

  // Initialize page configuration
  browserApi.storage.local.get(["path", "folder", "position"], (config) => {
    if (config.path === undefined) {
      browserApi.storage.local.set({ folder: true, path: "YMDownloader", position: true }, () => {
        refreshUI();
        updateSchema("YMDownloader");
      });
    } else {
      refreshUI();
      updateSchema(config.path);
    }
    bindEventHandlers();
  });
})();
