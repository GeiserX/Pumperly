import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { headers?: Record<string, string>; status?: number }) => ({
      data,
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
    }),
  },
}));

vi.mock("@/lib/photon", () => ({
  geocode: vi.fn(),
}));

function makeRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/geocode");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: url };
}

describe("geocode API", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PHOTON_URL;
  });

  it("returns geocode results for valid query", async () => {
    const { geocode } = await import("@/lib/photon");
    vi.mocked(geocode).mockResolvedValue([
      { name: "Madrid", city: "Madrid", state: "Comunidad de Madrid", country: "Spain", coordinates: [-3.7, 40.4] },
    ]);

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET(makeRequest({ q: "Madrid" }) as any)) as any;

    expect(response.status).toBe(200);
    expect(response.data).toHaveLength(1);
    expect(response.data[0].name).toBe("Madrid");
    expect(response.headers["Cache-Control"]).toBe("public, s-maxage=300, stale-while-revalidate=600");
  });

  it("passes lat/lon to geocode when provided", async () => {
    const { geocode } = await import("@/lib/photon");
    vi.mocked(geocode).mockResolvedValue([]);

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(makeRequest({ q: "Berlin", lat: "52.52", lon: "13.405" }) as any);

    expect(geocode).toHaveBeenCalledWith("Berlin", 52.52, 13.405);
  });

  it("returns 400 when q is missing", async () => {
    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET(makeRequest({}) as any)) as any;

    expect(response.status).toBe(400);
    expect(response.data.error).toBe("Invalid parameters");
    expect(response.data.details).toBeDefined();
  });

  it("returns 400 when lat is out of range", async () => {
    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET(makeRequest({ q: "test", lat: "999" }) as any)) as any;

    expect(response.status).toBe(400);
    expect(response.data.error).toBe("Invalid parameters");
  });

  it("returns 502 when geocode throws", async () => {
    const { geocode } = await import("@/lib/photon");
    vi.mocked(geocode).mockRejectedValue(new Error("Network error"));

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET(makeRequest({ q: "Madrid" }) as any)) as any;

    expect(response.status).toBe(502);
    expect(response.data.error).toBe("Geocoding failed");
    expect(response.headers["Cache-Control"]).toBeUndefined();
  });

  // End to end through the real Photon client: a search server that is down
  // or serves an HTML error page must give an uncached 502, never a cached
  // empty list that reads as "No results found" for minutes.
  it.each([
    ["a 503", { ok: false, status: 503, json: async () => ({}) }],
    ["an HTML page", { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }],
  ])("returns an uncached 502 when Photon answers %s", async (_label, upstream) => {
    process.env.PHOTON_URL = "http://photon.test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstream));
    const actual = await vi.importActual<typeof import("@/lib/photon")>("@/lib/photon");
    const { geocode } = await import("@/lib/photon");
    vi.mocked(geocode).mockImplementation(actual.geocode);

    const { GET } = await import("./route");
    const response = (await GET(makeRequest({ q: "Town A" }) as any)) as any;

    expect(response.status).toBe(502);
    expect(response.headers["Cache-Control"]).toBeUndefined();
  });
});
