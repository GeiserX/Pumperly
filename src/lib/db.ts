import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// The pg adapter reads a timestamptz as text and swaps its offset for
// +00:00, so any session TimeZone other than UTC shifts every timestamp.
const UTC_SESSION = "-c TimeZone=UTC";

// pg lets an ?options= in the URL replace the options passed beside it,
// so move the URL's options out and append the UTC pin last (last -c wins).
function pinSessionToUtc(connectionString: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString, options: UTC_SESSION };
  }
  if (!url.searchParams.has("options")) return { connectionString, options: UTC_SESSION };
  // pg keeps the last options parameter, and an empty one still replaces ours
  const values = url.searchParams.getAll("options");
  const fromUrl = values[values.length - 1];
  url.searchParams.delete("options");
  const options = fromUrl ? `${fromUrl} ${UTC_SESSION}` : UTC_SESSION;
  return { connectionString: url.toString(), options };
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  const adapter = new PrismaPg(pinSessionToUtc(connectionString));
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
