import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useImperativeHandle, type Ref } from "react";
import type { StationGeoJSON } from "@/types/station";

// --- A fake MapLibre popup and map ---------------------------------------
// The card's box is cut off at the right edge of a 393x800 map, so a fit
// always wants to pan.
type Handler = (e: Record<string, unknown>) => void;
const handlers = new Set<Handler>();
const map = {
  moving: false,
  isMoving: vi.fn(() => map.moving),
  on: vi.fn((_type: string, h: Handler) => handlers.add(h)),
  off: vi.fn((_type: string, h: Handler) => handlers.delete(h)),
  panBy: vi.fn(),
  getContainer: () => container,
};
let container: HTMLDivElement;
const popupElement = document.createElement("div");
popupElement.getBoundingClientRect = () => ({ top: 300, bottom: 500, left: 140, right: 420, width: 280, height: 200 }) as DOMRect;
const fakePopup = { _map: map, getElement: () => popupElement };

function moveEnd(data: Record<string, unknown> = {}) {
  for (const h of handlers) h({ type: "moveend", ...data });
}

vi.mock("react-map-gl/maplibre", () => ({
  Popup: ({ children, ref }: { children: React.ReactNode; ref?: Ref<unknown> }) => {
    useImperativeHandle(ref, () => fakePopup);
    return <div data-testid="popup">{children}</div>;
  },
}));

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

vi.mock("@/lib/currency", async () => {
  const actual = await vi.importActual<typeof import("@/lib/currency")>("@/lib/currency");
  return {
    CURRENCIES: actual.CURRENCIES,
    useCurrency: () => ({ decimals: 3, rateInfo: () => null }),
  };
});

import { StationPopup } from "./station-popup";

const station: StationGeoJSON = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-3.7, 40.4] },
  properties: {
    id: "station-a",
    name: "Station A",
    brand: "Brand A",
    address: "Street 1",
    city: "Town",
    price: 1.5,
    reportedAt: null,
    fuelType: "E5",
    currency: "EUR",
  },
};

// Frames run only when a test says so, so it can change the map in between.
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function runFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(0);
}

beforeEach(() => {
  handlers.clear();
  map.moving = false;
  vi.clearAllMocks();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const root = document.createElement("div");
  container = document.createElement("div");
  container.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 393, width: 393, height: 800 }) as DOMRect;
  root.appendChild(container);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StationPopup map fit", () => {
  it("pans once when the card opens on a still map", () => {
    render(<StationPopup station={station} onClose={() => {}} />);
    runFrames();
    expect(map.panBy).toHaveBeenCalledTimes(1);
    // Cut off by 35 px at the right edge (385 with the 8 px margin): the map pans right.
    const [x, y] = map.panBy.mock.calls[0][0] as [number, number];
    expect(x).toBe(35);
    expect(Math.abs(y)).toBe(0);
    expect(map.panBy.mock.calls[0][2]).toEqual({ popupFit: true });
  });

  it("waits for the map to stop when the card opens mid-flight", () => {
    map.moving = true;
    render(<StationPopup station={station} onClose={() => {}} />);
    runFrames();
    expect(map.panBy).not.toHaveBeenCalled();
    map.moving = false;
    moveEnd();
    runFrames();
    expect(map.panBy).toHaveBeenCalledTimes(1);
  });

  it("does not pan when another move has started by the next frame", () => {
    // A cut-short fly sends its moveend just before the station re-centre
    // starts; a pan then would cancel the re-centre.
    map.moving = true;
    render(<StationPopup station={station} onClose={() => {}} />);
    moveEnd();
    runFrames();
    expect(map.panBy).not.toHaveBeenCalled();
    map.moving = false;
    moveEnd();
    runFrames();
    expect(map.panBy).toHaveBeenCalledTimes(1);
  });

  it("leaves moves the person made and its own pan alone", () => {
    map.moving = true;
    render(<StationPopup station={station} onClose={() => {}} />);
    map.moving = false;
    moveEnd({ originalEvent: new Event("touchend") });
    moveEnd({ popupFit: true });
    runFrames();
    expect(map.panBy).not.toHaveBeenCalled();
  });

  it("stops listening once the card closes", () => {
    map.moving = true;
    const { unmount } = render(<StationPopup station={station} onClose={() => {}} />);
    unmount();
    map.moving = false;
    moveEnd();
    runFrames();
    expect(map.panBy).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });
});
