// Copy MapLibre's module worker into public/ so we can serve it ourselves.
//
// WHY THIS EXISTS — the blank-map trap, twice bitten:
// maplibre-gl v6 runs its worker as an ES module. The worker entry imports its
// shared chunk with a RELATIVE specifier (`./maplibre-gl-shared.mjs`). When the
// bundler emits the worker as a static asset it content-hashes the shared chunk
// (`maplibre-gl-shared.<hash>.mjs`) but leaves that import untouched, so the
// worker asks for `/_next/static/media/maplibre-gl-shared.mjs` and gets a 404.
// The worker then never boots, MapLibre never parses a tile, and the map paints
// nothing but the style background — while the build stays green and every other
// feature keeps working. That shipped undetected for four releases (v1.10.7 →
// v1.10.11) the last time maplibre-gl went to v6.
//
// Since maplibre-gl 6.13 the worker is self-contained again: it imports nothing
// relatively, and `maplibre-gl-shared.mjs` ships as an empty, deprecated
// placeholder (removed in the next major). So we copy the worker alone. We still
// serve it ourselves so its URL stays under our control; `setWorkerUrl()` in
// map-view.tsx points at the copy. If a release splits the worker again, the
// `maplibre-worker-assets` test names the file this list must add.
import { copyFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "maplibre-gl", "dist");
const dest = join(root, "public", "maplibre");

// The worker entry plus any chunk it imports relatively. Each keeps its exact name.
const FILES = ["maplibre-gl-worker.mjs"];

const missing = FILES.filter((f) => !existsSync(join(src, f)));
if (missing.length > 0) {
  // Fail the build rather than ship a map that renders nothing. If a future
  // maplibre-gl release renames these, this is where you find out.
  throw new Error(
    `maplibre-gl dist is missing ${missing.join(", ")} — the worker layout changed. ` +
      `Check dist/ and update scripts/copy-maplibre-worker.mjs (and setWorkerUrl in map-view.tsx).`,
  );
}

mkdirSync(dest, { recursive: true });
for (const file of FILES) copyFileSync(join(src, file), join(dest, file));

const { version } = JSON.parse(readFileSync(join(root, "node_modules", "maplibre-gl", "package.json"), "utf8"));
console.log(`[maplibre] copied worker assets for v${version} -> public/maplibre/`);
