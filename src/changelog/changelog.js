const CHANGELOG_URL =
  "https://raw.githubusercontent.com/doroved/ymd/refs/heads/main/CHANGELOG.md";

const MONTHS_RU = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const EMOJI_TO_CATEGORY = {
  "✨": { label: "Новое", cls: "new" },
  "⬆️": { label: "Улучшение", cls: "improvement" },
  "🐛": { label: "Исправление", cls: "fix" },
};

function formatDateRu(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${day} ${MONTHS_RU[month - 1]} ${year}`;
}

function parseChangelog(md) {
  const versions = [];
  let current = null;
  let currentCategory = null;

  for (const rawLine of md.split("\n")) {
    const line = rawLine.trimEnd();

    // ## Версия X.X.X — YYYY-MM-DD
    const versionMatch = line.match(
      /^## Версия\s+([\d.]+)\s+—\s+(\d{4}-\d{2}-\d{2})/
    );
    if (versionMatch) {
      current = {
        version: versionMatch[1],
        date: versionMatch[2],
        changes: [],
      };
      versions.push(current);
      currentCategory = null;
      continue;
    }

    if (!current) continue;

    // ### emoji Категория
    const categoryMatch = line.match(/^### (.+)/);
    if (categoryMatch) {
      const heading = categoryMatch[1].trim();
      currentCategory = null;
      for (const [emoji, cat] of Object.entries(EMOJI_TO_CATEGORY)) {
        if (heading.includes(emoji)) {
          currentCategory = cat;
          break;
        }
      }
      continue;
    }

    // - **Title** — Description
    const itemMatch = line.match(/^- \*\*(.+?)\*\*\s*—\s*(.+)/);
    if (itemMatch && currentCategory) {
      current.changes.push({
        category: currentCategory,
        title: itemMatch[1],
        description: itemMatch[2],
      });
    }
  }

  return versions;
}

function renderTimeline(versions) {
  const timeline = document.createElement("div");
  timeline.className = "timeline";

  versions.forEach((ver, index) => {
    const item = document.createElement("div");
    item.className = "timeline-item";

    // Dot
    const dot = document.createElement("div");
    dot.className = "timeline-dot";
    if (index === 0) dot.classList.add("active");
    item.appendChild(dot);

    // Version header
    const header = document.createElement("div");
    header.className = "timeline-header";

    const versionEl = document.createElement("span");
    versionEl.className = "timeline-version";
    versionEl.textContent = `Версия ${ver.version}`;
    header.appendChild(versionEl);

    const dateEl = document.createElement("span");
    dateEl.className = "timeline-date";
    dateEl.textContent = `— ${formatDateRu(ver.date)}`;
    header.appendChild(dateEl);

    item.appendChild(header);

    // Changes
    const changesEl = document.createElement("div");
    changesEl.className = "timeline-changes";

    for (const change of ver.changes) {
      const changeEl = document.createElement("div");
      changeEl.className = "timeline-change";

      const titleRow = document.createElement("div");
      titleRow.className = "timeline-change-header";

      const title = document.createElement("span");
      title.className = "timeline-change-title";
      title.textContent = change.title;
      titleRow.appendChild(title);

      const badge = document.createElement("span");
      badge.className = `feature-badge ${change.category.cls}`;
      badge.textContent = change.category.label;
      titleRow.appendChild(badge);

      changeEl.appendChild(titleRow);

      const desc = document.createElement("div");
      desc.className = "timeline-change-desc";
      desc.textContent = change.description;
      changeEl.appendChild(desc);
      changesEl.appendChild(changeEl);
    }

    item.appendChild(changesEl);
    timeline.appendChild(item);
  });

  return timeline;
}

function showLoading(container) {
  const el = document.createElement("div");
  el.className = "timeline-loading";
  el.textContent = "Загрузка...";
  container.appendChild(el);
}

function showError(container) {
  container.innerHTML = "";
  const el = document.createElement("div");
  el.className = "timeline-error";
  el.textContent = "Не удалось загрузить историю изменений";
  container.appendChild(el);
}

async function init() {
  const container = document.getElementById("timeline");
  const versionBadge = document.querySelector(".version-badge");

  showLoading(container);

  try {
    const response = await fetch(CHANGELOG_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const md = await response.text();
    const versions = parseChangelog(md);

    if (versions.length === 0) {
      showError(container);
      return;
    }

    // Update version badge in header
    if (versionBadge) {
      versionBadge.textContent = `Версия ${versions[0].version}`;
    }

    // Render timeline
    container.innerHTML = "";
    container.appendChild(renderTimeline(versions));
  } catch (e) {
    console.error("Changelog load error:", e);
    showError(container);
  }
}

document.addEventListener("DOMContentLoaded", init);
