/**
 * Guards the MapLibre worker assets we serve ourselves from public/maplibre/.
 *
 * The failure this exists to catch is silent and expensive: maplibre-gl v6 runs
 * its worker as an ES module, and that worker imports its shared chunk with a
 * relative specifier. If we don't serve every file it asks for, side by side and
 * under the exact names it uses, the worker never boots and the map renders
 * nothing but its background — with a green build, a healthy server, and every
 * other feature working. That shipped unnoticed for four releases once already.
 *
 * A browser test would catch it too, but there is no browser in CI; this runs in
 * milliseconds and pins the one fact the fix depends on. It lives under src/ so
 * the `node` vitest project picks it up (it only scans src/**).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "node_modules", "maplibre-gl", "dist");
const COPY_SCRIPT = join(ROOT, "scripts", "copy-maplibre-worker.mjs");
const WORKER_ENTRY = "maplibre-gl-worker.mjs";

/** The FILES array the prebuild script actually copies — parsed, not duplicated. */
function filesCopiedByScript(): string[] {
  const src = readFileSync(COPY_SCRIPT, "utf8");
  const match = src.match(/const FILES = \[([^\]]*)\]/);
  if (!match) throw new Error("could not find the FILES array in copy-maplibre-worker.mjs");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Relative specifiers (`./x.mjs`) a module imports — these must resolve at runtime. */
function relativeImports(fileContents: string): string[] {
  const specifiers = [...fileContents.matchAll(/from\s*"(\.[^"]*)"/g)].map((m) => m[1]);
  return [...new Set(specifiers)];
}

describe("maplibre worker assets", () => {
  it("ships the worker entry maplibre-gl exposes", () => {
    expect(existsSync(join(DIST, WORKER_ENTRY))).toBe(true);
    expect(filesCopiedByScript()).toContain(WORKER_ENTRY);
  });

  it("copies every file the worker imports relatively", () => {
    const copied = filesCopiedByScript();
    const imports = relativeImports(readFileSync(join(DIST, WORKER_ENTRY), "utf8"));

    // The worker must import something — a zero-match regex would pass vacuously.
    expect(imports.length).toBeGreaterThan(0);

    for (const specifier of imports) {
      const name = specifier.replace(/^\.\//, "");
      expect(
        copied,
        `the worker imports ${specifier}, so copy-maplibre-worker.mjs must copy ${name} ` +
          `or the worker 404s and the map renders blank`,
      ).toContain(name);
    }
  });

  it("copies only files that exist in maplibre-gl's dist", () => {
    for (const file of filesCopiedByScript()) {
      expect(existsSync(join(DIST, file)), `${file} is missing from maplibre-gl/dist`).toBe(true);
    }
  });
});
