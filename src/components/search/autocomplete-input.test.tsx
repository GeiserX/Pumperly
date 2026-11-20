import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { AutocompleteInput, type AutocompleteRef } from "./autocomplete-input";
import type { PhotonResult } from "@/lib/photon";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

const RESULT: PhotonResult = {
  name: "Madrid",
  city: "Madrid",
  state: "Comunidad de Madrid",
  coordinates: [-3.7, 40.4],
} as PhotonResult;

// Controlled wrapper mirroring how SearchPanel drives the input: onSelect feeds
// the formatted label back into `value` (as handleDestSelect/handleOriginSelect do).
function Harness({
  withLocation,
  onSelect,
}: {
  withLocation?: boolean;
  onSelect?: (r: PhotonResult) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <AutocompleteInput
      placeholder="dest"
      value={value}
      onChange={setValue}
      onSelect={(r) => {
        setValue(`${r.name}, ${r.city}`);
        onSelect?.(r);
      }}
      {...(withLocation
        ? { locationLabel: "My location", onLocationSelect: () => {} }
        : {})}
    />
  );
}

describe("AutocompleteInput — dropdown closes on selection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [RESULT] }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // user-event drives real pointer + focus semantics, so it exercises the
  // onMouseDown preventDefault (which keeps focus on the input) — the regression
  // surface fireEvent cannot reach.
  it("hides the suggestion list after a result is picked (destination)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByPlaceholderText("dest");

    await user.type(input, "Mad");
    const option = await screen.findByText("Madrid", {}, { timeout: 2000 });

    await user.click(option);
    expect(onSelect).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByText("Comunidad de Madrid")).not.toBeInTheDocument();
    });
  });

  it("hides the suggestion list after a result is picked (origin with My location)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness withLocation onSelect={onSelect} />);
    const input = screen.getByPlaceholderText("dest");

    await user.type(input, "Mad");
    const option = await screen.findByText("Madrid", {}, { timeout: 2000 });

    await user.click(option);
    expect(onSelect).toHaveBeenCalledTimes(1);

    // Neither the geocoded suggestion nor the "My location" row should remain
    // (the input stays focused due to preventDefault, so the location branch
    // must NOT re-open once a value is set).
    await waitFor(() => {
      expect(screen.queryByText("Comunidad de Madrid")).not.toBeInTheDocument();
      expect(screen.queryByText("My location")).not.toBeInTheDocument();
    });
  });
});

function place(name: string, city: string | null, state: string | null, lon = 1, lat = 2): PhotonResult {
  return { name, city, state, country: "Spain", coordinates: [lon, lat] };
}

function okResponse(data: PhotonResult[]) {
  return { ok: true, status: 200, json: async () => data };
}

describe("AutocompleteInput — failed, empty and slow searches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("says the search failed and offers Retry when the request is rejected", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByPlaceholderText("dest"), "Town A");

    expect(await screen.findByText("search.failed", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByText("search.noResults")).not.toBeInTheDocument();

    // Retry after the network is back lists the place.
    fetchMock.mockResolvedValueOnce(okResponse([place("Town A", null, "Region A")]));
    await user.click(screen.getByRole("button", { name: "search.retry" }));
    expect(await screen.findByText("Town A", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("search.failed")).not.toBeInTheDocument();
  });

  it("says the search failed when the server answers 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByPlaceholderText("dest"), "Town A");

    expect(await screen.findByText("search.failed", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "search.retry" })).toBeInTheDocument();
    expect(screen.queryByText("search.noResults")).not.toBeInTheDocument();
  });

  it("says no results only for a real empty answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse([])));
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByPlaceholderText("dest"), "Qqqq");

    expect(await screen.findByText("search.noResults", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByText("search.failed")).not.toBeInTheDocument();
  });

  it("shows a searching cue while a request is slow", async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((r) => { resolve = r; })));
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByPlaceholderText("dest"), "Town A");

    expect(await screen.findByText("search.searching", {}, { timeout: 2000 })).toBeInTheDocument();
    resolve(okResponse([place("Town A", null, "Region A")]));
    await waitFor(() => expect(screen.queryByText("search.searching")).not.toBeInTheDocument());
  });
});

