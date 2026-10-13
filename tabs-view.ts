import { ItemView, Menu, Scope, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { srLabel } from "./a11y";
import { KeyedDom, flip, measure, reducedMotion } from "./keyed-dom";
import {
  DragSource,
  DropTarget,
  MAX_SPLIT,
  Snapshot,
  SplitGroup,
  TabsManager,
  executeCommand,
  leafId,
  leafPath,
  leafTitle,
} from "./tabs-manager";
import { FolderNode, MAX_FOLDER_DEPTH, PinNode, TreeNode, ancestors, locate, pinFileName, walkPins } from "./tabs-model";
import { ColorPicker, FolderPicker, IconPicker, SpacePicker } from "./tabs-modals";
import { ATLAS_ART, ATLAS_COMMANDS, isAtlasMap } from "./atlas";
import { FolderPeek } from "./tabs-folder-peek";
import { fitWindowCorners } from "./window-corners";
import { ConfirmModal, FantasyIconPicker, renderFantasyIcon } from "./space-icons";
import { Space, walkPins as walkSpacePins } from "./tabs-model";

/** The Atlas card's own corner radius, where no window corner is near. */

export const TABS_VIEW_TYPE = "zen-tabs";

/** Hovering a collapsed folder this long while dragging opens it. */
const SPRING_OPEN_MS = 650;

type RowKind = "tab" | "pin" | "ess" | "folder" | "split" | "space";
type RowRef = { kind: RowKind; id: string };
type RowPart = "open" | "action" | "reset";
/** `seg` is the leaf id of the split-view segment under the pointer, if any. */
type Hit = { el: HTMLElement; ref: RowRef; seg?: string };

type RowState = {
  title: string;
  icon: string;
  /** Pinned icon shown as a "back to pinned note" button when the tab has navigated elsewhere. */
  resetIcon: string | null;
  active: boolean;
  shown: boolean;
  loaded: boolean;
  missing: boolean;
  action: string | null;
};

type DropVisual = { line: HTMLElement; edge: "top" | "bottom" | "left" | "right" } | { inside: HTMLElement };
type Target = { drop: DropTarget; visual: DropVisual; spring?: string; springSpace?: string };

/** Horizontal travel (px) that switches spaces, and how far the list follows the fingers meanwhile. */
const SWIPE_THRESHOLD = 70;
const SWIPE_FOLLOW = 0.35;
/**
 * Pages get no trackpad phases, so a swipe's momentum looks like more swiping. Momentum events come every
 * frame and never turn round, so a pause this long, or a turn, starts a new swipe (measured: momentum's
 * gaps stay under 25 ms, the next swipe begins 24 to 130 ms after it, the way back always turned).
 */
const SWIPE_GAP_MS = 60;
/** The list springs back once the wheel has been quiet this long. */
const SWIPE_SETTLE_MS = 180;
/** Holding a drag over a space's icon this long switches to that space. */
const SPRING_SPACE_MS = 700;

type Draggable = { type: string; icon?: string; title?: string; source?: string; file?: unknown; files?: unknown[] };
type DragManager = {
  draggable: Draggable | null;
  onDragStart: (e: DragEvent, draggable: Draggable) => void;
  dragFile: (e: DragEvent, file: TFile, source?: string) => Draggable;
  setAction: (action: string | null) => void;
};

export class TabsView extends ItemView {
  private readonly dom = new KeyedDom();
  private scroller!: HTMLElement;
  private headerEl!: HTMLElement;
  private atlasEl!: HTMLElement;
  private spacePane!: HTMLElement;
  private spaceHeaderEl!: HTMLElement;
  private switcherEl!: HTMLElement;
  private spaceHint!: HTMLElement;
  private slide: 1 | -1 | 0 = 0;
  private pendingSpaceRename = false;
  /** `momentum` is the direction the last switch went in: its events are ignored until a pause. */
  private swipe = { travel: 0, momentum: 0, committed: false, last: 0, timer: 0 };
  /** The element the current wheel gesture is sent to; see `followWheelTarget`. */
  private wheelTarget: EventTarget | null = null;
  private springSpace: { id: string; timer: number } | null = null;
  private essentialsEl!: HTMLElement;
  private pinnedEl!: HTMLElement;
  private separatorEl!: HTMLElement;
  private newTabEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private indicator!: HTMLElement;

  private snap: Snapshot | null = null;
  private frame = 0;
  private rendered = false;
  private renaming: string | null = null;
  private pendingRename: string | null = null;
  private readonly peek: FolderPeek;
  /** Row keys picked with Ctrl/Cmd-click, for splitting or closing several tabs at once. */
  private readonly selected = new Set<string>();
  /** Where a Shift-click range starts: the row last clicked. */
  private selectAnchor: string | null = null;

  /** The row being dragged; `group` when it carries the whole selection along. */
  private drag: { src: DragSource; row: HTMLElement; group: DragSource[] | null } | null = null;
  private dropTarget: DropTarget | null = null;
  private insideEl: HTMLElement | null = null;
  private spring: { folderId: string; timer: number } | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly tabs: TabsManager) {
    super(leaf);
    this.navigation = false;
    this.peek = new FolderPeek(tabs);
    // F2 is Obsidian's global "Rename file" hotkey, which would otherwise swallow the key before the row sees it.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "F2", (e) => {
      if (!this.onKeyDown(e)) executeCommand(this.app, "workspace:edit-file-title");
      return false;
    });
  }

  getViewType() {
    return TABS_VIEW_TYPE;
  }

  getDisplayText() {
    return "Tabs";
  }

  getIcon() {
    return "layers";
  }

  async onOpen() {
    this.buildSkeleton();

    const schedule = () => this.schedule();
    const ws = this.app.workspace;
    this.registerEvent(this.tabs.on("changed", schedule));
    this.registerEvent(
      this.tabs.on("space-switched", (...data: unknown[]) => {
        this.slide = data[0] === -1 ? -1 : 1;
        schedule();
      })
    );
    this.registerEvent(
      this.tabs.on("space-created", () => {
        this.pendingSpaceRename = true;
        schedule();
      })
    );
    this.registerEvent(
      this.tabs.on("space-rename", () => {
        this.pendingSpaceRename = true;
        schedule();
      })
    );
    this.registerEvent(
      this.tabs.on("folder-created", (...data: unknown[]) => {
        this.pendingRename = String(data[0]);
        schedule();
      })
    );
    this.registerEvent(ws.on("layout-change", schedule));
    // The card's corners follow the window's, which move with its size and fullscreen.
    this.registerEvent(ws.on("resize", schedule));
    this.registerEvent(ws.on("active-leaf-change", schedule));
    this.registerEvent(ws.on("file-open", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    // Vault indexing fires "create" for every file before the layout is ready; nothing to redraw then.
    this.registerEvent(
      this.app.vault.on("create", () => {
        if (ws.layoutReady) schedule();
      })
    );

    const s = this.scroller;
    this.registerDomEvent(s, "click", (e) => this.onClick(e));
    this.registerDomEvent(s, "auxclick", (e) => this.onAuxClick(e));
    this.registerDomEvent(s, "mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.registerDomEvent(s, "contextmenu", (e) => this.onContextMenu(e));
    this.registerDomEvent(s, "keydown", (e) => {
      if (!e.defaultPrevented) this.onKeyDown(e);
    });
    this.registerDomEvent(s, "mouseover", (e) => this.onPeekOver(e));
    this.registerDomEvent(s, "mouseout", (e) => this.onPeekOut(e));
    this.registerDomEvent(this.contentEl.win, "wheel", (e) => this.onWindowWheel(e), { capture: true, passive: true });
    for (const target of [this.switcherEl]) {
      this.registerDomEvent(target, "dragover", (e) => this.onDragOver(e));
      this.registerDomEvent(target, "dragleave", (e) => this.onDragLeave(e));
      this.registerDomEvent(target, "drop", (e) => void this.onDrop(e));
    }
    this.registerDomEvent(s, "dragstart", (e) => this.onDragStart(e));
    this.registerDomEvent(s, "dragover", (e) => this.onDragOver(e));
    this.registerDomEvent(s, "dragleave", (e) => this.onDragLeave(e));
    this.registerDomEvent(s, "drop", (e) => void this.onDrop(e));
    this.registerDomEvent(s, "dragend", () => this.endDrag());
    // The source row can be re-parented or removed mid-drag, so its dragend may never bubble to the scroller.
    this.registerDomEvent(s.doc, "dragend", () => this.endDrag(), true);
    this.registerDomEvent(s.doc, "drop", () => window.setTimeout(() => this.endDrag()), true);

    this.render();
  }

  async onClose() {
    this.peek.close(false);
    this.followWheelTarget(null);
    window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.endDrag();
  }

  /** Coalesce bursts of workspace events into a single render per frame. */
  private schedule() {
    if (!this.frame) this.frame = window.requestAnimationFrame(() => this.render());
  }

  private buildSkeleton() {
    const root = this.contentEl;
    root.empty();
    root.addClass("zen-tabs");
    // The Atlas pin stays put above the scrolling list.
    this.headerEl = root.createDiv({ cls: "zen-tabs-header" });
    this.atlasEl = this.buildAtlasPin();
    this.scroller = root.createDiv({ cls: "zen-tabs-scroller" });
    this.registerDomEvent(this.scroller, "scroll", () =>
      this.headerEl.toggleClass("is-scrolled", this.scroller.scrollTop > 0)
    );

    this.essentialsEl = this.scroller.createDiv({
      cls: "zen-tabs-essentials",
      attr: { role: "list", "data-empty-label": "Drop here to add to essentials" },
    });
    // Everything below Essentials belongs to the active space and slides when spaces switch.
    this.spacePane = this.scroller.createDiv({ cls: "zen-space-pane" });
    this.spaceHeaderEl = this.spacePane.createDiv({
      cls: "zen-row zen-space-header",
      attr: { role: "button", tabindex: "0" },
    });
    this.spaceHeaderEl.createDiv({ cls: "zen-space-header-icon" });
    this.spaceHeaderEl.createDiv({ cls: "zen-row-title" });
    setIcon(this.spaceHeaderEl.createDiv({ cls: "zen-space-header-more" }), "chevron-down");
    this.pinnedEl = this.spacePane.createDiv({
      cls: "zen-tabs-pinned",
      attr: { role: "tree", "data-empty-label": "Drop here to pin" },
    });

    this.separatorEl = this.spacePane.createDiv({ cls: "zen-tabs-separator" });
    this.separatorEl.createDiv({ cls: "zen-tabs-separator-line" });
    const clear = this.separatorEl.createDiv({
      cls: "zen-tabs-clear",
      attr: { role: "button", tabindex: "0" },
    });
    setIcon(clear.createSpan({ cls: "zen-tabs-clear-icon" }), "arrow-down");
    clear.createSpan({ text: "Clear" });
    onActivate(clear, () => this.tabs.closeUnpinned());

    this.newTabEl = this.spacePane.createDiv({
      cls: "zen-row zen-tabs-new",
      attr: { role: "button", tabindex: "0" },
    });
    setIcon(this.newTabEl.createDiv({ cls: "zen-row-icon" }), "plus");
    this.newTabEl.createDiv({ cls: "zen-row-title", text: "New tab" });
    onActivate(this.newTabEl, () => void this.tabs.newTab());

    this.tabsEl = this.spacePane.createDiv({ cls: "zen-tabs-list", attr: { role: "list" } });
    this.indicator = this.scroller.createDiv({ cls: "zen-drop-indicator" });

    this.switcherEl = root.createDiv({ cls: "zen-space-switcher", attr: { role: "tablist" } });
    this.spaceHint = root.createDiv({ cls: "zen-space-hint" });
    this.registerDomEvent(this.switcherEl, "click", (e) => {
      const button = spaceButtonOf(e.target);
      if (button === "add") void this.tabs.addSpace();
      else if (button) void this.tabs.switchSpace(button);
    });
    this.registerDomEvent(this.switcherEl, "contextmenu", (e) => {
      const button = spaceButtonOf(e.target);
      e.preventDefault();
      e.stopPropagation();
      if (button && button !== "add") this.spaceMenu(button).showAtMouseEvent(e);
    });
    this.registerDomEvent(this.switcherEl, "keydown", (e) => this.onSwitcherKey(e));
    this.registerDomEvent(this.switcherEl, "mouseover", (e) => this.showSpaceHint(e.target));
    this.registerDomEvent(this.switcherEl, "mouseleave", () => this.spaceHint.removeClass("is-shown"));
    this.registerDomEvent(this.spaceHeaderEl, "click", () => this.openSpaceMenuAtHeader());
    this.registerDomEvent(this.spaceHeaderEl, "keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.openSpaceMenuAtHeader();
      } else if (e.key === "F2") {
        e.preventDefault();
        this.renameSpace();
      }
    });
    this.registerDomEvent(this.spaceHeaderEl, "contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.spaceMenu(this.tabs.activeSpace().id).showAtMouseEvent(e);
    });
  }

  // ── Rendering ───────────────────────────────────────────────────────

  private render() {
    this.frame = 0;
    if (!this.scroller) return;
    const animate = this.rendered && !reducedMotion();
    // A space switch slides the whole pane instead of moving rows about.
    const slide = this.slide;
    this.slide = 0;
    const before = animate && !slide ? measure(this.scroller.querySelectorAll<HTMLElement>(".zen-flip")) : null;

    const snap = (this.snap = this.tabs.sync());
    const { essentials, pinned } = this.tabs.state;
    const peek = this.peekPlan(snap);

    this.updateAtlasPin(snap);
    this.dom.begin();
    this.updateSpaces();
    this.dom.place(
      this.essentialsEl,
      essentials.map((pin) => this.tileEl(pin, snap))
    );
    this.dom.place(this.pinnedEl, this.nodeEls(pinned, snap, peek));
    this.dom.place(this.tabsEl, this.tabListEls(snap));
    this.dom.end();
    this.updateSelection();

    const peeked = this.peek.openFor ? this.tabs.findFolder(this.peek.openFor) : undefined;
    if (this.peek.openFor && !peeked?.collapsed) this.peek.close(false);
    this.essentialsEl.toggleClass("is-empty", essentials.length === 0);
    this.pinnedEl.toggleClass("is-empty", pinned.length === 0);
    this.separatorEl.toggleClass("has-tabs", snap.unpinned.length > 0);
    this.updateRovingFocus();

    if (before) {
      const entering = this.dom
        .created()
        .flatMap((el) => (el.hasClass("zen-flip") ? [el] : [...el.querySelectorAll<HTMLElement>(":scope > .zen-flip")]));
      flip(before, entering);
    }
    if (slide && animate) this.slidePane(slide);
    this.rendered = true;

    if (this.pendingSpaceRename) {
      this.pendingSpaceRename = false;
      this.renameSpace();
    }
    if (this.pendingRename) {
      const row = this.rowEl({ kind: "folder", id: this.pendingRename });
      this.pendingRename = null;
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        this.renameFolder(row);
      }
    }
  }

  // ── Spaces ──────────────────────────────────────────────────────────

  private updateSpaces() {
    const spaces = this.tabs.spaces();
    const active = this.tabs.activeSpace();
    const header = this.spaceHeaderEl;
    header.dataset.row = `space:${active.id}`;
    renderFantasyIcon(header.querySelector<HTMLElement>(".zen-space-header-icon")!, active.icon);
    if (!this.renaming?.startsWith("space:")) setText(header.querySelector(".zen-row-title"), active.name);

    const buttons = spaces.map((space) => {
      const button = this.dom.take(`spacebtn:${space.id}`, () =>
        createDiv({ cls: "zen-space-button", attr: { role: "tab", tabindex: "-1", "data-space": space.id } })
      );
      renderFantasyIcon(button, space.icon);
      srLabel(button, space.name);
      const isActive = space.id === active.id;
      button.toggleClass("is-active", isActive);
      button.setAttr("aria-selected", isActive ? "true" : "false");
      button.tabIndex = isActive ? 0 : -1;
      return button;
    });
    const add = this.dom.take("spacebtn:add", () => {
      const el = createDiv({ cls: "zen-space-button zen-space-add", attr: { role: "button", tabindex: "0", "data-space": "add" } });
      setIcon(el, "plus");
      srLabel(el, "New space");
      return el;
    });
    this.dom.place(this.switcherEl, [...buttons, add]);
    this.contentEl.toggleClass("has-spaces", spaces.length > 1);
  }

  private slidePane(direction: 1 | -1) {
    const pane = this.spacePane;
    pane.style.removeProperty("transform");
    pane.style.removeProperty("opacity");
    pane.animate(
      [
        { transform: `translateX(${direction * 28}px)`, opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 260, easing: "cubic-bezier(0.2, 0, 0, 1)" }
    );
  }

  /** A space's name, shown above its icon while the pointer is on it (Obsidian's tooltips stay off). */
  private showSpaceHint(target: EventTarget | null) {
    const id = spaceButtonOf(target);
    const button = id ? this.switcherEl.querySelector<HTMLElement>(`[data-space="${CSS.escape(id)}"]`) : null;
    if (!id || !button) return this.spaceHint.removeClass("is-shown");
    const name = id === "add" ? "New space" : this.tabs.spaces().find((s) => s.id === id)?.name;
    if (!name) return;
    this.spaceHint.setText(name);
    const root = this.contentEl.getBoundingClientRect();
    const r = button.getBoundingClientRect();
    this.spaceHint.style.left = `${r.left + r.width / 2 - root.left}px`;
    this.spaceHint.style.top = `${r.top - root.top}px`;
    this.spaceHint.addClass("is-shown");
  }

  private onSwitcherKey(e: KeyboardEvent) {
    const id = spaceButtonOf(e.target);
    if (!id) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (id === "add") void this.tabs.addSpace();
      else void this.tabs.switchSpace(id);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const buttons = [...this.switcherEl.querySelectorAll<HTMLElement>("[data-space]")];
      const at = buttons.findIndex((b) => b.dataset.space === id);
      buttons[at + (e.key === "ArrowRight" ? 1 : -1)]?.focus();
    }
  }

  /** Sideways wheel events over the sidebar, found by where the pointer is rather than by their target. */
  private onWindowWheel(e: WheelEvent) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const under = this.contentEl.doc.elementFromPoint(e.clientX, e.clientY);
    if (!under || !this.contentEl.contains(under)) return;
    this.followWheelTarget(e.target);
    this.onWheel(e);
  }

  /**
   * Chromium sends every wheel event of a trackpad gesture, momentum included, to the element the gesture
   * began on. A swipe that switches spaces removes the rows of the old space, and events sent to a removed
   * row reach neither the sidebar nor the window, so swiping back went unheard. Listen on that element too.
   */
  private followWheelTarget(target: EventTarget | null) {
    if (target === this.wheelTarget) return;
    this.wheelTarget?.removeEventListener("wheel", this.onDetachedWheel);
    this.wheelTarget = target;
    target?.addEventListener("wheel", this.onDetachedWheel, { passive: true });
  }

  /** While the gesture's element is still in the document, the window's listener hears its events. */
  private readonly onDetachedWheel = (e: Event) => {
    if (!(e.currentTarget as Node).isConnected) this.onWheel(e as WheelEvent);
  };

  /** A sideways swipe (or a mouse's horizontal wheel) switches spaces; the list follows until it lets go. */
  private onWheel(e: WheelEvent) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || this.tabs.spaces().length < 2 || this.drag) return;
    const swipe = this.swipe;
    if (e.timeStamp - swipe.last > SWIPE_GAP_MS) this.startSwipe();
    swipe.last = e.timeStamp;
    window.clearTimeout(swipe.timer);
    swipe.timer = window.setTimeout(() => this.endSwipe(), SWIPE_SETTLE_MS);
    // Line-based wheels (most mice) report notches: one notch, one space.
    const delta = e.deltaMode === 1 ? Math.sign(e.deltaX) * SWIPE_THRESHOLD : e.deltaX;
    if (swipe.momentum) {
      if (Math.sign(delta) === swipe.momentum) return;
      swipe.committed = false;
    }
    swipe.travel += delta;
    const step: 1 | -1 = swipe.travel > 0 ? 1 : -1;
    const open = this.tabs.canStepSpace(step);
    if (open && Math.abs(swipe.travel) >= SWIPE_THRESHOLD) {
      Object.assign(swipe, { travel: 0, momentum: step, committed: true });
      void this.tabs.stepSpace(step, false);
      return;
    }
    if (reducedMotion()) return;
    // Past the first or last space the list only gives a little, like a rubber band.
    const follow = open ? SWIPE_FOLLOW : SWIPE_FOLLOW / 4;
    const offset = Math.max(-48, Math.min(48, -swipe.travel * follow));
    this.spacePane.removeClass("is-settling");
    this.spacePane.addClass("is-swiping");
    this.spacePane.style.transform = `translateX(${offset}px)`;
    this.spacePane.style.opacity = String(1 - Math.min(0.4, Math.abs(offset) / 120));
  }

  private startSwipe() {
    Object.assign(this.swipe, { travel: 0, momentum: 0, committed: false });
  }

  private endSwipe() {
    const swipe = this.swipe;
    const committed = swipe.committed;
    this.startSwipe();
    swipe.timer = 0;
    const pane = this.spacePane;
    pane.removeClass("is-swiping");
    if (committed) return;
    pane.addClass("is-settling");
    pane.style.removeProperty("transform");
    pane.style.removeProperty("opacity");
  }

  private openSpaceMenuAtHeader() {
    const r = this.spaceHeaderEl.getBoundingClientRect();
    this.spaceMenu(this.tabs.activeSpace().id).showAtPosition({ x: r.left, y: r.bottom + 4 });
  }

  private spaceMenu(id: string): Menu {
    const menu = new Menu();
    const spaces = this.tabs.spaces();
    const space = spaces.find((s) => s.id === id);
    if (!space) return menu;
    const index = spaces.indexOf(space);
    menu.addItem((i) =>
      i
        .setTitle("Rename…")
        .setIcon("pencil")
        .onClick(async () => {
          await this.tabs.switchSpace(id);
          this.renameSpace();
        })
    );
    menu.addItem((i) =>
      i
        .setTitle("Change icon…")
        .setIcon("shapes")
        .onClick(() =>
          new FantasyIconPicker(this.app, `Icon for ${space.name}`, space.icon, (icon) =>
            this.tabs.setSpaceIcon(id, icon)
          ).open()
        )
    );
    if (spaces.length > 1) {
      menu.addSeparator();
      if (index > 0) menu.addItem((i) => i.setTitle("Move left").setIcon("arrow-left").onClick(() => this.tabs.moveSpace(id, -1)));
      if (index < spaces.length - 1) {
        menu.addItem((i) => i.setTitle("Move right").setIcon("arrow-right").onClick(() => this.tabs.moveSpace(id, 1)));
      }
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("New space").setIcon("plus").onClick(() => void this.tabs.addSpace()));
    if (spaces.length > 1) {
      menu.addItem((i) =>
        i
          .setTitle("Delete space…")
          .setIcon("trash-2")
          .setWarning(true)
          .onClick(() => this.confirmDeleteSpace(space))
      );
    }
    return menu;
  }

  private confirmDeleteSpace(space: Space) {
    const spaces = this.tabs.spaces();
    const index = spaces.indexOf(space);
    const neighbour = spaces[index === 0 ? 1 : index - 1];
    const hasPins = [...walkSpacePins(space.pinned)].length > 0 || space.pinned.length > 0;
    const message = hasPins
      ? `Its pinned tabs and folders are removed. Notes it has open stay open, in “${neighbour.name}”.`
      : `Notes it has open stay open, in “${neighbour.name}”.`;
    new ConfirmModal(this.app, `Delete “${space.name}”?`, message, "Delete space", () => void this.tabs.deleteSpace(space.id)).open();
  }

  private renameSpace() {
    const space = this.tabs.activeSpace();
    this.startRename(this.spaceHeaderEl, space.name, (name) => this.tabs.renameSpace(space.id, name));
  }

  /** Atlas VTT, pinned across the top: its art fades into the sidebar, and it holds Atlas's own tabs. */
  private buildAtlasPin(): HTMLElement {
    const pin = this.headerEl.createDiv({
      cls: "zen-atlas",
      attr: { role: "button", tabindex: "0" },
    });
    pin.style.setProperty("--zen-atlas-art", `url("${ATLAS_ART}")`);
    pin.createDiv({ cls: "zen-atlas-backdrop" });
    pin.createDiv({ cls: "zen-atlas-art" });
    const text = pin.createDiv({ cls: "zen-atlas-text" });
    text.createDiv({ cls: "zen-atlas-title", text: "Atlas" });
    const sub = text.createDiv({ cls: "zen-atlas-sub" });
    sub.createSpan({ cls: "zen-atlas-sub-icon" });
    sub.createSpan({ cls: "zen-atlas-sub-text" });

    this.registerDomEvent(pin, "click", () => void this.tabs.openAtlas());
    this.registerDomEvent(pin, "keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      void this.tabs.openAtlas();
    });
    this.registerDomEvent(pin, "contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.atlasMenu().showAtMouseEvent(e);
    });
    return pin;
  }

  private updateAtlasPin(snap: Snapshot) {
    const shown = this.tabs.atlasPinShown();
    this.headerEl.toggle(shown);
    if (!shown) return;
    const map = snap.atlas.find(isAtlasMap);
    const scene = map ? leafPath(map) : undefined;
    const [icon, text] = scene
      ? ["map", pinFileName(scene)]
      : snap.atlas.length
        ? ["layout-dashboard", "Dashboard"]
        : ["sparkles", "Open your campaign"];
    const active = !!snap.active && snap.atlas.includes(snap.active);
    this.atlasEl.toggleClass("is-active", active);
    this.atlasEl.setAttr("aria-current", active ? "page" : null);
    setIconCached(this.atlasEl.querySelector<HTMLElement>(".zen-atlas-sub-icon"), icon);
    setText(this.atlasEl.querySelector(".zen-atlas-sub-text"), text);
    fitWindowCorners(this.atlasEl);
  }

  private atlasMenu(): Menu {
    const menu = new Menu();
    const run = (id: string) => () => executeCommand(this.app, id);
    menu.addItem((i) => i.setTitle("Open dashboard").setIcon("layout-dashboard").onClick(run(ATLAS_COMMANDS.dashboard)));
    menu.addItem((i) => i.setTitle("Browse scenes").setIcon("map").onClick(run(ATLAS_COMMANDS.scenes)));
    menu.addItem((i) => i.setTitle("Open player window").setIcon("monitor").onClick(run(ATLAS_COMMANDS.playerWindow)));
    if (this.snap?.atlas.length) {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Close map and dashboard tabs").setIcon("x").onClick(() => this.tabs.closeAtlas()));
    }
    return menu;
  }

  /** Zen keeps the active tab visible when its folder is collapsed: the outermost collapsed folder shows it. */
  private peekPlan(snap: Snapshot): { folderId: string; pinId: string } | null {
    const pin = snap.active ? snap.owner.get(leafId(snap.active)) : undefined;
    if (!pin) return null;
    const collapsed = ancestors(this.tabs.state.pinned, pin.id).find((f) => f.collapsed);
    return collapsed ? { folderId: collapsed.id, pinId: pin.id } : null;
  }

  private nodeEls(nodes: TreeNode[], snap: Snapshot, peek: { folderId: string; pinId: string } | null): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const node of nodes) {
      if (node.kind === "folder") out.push(this.folderEl(node, snap, peek));
      else if (node.id !== peek?.pinId) out.push(this.pinEl(node, snap));
    }
    return out;
  }

  private pinEl(pin: PinNode, snap: Snapshot): HTMLElement {
    const key = `pin:${pin.id}`;
    const el = this.dom.take(key, () => createRow(key));
    const leaf = snap.bound.get(pin.id);
    const changed = !!leaf && this.tabs.isChanged(pin, leaf);
    const title = this.tabs.pinTitle(pin, leaf);
    this.updateRow(el, {
      title,
      icon: leaf && changed ? this.tabs.leafIcon(leaf) : this.tabs.pinIcon(pin),
      resetIcon: changed ? this.tabs.pinIcon(pin) : null,
      active: !!leaf && leaf === snap.active,
      shown: !!leaf && leaf !== snap.active && this.tabs.isShown(leaf),
      loaded: !!leaf,
      missing: this.tabs.isMissing(pin),
      action: leaf ? "Close tab" : null,
    });
    return el;
  }

  /** Unpinned tabs, with each split view drawn once, where its first member sits. */
  private tabListEls(snap: Snapshot): HTMLElement[] {
    const out: HTMLElement[] = [];
    const drawn = new Set<SplitGroup>();
    for (const leaf of snap.unpinned) {
      const group = snap.splitOf.get(leafId(leaf));
      if (!group) out.push(this.tabEl(leaf, snap));
      else if (!drawn.has(group)) {
        drawn.add(group);
        out.push(this.splitEl(group, snap));
      }
    }
    return out;
  }

  private splitEl(group: SplitGroup, snap: Snapshot): HTMLElement {
    const key = `split:${group.id}`;
    const el = this.dom.take(key, () =>
      createDiv({
        cls: "zen-row zen-split-row zen-flip",
        attr: { "data-row": key, role: "treeitem", tabindex: "-1", draggable: "true" },
      })
    );
    const members = group.leafIds.map((id) => snap.leaves.get(id)).filter((l): l is WorkspaceLeaf => !!l);
    const active = !!snap.active && members.includes(snap.active);
    el.toggleClass("is-active", active);
    el.toggleClass("is-stacked", group.direction === "horizontal");
    el.setAttr("aria-current", active ? "page" : null);
    this.dom.place(
      el,
      members.map((leaf) => this.segmentEl(leaf, snap))
    );
    return el;
  }

  private segmentEl(leaf: WorkspaceLeaf, snap: Snapshot): HTMLElement {
    const id = leafId(leaf);
    const el = this.dom.take(`seg:${id}`, () => {
      const seg = createDiv({ cls: "zen-split-seg", attr: { "data-seg": id } });
      seg.createDiv({ cls: "zen-row-icon" });
      seg.createDiv({ cls: "zen-row-title" });
      const close = seg.createDiv({ cls: "zen-row-action clickable-icon", attr: { role: "button" } });
      setIcon(close, "x");
      srLabel(close, "Close tab");
      return seg;
    });
    const title = leafTitle(leaf);
    el.toggleClass("is-focused", leaf === snap.active);
    setIconCached(el.querySelector<HTMLElement>(".zen-row-icon"), this.tabs.leafIcon(leaf));
    setText(el.querySelector(".zen-row-title"), title);
    return el;
  }

  private tabEl(leaf: WorkspaceLeaf, snap: Snapshot): HTMLElement {
    const key = `tab:${leafId(leaf)}`;
    const el = this.dom.take(key, () => createRow(key));
    const title = leafTitle(leaf);
    this.updateRow(el, {
      title,
      icon: this.tabs.leafIcon(leaf),
      resetIcon: null,
      active: leaf === snap.active,
      shown: leaf !== snap.active && this.tabs.isShown(leaf),
      loaded: true,
      missing: false,
      action: "Close tab",
    });
    return el;
  }

  private tileEl(pin: PinNode, snap: Snapshot): HTMLElement {
    const key = `ess:${pin.id}`;
    const el = this.dom.take(key, () => {
      const tile = createDiv({
        cls: "zen-tile zen-flip",
        attr: { "data-row": key, role: "listitem", tabindex: "-1", draggable: "true" },
      });
      tile.createDiv({ cls: "zen-tile-icon" });
      tile.createDiv({ cls: "zen-tile-title" });
      return tile;
    });
    const leaf = snap.bound.get(pin.id);
    const title = this.tabs.pinTitle(pin, leaf);
    el.toggleClass("is-active", !!leaf && leaf === snap.active);
    el.toggleClass("is-shown", !!leaf && leaf !== snap.active && this.tabs.isShown(leaf));
    el.toggleClass("is-unloaded", !leaf);
    el.toggleClass("is-missing", this.tabs.isMissing(pin));
    el.toggleClass("is-changed", !!leaf && this.tabs.isChanged(pin, leaf));
    el.setAttr("aria-current", leaf && leaf === snap.active ? "page" : null);
    setIconCached(el.querySelector<HTMLElement>(".zen-tile-icon"), this.tabs.pinIcon(pin));
    if (this.renaming !== key) setText(el.querySelector(".zen-tile-title"), title);
    return el;
  }

  private folderEl(folder: FolderNode, snap: Snapshot, peek: { folderId: string; pinId: string } | null): HTMLElement {
    const key = `folder:${folder.id}`;
    const el = this.dom.take(key, () => createFolder(key));
    const row = el.querySelector<HTMLElement>(":scope > .zen-folder-row")!;
    const body = el.querySelector<HTMLElement>(":scope > .zen-folder-body")!;
    const children = body.firstElementChild as HTMLElement;
    const peekEl = el.querySelector<HTMLElement>(":scope > .zen-folder-peek")!;

    const pins = [...walkPins(folder.children)];
    const loaded = pins.some((p) => snap.bound.has(p.id));
    const hasActive = !!snap.active && pins.some((p) => snap.bound.get(p.id) === snap.active);

    el.toggleClass("is-collapsed", folder.collapsed);
    row.toggleClass("has-active", hasActive && folder.collapsed);
    row.toggleClass("is-unloaded", !loaded);
    row.toggleClass("is-empty", folder.children.length === 0);
    row.setAttr("aria-expanded", String(!folder.collapsed));
    body.toggleAttribute("inert", folder.collapsed);
    if (folder.color) el.style.setProperty("--zt-folder-hue", `var(--color-${folder.color})`);
    else el.style.removeProperty("--zt-folder-hue");

    const glyph = row.querySelector<HTMLElement>(".zen-folder-glyph")!;
    glyph.toggleClass("has-icon", !!folder.icon);
    if (folder.icon) setIconCached(glyph, folder.icon);
    if (this.renaming !== key) setText(row.querySelector(".zen-row-title"), folder.name);

    this.dom.place(children, this.nodeEls(folder.children, snap, peek));
    const peekPin = peek?.folderId === folder.id ? this.tabs.findPin(peek.pinId) : undefined;
    this.dom.place(peekEl, peekPin ? [this.pinEl(peekPin, snap)] : []);
    return el;
  }

  private updateRow(el: HTMLElement, s: RowState) {
    el.toggleClass("is-active", s.active);
    el.toggleClass("is-shown", s.shown);
    el.toggleClass("is-unloaded", !s.loaded);
    el.toggleClass("is-missing", s.missing);
    el.toggleClass("is-changed", !!s.resetIcon);
    el.setAttr("aria-current", s.active ? "page" : null);
    setIconCached(el.querySelector<HTMLElement>(".zen-row-icon"), s.icon);
    if (s.resetIcon) {
      const reset = el.querySelector<HTMLElement>(".zen-row-reset")!;
      setIconCached(reset, s.resetIcon);
      srLabel(reset, "Back to pinned note");
    }
    if (this.renaming !== el.dataset.row) setText(el.querySelector(".zen-row-title"), s.title);
    const action = el.querySelector<HTMLElement>(".zen-row-action")!;
    action.toggleClass("is-hidden", !s.action);
    if (s.action) srLabel(action, s.action);
  }

  /** One row is reachable with Tab; arrow keys move between rows. */
  private updateRovingFocus() {
    const rows = this.visibleRows();
    const focused = this.scroller.doc.activeElement;
    const current =
      rows.find((r) => r === focused) ?? rows.find((r) => r.hasClass("is-active")) ?? rows[0] ?? null;
    for (const row of this.scroller.querySelectorAll<HTMLElement>("[data-row]")) {
      row.tabIndex = row === current ? 0 : -1;
    }
  }

  private visibleRows(): HTMLElement[] {
    return [...this.scroller.querySelectorAll<HTMLElement>("[data-row]")].filter(
      (r) => !r.closest(".zen-folder.is-collapsed > .zen-folder-body")
    );
  }

  private rowEl(ref: RowRef): HTMLElement | null {
    return this.scroller.querySelector<HTMLElement>(`[data-row="${ref.kind}:${CSS.escape(ref.id)}"]`);
  }

  private hitOf(target: EventTarget | null): Hit | null {
    const node = target as Element | null;
    if (!node || typeof node.closest !== "function") return null;
    const el = node.closest<HTMLElement>("[data-row]");
    if (!el || !this.scroller.contains(el)) return null;
    const raw = el.dataset.row ?? "";
    const split = raw.indexOf(":");
    const seg = node.closest<HTMLElement>("[data-seg]")?.dataset.seg;
    return { el, ref: { kind: raw.slice(0, split) as RowKind, id: raw.slice(split + 1) }, seg };
  }

  private pathOf(ref: RowRef): string | undefined {
    if (ref.kind === "folder" || ref.kind === "split") return undefined;
    if (ref.kind === "tab") {
      const leaf = this.tabs.sync().leaves.get(ref.id);
      return leaf ? leafPath(leaf) : undefined;
    }
    const pin = this.tabs.findPin(ref.id);
    if (!pin) return undefined;
    const leaf = this.tabs.sync().bound.get(pin.id);
    return (leaf ? leafPath(leaf) : undefined) ?? pin.path;
  }

  // ── Pointer and keyboard ────────────────────────────────────────────

  private onClick(e: MouseEvent) {
    const hit = this.hitOf(e.target);
    if (!hit || isWithin(e.target, ".zen-row-rename")) return;
    let part: RowPart = "open";
    if (isWithin(e.target, ".zen-row-action")) part = "action";
    else if (isWithin(e.target, ".zen-row-reset")) part = "reset";
    const selectable = hit.ref.kind !== "folder" && hit.ref.kind !== "space";
    if (part === "open" && selectable && (e.metaKey || e.ctrlKey)) {
      this.toggleSelected(hit);
      return;
    }
    if (part === "open" && selectable && e.shiftKey && this.selectAnchor) {
      this.selectRange(this.selectAnchor, hit.el.dataset.row ?? "");
      return;
    }
    this.clearSelection();
    this.selectAnchor = hit.el.dataset.row ?? null;
    this.activate(hit.ref, part, hit.seg);
  }

  private activate(ref: RowRef, part: RowPart, seg?: string) {
    if (ref.kind === "space") return;
    if (ref.kind === "split") {
      const group = this.tabs.findSplit(ref.id);
      if (!group) return;
      const leaf = seg ? this.tabs.sync().leaves.get(seg) : undefined;
      if (part === "action") {
        if (leaf) leaf.detach();
        else this.tabs.closeSplit(group);
      } else void this.tabs.showSplit(group, leaf);
      return;
    }
    if (ref.kind === "folder") {
      const folder = this.tabs.findFolder(ref.id);
      if (!folder) return;
      this.peek.close(false);
      if (part === "action") this.tabs.unloadFolder(folder);
      else this.tabs.setCollapsed(folder.id, !folder.collapsed);
      return;
    }
    if (ref.kind === "tab") {
      const leaf = this.tabs.sync().leaves.get(ref.id);
      if (!leaf) return;
      if (part === "action") leaf.detach();
      else void this.tabs.focus(leaf);
      return;
    }
    const pin = this.tabs.findPin(ref.id);
    if (!pin) return;
    if (part === "action") this.tabs.unload(pin);
    else if (part === "reset") void this.tabs.reset(pin);
    else void this.tabs.open(pin);
  }

  private onAuxClick(e: MouseEvent) {
    if (e.button !== 1) return;
    const hit = this.hitOf(e.target);
    if (!hit || hit.ref.kind === "folder") return;
    e.preventDefault();
    this.activate(hit.ref, "action", hit.seg);
  }

  /** Resting on a collapsed folder shows its tabs (Zen's folder popup). */
  private onPeekOver(e: MouseEvent) {
    if (this.drag) return;
    const hit = this.hitOf(e.target);
    if (hit?.ref.kind !== "folder") return;
    const folder = this.tabs.findFolder(hit.ref.id);
    if (folder) this.peek.hoverFolder(hit.el, folder);
  }

  private onPeekOut(e: MouseEvent) {
    const from = isWithin(e.target, ".zen-folder-row") ? (e.target as Element).closest(".zen-folder-row") : null;
    const to = e.relatedTarget as Node | null;
    if (from && !(to && from.contains(to))) this.peek.leaveFolder();
  }

  /** Returns whether the key was handled. */
  private onKeyDown(e: KeyboardEvent): boolean {
    if (this.renaming) return false;
    if (e.key === "Escape" && this.selected.size) {
      this.clearSelection();
      return true;
    }
    const hit = this.hitOf(e.target);
    if (!hit) return false;
    const { el, ref } = hit;
    const folder = ref.kind === "folder" ? this.tabs.findFolder(ref.id) : undefined;

    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const rows = this.visibleRows();
        const next = rows[rows.indexOf(el) + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) this.focusRow(next);
        break;
      }
      case "ArrowRight":
        if (folder?.collapsed) this.tabs.setCollapsed(folder.id, false);
        else return false;
        break;
      case "ArrowLeft":
        if (folder && !folder.collapsed) this.tabs.setCollapsed(folder.id, true);
        else return false;
        break;
      case "Enter":
      case " ":
        this.activate(ref, "open");
        break;
      case "Delete":
      case "Backspace":
        if (ref.kind === "folder") return false;
        this.activate(ref, "action");
        break;
      case "F2":
        if (folder) this.renameFolder(el);
        else if (ref.kind === "pin" || ref.kind === "ess") this.renamePin(el, ref.id);
        else return false;
        break;
      case "ContextMenu": {
        const rect = el.getBoundingClientRect();
        this.menuFor(hit).showAtPosition({ x: rect.left + 16, y: rect.bottom });
        break;
      }
      default:
        return false;
    }
    e.preventDefault();
    return true;
  }

  private focusRow(row: HTMLElement) {
    for (const r of this.scroller.querySelectorAll<HTMLElement>("[data-row]")) r.tabIndex = -1;
    row.tabIndex = 0;
    row.focus();
    row.scrollIntoView({ block: "nearest" });
  }

  // ── Context menus ───────────────────────────────────────────────────

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const hit = this.hitOf(e.target);
    this.menuFor(hit).showAtMouseEvent(e);
  }

  private menuFor(hit: Hit | null): Menu {
    const menu = new Menu();
    if (!hit) this.fillBackgroundMenu(menu);
    else if (this.actsOnSelection(hit.el.dataset.row ?? "")) this.fillSelectionMenu(menu);
    else if (hit.ref.kind === "folder") this.fillFolderMenu(menu, hit.el, hit.ref.id);
    else if (hit.ref.kind === "space") return this.spaceMenu(hit.ref.id);
    else if (hit.ref.kind === "split") this.fillSplitMenu(menu, hit.ref.id, hit.seg);
    else if (hit.ref.kind === "tab") this.fillTabMenu(menu, hit.ref.id);
    else this.fillPinMenu(menu, hit.el, hit.ref.id);
    return menu;
  }

  private fillSplitMenu(menu: Menu, id: string, seg?: string) {
    const group = this.tabs.findSplit(id);
    if (!group) return;
    const leaf = seg ? this.tabs.sync().leaves.get(seg) : undefined;
    if (leaf) {
      const title = leafTitle(leaf);
      menu.addItem((i) =>
        i
          .setTitle(`Remove “${title}” from split view`)
          .setIcon("log-out")
          .onClick(() => this.tabs.removeFromSplit(leaf))
      );
      menu.addItem((i) =>
        i
          .setTitle(`Pin “${title}”`)
          .setIcon("pin")
          .onClick(() => void this.tabs.move({ kind: "tab", leafId: leafId(leaf) }, this.tabs.pinnedEnd()))
      );
      menu.addItem((i) => i.setTitle(`Close “${title}”`).setIcon("x").onClick(() => leaf.detach()));
      menu.addSeparator();
    }
    menu.addItem((i) => i.setTitle("Unsplit").setIcon("rectangle-horizontal").onClick(() => this.tabs.unsplit(group)));
    menu.addItem((i) => i.setTitle("Close split view").setIcon("copy-x").onClick(() => this.tabs.closeSplit(group)));
    if (leaf) this.addFileMenu(menu, leafPath(leaf), leaf);
  }

  /** Split this tab with the one in focus, or add it to the split on screen, Zen style. */
  private addSplitItems(menu: Menu, leaf: WorkspaceLeaf | undefined) {
    const active = this.tabs.sync().active;
    if (!leaf || !active || active === leaf || leaf.getViewState().type === "empty") return;
    const group = this.tabs.splitOfLeaf(active);
    if (group?.leafIds.includes(leafId(leaf))) return;
    if (group && group.leafIds.length < MAX_SPLIT) {
      menu.addItem((i) =>
        i
          .setTitle("Add to split view")
          .setIcon("columns-3")
          .onClick(() => void this.tabs.addToSplit(group, leaf))
      );
    } else if (!group && active.getViewState().type !== "empty") {
      menu.addItem((i) =>
        i
          .setTitle("Split with current tab")
          .setIcon("columns-2")
          .onClick(() => void this.tabs.split([active, leaf], "vertical", leaf))
      );
    }
  }

  /** Everything that can be done to the Ctrl/Cmd- or Shift-selected rows at once. */
  private fillSelectionMenu(menu: Menu) {
    const sources = this.selectionSources();
    const leaves = this.selectedLeaves();
    const what = `${sources.length} tabs`;
    // Each action works on the selection as it was when the menu opened, then clears it.
    const run = (action: () => unknown) => () => {
      this.clearSelection();
      void action();
    };
    const pins = sources.filter((src) => src.kind === "node");
    const essential = (src: DragSource) => src.kind === "node" && this.tabs.isEssential(src.id);
    const allEssentials = sources.every(essential);

    if (leaves.length >= 2) {
      const count = Math.min(leaves.length, MAX_SPLIT);
      menu.addItem((i) =>
        i
          .setTitle(`Split ${count} tabs`)
          .setIcon("columns-2")
          .onClick(run(() => this.tabs.split(leaves, "vertical")))
      );
      menu.addItem((i) =>
        i
          .setTitle(`Split ${count} tabs stacked`)
          .setIcon("rows-2")
          .onClick(run(() => this.tabs.split(leaves, "horizontal")))
      );
      menu.addSeparator();
    }
    const pinnable = sources.some((src) => src.kind !== "node" || essential(src));
    if (pinnable && this.tabs.canDropMany(sources, this.tabs.pinnedEnd())) {
      menu.addItem((i) =>
        i
          .setTitle(allEssentials ? "Move to pinned tabs" : `Pin ${what}`)
          .setIcon("pin")
          .onClick(run(() => this.tabs.moveMany(sources, this.tabs.pinnedEnd())))
      );
    }
    if (!allEssentials && this.tabs.canDropMany(sources, this.tabs.essentialsEnd())) {
      menu.addItem((i) =>
        i
          .setTitle("Add to essentials")
          .setIcon("layout-grid")
          .onClick(run(() => this.tabs.moveMany(sources, this.tabs.essentialsEnd())))
      );
    }
    if (pins.length) {
      const unpinned = { zone: "tabs", index: this.tabs.state.order.length } as const;
      menu.addItem((i) =>
        i
          .setTitle(
            allEssentials
              ? "Remove from essentials"
              : pins.length === sources.length
                ? `Unpin ${what}`
                : `Unpin ${pins.length} pinned tabs`
          )
          .setIcon("pin-off")
          .onClick(run(() => this.tabs.moveMany(pins, unpinned)))
      );
    }
    if (this.tabs.state.pinned.some((n) => n.kind === "folder")) {
      menu.addItem((i) =>
        i
          .setTitle("Move to folder…")
          .setIcon("folder-input")
          .onClick(() =>
            new FolderPicker(this.app, this.tabs.folders(), (parentId) =>
              run(() => this.tabs.moveMany(sources, this.tabs.pinnedEnd(parentId)))()
            ).open()
          )
      );
    }
    menu.addItem((i) =>
      i
        .setTitle(`New folder with ${what}`)
        .setIcon("folder-plus")
        .onClick(run(() => this.tabs.folderAroundMany(sources)))
    );
    const others = this.tabs.spaces().filter((space) => space.id !== this.tabs.activeSpace().id);
    if (others.length) {
      menu.addItem((i) =>
        i
          .setTitle("Move to space…")
          .setIcon("layers")
          .onClick(() =>
            new SpacePicker(this.app, others, (space) =>
              run(() => this.tabs.moveMany(sources, { zone: "space", spaceId: space.id }))()
            ).open()
          )
      );
    }
    if (leaves.length) {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle(leaves.length === 1 ? "Close tab" : `Close ${leaves.length} tabs`)
          .setIcon("copy-x")
          .onClick(run(() => leaves.forEach((leaf) => leaf.detach())))
      );
    }
  }

  // ── Selection ───────────────────────────────────────────────────────

  private toggleSelected(hit: Hit) {
    const key = hit.el.dataset.row ?? "";
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
    this.selectAnchor = key;
    this.updateSelection();
  }

  /** Shift-click: select every tab and pin from the anchor row to this one, as they appear. */
  private selectRange(from: string, to: string) {
    const keys = this.visibleRows()
      .map((row) => row.dataset.row ?? "")
      .filter((key) => !key.startsWith("folder:") && !key.startsWith("space:"));
    const a = keys.indexOf(from);
    const b = keys.indexOf(to);
    if (a < 0 || b < 0) return;
    for (const key of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) this.selected.add(key);
    this.updateSelection();
  }

  /** The selected rows as things to move, in sidebar order. */
  private selectionSources(): DragSource[] {
    const out: DragSource[] = [];
    for (const row of this.scroller.querySelectorAll<HTMLElement>("[data-row].is-selected")) {
      const raw = row.dataset.row ?? "";
      const at = raw.indexOf(":");
      const kind = raw.slice(0, at);
      const id = raw.slice(at + 1);
      if (kind === "tab") out.push({ kind: "tab", leafId: id });
      else if (kind === "split") out.push({ kind: "split", id });
      else if (kind === "pin" || kind === "ess") out.push({ kind: "node", id });
    }
    return out;
  }

  /** Whether a right-click or drag on this row means the whole selection. */
  private actsOnSelection(key: string): boolean {
    return this.selected.has(key) && this.selected.size > 1;
  }

  private clearSelection() {
    if (!this.selected.size) return;
    this.selected.clear();
    this.updateSelection();
  }

  private updateSelection() {
    const present = new Set<string>();
    for (const row of this.scroller.querySelectorAll<HTMLElement>("[data-row]")) {
      const key = row.dataset.row ?? "";
      present.add(key);
      row.toggleClass("is-selected", this.selected.has(key));
    }
    for (const key of [...this.selected]) if (!present.has(key)) this.selected.delete(key);
    this.contentEl.toggleClass("has-selection", this.selected.size > 0);
  }

  /** The open leaves behind the selected rows, in sidebar order. Unloaded pins are skipped. */
  private selectedLeaves(): WorkspaceLeaf[] {
    const snap = this.tabs.sync();
    const out: WorkspaceLeaf[] = [];
    const add = (leaf: WorkspaceLeaf | undefined) => {
      if (leaf && !out.includes(leaf)) out.push(leaf);
    };
    for (const row of this.scroller.querySelectorAll<HTMLElement>("[data-row].is-selected")) {
      const raw = row.dataset.row ?? "";
      const at = raw.indexOf(":");
      const kind = raw.slice(0, at);
      const id = raw.slice(at + 1);
      if (kind === "tab") add(snap.leaves.get(id));
      else if (kind === "pin" || kind === "ess") add(snap.bound.get(id));
      else if (kind === "split") for (const m of this.tabs.findSplit(id)?.leafIds ?? []) add(snap.leaves.get(m));
    }
    return out;
  }

  private fillBackgroundMenu(menu: Menu) {
    menu.addItem((i) => i.setTitle("New tab").setIcon("plus").onClick(() => void this.tabs.newTab()));
    menu.addItem((i) => i.setTitle("New folder").setIcon("folder-plus").onClick(() => this.tabs.addFolder()));
    if (this.snap?.unpinned.length) {
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("Close unpinned tabs").setIcon("x").onClick(() => this.tabs.closeUnpinned())
      );
    }
  }

  private fillTabMenu(menu: Menu, id: string) {
    const leaf = this.tabs.sync().leaves.get(id);
    if (!leaf) return;
    const src: DragSource = { kind: "tab", leafId: id };
    const pinnable = leaf.getViewState().type !== "empty";

    this.addSplitItems(menu, leaf);
    if (pinnable) {
      menu.addItem((i) =>
        i
          .setTitle("Pin tab")
          .setIcon("pin")
          .onClick(() => void this.tabs.move(src, this.tabs.pinnedEnd()))
      );
      menu.addItem((i) =>
        i
          .setTitle("Add to essentials")
          .setIcon("layout-grid")
          .onClick(() => void this.tabs.move(src, this.tabs.essentialsEnd()))
      );
      this.addFolderItems(menu, src);
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Close tab").setIcon("x").onClick(() => leaf.detach()));
    menu.addItem((i) =>
      i
        .setTitle("Close other unpinned tabs")
        .setIcon("copy-x")
        .onClick(() => this.tabs.closeOthers(leaf))
    );
    this.addFileMenu(menu, leafPath(leaf), leaf);
  }

  private fillPinMenu(menu: Menu, row: HTMLElement, id: string) {
    const pin = this.tabs.findPin(id);
    if (!pin) return;
    const leaf = this.tabs.sync().bound.get(pin.id);
    const essential = this.tabs.isEssential(pin.id);
    const src: DragSource = { kind: "node", id: pin.id };

    if (leaf && this.tabs.isChanged(pin, leaf)) {
      menu.addItem((i) =>
        i
          .setTitle("Back to pinned note")
          .setIcon("rotate-ccw")
          .onClick(() => void this.tabs.reset(pin))
      );
    }
    if (leaf) menu.addItem((i) => i.setTitle("Close tab").setIcon("x").onClick(() => this.tabs.unload(pin)));
    menu.addSeparator();
    this.addSplitItems(menu, leaf);
    menu.addSeparator();

    menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").onClick(() => this.renamePin(row, pin.id)));
    if (pin.title && pin.path) {
      menu.addItem((i) =>
        i
          .setTitle("Reset name")
          .setIcon("eraser")
          .onClick(() => this.tabs.setPinTitle(pin.id, undefined))
      );
    }
    this.addIconItems(menu, pin.id, !!pin.icon && !!pin.path);
    menu.addSeparator();

    if (essential) {
      menu.addItem((i) =>
        i
          .setTitle("Move to pinned tabs")
          .setIcon("pin")
          .onClick(() => void this.tabs.move(src, this.tabs.pinnedEnd()))
      );
      menu.addItem((i) =>
        i
          .setTitle("Remove from essentials")
          .setIcon("pin-off")
          .onClick(() => this.tabs.unpin(pin.id))
      );
    } else {
      menu.addItem((i) =>
        i
          .setTitle("Add to essentials")
          .setIcon("layout-grid")
          .onClick(() => void this.tabs.move(src, this.tabs.essentialsEnd()))
      );
      this.addFolderItems(menu, src);
      menu.addItem((i) => i.setTitle("Unpin tab").setIcon("pin-off").onClick(() => this.tabs.unpin(pin.id)));
    }

    this.addFileMenu(menu, pin.path, leaf);
  }

  private fillFolderMenu(menu: Menu, row: HTMLElement, id: string) {
    const folder = this.tabs.findFolder(id);
    if (!folder) return;
    const snap = this.tabs.sync();
    const loaded = [...walkPins(folder.children)].some((p) => snap.bound.has(p.id));

    menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").onClick(() => this.renameFolder(row)));
    this.addIconItems(menu, folder.id, !!folder.icon);
    menu.addItem((i) =>
      i
        .setTitle("Change color…")
        .setIcon("palette")
        .onClick(() =>
          new ColorPicker(this.app, folder.color, (color) => this.tabs.setFolderColor(folder.id, color)).open()
        )
    );
    menu.addSeparator();
    if (this.tabs.depthOf(folder.id) < MAX_FOLDER_DEPTH) {
      menu.addItem((i) =>
        i
          .setTitle("New subfolder")
          .setIcon("folder-plus")
          .onClick(() => {
            this.tabs.setCollapsed(folder.id, false);
            this.tabs.addFolder(folder.id, 0);
          })
      );
    }
    if (loaded) {
      menu.addItem((i) =>
        i
          .setTitle("Close tabs in folder")
          .setIcon("x")
          .onClick(() => this.tabs.unloadFolder(folder))
      );
    }
    menu.addSeparator();
    if (folder.children.length) {
      menu.addItem((i) =>
        i
          .setTitle("Ungroup")
          .setIcon("folder-output")
          .onClick(() => this.tabs.ungroup(folder.id))
      );
    }
    menu.addItem((i) =>
      i
        .setTitle(folder.children.length ? "Delete folder and unpin tabs" : "Delete folder")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => this.tabs.deleteFolder(folder.id))
    );
  }

  private addFolderItems(menu: Menu, src: DragSource) {
    if (this.tabs.state.pinned.some((n) => n.kind === "folder")) {
      menu.addItem((i) =>
        i
          .setTitle("Move to folder…")
          .setIcon("folder-input")
          .onClick(() =>
            new FolderPicker(
              this.app,
              this.tabs.folders(),
              (parentId) => void this.tabs.move(src, this.tabs.pinnedEnd(parentId))
            ).open()
          )
      );
    }
    menu.addItem((i) =>
      i
        .setTitle("New folder with tab")
        .setIcon("folder-plus")
        .onClick(() => void this.tabs.folderAround(src))
    );
  }

  private addIconItems(menu: Menu, id: string, canReset: boolean) {
    menu.addItem((i) =>
      i
        .setTitle("Change icon…")
        .setIcon("shapes")
        .onClick(() => new IconPicker(this.app, (icon) => this.tabs.setIcon(id, icon)).open())
    );
    if (canReset) {
      menu.addItem((i) =>
        i
          .setTitle("Reset icon")
          .setIcon("eraser")
          .onClick(() => this.tabs.setIcon(id, undefined))
      );
    }
  }

  /** Let core and community plugins add their usual file actions. */
  private addFileMenu(menu: Menu, path: string | undefined, leaf: WorkspaceLeaf | undefined) {
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile)) return;
    menu.addSeparator();
    this.app.workspace.trigger("file-menu", menu, file, TABS_VIEW_TYPE, leaf);
  }

  // ── Inline rename ───────────────────────────────────────────────────

  private renameFolder(row: HTMLElement) {
    const id = row.dataset.row?.slice("folder:".length) ?? "";
    const folder = this.tabs.findFolder(id);
    if (!folder) return;
    this.startRename(row, folder.name, (name) => this.tabs.renameFolder(id, name));
  }

  private renamePin(row: HTMLElement, id: string) {
    const pin = this.tabs.findPin(id);
    if (!pin) return;
    const fallback = pin.path ? pinFileName(pin.path) : undefined;
    this.startRename(row, this.tabs.pinTitle(pin), (title) =>
      this.tabs.setPinTitle(id, title === fallback ? undefined : title)
    );
  }

  private startRename(row: HTMLElement, initial: string, commit: (value: string) => void) {
    const titleEl = row.querySelector<HTMLElement>(".zen-row-title, .zen-tile-title");
    if (!titleEl || this.renaming) return;
    this.renaming = row.dataset.row ?? null;
    const draggable = row.getAttribute("draggable");
    row.setAttr("draggable", "false");
    row.addClass("is-renaming");

    const input = createEl("input", { cls: "zen-row-rename", type: "text", value: initial });
    input.spellcheck = false;
    titleEl.after(input);
    input.focus();
    input.select();

    let done = false;
    /** Only Enter and Escape return focus to the row; blurring means focus is already going elsewhere. */
    const finish = (save: boolean, refocus: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      row.removeClass("is-renaming");
      row.setAttr("draggable", draggable);
      this.renaming = null;
      if (save && value && value !== initial) commit(value);
      else this.schedule();
      if (refocus && row.isConnected) row.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true, true);
      else if (e.key === "Escape") finish(false, true);
      else return;
      e.preventDefault();
    });
    input.addEventListener("blur", () => finish(true, false));
    for (const type of ["click", "dblclick", "mousedown"] as const) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  // ── Drag and drop ───────────────────────────────────────────────────

  private dragManager(): DragManager | null {
    return (this.app as unknown as { dragManager?: DragManager }).dragManager ?? null;
  }

  private onDragStart(e: DragEvent) {
    const hit = this.hitOf(e.target);
    if (!hit || this.renaming || !e.dataTransfer || hit.ref.kind === "space") return;
    this.peek.close(false);
    const { el, ref } = hit;
    const src: DragSource =
      ref.kind === "tab"
        ? { kind: "tab", leafId: ref.id }
        : ref.kind === "split"
          ? { kind: "split", id: ref.id }
          : { kind: "node", id: ref.id };
    const group = this.actsOnSelection(el.dataset.row ?? "") ? this.selectionSources() : null;
    this.drag = { src, row: el, group };
    // A drag carrying the selection doesn't open a split; one tab at a time does.
    this.tabs.dragging = group ? null : src;
    e.dataTransfer.effectAllowed = "all";

    // Hand the drag to Obsidian too: native ghost, edge auto-scroll, and dropping a note into an editor links it.
    const dm = this.dragManager();
    const path = this.pathOf(ref);
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    try {
      if (dm && group) {
        dm.onDragStart(e, { type: "zen-tabs-item", source: TABS_VIEW_TYPE, icon: "files", title: `${group.length} tabs` });
      } else if (dm && file instanceof TFile) dm.onDragStart(e, dm.dragFile(e, file, TABS_VIEW_TYPE));
      else if (dm) {
        const folder = ref.kind === "folder" ? this.tabs.findFolder(ref.id) : undefined;
        const titles = [...el.querySelectorAll(".zen-row-title")].map((t) => t.textContent ?? "");
        dm.onDragStart(e, {
          type: "zen-tabs-item",
          source: TABS_VIEW_TYPE,
          icon: folder ? "folder" : ref.kind === "split" ? "columns-2" : "file",
          title: folder?.name ?? titles.join(" | "),
        });
      }
    } catch (err) {
      console.error("Atlas Sidebar: could not start Obsidian drag", err);
    }

    // Changing the DOM inside dragstart can cancel the drag in Chromium, so defer the styling.
    window.setTimeout(() => {
      if (this.drag?.row !== el) return;
      this.contentEl.addClass("is-dragging");
      el.addClass("is-drag-source");
      if (group) for (const row of this.scroller.querySelectorAll(".is-selected")) row.addClass("is-drag-source");
    });
  }

  private externalSource(): DragSource | null {
    const d = this.dragManager()?.draggable;
    if (!d) return null;
    const items = d.type === "file" || d.type === "link" ? [d.file] : d.type === "files" ? (d.files ?? []) : [];
    const paths = items.filter((f): f is TFile => f instanceof TFile).map((f) => f.path);
    return paths.length ? { kind: "files", paths } : null;
  }

  private onDragOver(e: DragEvent) {
    if (this.drag && !this.drag.row.isConnected) this.endDrag();
    const src = this.drag?.src ?? this.externalSource();
    if (!src || !e.dataTransfer) return;
    this.contentEl.addClass("is-dragging");
    const group = this.drag?.group;
    const target = this.targetAt(e, src);
    const ok = target && (group ? this.tabs.canDropMany(group, target.drop) : this.tabs.canDrop(src, target.drop));
    if (!target || !ok) {
      this.clearDropFeedback();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = this.drag ? "move" : "copy";
    this.dropTarget = target.drop;
    this.showDropFeedback(target);
    this.dragManager()?.setAction(group ? groupDropLabel(group.length, target.drop) : dropLabel(src, target.drop));
  }

  private onDragLeave(e: DragEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && (this.scroller.contains(to) || this.switcherEl.contains(to))) return;
    this.clearDropFeedback();
    if (!this.drag) this.contentEl.removeClass("is-dragging");
  }

  private async onDrop(e: DragEvent) {
    const src = this.drag?.src ?? this.externalSource();
    const target = this.dropTarget;
    if (!src || !target) return this.endDrag();
    e.preventDefault();
    const group = this.drag?.group;
    this.endDrag();
    if (group) {
      this.clearSelection();
      await this.tabs.moveMany(group, target);
    } else await this.tabs.move(src, target);
  }

  private endDrag() {
    for (const row of this.scroller?.querySelectorAll(".is-drag-source") ?? []) row.removeClass("is-drag-source");
    if (this.drag) this.tabs.dragging = null;
    this.drag = null;
    this.contentEl?.removeClass("is-dragging");
    this.clearDropFeedback();
  }

  private targetAt(e: DragEvent, src: DragSource): Target | null {
    const state = this.tabs.state;
    const t = e.target as Node;
    if (this.switcherEl.contains(t)) {
      const id = spaceButtonOf(e.target);
      const button = id && id !== "add" ? this.switcherEl.querySelector<HTMLElement>(`[data-space="${CSS.escape(id)}"]`) : null;
      if (!id || !button || id === "add") return null;
      return { drop: { zone: "space", spaceId: id }, visual: { inside: button }, springSpace: id };
    }
    if (this.spaceHeaderEl.contains(t)) return null;
    const hit = this.hitOf(e.target);

    if (hit) {
      const { el, ref } = hit;
      const r = el.getBoundingClientRect();
      if (ref.kind === "ess") {
        const after = e.clientX > r.left + r.width / 2;
        const index = state.essentials.findIndex((p) => p.id === ref.id) + (after ? 1 : 0);
        return { drop: { zone: "essentials", index }, visual: { line: el, edge: after ? "right" : "left" } };
      }
      if (ref.kind === "tab" || ref.kind === "split") {
        const after = e.clientY > r.top + r.height / 2;
        const ids = ref.kind === "split" ? (this.tabs.findSplit(ref.id)?.leafIds ?? []) : [ref.id];
        const positions = ids.map((id) => state.order.indexOf(id)).filter((i) => i >= 0);
        if (!positions.length) return null;
        const index = after ? Math.max(...positions) + 1 : Math.min(...positions);
        return { drop: { zone: "tabs", index }, visual: { line: el, edge: after ? "bottom" : "top" } };
      }
      const loc = locate(state.pinned, ref.id);
      if (!loc) return null;
      const parentId = loc.parent?.id ?? null;
      const y = (e.clientY - r.top) / r.height;
      const node = loc.list[loc.index];
      if (node.kind === "folder") {
        const draggingFolder = src.kind === "node" && this.tabs.findFolder(src.id);
        const edge = draggingFolder ? 0.3 : 0.25;
        if (y < edge) return { drop: { zone: "pinned", parentId, index: loc.index }, visual: { line: el, edge: "top" } };
        if (y > 1 - edge && (node.collapsed || draggingFolder)) {
          const folderEl = el.parentElement ?? el;
          return { drop: { zone: "pinned", parentId, index: loc.index + 1 }, visual: { line: folderEl, edge: "bottom" } };
        }
        return {
          drop: { zone: "pinned", parentId: node.id, index: node.collapsed ? node.children.length : 0 },
          visual: { inside: el },
          spring: node.collapsed ? node.id : undefined,
        };
      }
      const after = y > 0.5;
      return {
        drop: { zone: "pinned", parentId, index: loc.index + (after ? 1 : 0) },
        visual: { line: el, edge: after ? "bottom" : "top" },
      };
    }

    if (this.atlasEl.contains(t)) return null;
    if (this.essentialsEl.contains(t)) {
      const last = this.essentialsEl.lastElementChild as HTMLElement | null;
      return {
        drop: { zone: "essentials", index: state.essentials.length },
        visual: last ? { line: last, edge: "right" } : { inside: this.essentialsEl },
      };
    }
    if (this.pinnedEl.contains(t) || this.separatorEl.contains(t)) {
      const last = this.pinnedEl.lastElementChild as HTMLElement | null;
      return {
        drop: { zone: "pinned", parentId: null, index: state.pinned.length },
        visual: last ? { line: last, edge: "bottom" } : { inside: this.pinnedEl },
      };
    }
    if (this.newTabEl.contains(t)) {
      return { drop: { zone: "tabs", index: 0 }, visual: { line: this.newTabEl, edge: "bottom" } };
    }
    const last = this.tabsEl.lastElementChild as HTMLElement | null;
    return {
      drop: { zone: "tabs", index: state.order.length },
      visual: { line: last ?? this.newTabEl, edge: "bottom" },
    };
  }

  private showDropFeedback(target: Target) {
    const v = target.visual;
    const inside = "inside" in v ? v.inside : null;
    if (inside !== this.insideEl) {
      this.insideEl?.removeClass("is-drop-inside");
      inside?.addClass("is-drop-inside");
      this.insideEl = inside;
    }

    if ("line" in v) {
      const s = this.scroller.getBoundingClientRect();
      const r = v.line.getBoundingClientRect();
      const top = r.top - s.top + this.scroller.scrollTop;
      const left = r.left - s.left + this.scroller.scrollLeft;
      const vertical = v.edge === "left" || v.edge === "right";
      const style = this.indicator.style;
      if (vertical) {
        const x = v.edge === "left" ? left - 3 : left + r.width + 1;
        style.transform = `translate(${x}px, ${top + 6}px)`;
        style.width = "2px";
        style.height = `${Math.max(0, r.height - 12)}px`;
      } else {
        const y = v.edge === "top" ? top - 1 : top + r.height - 1;
        style.transform = `translate(${left + 6}px, ${y}px)`;
        style.width = `${Math.max(0, r.width - 12)}px`;
        style.height = "2px";
      }
      this.indicator.toggleClass("is-vertical", vertical);
      this.indicator.addClass("is-visible");
    } else {
      this.indicator.removeClass("is-visible");
    }

    if (target.springSpace !== this.springSpace?.id) {
      if (this.springSpace) window.clearTimeout(this.springSpace.timer);
      this.springSpace = null;
      const id = target.springSpace;
      // Holding a drag on a space's icon opens that space, so the drop can land anywhere in it.
      if (id && id !== this.tabs.activeSpace().id) {
        this.springSpace = { id, timer: window.setTimeout(() => {
          this.springSpace = null;
          void this.tabs.switchSpace(id, false);
        }, SPRING_SPACE_MS) };
      }
    }
    if (target.spring !== this.spring?.folderId) {
      this.cancelSpring();
      if (target.spring) {
        const folderId = target.spring;
        this.spring = {
          folderId,
          timer: window.setTimeout(() => {
            this.spring = null;
            this.tabs.setCollapsed(folderId, false);
          }, SPRING_OPEN_MS),
        };
      }
    }
  }

  private clearDropFeedback() {
    this.dropTarget = null;
    this.indicator?.removeClass("is-visible");
    this.insideEl?.removeClass("is-drop-inside");
    this.insideEl = null;
    this.cancelSpring();
  }

  private cancelSpring() {
    if (this.spring) window.clearTimeout(this.spring.timer);
    this.spring = null;
    if (this.springSpace) window.clearTimeout(this.springSpace.timer);
    this.springSpace = null;
  }
}

