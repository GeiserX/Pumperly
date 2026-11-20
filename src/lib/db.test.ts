import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

// pg's own parser, used to check what the driver will actually send
const ConnectionParameters = createRequire(import.meta.url)("pg/lib/connection-parameters");

// Mock PrismaPg adapter — must be a real constructor (used with `new`)
const pgAdapterOpts = vi.hoisted(() => [] as any[]);
vi.mock("@prisma/adapter-pg", () => {
  return {
    PrismaPg: class PrismaPg {
      constructor(opts: any) {
        pgAdapterOpts.push(opts);
      }
    },
  };
});

// Mock PrismaClient — must be a real constructor (used with `new`)
vi.mock("@/generated/prisma/client", () => {
  return {
    PrismaClient: class PrismaClient {
      _isMock = true;
      constructor(_opts?: any) {}
    },
  };
});

describe("db module", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    // Clear the globalThis cache so each test starts fresh
    delete (globalThis as any).prisma;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    delete (globalThis as any).prisma;
  });

  it("exports a prisma client instance", async () => {
    const { prisma } = await import("./db");
    expect(prisma).toBeDefined();
  });

  it("creates a PrismaClient instance", async () => {
    const { prisma } = await import("./db");
    const { PrismaClient } = await import("@/generated/prisma/client");
    expect(prisma).toBeInstanceOf(PrismaClient);
  });

  it("pins the database session to UTC so timestamptz values are not shifted", async () => {
    pgAdapterOpts.length = 0;
    await import("./db");
    expect(pgAdapterOpts).toHaveLength(1);
    expect(pgAdapterOpts[0].connectionString).toBe("postgresql://test:test@localhost:5432/test");
    expect(pgAdapterOpts[0].options).toContain("TimeZone=UTC");
  });

  it("keeps startup options from DATABASE_URL and still pins the session to UTC", async () => {
    process.env.DATABASE_URL =
      "postgresql://test:test@localhost:5432/test?options=-c%20statement_timeout%3D5000&sslmode=disable";
    pgAdapterOpts.length = 0;
    await import("./db");
    expect(pgAdapterOpts).toHaveLength(1);
    // pg lets options in the URL replace the options passed beside it,
    // so check the config pg derives, not only the constructor arguments
    const effective = new ConnectionParameters(pgAdapterOpts[0]);
    expect(effective.options).toContain("-c statement_timeout=5000");
    expect(effective.options).toContain("-c TimeZone=UTC");
    expect(effective.database).toBe("test");
    expect(effective.host).toBe("localhost");
  });

  it("caches prisma on globalThis in non-production", async () => {
    (process.env as Record<string, string>).NODE_ENV = "development";
    const { prisma } = await import("./db");
    expect((globalThis as any).prisma).toBe(prisma);
  });

  it("reuses existing globalThis.prisma if present", async () => {
    const sentinel = { _sentinel: true };
    (globalThis as any).prisma = sentinel;
    const { prisma } = await import("./db");
    expect(prisma).toBe(sentinel);
  });

  it("throws a descriptive error when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    await expect(import("./db")).rejects.toThrow(
      "DATABASE_URL environment variable is not set",
    );
  });
});
