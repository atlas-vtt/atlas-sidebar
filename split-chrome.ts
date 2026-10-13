import { App, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { srLabel } from "./a11y";
import { Parent, rootSplitEl } from "./split-layout";
import { DragSource, SplitLayoutInfo, SplitSide, TabsManager, leafId } from "./tabs-manager";

/** No split is offered this close to the main area's border (Zen's guard). */
const EDGE_GUARD_PX = 10;
const EXPAND_MS = 110;
/** Panes sit this far apart while split; the placeholder keeps the same inset. */
const PANE_GAP_PX = 8;

/** The parts of Obsidian's drag manager that draw the drag ghost and its action label. */
type DragManager = {
  onDragOver: (e: DragEvent) => void;
  setAction: (action: string | null) => void;
};

/**
 * Zen's split view chrome on Obsidian's panes:
 * - dragging a tab over an edge of the main area squeezes what's there and grows a placeholder pane where
 *   the tab will land; dropping on it splits, leaving it takes the offer back;
 * - the split's panes are cards with a focus ring on the one in use, and a handle that hangs from each
 *   pane on hover, to unsplit or to drag the pane onto another to trade places.
 */
export class SplitChrome {
  private placeholder: HTMLElement | null = null;
  /** Where the placeholder ends up: hit-tested instead of its animated box, which starts at zero size. */
  private box: DOMRect | null = null;
  private side: SplitSide | null = null;
  private squeezed: HTMLElement | null = null;
  private panes = new Map<HTMLElement, Parent>();
  private paneDrag: string | null = null;
  private swapTarget: HTMLElement | null = null;

  constructor(
    private readonly app: App,
    private readonly tabs: TabsManager
  ) {}

  // ── Panes ───────────────────────────────────────────────────────────

  /** Mark the split's panes (and the focused one), adding a handle to each; undo it on panes that left. */
  decorate(info: SplitLayoutInfo) {
    const current = new Map(info.panes.map((pane) => [pane.containerEl, pane]));
    for (const el of this.panes.keys()) if (!current.has(el)) this.undecorate(el);
    for (const [el, pane] of current) {
      el.addClass("zen-split-pane");
      el.toggleClass("is-focused", pane === info.focused);
      if (!el.querySelector(":scope > .zen-split-handle")) this.buildHandle(el);
    }
    this.panes = current;
  }

  destroy() {
    for (const el of this.panes.keys()) this.undecorate(el);
    this.panes.clear();
    this.clearPreview(false);
    this.endPaneDrag();
  }

  private undecorate(el: HTMLElement) {
    el.removeClass("zen-split-pane", "is-focused", "is-swap-target");
    el.querySelector(":scope > .zen-split-handle")?.remove();
  }

  private buildHandle(el: HTMLElement) {
    const handle = el.createDiv({ cls: "zen-split-handle" });
    const grip = handle.createDiv({
      cls: "zen-split-handle-button is-grip",
      attr: { draggable: "true", role: "button" },
    });
    setIcon(grip, "grip-horizontal");
    srLabel(grip, "Drag onto another pane to swap");
    const unsplit = handle.createDiv({ cls: "zen-split-handle-button", attr: { role: "button" } });
    setIcon(unsplit, "x");
    srLabel(unsplit, "Unsplit");

    unsplit.addEventListener("click", (e) => {
      e.stopPropagation();
      const group = this.groupOf(el);
      if (group) this.tabs.unsplit(group);
    });
    grip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showLayoutMenu(el, handle);
    });
    grip.addEventListener("dragstart", (e) => {
      const leaf = this.leafOf(el);
      if (!leaf || !e.dataTransfer) return;
      this.paneDrag = leafId(leaf);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-zen-pane", this.paneDrag);
      window.setTimeout(() => el.doc.body.addClass("zen-pane-dragging"));
    });
    grip.addEventListener("dragend", () => this.endPaneDrag());
  }

  /** Zen's split options, from a click on the grip: the layout, trading places, unsplitting. */
  private showLayoutMenu(el: HTMLElement, handle: HTMLElement) {
    const group = this.groupOf(el);
    const leaf = this.leafOf(el);
    if (!group || !leaf) return;
    const menu = new Menu();
    const layouts = [
      ["vertical", "Side by side", "columns-2"],
      ["horizontal", "Stacked", "rows-2"],
    ] as const;
    for (const [direction, title, icon] of layouts) {
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon(icon)
          .setChecked(group.direction === direction)
          .onClick(() => void this.tabs.setSplitDirection(group, direction))
      );
    }
    menu.addSeparator();
    if (group.leafIds.length === 2) {
      const other = group.leafIds.find((id) => id !== leafId(leaf));
      menu.addItem((item) =>
        item
          .setTitle("Swap panes")
          .setIcon("arrow-left-right")
          .onClick(() => other && this.tabs.swapSplitMembers(leafId(leaf), other))
      );
    }
    menu.addItem((item) => item.setTitle("Unsplit").setIcon("x").onClick(() => this.tabs.unsplit(group)));
    // The handle stays out while its menu is open.
    handle.addClass("is-open");
    menu.onHide(() => handle.removeClass("is-open"));
    const r = handle.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 }, el.doc);
  }

  private groupOf(el: HTMLElement) {
    const leaf = this.leafOf(el);
    return leaf ? this.tabs.splitOfLeaf(leaf) : undefined;
  }

  /** A split pane holds exactly one tab: the split member. */
  private leafOf(el: HTMLElement): WorkspaceLeaf | undefined {
    return this.panes.get(el)?.children[0] as unknown as WorkspaceLeaf | undefined;
  }

  // ── Dragging ────────────────────────────────────────────────────────

  onDragOver(e: DragEvent) {
    if (this.paneDrag) return this.onPaneDragOver(e);
    const src = this.tabs.dragging;
    if (!src || !e.dataTransfer) return this.clearPreview(true);
    if (this.placeholder) {
      // The offer stands while the pointer is on the placeholder; anywhere else takes it back.
      if (this.inBox(e)) return this.accept(e, "Split view");
      return this.clearPreview(true);
    }
    const root = rootSplitEl(this.app);
    if (!root.contains(e.target as Node)) return;
    const rect = root.getBoundingClientRect();
    const side = dropSide(e, rect);
    if (!side) return;
    const count = this.tabs.splitDropCount(src);
    if (count === null) return;
    this.accept(e, "Split view");
    this.expand(root, rect, side, count);
  }

  async onDrop(e: DragEvent) {
    if (this.paneDrag) return this.onPaneDrop(e);
    const src = this.tabs.dragging;
    const side = this.side;
    if (!src || !side || !this.placeholder || !this.inBox(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // The new pane takes the placeholder's place in the same frame, so nothing jumps.
    this.clearPreview(false);
    await this.tabs.dropIntoSplit(src as DragSource, side);
  }

  onDragEnd() {
    this.clearPreview(true);
    this.endPaneDrag();
  }

  /**
   * Take the drag from the panes underneath (their own drop overlays and link drops), but still pass it to
   * Obsidian's drag manager, which moves the drag ghost from a window listener that this would cut off.
   */
  private accept(e: DragEvent, action: string) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const dm = (this.app as unknown as { dragManager?: DragManager }).dragManager;
    dm?.onDragOver(e);
    dm?.setAction(action);
  }

  private inBox(e: DragEvent): boolean {
    const r = this.box;
    return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  /** Squeeze the main area away from `side` and grow the placeholder into the room it leaves, like Zen. */
  private expand(root: HTMLElement, rect: DOMRect, side: SplitSide, count: number) {
    const horizontal = side === "left" || side === "right";
    const share = (horizontal ? rect.width : rect.height) / count;
    const doc = root.doc;
    this.side = side;
    this.squeezed = root;
    root.addClass("zen-split-squeezing");
    root.style.setProperty(`padding-${side}`, `${share}px`);

    const placeholder = (this.placeholder = doc.body.createDiv({ cls: "zen-split-placeholder" }));
    const inset = PANE_GAP_PX / 2;
    const size = share - PANE_GAP_PX;
    const box = {
      left: side === "right" ? rect.right - share + inset : rect.left + inset,
      top: side === "bottom" ? rect.bottom - share + inset : rect.top + inset,
      width: horizontal ? size : rect.width - PANE_GAP_PX,
      height: horizontal ? rect.height - PANE_GAP_PX : size,
    };
    this.box = new DOMRect(box.left, box.top, box.width, box.height);
    Object.assign(placeholder.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      transformOrigin: { left: "left center", right: "right center", top: "center top", bottom: "center bottom" }[side],
    });
    placeholder.animate(
      [{ transform: horizontal ? "scaleX(0)" : "scaleY(0)", opacity: 0.4 }, { transform: "none", opacity: 1 }],
      { duration: EXPAND_MS, easing: "ease-out" }
    );
    doc.body.addClass("zen-split-previewing");
  }

  /** Remove the offer: animated when the pointer moved away, at once when the drop takes its place. */
  private clearPreview(animate: boolean) {
    const placeholder = this.placeholder;
    const root = this.squeezed;
    const side = this.side;
    this.placeholder = null;
    this.box = null;
    this.squeezed = null;
    this.side = null;
    if (placeholder) {
      placeholder.doc.body.removeClass("zen-split-previewing");
      if (animate) {
        const horizontal = side === "left" || side === "right";
        placeholder
          .animate([{ transform: "none", opacity: 1 }, { transform: horizontal ? "scaleX(0)" : "scaleY(0)", opacity: 0 }], {
            duration: EXPAND_MS,
            easing: "ease-in",
          })
          .finished.then(() => placeholder.remove(), () => placeholder.remove());
      } else placeholder.remove();
    }
    if (root && side) {
      if (!animate) root.removeClass("zen-split-squeezing");
      root.style.removeProperty(`padding-${side}`);
      if (animate) window.setTimeout(() => root.removeClass("zen-split-squeezing"), EXPAND_MS);
    }
  }

  private onPaneDragOver(e: DragEvent) {
    const target = (e.target as Element | null)?.closest?.<HTMLElement>(".zen-split-pane") ?? null;
    const valid = target && this.panes.has(target) && this.leafOf(target) && leafId(this.leafOf(target)!) !== this.paneDrag;
    this.setSwapTarget(valid ? target : null);
    if (valid) this.accept(e, "Swap panes");
  }

  private onPaneDrop(e: DragEvent) {
    const target = this.swapTarget;
    const from = this.paneDrag;
    const to = target ? this.leafOf(target) : undefined;
    this.endPaneDrag();
    if (!from || !to) return;
    e.preventDefault();
    e.stopPropagation();
    this.tabs.swapSplitMembers(from, leafId(to));
  }

  private setSwapTarget(el: HTMLElement | null) {
    if (el === this.swapTarget) return;
    this.swapTarget?.removeClass("is-swap-target");
    el?.addClass("is-swap-target");
    this.swapTarget = el;
  }

  private endPaneDrag() {
    this.paneDrag = null;
    this.setSwapTarget(null);
    activeDocument.body.removeClass("zen-pane-dragging");
  }
}

/** The edge the pointer is nearest, if within the outer quarter of the main area and off its border. */
function dropSide(e: DragEvent, rect: DOMRect): SplitSide | null {
  const { clientX: x, clientY: y } = e;
  if (x < rect.left + EDGE_GUARD_PX || x > rect.right - EDGE_GUARD_PX) return null;
  if (y < rect.top + EDGE_GUARD_PX || y > rect.bottom - EDGE_GUARD_PX) return null;
  const edges: [SplitSide, number, number][] = [
    ["left", x - rect.left, rect.width / 4],
    ["right", rect.right - x, rect.width / 4],
    ["top", y - rect.top, rect.height / 4],
    ["bottom", rect.bottom - y, rect.height / 4],
  ];
  let best: SplitSide | null = null;
  let nearest = Infinity;
  for (const [side, distance, reach] of edges) {
    if (distance < reach && distance < nearest) {
      nearest = distance;
      best = side;
    }
  }
  return best;
}
