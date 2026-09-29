/**
 * Refuel stop planner (liquid fuels).
 *
 * Picks 0..maxStops corridor stations that minimise
 *   fuel bought · price  +  (detour + fixed stop time) · value of time
 * while the tank never drops below `reservePct` and arrives at the destination
 * with at least `arrivalPct`. The one exception is the first leg: when the start
 * level can't reach any station with the reserve intact, it may use up to half of
 * the start level, and the result says so (`dipsBelowReserve`).
 *
 * DP over (stops used, station, departure level in whole %). Arrival levels are
 * kept continuous, so rounding never accumulates along the route. For a fixed
 * previous stop i and next stop j the cost is linear in the departure level at
 * i, so a prefix-min over i's levels gives every j level in O(L):
 * O(maxStops · n² · L) overall.
 */

export interface PlannerStation {
  id: string;
  /** Distance along the route from the origin, km. */
  km: number;
  /** Price per litre in the display currency. */
  price: number;
  /** Extra driving time to visit the station, minutes (≥ 0). */
  detourMin: number;
}

export interface PlannerInput {
  routeKm: number;
  stations: PlannerStation[];
  tankL: number;
  consumptionL100: number;
  startPct: number;
  arrivalPct: number;
  reservePct: number;
  timeValuePerHour: number;
  maxStops: number;
}

export interface PlannedStop {
  id: string;
  km: number;
  litres: number;
  cost: number;
  detourMin: number;
  arrivePct: number;
  departPct: number;
}

export interface PlanResult {
  status: "ok" | "no-stop-needed" | "infeasible";
  stops: PlannedStop[];
  totalFuelCost: number;
  totalDetourMin: number;
  /** Fuel level (%) at the destination. */
  endPct: number;
  /** Fuel level profile along the route, for the gauge chart. */
  profile: { km: number; pct: number }[];
  /** Infeasible only: furthest km reachable with the given constraints. */
  gapKm?: number;
  /**
   * Infeasible only: what to change.
   * - `arrival`: the destination is reachable above the reserve, but not with `arrivalPct` left.
   * - `reserve`: the destination is reachable with `arrivalPct` left, but only by going
   *   under the reserve (the reserve, not the arrival level, is the binding target).
   * - `stops`: reachable with more stops than `maxStops` allows.
   * - `no-candidates`: no usable station (no price/detour, filtered out, other currency).
   * - `range`: stations exist but the tank can't bridge the gap to the next one.
   */
  reason?: "arrival" | "reserve" | "stops" | "no-candidates" | "range";
  /**
   * Ok only: no plan keeps the reserve on the way to the first stop, so this one
   * lets the first leg use up to half of the start level instead.
   */
  dipsBelowReserve?: boolean;
}

/** Time spent at the pump regardless of detour (paying, filling), minutes. */
export const STOP_OVERHEAD_MIN = 5;
/** Average speed used to turn detour minutes into extra kilometres. */
const DETOUR_KMH = 50;
/** Above this many candidates, prune per route bucket to keep the DP fast. */
const MAX_CANDIDATES = 200;
const L = 101; // fuel levels 0..100 %

/**
 * Keep at most `max` candidates: split the route into equal buckets and keep
 * four stations from each: the cheapest, the least-detour, the earliest-reachable
 * and the one with the furthest onward reach. The earliest-reachable one means a
 * bucket with any station in range keeps one in range, so pruning never drops the
 * only station a low tank can reach; the furthest-reaching one means pruning never
 * drops the station needed to get out of the bucket towards the next one. At most
 * four per bucket keeps the total within `max`. Order by km is preserved.
 */
export function pruneCandidates(stations: PlannerStation[], routeKm: number, max = MAX_CANDIDATES): PlannerStation[] {
  if (stations.length <= max) return stations;
  const buckets = Math.max(1, Math.floor(max / 4));
  const size = routeKm / buckets || 1;
  const keep = new Map<string, PlannerStation>();
  const byBucket = new Map<number, PlannerStation[]>();
  for (const s of stations) {
    const b = Math.min(buckets - 1, Math.floor(s.km / size));
    const list = byBucket.get(b);
    if (list) list.push(s);
    else byBucket.set(b, [s]);
  }
  // Half a station's detour is driven on the way in and half on the way out (as legPct charges it).
  const halfDetourKm = (s: PlannerStation) => ((s.detourMin / 60) * DETOUR_KMH) / 2;
  // Distance driven to reach a station.
  const reachKm = (s: PlannerStation) => s.km + halfDetourKm(s);
  // Where a full tank bought here effectively starts from, on the route.
  const onwardKm = (s: PlannerStation) => s.km - halfDetourKm(s);
  for (const list of byBucket.values()) {
    const cheapest = list.reduce((a, b) => (b.price < a.price ? b : a));
    const closest = list.reduce((a, b) => (b.detourMin < a.detourMin ? b : a));
    const earliest = list.reduce((a, b) => (reachKm(b) < reachKm(a) ? b : a));
    const furthest = list.reduce((a, b) => (onwardKm(b) > onwardKm(a) ? b : a));
    keep.set(cheapest.id, cheapest);
    keep.set(closest.id, closest);
    keep.set(earliest.id, earliest);
    keep.set(furthest.id, furthest);
  }
  return [...keep.values()].sort((a, b) => a.km - b.km);
}

