import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapStatus } from "./map-status";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

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
