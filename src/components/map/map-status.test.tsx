import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import { MapStatus } from "./map-status";
import { MapView } from "./map-view";
import type { Route } from "./route-layer";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

// MapView needs MapLibre (WebGL), which jsdom lacks: replace <Map> with a box
// that renders its children, exposes the few map calls the station fetch
// makes, and fires onLoad once, as the real map does.
const fakeMap = {
  getBounds: () => ({ getWest: () => -3.71, getSouth: () => 40.41, getEast: () => -3.69, getNorth: () => 40.42 }),
  getZoom: () => 14,
  getCenter: () => ({ lng: -3.7, lat: 40.415 }),
};
vi.mock("react-map-gl/maplibre", () => ({
  default: forwardRef(function FakeMap({ children, onLoad }: { children?: ReactNode; onLoad?: () => void }, ref) {
    useImperativeHandle(ref, () => fakeMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { onLoad?.(); }, []);
    return <div data-testid="map">{children}</div>;
  }),
  Marker: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("maplibre-gl", () => ({ setWorkerUrl: () => {} }));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("./station-layer", () => ({ StationLayer: () => null }));
vi.mock("./route-layer", () => ({ RouteLayer: () => null }));
vi.mock("./country-markers", () => ({ CountryMarkers: () => null }));
vi.mock("./price-filter", () => ({ PriceFilter: () => <div data-testid="legend" /> }));
vi.mock("@/lib/currency", () => ({ useConvertedStations: <T,>(s: T) => s }));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ mapStyle: "" }) }));

describe("MapStatus", () => {
  // A failed station fetch with no route used to leave a bare street map that
  // looked the same as an empty area. The map must say so and offer a retry.
  it("says the stations could not be loaded and retries on click", () => {
    const onRetry = vi.fn();
    render(<MapStatus status="error" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("map.loadError");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a loading cue while the stations are on their way", () => {
    render(<MapStatus status="loading" onRetry={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("map.loading");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says no station sells this fuel in the visible area", () => {
    render(<MapStatus status="empty" onRetry={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("map.noStationsHere");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when the stations loaded", () => {
    const { container } = render(<MapStatus status="idle" onRetry={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("MapView station status", () => {
  const route = {
    geometry: { type: "LineString", coordinates: [[-3.7, 40.41], [-3.6, 40.5]] },
    distance: 10000,
    duration: 600,
    bbox: [-3.7, 40.41, -3.6, 40.5],
  } as Route;

  function mapView(routes: Route[] | null) {
    return (
      <MapView
        selectedFuel="B7"
        center={[-3.7, 40.415]}
        zoom={14}
        clusterStations={false}
        corridorKm={5}
        routes={routes}
        primaryRouteIndex={0}
        maxPrice={null}
        onMaxPriceChange={() => {}}
        maxDetour={null}
      />
    );
  }

  const failed = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
  const empty = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ type: "FeatureCollection", features: [] }) } as Response);
  const pending = () => new Promise<Response>(() => {});

  afterEach(() => { vi.unstubAllGlobals(); });

  // The search card, its nearby list and its toasts cover the top of the map,
  // so the status stacks above the price legend at the bottom instead.
  it("shows a failed load above the price legend, in the same overlay column", async () => {
    vi.stubGlobal("fetch", vi.fn(failed));
    render(mapView(null));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("map.loadError");
    const column = alert.closest("[data-map-overlay]");
    const legend = screen.getByTestId("legend");
    expect(column).not.toBeNull();
    expect(column).toContainElement(legend);
    expect(alert.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says when no station sells this fuel in the visible area", async () => {
    vi.stubGlobal("fetch", vi.fn(empty));
    render(mapView(null));
    expect(await screen.findByRole("status")).toHaveTextContent("map.noStationsHere");
  });

  // An error from before a route must not come back the moment the route is
  // cleared, before the new fetch has answered.
  it("does not flash an old error when a route is cleared", async () => {
    const fetchMock = vi.fn(failed);
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(mapView(null));
    await screen.findByRole("alert");

    fetchMock.mockImplementation(pending);
    await act(async () => { rerender(mapView([route])); });
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => { rerender(mapView(null)); });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
