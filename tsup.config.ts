// tsup.config.ts

import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  // Osobne wejście dla modułu backupu: ciągnie Node-owe API (child_process,
  // zlib, crypto), więc nie może trafić do buildu przeglądarkowego.
  entry: ["src/index.ts", "src/backup/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: "es2020",
  outDir: "dist",
  // Jedno źródło prawdy wersji: podmieniamy __SDK_VERSION__ na wersję z package.json.
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  esbuildOptions(options) {
    options.footer = {
      js: "",
    };
  },
});
