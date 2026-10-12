import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

// Static files are copied as-is.
for (const file of ["manifest.json", "sidepanel.html", "sidepanel.css", "background.js"]) {
  cpSync(`src/${file}`, `dist/${file}`);
}
cpSync("src/icons", "dist/icons", { recursive: true, filter: (f) => !f.endsWith(".svg") });

// sidepanel.js imports WebLLM and OpenCC from node_modules, so bundle it into one file.
// Chrome extensions can't load code from a CDN, so everything must be local.
await build({
  entryPoints: ["src/sidepanel.js"],
  bundle: true,
  format: "esm",
  target: "chrome124",
  outdir: "dist",
  logLevel: "info",
});
