import { copyFileSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig, type UserConfig } from "vite";

const outputDirs = ["extension/chrome/src", "extension/firefox/src"];

/**
 * Vite plugin that copies static vendor files (e.g. tag.js)
 * and shared static assets (icons, options, welcome)
 * into each output directory after the build completes.
 */
function copyAssetsPlugin(): Plugin {
  return {
    name: "copy-assets",
    writeBundle(options) {
      const srcDir = options.dir; // e.g. "extension/chrome/src"
      if (!srcDir) return;

      const extDir = resolve(srcDir, ".."); // e.g. "extension/chrome"

      // Copy tag.js into extension/*/src/
      mkdirSync(srcDir, { recursive: true });
      copyFileSync(
        resolve("src/vendor/tag.js"),
        resolve(srcDir, "tag.js")
      );

      // Copy static assets (icons, options, welcome) into extension/*/src/
      // 1. Icons folder
      const destIcons = resolve(srcDir, "icons");
      mkdirSync(destIcons, { recursive: true });
      cpSync(resolve("src/assets/icons"), destIcons, { recursive: true });

      // 2. Options pages
      const destOptions = resolve(srcDir, "options");
      mkdirSync(destOptions, { recursive: true });
      copyFileSync(resolve("src/options/options.html"), resolve(destOptions, "options.html"));
      copyFileSync(resolve("src/options/options.css"), resolve(destOptions, "options.css"));

      // 3. Welcome pages
      const destWelcome = resolve(srcDir, "welcome");
      mkdirSync(destWelcome, { recursive: true });
      copyFileSync(resolve("src/welcome/welcome.html"), resolve(destWelcome, "welcome.html"));
      copyFileSync(resolve("src/welcome/welcome.css"), resolve(destWelcome, "welcome.css"));

      // 4. Changelog pages
      const destChangelog = resolve(srcDir, "changelog");
      mkdirSync(destChangelog, { recursive: true });
      copyFileSync(resolve("src/changelog/changelog.html"), resolve(destChangelog, "changelog.html"));
      copyFileSync(resolve("src/changelog/changelog.css"), resolve(destChangelog, "changelog.css"));
      copyFileSync(resolve("src/changelog/changelog.js"), resolve(destChangelog, "changelog.js"));
      copyFileSync(resolve("src/changelog/attention.png"), resolve(destChangelog, "attention.png"));
    },
  };
}

export default defineConfig(({ mode }) => {
  return {
    build: {
      emptyOutDir: false,
      sourcemap: mode === "development" ? "inline" : false,
      rollupOptions: {
        input: {
          content: "./src/content/content.ts",
          sw: "./src/background/sw.ts",
          "options/options": "./src/options/options.ts",
          "welcome/welcome": "./src/welcome/welcome.ts",
          "content-styles": "./src/assets/content.css",
        },
        output: outputDirs.map((dir) => ({
          dir,
          entryFileNames: "[name].js",
          assetFileNames: "content.css",
        })),
        plugins: [copyAssetsPlugin()],
      },
    },
  } satisfies UserConfig;
});
