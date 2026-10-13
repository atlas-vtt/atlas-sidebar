const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";
const FLIP_MS = 240;
const ENTER_MS = 200;

/**
 * Reuses DOM elements across renders by key, so transitions, focus and hover state survive updates.
 * Elements can move between parents; anything not taken during a render pass is removed by `end()`.
 */
export class KeyedDom {
  private els = new Map<string, HTMLElement>();
  private used = new Set<string>();
  private fresh = new Set<HTMLElement>();

  begin() {
    this.used.clear();
    this.fresh.clear();
  }

  take<T extends HTMLElement>(key: string, create: () => T): T {
    let el = this.els.get(key);
    if (!el) {
      el = create();
      this.els.set(key, el);
      this.fresh.add(el);
    }
    this.used.add(key);
    return el as T;
  }

  /** Make `children` the exact, ordered child list of `parent`, moving rather than recreating nodes. */
  place(parent: HTMLElement, children: HTMLElement[]) {
    // Drop unwanted nodes first so the ones that stay are never re-inserted (which would drop focus and restart transitions).
    const wanted = new Set<Node>(children);
    for (const node of [...parent.childNodes]) if (!wanted.has(node)) node.remove();
    let ref: ChildNode | null = parent.firstChild;
    for (const child of children) {
      if (child === ref) {
        ref = ref.nextSibling;
        continue;
      }
      parent.insertBefore(child, ref);
    }
  }

  end() {
    for (const [key, el] of this.els) {
      if (this.used.has(key)) continue;
      el.remove();
      this.els.delete(key);
    }
  }

  created(): HTMLElement[] {
    return [...this.fresh];
  }
}

export type FlipSnapshot = Map<HTMLElement, DOMRect>;

const running = new WeakMap<HTMLElement, Animation>();

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Record visual positions (including any in-flight animation) before a DOM change. */
export function measure(els: Iterable<HTMLElement>): FlipSnapshot {
  const snap: FlipSnapshot = new Map();
  for (const el of els) snap.set(el, el.getBoundingClientRect());
  return snap;
}

/** Animate elements from their recorded positions to their new layout, and fade in newly created ones. */
export function flip(before: FlipSnapshot, entering: HTMLElement[]) {
  const moves: [HTMLElement, number, number][] = [];
  for (const [el, rect] of before) {
    if (!el.isConnected) continue;
    running.get(el)?.cancel();
    const now = el.getBoundingClientRect();
    if (!now.height) continue;
    const dx = rect.left - now.left;
    const dy = rect.top - now.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moves.push([el, dx, dy]);
  }
  for (const [el, dx, dy] of moves) {
    running.set(
      el,
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: FLIP_MS,
        easing: EASE_OUT,
      })
    );
  }
  for (const el of entering) {
    if (!el.isConnected) continue;
    running.set(
      el,
      el.animate(
        [
          { opacity: 0, transform: "translateY(-4px) scale(0.97)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: ENTER_MS, easing: EASE_OUT }
      )
    );
  }
}
