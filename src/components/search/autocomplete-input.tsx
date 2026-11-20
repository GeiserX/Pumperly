"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PhotonResult } from "@/lib/photon";
import { useI18n } from "@/lib/i18n";

export interface AutocompleteRef {
  geocode: (query: string) => Promise<PhotonResult | null>;
  focus: () => void;
}

interface AutocompleteInputProps {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSelect: (result: PhotonResult) => void;
  onClearCoordinates?: () => void;
  onEnter?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  mapCenter?: [number, number];
  /** Render without border/bg — parent provides the container */
  bare?: boolean;
  /** Show a "My location" option when focused; label is the translated text */
  locationLabel?: string;
  /** Called when user clicks the "My location" option */
  onLocationSelect?: () => void;
}

export const AutocompleteInput = forwardRef<AutocompleteRef, AutocompleteInputProps>(function AutocompleteInput({
  placeholder,
  value,
  onChange,
  onSelect,
  onClearCoordinates,
  onEnter,
  onFocus,
  onBlur,
  mapCenter,
  bare,
  locationLabel,
  onLocationSelect,
}, ref) {
  const { t } = useI18n();
  const [results, setResults] = useState<PhotonResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isFocused, setIsFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const internalInputRef = useRef<HTMLInputElement>(null);
  // Monotonic request id — guards against a stale fetch resolving after the
  // user has already picked a result and re-opening/reshuffling the list.
  const requestIdRef = useRef(0);

  // `failed` separates a broken request (offline, 5xx) from a real empty answer,
  // so a failure never reads as "this place does not exist".
  const doGeocode = useCallback(
    async (query: string): Promise<{ results: PhotonResult[]; failed: boolean }> => {
      const params = new URLSearchParams({ q: query });
      if (mapCenter) {
        params.set("lon", String(mapCenter[0]));
        params.set("lat", String(mapCenter[1]));
      }
      try {
        const res = await fetch(`/api/geocode?${params}`);
        if (!res.ok) return { results: [], failed: true };
        const data: unknown = await res.json();
        if (!Array.isArray(data)) return { results: [], failed: true };
        return { results: dedupeResults(data as PhotonResult[]), failed: false };
      } catch {
        return { results: [], failed: true };
      }
    },
    [mapCenter],
  );

  const [noResults, setNoResults] = useState(false);
  const [failed, setFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [pickHint, setPickHint] = useState(false);

  // Enter (or the parent's Enter handler) must never silently take an unrelated
  // top hit: when it does not match what was typed, show the list and ask.
  useImperativeHandle(ref, () => ({
    geocode: async (query: string) => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      const reqId = ++requestIdRef.current;
      // The bump above makes a pending typed search drop its answer (and its
      // own cue reset), so this request owns the "Searching…" cue from here:
      // show it when the answer is slow, and clear it when the answer arrives.
      const slowTimer = setTimeout(() => {
        if (reqId === requestIdRef.current) setSearching(true);
      }, 300);
      const { results: data, failed: didFail } = await doGeocode(query);
      clearTimeout(slowTimer);
      if (reqId === requestIdRef.current) setSearching(false);
      if (data[0] && matchesQuery(data[0], query)) {
        if (reqId === requestIdRef.current) {
          setIsOpen(false);
          setNoResults(false);
          setFailed(false);
          setPickHint(false);
          setResults([]);
          // Close the on-screen keyboard, the same as picking from the list.
          internalInputRef.current?.blur();
        }
        // A late answer for text the person has since changed must not win.
        return reqId === requestIdRef.current ? data[0] : null;
      }
      if (reqId === requestIdRef.current) {
        setResults(data);
        setFailed(didFail);
        setNoResults(!didFail && data.length === 0);
        setIsOpen(data.length > 0);
        setPickHint(data.length > 0);
        setActiveIndex(-1);
      }
      return null;
    },
    focus: () => {
      internalInputRef.current?.focus();
    },
  }), [doGeocode]);

  // Under 2 characters there is nothing to search: drop any pending or
  // in-flight search so its late answer cannot reopen the list.
  const resetShort = useCallback(() => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    requestIdRef.current++;
    setResults([]);
    setIsOpen(false);
    setNoResults(false);
    setFailed(false);
    setSearching(false);
  }, []);

  const fetchResults = useCallback(
    async (query: string) => {
      setPickHint(false);
      if (query.length < 2) {
        resetShort();
        return;
      }

      const reqId = ++requestIdRef.current;
      // Only show "Searching…" when the answer is slow, so fast searches don't flicker.
      const slowTimer = setTimeout(() => {
        if (reqId === requestIdRef.current) setSearching(true);
      }, 300);
      const { results: data, failed: didFail } = await doGeocode(query);
      clearTimeout(slowTimer);
      // Discard if a newer request (or a selection) superseded this one
      if (reqId !== requestIdRef.current) return;
      setSearching(false);
      setResults(data);
      setFailed(didFail);
      setNoResults(!didFail && data.length === 0);
      setIsOpen(data.length > 0);
      setActiveIndex(-1);
    },
    [doGeocode, resetShort],
  );

  // The parent can shorten the text without a keystroke (the × button clears it).
  useEffect(() => {
    if (value.length < 2) resetShort();
  }, [value, resetShort]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      onChange(val);
      onClearCoordinates?.();
      setPickHint(false);

      // New text makes every older search stale, a Return search included.
      requestIdRef.current++;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchResults(val), 300);
    },
    [onChange, onClearCoordinates, fetchResults],
  );

  const handleSelect = useCallback(
    (result: PhotonResult) => {
      // Cancel any pending debounced fetch and invalidate in-flight ones so a
      // late result can't re-open the dropdown after the user has picked.
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      requestIdRef.current++;
      const label = formatResult(result);
      onChange(label);
      onSelect(result);
      setIsOpen(false);
      setNoResults(false);
      setFailed(false);
      setSearching(false);
      setPickHint(false);
      setResults([]);
      // Close the on-screen keyboard (and the iOS accessory bar) once a place is chosen.
      internalInputRef.current?.blur();
    },
    [onChange, onSelect],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        if (isOpen && results.length > 0) {
          e.preventDefault();
          if (activeIndex >= 0) handleSelect(results[activeIndex]);
          else if (matchesQuery(results[0], value)) handleSelect(results[0]);
          else setPickHint(true);
        } else {
          e.preventDefault();
          setIsOpen(false);
          onEnter?.();
        }
        return;
      }

      if (!isOpen || results.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Escape") {
        setIsOpen(false);
      }
    },
    [isOpen, results, activeIndex, value, handleSelect, onEnter],
  );

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Always 16 px: iOS zooms the page into any focused field under 16 px, and a
  // phone in landscape is wider than the `sm` breakpoint.
  const inputClassName = bare
    ? "w-full bg-transparent px-3 py-2.5 text-base font-medium text-gray-900 placeholder-gray-500 outline-none dark:text-gray-100 dark:placeholder-gray-500"
    : "w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-base text-gray-900 placeholder-gray-500 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500";

  return (
    <div ref={containerRef} className="relative flex-1">
      <input
        ref={internalInputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          setIsFocused(true);
          if (results.length > 0) setIsOpen(true);
          onFocus?.();
        }}
        onBlur={() => {
          setIsFocused(false);
          onBlur?.();
        }}
        placeholder={placeholder}
        className={inputClassName}
      />

      {/* Location option shown when focused with no/short input; also prepended to results */}
      {(isOpen && results.length > 0) || (isFocused && locationLabel && onLocationSelect && value.length < 2 && !isOpen) ? (
        <ul className="absolute z-50 mt-1.5 max-h-56 w-full overflow-auto rounded-xl border border-black/[0.06] bg-white/95 p-1 shadow-xl shadow-black/10 ring-1 ring-black/[0.04] backdrop-blur-xl dark:border-white/[0.07] dark:bg-gray-900/95 dark:shadow-black/40 dark:ring-white/[0.04]">
          {pickHint && isOpen && results.length > 0 && (
            <li role="status" className="px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              {t("search.pickSuggestion")}
            </li>
          )}
          {locationLabel && onLocationSelect && (
            <li
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-gray-700 transition-colors hover:bg-emerald-50 hover:text-emerald-700 dark:text-gray-200 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
              onMouseDown={(e) => {
                e.preventDefault();
                onLocationSelect();
                setIsFocused(false);
              }}
            >
              <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                <span className="absolute h-3 w-3 animate-ping rounded-full bg-emerald-400/40" />
                <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/25" />
              </span>
              <span className="font-medium">{locationLabel}</span>
            </li>
          )}
          {results.map((r, i) => (
            <li
              key={`${r.coordinates[0]}-${r.coordinates[1]}-${i}`}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                i === activeIndex
                  ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200"
                  : "text-gray-700 hover:bg-gray-100/80 dark:text-gray-200 dark:hover:bg-white/[0.06]"
              }`}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <svg
                className={`h-4 w-4 shrink-0 ${i === activeIndex ? "text-emerald-500 dark:text-emerald-400" : "text-gray-400 dark:text-gray-500"}`}
                fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
              </svg>
              <span className="min-w-0 truncate">
                <span className="font-medium">{r.name}</span>
                {(r.city || r.state) && (
                  <span className="ml-1 text-gray-500 dark:text-gray-400">
                    {[r.city, r.state].filter(Boolean).join(", ")}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {searching && !isOpen && value.length >= 2 ? (
        <div role="status" className={MESSAGE_CLASS}>
          {t("search.searching")}
        </div>
      ) : failed && !isOpen && value.length >= 2 ? (
        <div role="alert" className={`${MESSAGE_CLASS} flex items-center justify-between gap-3`}>
          <span>{t("search.failed")}</span>
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fetchResults(value)}
          >
            {t("search.retry")}
          </button>
        </div>
      ) : noResults && !isOpen && value.length >= 2 ? (
        <div className={MESSAGE_CLASS}>
          {t("search.noResults")}
        </div>
      ) : null}
    </div>
  );
});

const MESSAGE_CLASS =
  "absolute z-50 mt-1.5 w-full rounded-xl border border-black/[0.06] bg-white/95 px-3 py-2.5 text-sm text-gray-500 shadow-xl shadow-black/10 ring-1 ring-black/[0.04] backdrop-blur-xl dark:border-white/[0.07] dark:bg-gray-900/95 dark:text-gray-400 dark:shadow-black/40 dark:ring-white/[0.04]";

/** Lower-case and strip accents, so "Valencia" matches "València". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * True when the place's name is what the person typed: equal, a completion of
 * it, or the start of our own "Name, City" label (a picked value edited back).
 */
function matchesQuery(r: PhotonResult, query: string): boolean {
  const name = fold(r.name ?? "");
  const q = fold(query);
  if (!name || !q) return false;
  return name.startsWith(q) || q.startsWith(`${name},`);
}

/** Drop rows that would render identically (same name, city, region, country). */
function dedupeResults(results: PhotonResult[]): PhotonResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = [r.name, r.city, r.state, r.country].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatResult(r: PhotonResult): string {
  const parts = [r.name];
  if (r.city && r.city !== r.name) parts.push(r.city);
  return parts.join(", ");
}