describe("AutocompleteInput — duplicate rows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists identical places once", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse([
      place("City A", null, "Region A", 1, 1),
      place("City A", null, "Region A", 2, 2),
      place("City A", null, "Region A", 3, 3),
      place("City A Airport", "City A", "Region A", 4, 4),
    ])));
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByPlaceholderText("dest"), "City A");

    await screen.findByText("City A Airport", {}, { timeout: 2000 });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("AutocompleteInput — Enter picks only a matching place", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not pick an unrelated top suggestion and asks to pick one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse([
      place("Museum B", "City B", "Region B"),
      place("Gate C", "City B", "Region B"),
    ])));
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByPlaceholderText("dest");
    await user.type(input, "Alcala de Enares");
    await screen.findByText("Museum B", {}, { timeout: 2000 });

    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("search.pickSuggestion")).toBeInTheDocument();
    expect(screen.getByText("Museum B")).toBeInTheDocument();
  });

  it("picks the top suggestion when its name matches the typed text without accents", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse([
      place("València", null, "Comunitat Valenciana"),
      place("Valence", null, "Region C"),
    ])));
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.type(screen.getByPlaceholderText("dest"), "Valencia");
    await screen.findByText("Valence", {}, { timeout: 2000 });

    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("València");
  });

  it("imperative geocode returns null for an unrelated top hit and a match otherwise", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([place("Museum B", "City B", "Region B")]));
    vi.stubGlobal("fetch", fetchMock);
    const ref = createRef<AutocompleteRef>();
    render(<AutocompleteInput ref={ref} placeholder="dest" value="" onChange={() => {}} onSelect={() => {}} />);

    let got: PhotonResult | null = null;
    await act(async () => { got = await ref.current!.geocode("Alcala de Enares"); });
    expect(got).toBeNull();

    fetchMock.mockResolvedValue(okResponse([place("València", null, "Comunitat Valenciana")]));
    await act(async () => { got = await ref.current!.geocode("valencia"); });
    expect(got).not.toBeNull();
  });
});

describe("AutocompleteInput — keyboard closes after a pick", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("blurs the input once a place is picked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse([RESULT])));
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByPlaceholderText("dest");
    await user.type(input, "Mad");
    await user.click(await screen.findByText("Madrid", {}, { timeout: 2000 }));

    expect(document.activeElement).not.toBe(input);
  });
});

// Mirrors SearchPanel: Return with the list closed runs the parent's handler,
// which calls the imperative geocode() of the same input.
function EnterHarness({ onMatch }: { onMatch?: (r: PhotonResult) => void }) {
  const [value, setValue] = useState("");
  const ref = createRef<AutocompleteRef>();
  return (
    <AutocompleteInput
      ref={ref}
      placeholder="dest"
      value={value}
      onChange={setValue}
      onSelect={() => {}}
      onEnter={async () => {
        const r = await ref.current?.geocode(value);
        if (r) onMatch?.(r);
      }}
    />
  );
}

function deferredFetch() {
  const calls: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const fn = vi.fn(() => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }));
  return { fn, calls };
}

describe("AutocompleteInput — Return while a search is still running", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clears the searching cue and closes the keyboard when Return finds the place", async () => {
    const { fn, calls } = deferredFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    const onMatch = vi.fn();
    render(<EnterHarness onMatch={onMatch} />);
    const input = screen.getByPlaceholderText("dest");
    await user.type(input, "Town A");
    expect(await screen.findByText("search.searching", {}, { timeout: 2000 })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => {
      calls[1].resolve(okResponse([place("Town A", null, "Region A")]));
      calls[0].resolve(okResponse([place("Town A", null, "Region A")]));
    });

    await waitFor(() => expect(onMatch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("search.searching")).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(input);
  });

  it("shows the failure with Retry when the Return search fails", async () => {
    const { fn, calls } = deferredFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<EnterHarness />);
    await user.type(screen.getByPlaceholderText("dest"), "Town A");
    expect(await screen.findByText("search.searching", {}, { timeout: 2000 })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => {
      calls[1].reject(new TypeError("Failed to fetch"));
      calls[0].reject(new TypeError("Failed to fetch"));
    });

    expect(await screen.findByText("search.failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "search.retry" })).toBeInTheDocument();
    expect(screen.queryByText("search.searching")).not.toBeInTheDocument();
  });
});
