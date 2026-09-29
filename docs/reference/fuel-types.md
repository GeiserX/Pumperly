# Fuel types

This page lists every fuel code Pumperly knows, what each one means, and how the fuels that are not sold by the litre are handled. Use these codes wherever a `fuel` value is expected: in the [HTTP API](api.md), in share links and in [`PUMPERLY_DEFAULT_FUEL`](environment-variables.md#pumperly_default_fuel).

## Where the list lives

The codes are defined once, in [`src/types/fuel.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/types/fuel.ts). The TypeScript type and the API validation are derived from the `FUEL_TYPE_CODES` list. The fuel picker reads `FUEL_TYPES` and `FUEL_CATEGORIES` from the same file. The API rejects any other code with `400`.

The core codes, such as `E5`, `E10`, `B7`, `B10`, `LPG`, `CNG`, `LNG` and `H2`, follow the fuel identifiers of the European standard EN 16942. That is the standard behind the `E5`, `E10` and `B7` labels on European pumps and fuel caps. The number after `E` is the maximum share of ethanol in petrol, in percent. The number after `B` is the maximum share of biodiesel in diesel. The other codes are Pumperly's own. In `E5_98` and `E98_E10`, the 98 is the octane rating.

## All codes

| Code | Label in the app | Category | What it is |
|---|---|---|---|
| `B7` | Diesel (A) | diesel | Standard road diesel, up to 7% biodiesel. |
| `B7_PREMIUM` | Diesel Premium | diesel | A brand's premium diesel, such as the "plus" grades. |
| `B10` | Diesel B10 | diesel | Diesel with up to 10% biodiesel. |
| `B_AGRICULTURAL` | Diesel B (Agrícola) | diesel | Spain's gasóleo B, the dyed diesel for farm and off-road use. |
| `HVO` | Diesel Renovable (HVO) | diesel | Hydrotreated vegetable oil, a renewable diesel. |
| `E5` | Gasolina 95 | gasoline | 95-octane petrol, up to 5% ethanol. |
| `E5_PREMIUM` | Gasolina 95 Premium | gasoline | A brand's premium petrol. Sources also map 100-octane grades here. |
| `E10` | Gasolina 95 E10 | gasoline | 95-octane petrol, up to 10% ethanol. |
| `E5_98` | Gasolina 98 | gasoline | 98-octane petrol, up to 5% ethanol. |
| `E98_E10` | Gasolina 98 E10 | gasoline | 98-octane petrol, up to 10% ethanol. |
| `LPG` | GLP / Autogas | gas | Liquefied petroleum gas. |
| `CNG` | GNC | gas | Compressed natural gas, including biomethane sold as CNG. |
| `LNG` | GNL | gas | Liquefied natural gas, mostly for trucks. |
| `H2` | Hidrógeno | hydrogen | Hydrogen for fuel-cell vehicles. |
| `EV` | EV Charging | electric | Electric vehicle charge points. Has no price. See [below](#ev). |
| `ADBLUE` | AdBlue | other | Diesel exhaust fluid, the urea solution diesel engines inject into their exhaust. |

The labels are fixed strings. They show as written in every language the app supports. Only the category headings in the fuel picker are translated.

A source's own fuel names are mapped onto these codes inside each scraper. For example, Spain's "Precio Gasoleo B" becomes `B_AGRICULTURAL`, and Italy's "Metano" becomes `CNG`. Two different products from one source can land on the same code: Italy maps both "Gasolio" and "Gasolio Alpino" to `B7`. [How scrapers work](../data/how-scrapers-work.md) covers the mapping.

Not every country publishes every fuel. [Fuel price sources](../data/fuel-sources.md) lists what each source provides.

## Categories

The fuel picker groups the codes under six headings, in this order:

| Category key | Heading (English) | Codes |
|---|---|---|
| `diesel` | Diesel | `B7`, `B7_PREMIUM`, `B10`, `B_AGRICULTURAL`, `HVO` |
| `gasoline` | Gasoline | `E5`, `E5_PREMIUM`, `E10`, `E5_98`, `E98_E10` |
| `gas` | Gas | `LPG`, `CNG`, `LNG` |
| `hydrogen` | Hydrogen | `H2` |
| `electric` | Electric | `EV` |
| `other` | Other | `ADBLUE` |

## Default fuel per country

When the map opens, it selects the default fuel of the instance's default country. [`PUMPERLY_DEFAULT_FUEL`](environment-variables.md#pumperly_default_fuel) overrides it for the whole instance. Pumperly does not check that value at startup, so use a code from the table above. A share link that carries its own `fuel` wins over both.

| Default fuel | Countries |
|---|---|
| `B7` | Spain, Italy, Austria, Portugal, Slovenia, Romania, Greece, Ireland, Croatia, Bulgaria, Bosnia and Herzegovina, North Macedonia, Turkey, Moldova, Iceland |
| `E10` | France, Netherlands, Belgium, Luxembourg, Denmark, Finland, Australia |
| `E5` | Germany, United Kingdom, Switzerland, Poland, Czechia, Hungary, Slovakia, Sweden, Norway, Serbia, Estonia, Latvia, Lithuania, Cyprus, Taiwan, Argentina, Mexico |

These defaults are set in [`src/lib/config.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/lib/config.ts).

## Fuels not sold by the litre

Pumperly's price model assumes a price per litre in the station's own currency. Each row in `fuel_prices` holds one number, one currency and no unit. Three kinds of fuel do not fit that model.

### Gases: CNG, LNG and hydrogen

Many sources price CNG, LNG and hydrogen per kilogram. Sweden's feed, for example, prices fordonsgas (its CNG) per kilogram. Pumperly stores the number as the source publishes it. It does not convert units.

!!! warning "The unit shown is always per litre"
    The station popup prints every price with `/L` after it, and so does the average price above the route results. For CNG, LNG and hydrogen the number is usually a per-kilogram price. Compare these prices with each other, not with liquid fuels.

### Price checks for CNG, LNG, H2 and AdBlue

Every price a scraper produces goes through a sanity check before it is stored. Most fuels are checked against a range that depends on the currency. [Currencies and exchange rates](currencies.md#price-bands) has the table.

`CNG`, `LNG`, `H2` and `ADBLUE` skip that table. For these four, any price of at least 0.05 and below 100 is kept, whatever the currency. `LPG` is sold by the litre, so it goes through the normal per-currency range.

### EV charging {#ev}

`EV` is not a fuel with a price. It selects stations by type instead:

- The API returns every station whose type is `ev_charger` or `both`, and ignores `fuel_prices`.
- EV features have no `price` and no `reportedAt`. Their `currency` is `EUR` and carries no meaning.

None of Pumperly's EV sources stores a tariff. Charging tariffs are per kilowatt-hour and per session, and a single per-litre number cannot express them. [EV charging sources](../data/ev-sources.md) lists where the chargers come from, and [EV charging](../using/ev-charging.md) shows how they appear on the map.

## Adding a fuel code

A new code goes in the `FUEL_TYPE_CODES` list and gets a `FUEL_TYPES` entry with a label and a category. Everything else that validates fuel codes reads from those two lists. Map the source's product name to it in the scraper. If it is not sold by the litre, decide whether it belongs in the alternative-fuel check in [`src/scrapers/base.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/base.ts). See [Adding a country](../data/adding-a-country.md) for the rest of the scraper workflow.
