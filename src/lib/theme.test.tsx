import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { ThemeProvider, useTheme } from "./theme";

describe("ThemeProvider", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    document.body.innerHTML = "";
  });

  it("gives the map the real theme on the hydration render", async () => {
    const seen: { theme: string; mapStyle: string }[] = [];
    function Probe() {
      const { theme, mapStyle } = useTheme();
      seen.push({ theme, mapStyle });
      return <span>{theme}</span>;
    }

    const container = document.createElement("div");
    container.innerHTML = renderToString(<ThemeProvider><Probe /></ThemeProvider>);
    document.body.appendChild(container);
    // The inline script in layout.tsx sets this before hydration.
    document.documentElement.classList.add("dark");
    seen.length = 0;

    await act(async () => {
      hydrateRoot(container, <ThemeProvider><Probe /></ThemeProvider>);
    });

    // theme stays "light" while hydrating (matches the SSR HTML); the map style doesn't.
    expect(seen[0]).toEqual({ theme: "light", mapStyle: "https://tiles.openfreemap.org/styles/dark" });
    expect(seen.every((s) => s.mapStyle.endsWith("/dark"))).toBe(true);
    expect(seen.at(-1)?.theme).toBe("dark");
  });
});
