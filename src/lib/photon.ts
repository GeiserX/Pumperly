const PHOTON_URL = process.env.PHOTON_URL;

export interface PhotonResult {
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  coordinates: [number, number]; // [lon, lat]
}

interface PhotonFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
  };
}

interface PhotonResponse {
  type: "FeatureCollection";
  features: PhotonFeature[];
}

type CoordToken =
  | { kind: "num"; value: number; text: string; unit?: "°" | "'" | '"' }
  | { kind: "hemi"; value: "N" | "S" | "E" | "W" }
  | { kind: "sep" };

const TOKEN_RE = /\s*(?:(-?\d+(?:\.\d+)?)\s*([°'"])?|([NSEW])|([,;]))/y;

function tokenize(input: string): CoordToken[] | null {
  const tokens: CoordToken[] = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < input.length) {
    const m = TOKEN_RE.exec(input);
    if (!m) return null;
    if (m[1] != null) {
      tokens.push({ kind: "num", value: Number(m[1]), text: m[1], unit: m[2] as "°" | "'" | '"' | undefined });
    } else if (m[3] != null) {
      tokens.push({ kind: "hemi", value: m[3] as "N" | "S" | "E" | "W" });
    } else {
      tokens.push({ kind: "sep" });
    }
  }
  return tokens;
}

// Split the token list into the two coordinate components
function splitComponents(tokens: CoordToken[]): [CoordToken[], CoordToken[]] | null {
  const seps = tokens.flatMap((t, i) => (t.kind === "sep" ? [i] : []));
  if (seps.length > 1) return null;
  if (seps.length === 1) return [tokens.slice(0, seps[0]), tokens.slice(seps[0] + 1)];

  const hemis = tokens.flatMap((t, i) => (t.kind === "hemi" ? [i] : []));
  if (hemis.length === 2) {
    if (hemis[0] === 0) return [tokens.slice(0, hemis[1]), tokens.slice(hemis[1])]; // N 40 W 73
    if (hemis[1] === tokens.length - 1) return [tokens.slice(0, hemis[0] + 1), tokens.slice(hemis[0] + 1)]; // 40 N 73 W
    return null;
  }
  if (hemis.length > 0) return null;

  // 40°44'30" 73°59'21" — second component starts at the second degree value
  const degs = tokens.flatMap((t, i) => (t.kind === "num" && t.unit === "°" ? [i] : []));
  if (degs.length === 2 && degs[0] === 0) return [tokens.slice(0, degs[1]), tokens.slice(degs[1])];

  // Bare "40.74 -73.98" (lone whole numbers are rejected in parseNormalized)
  if (tokens.length === 2 && tokens.every((t) => t.kind === "num" && !t.unit)) {
    return [[tokens[0]], [tokens[1]]];
  }
  return null;
}

// A single unitless whole number ("28") is too weak to be a coordinate on its own;
// rejecting it keeps "28, 3" for Photon and lets "40,74" fall through to the decimal-comma retry
function isLoneInteger(tokens: CoordToken[]): boolean {
  const t = tokens[0];
  return tokens.length === 1 && t.kind === "num" && !t.unit && !t.text.includes(".");
}

const UNIT_POS = { "°": 0, "'": 1, '"': 2 } as const;

function parseComponent(tokens: CoordToken[]): { value: number; hemi?: "N" | "S" | "E" | "W" } | null {
  let hemi: "N" | "S" | "E" | "W" | undefined;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (first?.kind === "hemi") {
    hemi = first.value;
    tokens = tokens.slice(1);
  } else if (last?.kind === "hemi") {
    hemi = last.value;
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length < 1 || tokens.length > 3) return null;

  const parts = [0, 0, 0];
  let pos = -1;
  let negative = false;
  for (const [i, t] of tokens.entries()) {
    if (t.kind !== "num") return null;
    if (i === 0) negative = t.text.startsWith("-");
    const p = t.unit ? UNIT_POS[t.unit] : pos + 1;
    if (p <= pos) return null; // units out of order, e.g. 30" 44'
    if (i > 0 && t.value < 0) return null;
    if (i < tokens.length - 1 && !Number.isInteger(t.value)) return null; // only the last part may be fractional
    parts[p] = Math.abs(t.value);
    pos = p;
  }
  if (parts[1] >= 60 || parts[2] >= 60) return null;

  if (negative && hemi) return null; // "-40 S" is ambiguous
  const abs = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return { value: negative || hemi === "S" || hemi === "W" ? -abs : abs, hemi };
}

function parseNormalized(input: string): [number, number] | null {
  const tokens = tokenize(input);
  if (!tokens) return null;
  const split = splitComponents(tokens);
  if (!split || split.some(isLoneInteger)) return null;
  const a = parseComponent(split[0]);
  const b = parseComponent(split[1]);
  if (!a || !b) return null;

  const isLat = (h?: string) => h === "N" || h === "S";
  const isLon = (h?: string) => h === "E" || h === "W";
  let lat = a;
  let lon = b;
  if (isLon(a.hemi) && isLat(b.hemi)) [lat, lon] = [b, a]; // "73 W 40 N"
  if (isLon(lat.hemi) || isLat(lon.hemi)) return null;

  if (Math.abs(lat.value) > 90 || Math.abs(lon.value) > 180) return null;
  return [lon.value, lat.value];
}

/**
 * Parses typed coordinates (latitude first) into [lon, lat]. Accepts decimal degrees,
 * DMS (40°44'30.8"N 73°59'21.5"W), DDM (40° 44.514' N), N/S/E/W letters before or
 * after the number, and decimal commas when unambiguous (40,7419; -73,9893).
 */
export function parseCoordinates(query: string): [number, number] | null {
  const normalized = query
    .toUpperCase()
    .replace(/[º˚]/g, "°")
    .replace(/[′’‘´`]/g, "'")
    .replace(/[″“”]|''/g, '"')
    .trim();
  if (!normalized) return null;

  const result = parseNormalized(normalized);
  if (result || normalized.includes(".")) return result;
  // European decimal commas: 40,7419, -73,9893 or 40,7419 -73,9893
  return parseNormalized(normalized.replace(/(\d),(\d)/g, "$1.$2"));
}

export async function geocode(
  query: string,
  lat?: number,
  lon?: number,
): Promise<PhotonResult[]> {
  if (!PHOTON_URL) return [];

  const params = new URLSearchParams({ q: query, limit: "5" });
  if (lat != null && lon != null) {
    params.set("lat", String(lat));
    params.set("lon", String(lon));
  }

  const res = await fetch(`${PHOTON_URL}/api?${params}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return [];

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. HTML error page) — treat as no results
    return [];
  }

  const features = (data as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];

  const results: PhotonResult[] = [];
  for (const f of features as PhotonFeature[]) {
    const coordinates = f?.geometry?.coordinates;
    // Skip malformed features lacking a valid [lon, lat] pair
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      typeof coordinates[0] !== "number" ||
      typeof coordinates[1] !== "number"
    ) {
      continue;
    }
    const properties = f.properties ?? {};
    results.push({
      name: properties.name ?? query,
      city: properties.city ?? null,
      state: properties.state ?? null,
      country: properties.country ?? null,
      coordinates: [coordinates[0], coordinates[1]],
    });
  }

  return results;
}
