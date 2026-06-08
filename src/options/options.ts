/// <reference types="chrome" />

declare global {
  var browser: typeof chrome | undefined;
}

(() => {
  const browserApi = globalThis.browser || globalThis.chrome;

  const elements = {
    formatSelect: document.getElementById("audioFormat") as HTMLSelectElement,
    bitrateRow: document.getElementById("bitrateRow") as HTMLDivElement,
    qualitySelect: document.getElementById("bitrateQuality") as HTMLSelectElement,
    tagsCheckbox: document.getElementById("tags") as HTMLInputElement,
    userFolderCheckbox: document.getElementById("userFolder") as HTMLInputElement,
    folderNameInput: document.getElementById("folderName") as HTMLInputElement,
    folderContainer: document.getElementById("folder") as HTMLDivElement,
    positionCheckbox: document.getElementById("position") as HTMLInputElement,
    coverSizeSelect: document.getElementById("coverSize") as HTMLSelectElement,
  };

  function updateSchema(folderName: string): void {
    const name = (folderName || "YMDownloader").trim();
    const schemaElement = document.getElementById("folderSchema");
    if (!schemaElement) return;

    const useIndex = elements.positionCheckbox ? elements.positionCheckbox.checked : false;
    const indexPrefix = useIndex ? "[Индекс]. " : "";
    const ext = elements.formatSelect.value === "flac" ? ".flac" : ".mp3";

    schemaElement.textContent =
      `Downloads/\n└── ${name}/\n    ├── tracks/ (одиночные файлы)\n    │   └── Исполнитель - Трек${ext}\n    ├── albums/\n    │   └── Название Альбома/\n    │       └── ${indexPrefix}Исполнитель - Трек${ext}\n    └── playlists/\n        └── Название Плейлиста/\n            └── ${indexPrefix}Исполнитель - Трек${ext}`;
  }

  function toggleBitrateVisibility(): void {
    if (elements.formatSelect.value === "flac") {
      elements.bitrateRow.style.display = "none";
    } else {
      elements.bitrateRow.style.display = "flex";
    }
  }

  function refreshUI(): void {
    browserApi.storage.local.get(
      ["quality", "format", "tags", "folder", "path", "position", "cover"],
      (config: Record<string, any>) => {
        elements.formatSelect.value = config.format || "mp3";
        elements.qualitySelect.value = config.quality || "hq";
        elements.coverSizeSelect.value = config.cover || "400x400";

        elements.tagsCheckbox.checked = config.tags !== false;
        elements.positionCheckbox.checked = config.position === true;
        elements.userFolderCheckbox.checked = config.folder === true;

        toggleBitrateVisibility();

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

  function bindEventHandlers(): void {
    elements.formatSelect.addEventListener("change", () => {
      browserApi.storage.local.set({ format: elements.formatSelect.value }, () => {
        toggleBitrateVisibility();
        updateSchema(elements.folderNameInput.value);
      });
    });

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

    elements.folderNameInput.addEventListener("input", () => {
      const sanitizedPath = elements.folderNameInput.value.replace(/[^a-z0-9A-Zа-яА-Я\-_]/gi, "");
      browserApi.storage.local.set({ path: sanitizedPath }, () => {
        updateSchema(sanitizedPath);
      });
    });
  }

  browserApi.storage.local.get(["path", "folder", "position"], (config: Record<string, any>) => {
    if (config.path === undefined) {
      browserApi.storage.local.set(
        { folder: false, path: "YMDownloader", position: false, format: "mp3" },
        () => {
          refreshUI();
          updateSchema("YMDownloader");
        }
      );
    } else {
      refreshUI();
      updateSchema(config.path);
    }
    bindEventHandlers();
  });
})();
