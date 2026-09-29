"use client";

import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";

export type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  mapStyle: string;
}

const MAP_STYLES: Record<Theme, string> = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  toggleTheme: () => {},
  mapStyle: MAP_STYLES.light,
});

// The `dark` class on <html> is the source of truth. The inline script in
// src/app/layout.tsx sets it from localStorage / system preference before
// paint. The server snapshot is always "light", so hydration matches the SSR
// HTML and React re-renders with the real theme right after.
const themeListeners = new Set<() => void>();

function subscribeTheme(cb: () => void) {
  themeListeners.add(cb);
  return () => {
    themeListeners.delete(cb);
  };
}

function getThemeSnapshot(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerThemeSnapshot(): Theme {
  return "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);

  const toggleTheme = useCallback(() => {
    const next: Theme = getThemeSnapshot() === "light" ? "dark" : "light";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("pumperly-theme", next);
    } catch {
      // Storage blocked (private mode): theme still applies for this session.
    }
    themeListeners.forEach((l) => l());
  }, []);

  // The map style never reaches the SSR HTML, so it can read the real theme
  // during hydration. Otherwise the map is created with the light style and
  // then swapped, flashing light for dark users and loading two styles.
  const mapTheme = typeof document === "undefined" ? theme : getThemeSnapshot();

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, mapStyle: MAP_STYLES[mapTheme] }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
