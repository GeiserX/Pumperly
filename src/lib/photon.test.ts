import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MOCK_PHOTON = "http://photon.test";

describe("photon geocode", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PHOTON_URL = MOCK_PHOTON;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each([
    ["40.741895, -73.989308", [-73.989308, 40.741895]],
    ["40.4168 -3.7038", [-3.7038, 40.4168]],
    ["40.7419°, -73.9893°", [-73.9893, 40.7419]],
    ["40.7419 N, 73.9893 W", [-73.9893, 40.7419]],
    ["N 40.7419 W 73.9893", [-73.9893, 40.7419]],
    ["40.7419°N 73.9893°W", [-73.9893, 40.7419]],
    [`40°44'30.8"N 73°59'21.5"W`, [-(73 + 59 / 60 + 21.5 / 3600), 40 + 44 / 60 + 30.8 / 3600]],
    ["40°44′30.8″N 73°59′21.5″W", [-(73 + 59 / 60 + 21.5 / 3600), 40 + 44 / 60 + 30.8 / 3600]],
    ["40 44 30.8 N 73 59 21.5 W", [-(73 + 59 / 60 + 21.5 / 3600), 40 + 44 / 60 + 30.8 / 3600]],
    [`40°44'30" 73°59'21"`, [73 + 59 / 60 + 21 / 3600, 40 + 44 / 60 + 30 / 3600]],
    ["40° 44.514' N, 73° 59.359' W", [-(73 + 59.359 / 60), 40 + 44.514 / 60]],
    ["N 40° 44.514 W 073° 59.359", [-(73 + 59.359 / 60), 40 + 44.514 / 60]],
    ["33°52'S 151°12'E", [151.2, -(33 + 52 / 60)]],
    ["73.9893 W 40.7419 N", [-73.9893, 40.7419]],
    ["40,7419; -73,9893", [-73.9893, 40.7419]],
    ["40,7419, -73,9893", [-73.9893, 40.7419]],
    ["40,7419 -73,9893", [-73.9893, 40.7419]],
  ])("parses %s", async (input, expected) => {
    const { parseCoordinates } = await import("./photon");
    const result = parseCoordinates(input);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(expected[0], 6);
    expect(result![1]).toBeCloseTo(expected[1], 6);
  });

  it.each([
    "95.0, 10.0",
    "40.4, 190",
    "Madrid 28",
    "N 340",
    "28 3",
    "28, 3",
    "28,3",
    "40,74",
    "40,5 3",
    "40 70 N 3 W",
    "-40.7 S, 73.9 W",
    "40.7 E, 73.9 E",
    "1, 2, 3",
  ])("rejects %s", async (input) => {
    const { parseCoordinates } = await import("./photon");
    expect(parseCoordinates(input)).toBeNull();
  });

  it("returns empty array when PHOTON_URL is not set", async () => {
    delete process.env.PHOTON_URL;
    const { geocode } = await import("./photon");
    const results = await geocode("Madrid");
    expect(results).toEqual([]);
  });

  it("returns parsed results from Photon API", async () => {
    const { geocode } = await import("./photon");

    const mockResponse = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-3.7038, 40.4168] },
          properties: {
            name: "Madrid",
            city: "Madrid",
            state: "Community of Madrid",
            country: "Spain",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-3.6, 40.5] },
          properties: {
            name: "Madrid Barajas",
            country: "Spain",
          },
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const results = await geocode("Madrid", 40.4, -3.7);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      name: "Madrid",
      city: "Madrid",
      state: "Community of Madrid",
      country: "Spain",
      coordinates: [-3.7038, 40.4168],
    });
    expect(results[1].city).toBeNull();
    expect(results[1].state).toBeNull();

    // Verify fetch was called with correct params
    const call = vi.mocked(fetch).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain(`${MOCK_PHOTON}/api?`);
    expect(url).toContain("q=Madrid");
    expect(url).toContain("lat=40.4");
    expect(url).toContain("lon=-3.7");
    expect(url).toContain("limit=5");
  });

  it("returns empty array on non-ok response", async () => {
    const { geocode } = await import("./photon");

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const results = await geocode("test");
    expect(results).toEqual([]);
  });

  it("uses query as fallback name when property name is missing", async () => {
    const { geocode } = await import("./photon");

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: {},
          },
        ],
      }),
    } as Response);

    const results = await geocode("Unknown Place");
    expect(results[0].name).toBe("Unknown Place");
  });

  it("returns empty array when response body is not valid JSON", async () => {
    const { geocode } = await import("./photon");

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);

    const results = await geocode("Madrid");
    expect(results).toEqual([]);
  });

  it("returns empty array when features is not an array", async () => {
    const { geocode } = await import("./photon");

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ type: "FeatureCollection" }),
    } as Response);

    const results = await geocode("Madrid");
    expect(results).toEqual([]);
  });

  it("skips features with malformed geometry coordinates", async () => {
    const { geocode } = await import("./photon");

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point" }, properties: { name: "NoCoords" } },
          { type: "Feature", properties: { name: "NoGeometry" } },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-3.7, 40.4] },
            properties: { name: "Valid" },
          },
        ],
      }),
    } as Response);

    const results = await geocode("test");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Valid");
    expect(results[0].coordinates).toEqual([-3.7, 40.4]);
  });

  it("does not send lat/lon params when not provided", async () => {
    const { geocode } = await import("./photon");

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ type: "FeatureCollection", features: [] }),
    } as Response);

    await geocode("Berlin");

    const call = vi.mocked(fetch).mock.calls[0];
    const url = call[0] as string;
    expect(url).not.toContain("lat=");
    expect(url).not.toContain("lon=");
  });
});
