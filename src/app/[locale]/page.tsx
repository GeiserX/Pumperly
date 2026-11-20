import { getConfig } from "@/lib/config";
import { HomeClient } from "@/components/home-client";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "@/lib/og-translations";
import type { Locale } from "@/lib/i18n";
import { deepLinkFuel } from "@/lib/share-url";
import { FUEL_COOKIE, bareFuel, parseFuel, resolveInitialFuel } from "@/lib/fuel-preference";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Home({ params, searchParams }: Props) {
  const { locale: raw } = await params;
  // The fuel the client will open on (shared link, bare ?fuel=, remembered
  // choice, site default), read here too so hydration does not flip it.
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(v) ? v : v != null ? [v] : []) sp.append(k, item);
  }
  const locale = (SUPPORTED_LOCALES.includes(raw as Locale) ? raw : DEFAULT_LOCALE) as Locale;
  const config = getConfig();
  const initialFuel = resolveInitialFuel({
    linkFuel: deepLinkFuel(sp),
    bareFuel: bareFuel(sp),
    cookieFuel: parseFuel((await cookies()).get(FUEL_COOKIE)?.value),
    defaultFuel: config.defaultFuel,
  });

  return (
    <HomeClient
      defaultFuel={initialFuel}
      center={config.center}
      zoom={config.zoom}
      clusterStations={config.clusterStations}
      locale={locale}
    />
  );
}
