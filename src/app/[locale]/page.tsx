import { getConfig } from "@/lib/config";
import { HomeClient } from "@/components/home-client";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "@/lib/og-translations";
import type { Locale } from "@/lib/i18n";
import { deepLinkFuel } from "@/lib/share-url";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Home({ params, searchParams }: Props) {
  const { locale: raw } = await params;
  // A shared link's fuel, read here too so the server renders what the client will.
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(v) ? v : v != null ? [v] : []) sp.append(k, item);
  }
  const locale = (SUPPORTED_LOCALES.includes(raw as Locale) ? raw : DEFAULT_LOCALE) as Locale;
  const config = getConfig();

  return (
    <HomeClient
      defaultFuel={deepLinkFuel(sp) ?? config.defaultFuel}
      center={config.center}
      zoom={config.zoom}
      clusterStations={config.clusterStations}
      locale={locale}
    />
  );
}
