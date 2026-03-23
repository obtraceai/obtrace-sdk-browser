import { build } from "esbuild";

await build({
  entryPoints: ["src/browser_entry.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/browser_entry.bundle.js",
  platform: "browser",
  target: "es2022",
  minify: false,
  sourcemap: true,
  external: [],
});