function dropLabel(src: DragSource, target: DropTarget): string {
  if (target.zone === "space") return "Move to space";
  if (target.zone === "essentials") return "Add to essentials";
  if (target.zone === "tabs") {
    if (src.kind === "tab" || src.kind === "split") return "Move";
    if (src.kind === "files") return "Open in new tab";
    return "Unpin";
  }
  if (target.parentId) return "Move into folder";
  return src.kind === "node" ? "Move" : "Pin";
}

function groupDropLabel(count: number, target: DropTarget): string {
  if (target.zone === "space") return `Move ${count} tabs to space`;
  if (target.zone === "essentials") return `Add ${count} to essentials`;
  if (target.zone === "tabs") return `Move ${count} tabs`;
  return target.parentId ? `Move ${count} into folder` : `Pin ${count} tabs`;
}

/** Run `action` on click, Enter or Space, like a native button. */
function onActivate(el: HTMLElement, action: () => void) {
  el.addEventListener("click", action);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      action();
    }
  });
}

function createRow(key: string): HTMLElement {
  const row = createDiv({
    cls: "zen-row zen-flip",
    attr: { "data-row": key, role: "treeitem", tabindex: "-1", draggable: "true" },
  });
  row.createDiv({ cls: "zen-row-reset", attr: { role: "button" } });
  row.createDiv({ cls: "zen-row-icon" });
  row.createDiv({ cls: "zen-row-title" });
  setIcon(row.createDiv({ cls: "zen-row-action clickable-icon" }), "x");
  return row;
}

