import type { ScreenBox } from "./geo";

function overlapArea(a: ScreenBox, b: ScreenBox): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Shift along one axis that puts [lo, hi] inside [min, max]; the start wins when it is too long. */
function shiftInto(lo: number, hi: number, min: number, max: number): number {
  if (lo < min || hi - lo > max - min) return min - lo;
  if (hi > max) return max - hi;
  return 0;
}

/**
 * The smallest screen move [dx, dy] that puts a map popup inside the viewport
 * and clear of every card drawn over the map, `margin` px from each. Pan the
 * map by [-dx, -dy] to apply it.
 *
 * The candidate moves are the viewport fit plus every move that lines the
 * popup up with an edge of a card. When no candidate is clear of all cards,
 * the one with the least covered area wins, and on a tie the one that keeps
 * the popup's top (its name and close button) visible.
 */
export function panToFit(
  popup: ScreenBox,
  viewport: ScreenBox,
  obstacles: ScreenBox[],
  margin = 8,
): [number, number] {
  const fitX = shiftInto(popup.left, popup.right, viewport.left + margin, viewport.right - margin);
  const fitY = shiftInto(popup.top, popup.bottom, viewport.top + margin, viewport.bottom - margin);
  const zones = obstacles.map((o) => ({
    top: o.top - margin,
    right: o.right + margin,
    bottom: o.bottom + margin,
    left: o.left - margin,
  }));
  const xs = new Set([0, fitX]);
  const ys = new Set([0, fitY]);
  for (const z of zones) {
    xs.add(z.right - popup.left);
    xs.add(z.left - popup.right);
    ys.add(z.bottom - popup.top);
    ys.add(z.top - popup.bottom);
  }

  const inside = (b: ScreenBox, dx: number, dy: number) =>
    (dx === fitX || (b.left >= viewport.left + margin && b.right <= viewport.right - margin)) &&
    (dy === fitY || (b.top >= viewport.top + margin && b.bottom <= viewport.bottom - margin));

  let best: { move: [number, number]; covered: number; topHidden: boolean; cost: number } | null = null;
  for (const dx of xs) {
    for (const dy of ys) {
      const b = { top: popup.top + dy, right: popup.right + dx, bottom: popup.bottom + dy, left: popup.left + dx };
      if (!inside(b, dx, dy)) continue;
      const covered = zones.reduce((sum, z) => sum + overlapArea(b, z), 0);
      const topRow = { ...b, bottom: b.top + 1 };
      const topHidden = zones.some((z) => overlapArea(topRow, z) > 0);
      const cost = Math.abs(dx) + Math.abs(dy);
      if (
        !best ||
        covered < best.covered ||
        (covered === best.covered && (topHidden !== best.topHidden ? !topHidden : cost < best.cost))
      ) {
        best = { move: [dx, dy], covered, topHidden, cost };
      }
    }
  }
  return best ? best.move : [fitX, fitY];
}

/**
 * Screen boxes of the cards over the map under `root` (elements marked
 * `data-map-overlay`). A `display: contents` wrapper has no box of its own,
 * so the union of its children counts instead.
 */
export function overlayRects(root: Element): ScreenBox[] {
  const boxes: ScreenBox[] = [];
  for (const el of root.querySelectorAll("[data-map-overlay]")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      boxes.push(r);
      continue;
    }
    const kids = Array.from(el.children, (c) => c.getBoundingClientRect()).filter((c) => c.width > 0 && c.height > 0);
    if (kids.length === 0) continue;
    boxes.push({
      top: Math.min(...kids.map((c) => c.top)),
      right: Math.max(...kids.map((c) => c.right)),
      bottom: Math.max(...kids.map((c) => c.bottom)),
      left: Math.min(...kids.map((c) => c.left)),
    });
  }
  return boxes;
}
