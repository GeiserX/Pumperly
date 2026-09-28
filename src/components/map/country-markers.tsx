"use client";

import { useCallback, useEffect, useState } from "react";
import { Marker, useMap } from "react-map-gl/maplibre";
import { COUNTRIES } from "@/lib/config";

interface CountryStats {
  code: string;
  name: string;
  stations: number;
}

const FLAG: Record<string, string> = {
  ES: "🇪🇸", FR: "🇫🇷", DE: "🇩🇪", IT: "🇮🇹", GB: "🇬🇧", AT: "🇦🇹", PT: "🇵🇹",
  SI: "🇸🇮", NL: "🇳🇱", BE: "🇧🇪", LU: "🇱🇺", RO: "🇷🇴", GR: "🇬🇷", IE: "🇮🇪", HR: "🇭🇷",
  CH: "🇨🇭", PL: "🇵🇱", CZ: "🇨🇿", HU: "🇭🇺", BG: "🇧🇬", SK: "🇸🇰",
  DK: "🇩🇰", SE: "🇸🇪", NO: "🇳🇴", RS: "🇷🇸", FI: "🇫🇮",
  EE: "🇪🇪", LV: "🇱🇻", LT: "🇱🇹", BA: "🇧🇦", MK: "🇲🇰",
  TR: "🇹🇷", MD: "🇲🇩", IS: "🇮🇸", AU: "🇦🇺", AR: "🇦🇷", MX: "🇲🇽",
};

function formatCount(n: number): string {
  if (n >= 10_000) return (n / 1_000).toFixed(0) + "K";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export function CountryMarkers() {
  const { current: mapRef } = useMap();
  const [countries, setCountries] = useState<CountryStats[]>([]);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.countries) {
          setCountries(data.countries.filter((c: CountryStats) => c.stations > 0));
        }
      })
      .catch(() => {});
  }, []);

  const handleClick = useCallback(
    (code: string) => {
      const country = COUNTRIES[code];
      if (!country || !mapRef) return;
      mapRef.flyTo({
        center: country.center,
        zoom: country.zoom,
        duration: 1200,
      });
    },
    [mapRef],
  );

  return (
    <>
      {countries.map((c) => {
        const config = COUNTRIES[c.code];
        if (!config) return null;
        return (
          <Marker
            key={c.code}
            longitude={config.center[0]}
            latitude={config.center[1]}
            anchor="center"
            onClick={() => handleClick(c.code)}
          >
            <div
              className="flex cursor-pointer flex-col items-center gap-0.5 rounded-lg bg-white/90 px-2 py-1 shadow-md backdrop-blur-sm transition-transform hover:scale-110 dark:bg-zinc-800/90"
              title={`${c.name}: ${c.stations.toLocaleString()} stations`}
            >
              <span className="text-lg leading-none">{FLAG[c.code] ?? "⛽"}</span>
              <span className="text-[10px] font-bold leading-none text-zinc-700 dark:text-zinc-300">
                {formatCount(c.stations)}
              </span>
            </div>
          </Marker>
        );
      })}
    </>
  );
}