export function planRefuel(input: PlannerInput): PlanResult {
  const { routeKm, tankL, consumptionL100, timeValuePerHour } = input;
  const startPct = clamp(input.startPct, 0, 100);
  const reservePct = clamp(input.reservePct, 0, 100);
  const arrivalPct = clamp(input.arrivalPct, 0, 100);
  const targetEnd = Math.max(arrivalPct, reservePct);
  const maxStops = Math.max(0, Math.floor(input.maxStops));

  // Fuel level (%) consumed per km.
  const pctPerKm = consumptionL100 / tankL;
  const litresPerPct = tankL / 100;

  const stations = pruneCandidates(
    input.stations
      .filter((s) => s.km >= 0 && s.km <= routeKm && s.price > 0 && s.detourMin >= 0)
      .sort((a, b) => a.km - b.km),
    routeKm,
  );
  const n = stations.length;
  const detourKm = stations.map((s) => (s.detourMin / 60) * DETOUR_KMH);
  const stopCost = stations.map((s) => ((s.detourMin + STOP_OVERHEAD_MIN) / 60) * timeValuePerHour);

  // Level consumed from stop i (-1 = origin) to stop j (n = destination).
  // Half of each station's detour is charged to the leg in, half to the leg out.
  const legPct = (i: number, j: number): number => {
    const fromKm = i < 0 ? 0 : stations[i].km;
    const toKm = j >= n ? routeKm : stations[j].km;
    const extra = (i < 0 ? 0 : detourKm[i] / 2) + (j >= n ? 0 : detourKm[j] / 2);
    return (toKm - fromKm + extra) * pctPerKm;
  };

  const endPctNoStop = startPct - legPct(-1, n);
  if (endPctNoStop >= targetEnd - 1e-9) {
    return {
      status: "no-stop-needed",
      stops: [],
      totalFuelCost: 0,
      totalDetourMin: 0,
      endPct: endPctNoStop,
      profile: [{ km: 0, pct: startPct }, { km: routeKm, pct: endPctNoStop }],
    };
  }

  // Starting at or below the reserve: the first leg may use up to half of what
  // is left, otherwise nothing would be reachable. Above it, the reserve holds.
  const strict = solve(startPct > reservePct ? reservePct : startPct / 2);
  if (strict.status !== "infeasible" || startPct <= reservePct) return strict;
  // Above the reserve but no plan keeps it on the first leg: rather than refuse a
  // start level that a lower one would have been allowed, dip into the reserve
  // the same way (at most half the start level) and say so. The strict plan wins
  // whenever it exists, so feasibility never falls as the start level rises.
  const relaxedFloor = Math.min(reservePct, startPct / 2);
  if (relaxedFloor >= reservePct) return strict;
  const relaxed = solve(relaxedFloor);
  return relaxed.status === "ok" ? { ...relaxed, dipsBelowReserve: true } : strict;

  function solve(firstLegFloor: number, end = targetEnd): PlanResult {
    // dp[k][j*L + g]: min cost having made k stops, the last at station j,
    // departing with level g. parent stores (prevStation+1)*L + prevLevel, -1 = none.
    const layers: Float64Array[] = [];
    const parents: Int32Array[] = [];
    let best = { cost: Infinity, k: -1, j: -1, g: -1 };

    for (let k = 1; k <= maxStops; k++) {
      const dp = new Float64Array(n * L).fill(Infinity);
      const par = new Int32Array(n * L).fill(-1);
      const prev = k === 1 ? null : layers[k - 2];

      for (let j = 0; j < n; j++) {
        const price = stations[j].price;
        const unit = litresPerPct * price;
        const sources = k === 1 ? [-1] : range(j);
        for (const i of sources) {
          const cons = legPct(i, j);
          if (k === 1) {
            const f = startPct - cons;
            if (f < firstLegFloor - 1e-9) continue;
            for (let g = Math.ceil(f); g < L; g++) {
              const c = (g - f) * unit + stopCost[j];
              if (c < dp[j * L + g]) {
                dp[j * L + g] = c;
                par[j * L + g] = -1;
              }
            }
            continue;
          }
          // Prefix-min over departure level at i of dp[i][gi] - gi·unit, restricted
          // to levels that arrive at j above the reserve.
          const minGi = Math.ceil(reservePct + cons - 1e-9);
          if (minGi >= L) continue;
          let runMin = Infinity;
          let runArg = -1;
          let gi = minGi;
          for (let g = 0; g < L; g++) {
            // Allowed gi: arrival level gi - cons must not exceed g (can't "buy" negative).
            const maxGi = Math.min(L - 1, Math.floor(g + cons + 1e-9));
            for (; gi <= maxGi; gi++) {
              const v = prev![i * L + gi] - gi * unit;
              if (v < runMin) {
                runMin = v;
                runArg = gi;
              }
            }
            if (runArg < 0 || runMin === Infinity) continue;
            const c = runMin + (g + cons) * unit + stopCost[j];
            if (c < dp[j * L + g]) {
              dp[j * L + g] = c;
              par[j * L + g] = (i + 1) * L + runArg;
            }
          }
        }
      }
      layers.push(dp);
      parents.push(par);

      // Close out to the destination from this layer.
      for (let j = 0; j < n; j++) {
        const need = Math.ceil(end + legPct(j, n) - 1e-9);
        for (let g = Math.max(0, need); g < L; g++) {
          const c = dp[j * L + g];
          if (c < best.cost) best = { cost: c, k, j, g };
        }
      }
    }

    if (best.k < 0) {
      // Furthest reachable point: origin with the start level, or any reachable stop state.
      let reach = Math.min(routeKm, Math.max(0, (startPct - firstLegFloor) / pctPerKm));
      for (const dp of layers) {
        for (let j = 0; j < n; j++) {
          for (let g = L - 1; g >= 0; g--) {
            if (dp[j * L + g] < Infinity) {
              // Leaving j drives the other half of its detour first (as legPct charges it).
              reach = Math.max(reach, stations[j].km + Math.max(0, (g - reservePct) / pctPerKm - detourKm[j] / 2));
              break;
            }
          }
        }
      }
      let reason: PlanResult["reason"];
      if (Number.isFinite(fewestStops(firstLegFloor, end))) reason = "stops";
      else if (reach >= routeKm - 1e-9) {
        // The end target is max(arrival, reserve): blame the reserve when the
        // arrival level alone could be met.
        const reserveBinds = end > arrivalPct + 1e-9
          && (startPct - legPct(-1, n) >= arrivalPct - 1e-9 || solve(firstLegFloor, arrivalPct).status === "ok");
        reason = reserveBinds ? "reserve" : "arrival";
      } else reason = n === 0 ? "no-candidates" : "range";
      return {
        status: "infeasible",
        stops: [],
        totalFuelCost: 0,
        totalDetourMin: 0,
        endPct: 0,
        profile: [],
        gapKm: Math.min(routeKm, reach),
        reason,
      };
    }

    // Backtrack to the stop sequence (station index, departure level).
    const seq: { j: number; g: number }[] = [];
    let cur = { k: best.k, j: best.j, g: best.g };
    while (cur.k >= 1) {
      seq.unshift({ j: cur.j, g: cur.g });
      const p = parents[cur.k - 1][cur.j * L + cur.g];
      if (p < 0) break;
      cur = { k: cur.k - 1, j: Math.floor(p / L) - 1, g: p % L };
    }

    const stops: PlannedStop[] = [];
    const profile: { km: number; pct: number }[] = [{ km: 0, pct: startPct }];
    let level = startPct;
    let prevIdx = -1;
    for (const { j, g } of seq) {
      const s = stations[j];
      const arrive = level - legPct(prevIdx, j);
      const litres = (g - arrive) * litresPerPct;
      stops.push({
        id: s.id,
        km: s.km,
        litres,
        cost: litres * s.price,
        detourMin: s.detourMin,
        arrivePct: arrive,
        departPct: g,
      });
      profile.push({ km: s.km, pct: arrive }, { km: s.km, pct: g });
      level = g;
      prevIdx = j;
    }
    const endPct = level - legPct(prevIdx, n);
    profile.push({ km: routeKm, pct: endPct });

    return {
      status: "ok",
      stops,
      totalFuelCost: stops.reduce((sum, s) => sum + s.cost, 0),
      totalDetourMin: stops.reduce((sum, s) => sum + s.detourMin, 0),
      endPct,
      profile,
    };
  }

  /**
   * Fewest stops that reach the destination with `end` left, ignoring cost and
   * the stop cap; Infinity when no number of stops does. Filling up is always the
   * furthest-reaching choice, so each station only needs its fewest stops to get there.
   */
  function fewestStops(firstLegFloor: number, end: number): number {
    const stopsTo = new Array<number>(n).fill(Infinity);
    let fewest = Infinity;
    for (let j = 0; j < n; j++) {
      if (startPct - legPct(-1, j) >= firstLegFloor - 1e-9) stopsTo[j] = 1;
      else {
        for (let i = 0; i < j; i++) {
          if (stopsTo[i] + 1 < stopsTo[j] && 100 - legPct(i, j) >= reservePct - 1e-9) stopsTo[j] = stopsTo[i] + 1;
        }
      }
      if (100 - legPct(j, n) >= end - 1e-9) fewest = Math.min(fewest, stopsTo[j]);
    }
    return fewest;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
