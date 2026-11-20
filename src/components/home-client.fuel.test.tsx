import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { forwardRef } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { FuelType } from "@/types/station";
import { HomeClient } from "./home-client";

// Captures the latest props Navbar was rendered with, so a test can pick a fuel.
let navbarProps: Record<string, unknown> = {};

vi.mock("@/lib/theme", () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/currency", () => ({ CurrencyProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
  useI18n: () => ({ t: (k: string) => k, locale: "es", setLocale: () => {} }),
}));
vi.mock("@/components/nav/navbar", () => ({
  Navbar: (props: Record<string, unknown>) => {
    navbarProps = props;
    return null;
  },
}));
vi.mock("@/lib/use-detour-stream", () => ({ useDetourStream: () => ({ detourMap: {}, detoursLoading: false }) }));
vi.mock("@/components/map/map-view", () => ({
  MapView: forwardRef<MapRef, Record<string, unknown>>(function MockMapView() {
    return null;
  }),
}));
vi.mock("@/components/search/search-panel", () => ({ SearchPanel: () => null }));

function renderHome() {
  return render(
    <HomeClient defaultFuel="LPG" center={[-3.7, 40.4]} zoom={6} clusterStations={false} locale="es" />,
  );
}

function clearFuelCookie() {
  document.cookie = "pumperly-fuel=; path=/; max-age=0";
}

describe("HomeClient — the fuel setting", () => {
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navbarProps = {};
    clearFuelCookie();
    postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { pumperlyFuel: { postMessage } } });
  });
  afterEach(() => {
    clearFuelCookie();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("stores a picked fuel and tells the app", () => {
    window.history.replaceState(null, "", "/es");
    renderHome();
    act(() => (navbarProps.onFuelChange as (f: FuelType) => void)("E10"));

    expect(document.cookie).toContain("pumperly-fuel=E10");
    expect(postMessage).toHaveBeenCalledWith({ fuel: "E10" });
    expect(navbarProps.selectedFuel).toBe("E10");
  });

  it("opens on a bare ?fuel=, stores it and does not echo it to the app", () => {
    window.history.replaceState(null, "", "/es?fuel=E5");
    renderHome();

    expect(navbarProps.selectedFuel).toBe("E5");
    expect(document.cookie).toContain("pumperly-fuel=E5");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("does not store the fuel of a shared route link", () => {
    window.history.replaceState(null, "", "/es?from=40.41672,-3.70379&to=39.46975,-0.37739&fuel=B7");
    renderHome();

    expect(navbarProps.selectedFuel).toBe("B7");
    expect(document.cookie).not.toContain("pumperly-fuel");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("picks a fuel in a plain browser without the app's message handler", () => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/es");
    renderHome();
    act(() => (navbarProps.onFuelChange as (f: FuelType) => void)("E5"));

    expect(document.cookie).toContain("pumperly-fuel=E5");
  });
});
