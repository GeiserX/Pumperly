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

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("@/lib/config", () => ({
  getConfig: vi.fn().mockReturnValue({
    defaultCountry: "ES",
    enabledCountries: ["ES", "DE"],
    defaultFuel: "B7",
    center: [-3.7, 40.4],
    zoom: 6,
  }),
  COUNTRIES: {
    ES: { code: "ES", name: "España", center: [-3.7, 40.4], zoom: 6 },
    DE: { code: "DE", name: "Deutschland", center: [10.45, 51.16], zoom: 6 },
  } as Record<string, { code: string; name: string; center: [number, number]; zoom: number }>,
}));

describe("stats API", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns stats with totals and per-country breakdown", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      { country: "ES", stations: 12000, prices: 180000, last_update: new Date("2026-04-20T10:00:00Z") },
      { country: "DE", stations: 15000, prices: 225000, last_update: new Date("2026-04-20T09:00:00Z") },
    ]);

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET()) as any;

    expect(response.status).toBe(200);
    expect(response.data.totals.stations).toBe(27000);
    expect(response.data.totals.prices).toBe(405000);
    expect(response.data.countries).toHaveLength(2);
    expect(response.data.countries[0].code).toBe("ES");
    expect(response.data.countries[0].name).toBe("España");
    expect(response.data.countries[0].stations).toBe(12000);
    expect(response.data.countries[0].lastUpdate).toBe("2026-04-20T10:00:00.000Z");
  });

  it("includes config in response", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET()) as any;

    expect(response.data.config.defaultCountry).toBe("ES");
    expect(response.data.config.enabledCountries).toEqual(["ES", "DE"]);
    expect(response.data.config.defaultFuel).toBe("B7");
    expect(response.data.config.center).toEqual([-3.7, 40.4]);
    expect(response.data.config.zoom).toBe(6);
  });

  it("sets cache-control header", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET()) as any;

    expect(response.headers["Cache-Control"]).toBe("public, s-maxage=300, stale-while-revalidate=600");
  });

  it("handles null last_update", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      { country: "ES", stations: 100, prices: 0, last_update: null },
    ]);

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET()) as any;

    expect(response.data.countries[0].lastUpdate).toBeNull();
  });

  it("falls back to country code when not in COUNTRIES map", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      { country: "XX", stations: 50, prices: 100, last_update: null },
    ]);

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET()) as any;

    expect(response.data.countries[0].code).toBe("XX");
    expect(response.data.countries[0].name).toBe("XX");
  });

  it("returns 500 when database fails", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockRejectedValue(new Error("DB error"));

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET()) as any;

    expect(response.status).toBe(500);
    expect(response.data.error).toBe("Internal server error");
  });

  it("returns zero totals when no countries exist", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    const { GET } = await import("./route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await GET()) as any;

    expect(response.data.totals.stations).toBe(0);
    expect(response.data.totals.prices).toBe(0);
    expect(response.data.countries).toHaveLength(0);
  });
  it("runs the stats query with more work_mem inside one transaction", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockClear().mockResolvedValue([]);
    vi.mocked(prisma.$executeRawUnsafe).mockClear();

    const { GET } = await import("./route");
    await GET();

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(vi.mocked(prisma.$executeRawUnsafe).mock.calls[0][0]).toMatch(/^SET LOCAL work_mem = '32MB'$/);
    const sql = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0][0] as string;
    expect(sql).not.toMatch(/COUNT\(DISTINCT/i);
  });

  it("serves a second call within 300 s from memory without querying the database", async () => {
    vi.useFakeTimers();
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockClear().mockResolvedValue([
      { country: "ES", stations: 100, prices: 200, last_update: null },
    ]);

    const { GET } = await import("./route");
    const first = (await GET()) as any;
    vi.advanceTimersByTime(299_000);
    const second = (await GET()) as any;

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(second.data).toEqual(first.data);
  });

  it("queries the database again once 300 s have passed", async () => {
    vi.useFakeTimers();
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockClear()
      .mockResolvedValueOnce([{ country: "ES", stations: 100, prices: 200, last_update: null }])
      .mockResolvedValueOnce([{ country: "ES", stations: 101, prices: 202, last_update: null }]);

    const { GET } = await import("./route");
    await GET();
    vi.advanceTimersByTime(300_000);
    const second = (await GET()) as any;

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(second.data.totals.stations).toBe(101);
  });

  it("shares one query between calls that arrive while it runs", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockClear().mockResolvedValue([]);

    const { GET } = await import("./route");
    await Promise.all([GET(), GET(), GET()]);

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed query, so the next call tries again", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRawUnsafe).mockClear()
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce([{ country: "ES", stations: 100, prices: 200, last_update: null }]);

    const { GET } = await import("./route");
    const failed = (await GET()) as any;
    const retried = (await GET()) as any;

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(retried.data.totals.stations).toBe(100);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });
});
