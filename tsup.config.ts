// tsup.config.ts

import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
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
