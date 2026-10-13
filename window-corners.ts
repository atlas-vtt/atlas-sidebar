import { Platform } from "obsidian";
import { release } from "os";

/**
 * Window corner radii in points: macOS 26 (Darwin 25) rounds Obsidian's toolbar-less window at about 16pt
 * (measured on a Retina screenshot); Big Sur through Sequoia at 10pt.
 */
const TAHOE_RADIUS_PT = 16;
const CLASSIC_RADIUS_PT = 10;
const TAHOE_DARWIN = 25;

type WebFrame = { getZoomFactor(): number };

/** Obsidian's zoom: CSS pixels are this many points wide. */
function zoomFactor(): number {
  try {
    const electron = (window as unknown as { require?: (id: string) => { webFrame?: WebFrame } }).require?.("electron");
    return electron?.webFrame?.getZoomFactor() || 1;
  } catch {
    return 1;
  }
}

/** The radius of this window's corners in CSS pixels, or 0 where they are square (other platforms, fullscreen). */
export function windowCornerRadius(doc: Document): number {
  if (!Platform.isMacOS || doc.body.hasClass("is-fullscreen")) return 0;
  let points = CLASSIC_RADIUS_PT;
  try {
    if (parseInt(release(), 10) >= TAHOE_DARWIN) points = TAHOE_RADIUS_PT;
  } catch {
    // Keep the classic radius.
  }
  return points / zoomFactor();
}

/**
 * Round `el` concentrically with the window corner it sits in: the window's radius less the element's inset
 * from that corner, on all four corners so the card stays even. Elsewhere it keeps its own radius from CSS.
 */
export function fitWindowCorners(el: HTMLElement) {
  const win = el.win;
  const radius = windowCornerRadius(el.doc);
  const r = el.getBoundingClientRect();
  const dx = Math.min(r.left, win.innerWidth - r.right);
  const dy = Math.min(r.top, win.innerHeight - r.bottom);
  const concentric = radius - Math.max(dx, dy);
  el.style.borderRadius = concentric > 0 ? `${Math.round(concentric * 2) / 2}px` : "";
}
