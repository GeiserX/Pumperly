import { describe, it, expect } from "vitest";
import type { ScreenBox } from "./geo";
import { panToFit } from "./popup-fit";

// A 393x800 phone map.
const viewport: ScreenBox = { top: 0, right: 393, bottom: 800, left: 0 };

function moved(box: ScreenBox, [dx, dy]: [number, number]): ScreenBox {
  return { top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy, left: box.left + dx };
}

function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("panToFit", () => {
  it("does not move a card that is on screen and clear of every overlay", () => {
    const popup = { top: 300, bottom: 500, left: 60, right: 340 };
    const searchCard = { top: 0, bottom: 200, left: 0, right: 393 };
    expect(panToFit(popup, viewport, [searchCard])).toEqual([0, 0]);
  });

  it("moves a card under the search card down until its top is clear", () => {
    const popup = { top: 60, bottom: 260, left: 40, right: 320 };
    const searchCard = { top: 0, bottom: 200, left: 0, right: 393 };
    const shift = panToFit(popup, viewport, [searchCard]);
    const after = moved(popup, shift);
    expect(after.top).toBeGreaterThanOrEqual(208);
    expect(after.bottom).toBeLessThanOrEqual(792);
    expect(shift[0]).toBe(0);
  });

  it("moves a card cut off at the right edge back on screen", () => {
    const popup = { top: 300, bottom: 500, left: 140, right: 420 };
    const after = moved(popup, panToFit(popup, viewport, []));
    expect(after.right).toBeLessThanOrEqual(385);
    expect(after.left).toBeGreaterThanOrEqual(8);
  });

  it("moves a card off the price legend", () => {
    const popup = { top: 500, bottom: 700, left: 60, right: 340 };
    const legend = { left: 12, right: 196, top: 600, bottom: 780 };
    const after = moved(popup, panToFit(popup, viewport, [legend]));
    expect(overlaps(after, legend)).toBe(false);
    expect(after.top).toBeGreaterThanOrEqual(8);
    expect(after.right).toBeLessThanOrEqual(385);
  });

  it("fits a card between the search card and the route sheet", () => {
    const popup = { top: 120, bottom: 340, left: 40, right: 320 };
    const searchCard = { top: 0, bottom: 200, left: 0, right: 393 };
    const sheet = { top: 684, bottom: 1404, left: 0, right: 393 };
    const after = moved(popup, panToFit(popup, viewport, [searchCard, sheet]));
    expect(overlaps(after, searchCard)).toBe(false);
    expect(overlaps(after, sheet)).toBe(false);
  });

  it("fixes the right edge and the search card in one move", () => {
    const popup = { top: 100, bottom: 300, left: 200, right: 480 };
    const searchCard = { top: 0, bottom: 200, left: 0, right: 393 };
    const after = moved(popup, panToFit(popup, viewport, [searchCard]));
    expect(after.right).toBeLessThanOrEqual(385);
    expect(after.top).toBeGreaterThanOrEqual(208);
  });

  it("keeps the card's top clear when no position is clear of everything", () => {
    // 184 px free between the cards, the card is 220 px tall.
    const popup = { top: 100, bottom: 320, left: 40, right: 320 };
    const searchCard = { top: 0, bottom: 200, left: 0, right: 393 };
    const sheet = { top: 400, bottom: 1120, left: 0, right: 393 };
    const after = moved(popup, panToFit(popup, viewport, [searchCard, sheet]));
    expect(after.top).toBeGreaterThanOrEqual(208);
    expect(after.bottom).toBeLessThanOrEqual(792);
  });
});
