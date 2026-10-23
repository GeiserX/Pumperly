// ---------------------------------------------------------------------------
// Which source supplies Germany's EV chargers
// ---------------------------------------------------------------------------
// Germany has three: OpenChargeMap (`EV_DE`, crowdsourced, needs an API key),
// the BNetzA Ladesäulenregister (`EV_DE_BNETZA`, the official register every
// operator of a public charge point must file into, keyless), and OCPDB
// (`EV_DE_OCPDB`, that register merged with the operators' own feeds, plus
// ad-hoc prices, keyless).
//
// They must never run together. The register holds ~74k German locations against
// OpenChargeMap's crowdsourced subset, and the two overlap heavily — running
// both double-pins the country. Worse, once the BNetzA scraper has retired the
// `ocm-` rows (see scrapers/bnetza.ts), a single stray OpenChargeMap run puts
// every one of them straight back, and nothing garbage-collects EV rows.
//
// BNetzA wins by default: it is official, it needs no key, and it is the more
// complete of the register-based sources. `PUMPERLY_DE_EV_SOURCE=ocpdb` adds
// prices; `=ocm` keeps OpenChargeMap.
// The OCPDB and BNetzA sweeps retire the other sources' rows (see
// scrapers/ocpdb.ts and scrapers/bnetza.ts); OpenChargeMap has no sweep, so
// switching to it leaves the `ocpdb-`/`bnetza-` rows to delete by hand.
//
// This rule is needed by both the scheduler (instrumentation-node.ts) and the manual
// CLI (scrapers/cli.ts), so it lives here rather than in either of them — the
// same reasoning as spain-ev-source.ts, whose shape this mirrors exactly. Two
// copies would drift, and the way they drift is silent: the map just quietly
// fills up with duplicates again.
// ---------------------------------------------------------------------------

const GERMANY_EV_CODES: Record<string, string> = {
  ocm: "EV_DE",
  bnetza: "EV_DE_BNETZA",
  ocpdb: "EV_DE_OCPDB",
};

// The externalId prefix each source writes. A source's sweep retires every
// other prefix in this list, so a new source only needs adding here.
const GERMANY_EV_PREFIXES = ["ocm-", "bnetza-", "ocpdb-"] as const;
export type GermanyEvPrefix = (typeof GERMANY_EV_PREFIXES)[number];

/** The prefixes of the German EV sources that `own` replaces. */
export function otherGermanyEvPrefixes(own: GermanyEvPrefix): string[] {
  return GERMANY_EV_PREFIXES.filter((p) => p !== own);
}

/**
 * Collapse Germany's EV scrapers down to whichever one is configured.
 *
 * Returns `codes` unchanged when Germany has no EV scraper enabled at all (e.g.
 * PUMPERLY_EV_ENABLED=0). Otherwise exactly one survives: the one named by
 * PUMPERLY_DE_EV_SOURCE (ocm | bnetza | ocpdb), BNetzA when unset or unknown.
 */
export function resolveGermanyEvSource(codes: string[]): string[] {
  const all = Object.values(GERMANY_EV_CODES);
  const hasGermanyEv = codes.some((c) => all.includes(c));
  const rest = codes.filter((c) => !all.includes(c));
  if (!hasGermanyEv) return rest;
  const chosen = process.env.PUMPERLY_DE_EV_SOURCE?.trim().toLowerCase() ?? "";
  rest.push(Object.hasOwn(GERMANY_EV_CODES, chosen) ? GERMANY_EV_CODES[chosen] : GERMANY_EV_CODES.bnetza);
  return rest;
}
