import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig, type UserConfig } from "vite";

const outputDirs = ["extension/chrome/src", "extension/firefox/src"];

/**
 * Vite plugin that copies static vendor files (e.g. tag.js)
 * into each output directory after the build completes.
 */
function copyVendorPlugin(): Plugin {
  return {
    name: "copy-vendor",
    writeBundle(options) {
      const dir = options.dir;
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      copyFileSync(
        resolve("src/vendor/tag.js"),
        resolve(dir, "tag.js")
      );
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
          options: "./src/options/options.ts",
          welcome: "./src/welcome/welcome.ts",
          "content-styles": "./src/assets/content.css",
        },
        output: outputDirs.map((dir) => ({
          dir,
          entryFileNames: "[name].js",
          assetFileNames: "content.css",
        })),
        plugins: [copyVendorPlugin()],
      },
    },
  } satisfies UserConfig;
});