function createFolder(key: string): HTMLElement {
  const folder = createDiv({ cls: "zen-folder" });
  const row = folder.createDiv({
    cls: "zen-row zen-folder-row zen-flip",
    attr: { "data-row": key, role: "treeitem", tabindex: "-1", draggable: "true" },
  });
  row.appendChild(folderIcon());
  row.createDiv({ cls: "zen-row-title" });
  const close = row.createDiv({ cls: "zen-row-action clickable-icon", attr: { role: "button" } });
  setIcon(close, "x");
  srLabel(close, "Close tabs in folder");
  folder.createDiv({ cls: "zen-folder-body" }).createDiv({ cls: "zen-folder-children", attr: { role: "group" } });
  folder.createDiv({ cls: "zen-folder-peek", attr: { role: "group" } });
  return folder;
}

/** A two-layer folder: the front panel tilts open when the folder is expanded, revealing a sheet of paper. */
function folderIcon(): HTMLElement {
  const wrap = createDiv({ cls: "zen-folder-icon", attr: { "aria-hidden": "true" } });

  const back = wrap.createSvg("svg", { cls: "zen-folder-back", attr: { viewBox: "0 0 20 20" } });
  const tab =
    "M2.75 5.25a1.5 1.5 0 0 1 1.5-1.5h3.38a1.5 1.5 0 0 1 1.06.44l.88.88a1.5 1.5 0 0 0 1.06.44h5.12a1.5 1.5 0 0 1 1.5 1.5v8.24a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5z";
  back.createSvg("path", { cls: "zen-folder-back-shape", attr: { d: tab } });
  back.createSvg("rect", { cls: "zen-folder-paper", attr: { x: "5", y: "5.5", width: "10", height: "8", rx: "1" } });

  const front = wrap.createDiv({ cls: "zen-folder-front" });
  const svg = front.createSvg("svg", { attr: { viewBox: "0 0 20 20" } });
  svg.createSvg("rect", {
    cls: "zen-folder-front-shape",
    attr: { x: "2.75", y: "7.75", width: "14.5", height: "9", rx: "1.5" },
  });
  const dots = svg.createSvg("g", { cls: "zen-folder-dots" });
  for (const cx of ["7", "10", "13"]) dots.createSvg("circle", { attr: { cx, cy: "12.25", r: "0.95" } });
  front.createDiv({ cls: "zen-folder-glyph" });
  return wrap;
}

/** The space id of the switcher button under `target` ("add" for the new-space button). */
function spaceButtonOf(target: EventTarget | null): string | undefined {
  const node = target as Element | null;
  if (!node || typeof node.closest !== "function") return undefined;
  return node.closest<HTMLElement>("[data-space]")?.dataset.space;
}

function isWithin(target: EventTarget | null, selector: string): boolean {
  const node = target as Element | null;
  return !!node && typeof node.closest === "function" && !!node.closest(selector);
}

function setText(el: Element | null, text: string) {
  if (el && el.textContent !== text) el.textContent = text;
}

function setIconCached(el: HTMLElement | null, icon: string) {
  if (!el || el.dataset.icon === icon) return;
  el.dataset.icon = icon;
  setIcon(el, icon);
}

