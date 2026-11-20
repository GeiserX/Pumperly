import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// i18n: echo the key back so we can assert on stable identifiers.
vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "es", setLocale: () => {} }),
}));

import { LegalModal } from "./legal-modal";

describe("LegalModal", () => {
  it.each([
    ["privacy", "menu.privacy"],
    ["terms", "menu.terms"],
    ["sources", "menu.sources"],
  ] as const)("titles the %s page through its menu key", (page, key) => {
    render(<LegalModal page={page} onClose={() => {}} />);
    expect(screen.getByRole("heading", { level: 2, name: key })).toBeInTheDocument();
  });

  it("does not show the English titles", () => {
    render(<LegalModal page="privacy" onClose={() => {}} />);
    expect(screen.queryByRole("heading", { name: "Privacy Policy" })).not.toBeInTheDocument();
  });

  it("gives the close button a translated name that closes the dialog", () => {
    const onClose = vi.fn();
    render(<LegalModal page="privacy" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
