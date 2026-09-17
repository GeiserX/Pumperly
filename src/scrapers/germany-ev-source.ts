// ---------------------------------------------------------------------------
// Which source supplies Germany's EV chargers
// ---------------------------------------------------------------------------
// Germany has two: OpenChargeMap (`EV_DE`, crowdsourced, needs an API key) and
// the BNetzA Ladesäulenregister (`EV_DE_BNETZA`, the official register every
// operator of a public charge point must file into, keyless).
//
// They must never both run. The register holds ~74k German locations against
// OpenChargeMap's crowdsourced subset, and the two overlap heavily — running
// both double-pins the country. Worse, once the BNetzA scraper has retired the
// `ocm-` rows (see scrapers/bnetza.ts), a single stray OpenChargeMap run puts
// every one of them straight back, and nothing garbage-collects EV rows.
//
// BNetzA wins by default: it is official, it needs no key, and it is the more
// complete of the two. `PUMPERLY_DE_EV_SOURCE=ocm` is the escape hatch.
//
// This rule is needed by both the scheduler (instrumentation.ts) and the manual
// CLI (scrapers/cli.ts), so it lives here rather than in either of them — the
// same reasoning as spain-ev-source.ts, whose shape this mirrors exactly. Two
// copies would drift, and the way they drift is silent: the map just quietly
// fills up with duplicates again.
// ---------------------------------------------------------------------------

/**
 * Collapse Germany's two EV scrapers down to whichever one is configured.
 *
 * Returns `codes` unchanged when Germany has no EV scraper enabled at all (e.g.
 * PUMPERLY_EV_ENABLED=0). Otherwise exactly one of `EV_DE` / `EV_DE_BNETZA`
 * survives: OpenChargeMap when PUMPERLY_DE_EV_SOURCE=ocm, BNetzA otherwise.
 */
export function resolveGermanyEvSource(codes: string[]): string[] {
  const hasGermanyEv = codes.includes("EV_DE") || codes.includes("EV_DE_BNETZA");
  const rest = codes.filter((c) => c !== "EV_DE" && c !== "EV_DE_BNETZA");
  if (!hasGermanyEv) return rest;
  const preferOcm = process.env.PUMPERLY_DE_EV_SOURCE?.trim().toLowerCase() === "ocm";
  rest.push(preferOcm ? "EV_DE" : "EV_DE_BNETZA");
  return rest;
}
