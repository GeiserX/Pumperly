// SQL shared by every query that shows a price and its date.
//
// Scrapers write a price row only when it changes, so a row's reported_at no
// longer moves on every run. It holds the upstream's own date when the source
// gives one, and NULL otherwise. A NULL row is as fresh as its source's last
// successful run in that country, which scrape_runs records. Readers show
// whichever applies. Keep every reader on these helpers so they agree.

/** LEFT JOIN of scrape_runs (alias `sr`) for price alias `p` and station alias `s`. */
export function scrapeRunJoin(p: string, s: string): string {
  return `LEFT JOIN scrape_runs sr ON sr.country = ${s}.country AND sr.source = ${p}.source`;
}

/** When price alias `p` was last confirmed. Needs scrapeRunJoin in the same FROM. */
export function priceDate(p: string): string {
  return `COALESCE(${p}.reported_at, sr.last_success_at)`;
}

/**
 * Body of a LATERAL subquery that picks station `s`'s newest price for one
 * fuel. `fuelType` is SQL: a bind parameter such as `$5` or a literal such
 * as `'EV'`, never user input.
 */
export function latestPriceSql(fuelType: string, withFees: boolean): string {
  return `SELECT p.price, p.currency, ${priceDate("p")} AS reported_at${withFees ? ", p.ev_fees" : ""}
            FROM fuel_prices p
            ${scrapeRunJoin("p", "s")}
            WHERE p.station_id = s.id
              AND p.fuel_type = ${fuelType}
            ORDER BY 3 DESC NULLS LAST
            LIMIT 1`;
}
