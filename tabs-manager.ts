import {
  App,
  Events,
  Notice,
  SplitDirection,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  WorkspaceSplit,
  debounce,
} from "obsidian";
import {
  Parent,
  allTabGroups,
  applyVisibility,
  clearVisibility,
  equalize,
  homeGroup,
  isInRootSplit,
  moveToGroup,
  newPaneBefore,
  placeBeside,
  showInGroup,
  swapPanes,
  supportsSplitMoves,
  tabGroupOf,
} from "./split-layout";
import { ATLAS_COMMANDS, isAtlasLeaf, isAtlasMap } from "./atlas";
import {
  FolderColor,
  FolderNode,
  Location,
  MAX_FOLDER_DEPTH,
  PinNode,
  SPACE_ICONS,
  Space,
  TabsState,
  TreeNode,
  ancestors,
  contains,
  emptyState,
  folderHeight,
  iconForPath,
  locate,
  newSpace,
  pinFileName,
  sanitizeState,
  uid,
  walkFolders,
  walkPins,
} from "./tabs-model";

export type DragSource =
  | { kind: "tab"; leafId: string }
  | { kind: "node"; id: string }
  | { kind: "split"; id: string }
  | { kind: "files"; paths: string[] };

export type DropTarget =
  | { zone: "essentials"; index: number }
  | { zone: "pinned"; parentId: string | null; index: number }
  | { zone: "tabs"; index: number }
  | { zone: "space"; spaceId: string };

/** A drop that lands at a place in a list (anything but onto a space). */
export type PlacedTarget = Exclude<DropTarget, { zone: "space" }>;

/** A consistent view of which leaf belongs where, computed fresh for every render. */
export type Snapshot = {
  leaves: Map<string, WorkspaceLeaf>;
  /** Pin id → the open leaf it owns. */
  bound: Map<string, WorkspaceLeaf>;
  /** Leaf id → the pin that owns it. */
  owner: Map<string, PinNode>;
  unpinned: WorkspaceLeaf[];
  active: WorkspaceLeaf | null;
  /** Leaf id → the split view it belongs to. */
  splitOf: Map<string, SplitGroup>;
  /** Atlas VTT's tabs, owned by the Atlas pin while it shows. */
  atlas: WorkspaceLeaf[];
  /** Leaf id → its space; null for what every space shares (Essentials, Atlas). */
  spaceOf: Map<string, string | null>;
};

/** Tabs shown side by side as one sidebar item. Members are unpinned leaves, each in its own tab group. */
export type SplitGroup = { id: string; leafIds: string[]; direction: SplitDirection };

export const MAX_SPLIT = 4;

export type SplitSide = "left" | "right" | "top" | "bottom";

/** What the split chrome needs to draw: the panes of the split on screen and the one in focus. */
export type SplitLayoutInfo = { group: SplitGroup | null; panes: Parent[]; focused: Parent | null };

type Host = {
  app: App;
  save: () => Promise<void>;
  zenNewTab: () => boolean;
  openLauncher: () => void;
  /** The Atlas pin shows: its setting is on and Atlas VTT is enabled. */
  atlasPin: () => boolean;
};

/** Leaf ids only mean something on this device, so bindings and tab order live in vault-scoped localStorage. */
const LOCAL_KEY = "zen-sidebar-tabs";

type LocalBindings = {
  pins: Record<string, string>;
  order: string[];
  splits: SplitGroup[];
  /** Pin id → when its tab last had focus on this device. */
  opened: Record<string, number>;
  activeSpace?: string;
  /** Unpinned leaf id → the space it belongs to. */
  leafSpace: Record<string, string>;
  /** Space id → the leaf last focused there, to return to it. */
  spaceFocus: Record<string, string>;
};


type NodeLocation = Location & { zone: "essentials" | "pinned" };

export function leafId(leaf: WorkspaceLeaf): string {
  return (leaf as unknown as { id: string }).id;
}

export function leafPath(leaf: WorkspaceLeaf): string | undefined {
  const file = leaf.getViewState().state?.file;
  return typeof file === "string" ? file : undefined;
}

export function executeCommand(app: App, id: string): boolean {
  return (app as unknown as { commands: { executeCommandById: (id: string) => boolean } }).commands.executeCommandById(id);
}

/**
 * Decide where newly opened tabs appear among the unpinned tabs.
 * `kept` is the existing sidebar order; `added` are leaves opened since the last sync, oldest first.
 */
export function placeNewTabs(kept: string[], added: string[]): string[] {
  return [...kept, ...added];
}

export class TabsManager extends Events {
  state: TabsState = emptyState();
  private readonly app: App;
  private readonly requestSave;
  private lastMain: WorkspaceLeaf | null = null;
  private savedTree = "";
  private splits: SplitGroup[] = [];
  /** Members of splits that broke up, waiting to move back to the home pane. */
  private orphans: string[] = [];
  private lastRoot: WorkspaceLeaf | null = null;
  private lastAtlas: WorkspaceLeaf | null = null;
  private opened: Record<string, number> = {};
  private activeSpaceId = "";
  /** What a tabs view is dragging right now, so the main area can offer to split it in. */
  dragging: DragSource | null = null;
  private leafSpace: Record<string, string> = {};
  private spaceFocus: Record<string, string> = {};
  private repairTimer = 0;
  private layoutFrame = 0;

  constructor(private readonly host: Host) {
    super();
    this.app = host.app;
    this.requestSave = debounce(() => this.save(), 300, true);
  }

  /**
   * Load the pin tree from data.json. Bindings come from this device's storage; when reloading after
   * data.json changed on another device, keep the bindings already in memory instead.
   */
  load(raw: unknown, keepBindings = false) {
    const local: LocalBindings = keepBindings
      ? this.localBindings()
      : sanitizeLocal(this.app.loadLocalStorage(LOCAL_KEY));
    this.state = sanitizeState(raw);
    for (const pin of this.allPins()) {
      const bound = local.pins[pin.id];
      if (bound) pin.leafId = bound;
    }
    if (keepBindings || local.order.length) this.state.order = local.order;
    this.splits = local.splits;
    this.opened = local.opened;
    this.leafSpace = local.leafSpace;
    this.spaceFocus = local.spaceFocus;
    const active = this.state.spaces.find((s) => s.id === local.activeSpace) ?? this.state.spaces[0];
    this.activeSpaceId = active.id;
    this.state.pinned = active.pinned;
    // Compare against the file as written, so data.json from older versions (with leaf ids) is rewritten once.
    this.savedTree = JSON.stringify(raw ?? null);
    if (!keepBindings && JSON.stringify(this.serialize()) !== this.savedTree) this.requestSave();
  }

  /** The synced part of the state: spaces, pins and folders, without device-specific leaf ids. */
  serialize(): Pick<TabsState, "essentials" | "spaces"> {
    const stripPin = (pin: PinNode): PinNode => ({ ...pin, leafId: undefined });
    const strip = (node: TreeNode): TreeNode =>
      node.kind === "pin" ? stripPin(node) : { ...node, children: node.children.map(strip) };
    return {
      essentials: this.state.essentials.map(stripPin),
      spaces: this.state.spaces.map((space) => ({ ...space, pinned: space.pinned.map(strip) })),
    };
  }

  /** Write any pending change to disk now (used on unload). */
  flush() {
    this.requestSave.run();
  }

  /** Persist the model and redraw every tabs view. */
  commit() {
    this.requestSave();
    this.trigger("changed");
    this.scheduleLayout();
  }

  noteActive(leaf: WorkspaceLeaf | null) {
    if (!leaf || !this.isMainLeaf(leaf)) return;
    this.lastMain = leaf;
    if (isAtlasLeaf(leaf)) this.lastAtlas = leaf;
    if (!this.app.workspace.layoutReady) return;
    const snap = this.sync();
    const id = leafId(leaf);
    const space = snap.spaceOf.get(id);
    if (space) {
      this.spaceFocus[space] = id;
      // Focus that lands in another space (a link, the launcher's "Switch to tab") takes the sidebar along.
      if (space !== this.activeSpaceId) void this.switchSpace(space, false);
    }
    const pin = snap.owner.get(id);
    if (pin) this.opened[pin.id] = Date.now();
    this.requestSave();
  }

  private save() {
    this.app.saveLocalStorage(LOCAL_KEY, this.localBindings());
    const tree = JSON.stringify(this.serialize());
    if (tree === this.savedTree) return;
    this.savedTree = tree;
    void this.host.save();
  }

  private localBindings(): LocalBindings {
    const pins: Record<string, string> = {};
    for (const pin of this.allPins()) if (pin.leafId) pins[pin.id] = pin.leafId;
    return {
      pins,
      order: [...this.state.order],
      splits: this.splits.map((g) => ({ ...g, leafIds: [...g.leafIds] })),
      opened: Object.fromEntries(this.allPins().flatMap((p) => (this.opened[p.id] ? [[p.id, this.opened[p.id]]] : []))),
      activeSpace: this.activeSpaceId,
      leafSpace: { ...this.leafSpace },
      spaceFocus: { ...this.spaceFocus },
    };
  }

  // ── Reading ─────────────────────────────────────────────────────────

  /** Every pin: Essentials and the pins of every space. */
  allPins(): PinNode[] {
    return [...this.state.essentials, ...this.state.spaces.flatMap((space) => [...walkPins(space.pinned)])];
  }

  findPin(id: string): PinNode | undefined {
    return this.allPins().find((p) => p.id === id);
  }

  findFolder(id: string): FolderNode | undefined {
    for (const tree of [this.state.pinned, ...this.state.spaces.map((s) => s.pinned)]) {
      const loc = locate(tree, id);
      const node = loc?.list[loc.index];
      if (node?.kind === "folder") return node;
    }
    return undefined;
  }

  folders(): { folder: FolderNode; depth: number }[] {
    return [...walkFolders(this.state.pinned)];
  }

  isEssential(id: string): boolean {
    return this.state.essentials.some((p) => p.id === id);
  }

  /** How many folders deep a folder sits, counting the folder itself. */
  depthOf(folderId: string): number {
    return ancestors(this.state.pinned, folderId).length + 1;
  }

  sync(): Snapshot {
    const ready = this.app.workspace.layoutReady;
    const leaves = new Map<string, WorkspaceLeaf>();
    for (const leaf of this.mainLeaves()) leaves.set(leafId(leaf), leaf);

    const bound = new Map<string, WorkspaceLeaf>();
    const owner = new Map<string, PinNode>();
    const pins = this.allPins();
    let dirty = ready && this.validateSplits(leaves);
    const atlas = this.host.atlasPin() ? [...leaves.values()].filter(isAtlasLeaf) : [];
    // Atlas tabs belong to the Atlas pin: no pin, split or place in the tab list claims them.
    const atlasIds = new Set(atlas.map(leafId));
    const splitOf = new Map<string, SplitGroup>();
    for (const group of this.splits) for (const id of group.leafIds) splitOf.set(id, group);

    for (const pin of pins) {
      const leaf = pin.leafId ? leaves.get(pin.leafId) : undefined;
      // Split members are always unpinned tabs; a pin that joins a split leaves a copy behind.
      const free = !!pin.leafId && !owner.has(pin.leafId) && !splitOf.has(pin.leafId) && !atlasIds.has(pin.leafId);
      if (leaf && pin.leafId && free) {
        bound.set(pin.id, leaf);
        owner.set(pin.leafId, pin);
      } else if (pin.leafId && ready) {
        // Never unbind before the layout has loaded: the leaves just don't exist yet.
        pin.leafId = undefined;
        dirty = true;
      }
    }

    const pinSpace = this.pinSpaces();
    const spaceIds = new Set(this.state.spaces.map((s) => s.id));
    const unpinnedSpace = (id: string) => {
      const space = this.leafSpace[id];
      return space && spaceIds.has(space) ? space : this.activeSpaceId;
    };

    if (ready) {
      // An unbound pin adopts a free tab that shows its file, if the tab is in the pin's space.
      const byPath = new Map<string, WorkspaceLeaf>();
      for (const [id, leaf] of leaves) {
        const path = owner.has(id) || splitOf.has(id) || atlasIds.has(id) ? undefined : leafPath(leaf);
        if (path && !byPath.has(path)) byPath.set(path, leaf);
      }
      for (const pin of pins) {
        if (bound.has(pin.id) || !pin.path) continue;
        const leaf = byPath.get(pin.path);
        if (!leaf) continue;
        const space = pinSpace.get(pin.id);
        if (space && space !== unpinnedSpace(leafId(leaf))) continue;
        byPath.delete(pin.path);
        pin.leafId = leafId(leaf);
        bound.set(pin.id, leaf);
        owner.set(pin.leafId, pin);
        dirty = true;
      }

      const listed = (id: string) => !owner.has(id) && !atlasIds.has(id);
      const kept = this.state.order.filter((id) => leaves.has(id) && listed(id));
      const keptSet = new Set(kept);
      const added = [...leaves.keys()].filter((id) => listed(id) && !keptSet.has(id));
      const order = groupSplits(added.length ? placeNewTabs(kept, added) : kept, splitOf);
      if (!sameItems(order, this.state.order)) {
        this.state.order = order;
        dirty = true;
      }
    }

    // Every leaf belongs to a space: a pinned one to its pin's, a new one to the space that is active.
    const spaceOf = new Map<string, string | null>();
    for (const id of atlasIds) spaceOf.set(id, null);
    for (const [id, pin] of owner) spaceOf.set(id, pinSpace.get(pin.id) ?? null);
    for (const id of leaves.keys()) {
      if (spaceOf.has(id)) continue;
      const space = unpinnedSpace(id);
      if (ready && this.leafSpace[id] !== space) {
        this.leafSpace[id] = space;
        dirty = true;
      }
      spaceOf.set(id, space);
    }
    if (ready) {
      for (const id of Object.keys(this.leafSpace)) {
        if (leaves.has(id) && !owner.has(id) && !atlasIds.has(id)) continue;
        delete this.leafSpace[id];
        dirty = true;
      }
    }

    const unpinnedIds = ready
      ? this.state.order
      : [...leaves.keys()].filter((id) => !owner.has(id) && !atlasIds.has(id));
    const unpinned = unpinnedIds
      .filter((id) => spaceOf.get(id) === this.activeSpaceId)
      .map((id) => leaves.get(id))
      .filter((l): l is WorkspaceLeaf => !!l);
    if (dirty) this.requestSave();
    return { leaves, bound, owner, unpinned, active: this.activeLeaf(leaves), splitOf, atlas, spaceOf };
  }

  /** Every open leaf of the active space in sidebar order, for next/previous tab navigation. */
  visualOrder(snap: Snapshot): WorkspaceLeaf[] {
    const pinned = [...this.state.essentials, ...walkPins(this.state.pinned)]
      .map((p) => snap.bound.get(p.id))
      .filter((l): l is WorkspaceLeaf => !!l);
    return [...snap.atlas, ...pinned, ...snap.unpinned];
  }

  /** When the pin's tab last had focus here, else when its file was last edited. */
  lastUsed(pin: PinNode): number | undefined {
    if (this.opened[pin.id]) return this.opened[pin.id];
    const file = pin.path ? this.app.vault.getAbstractFileByPath(pin.path) : null;
    return file instanceof TFile ? file.stat.mtime : undefined;
  }

  pinTitle(pin: PinNode, leaf?: WorkspaceLeaf): string {
    if (leaf && this.isChanged(pin, leaf)) return leafTitle(leaf);
    if (pin.title) return pin.title;
    if (pin.path) return pinFileName(pin.path);
    return leaf ? leafTitle(leaf) : "Untitled";
  }

  pinIcon(pin: PinNode): string {
    return pin.icon ?? (pin.path ? iconForPath(pin.path) : "file");
  }

  leafIcon(leaf: WorkspaceLeaf): string {
    const path = leafPath(leaf);
    return path ? iconForPath(path) : leaf.getIcon();
  }

  /** The pin's tab has navigated away from what was pinned. */
  isChanged(pin: PinNode, leaf: WorkspaceLeaf): boolean {
    if (pin.path) return leafPath(leaf) !== pin.path;
    return leaf.getViewState().type !== pin.view?.type;
  }

  isMissing(pin: PinNode): boolean {
    return !!pin.path && !(this.app.vault.getAbstractFileByPath(pin.path) instanceof TFile);
  }

  /** The leaf is the visible tab of its tab group (another split or window), without being focused. */
  isShown(leaf: WorkspaceLeaf): boolean {
    const parent = leaf.parent as unknown as { children?: unknown[]; currentTab?: number } | undefined;
    return !!parent?.children && parent.children[parent.currentTab ?? -1] === leaf;
  }

  // ── Opening and closing ─────────────────────────────────────────────

  async focus(leaf: WorkspaceLeaf) {
    const ws = this.app.workspace;
    // Unhide the target pane first: focusing into a hidden pane silently fails.
    if (isInRootSplit(this.app, leaf)) this.applyLayout(leaf);
    await ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: true });
  }

  async open(pin: PinNode) {
    const snap = this.sync();
    const leaf = snap.bound.get(pin.id);
    if (leaf) return this.focus(leaf);
    if (this.isMissing(pin)) {
      new Notice(`“${pinFileName(pin.path ?? "")}” no longer exists.`);
      return;
    }
    const target = this.reusableLeaf(snap) ?? this.app.workspace.getLeaf("tab");
    // Bind before loading so the new tab never flashes in the unpinned list.
    pin.leafId = leafId(target);
    this.commit();
    await this.loadInto(pin, target);
    await this.focus(target);
  }

  /** Send a pinned tab that navigated elsewhere back to its pinned note. */
  async reset(pin: PinNode) {
    const leaf = this.sync().bound.get(pin.id);
    if (!leaf) return this.open(pin);
    await this.loadInto(pin, leaf);
    await this.focus(leaf);
  }

  unload(pin: PinNode) {
    this.sync().bound.get(pin.id)?.detach();
  }

  unloadFolder(folder: FolderNode) {
    const snap = this.sync();
    for (const pin of walkPins(folder.children)) snap.bound.get(pin.id)?.detach();
  }

  closeUnpinned() {
    for (const leaf of this.sync().unpinned) leaf.detach();
  }

  closeOthers(keep: WorkspaceLeaf) {
    const kept = new Set(this.splitOfLeaf(keep)?.leafIds ?? [leafId(keep)]);
    for (const leaf of this.sync().unpinned) if (!kept.has(leafId(leaf))) leaf.detach();
  }

  async newTab() {
    if (this.host.zenNewTab()) return this.host.openLauncher();
    const leaf = this.reusableLeaf(this.sync()) ?? this.app.workspace.getLeaf("tab");
    await this.focus(leaf);
  }

  /** Go back to Atlas where it was left (a scene before the dashboard), or open its dashboard. */
  async openAtlas() {
    const atlas = this.sync().atlas;
    const last = this.lastAtlas && atlas.includes(this.lastAtlas) ? this.lastAtlas : undefined;
    const target = last ?? atlas.find(isAtlasMap) ?? atlas[0];
    if (target) return this.focus(target);
    executeCommand(this.app, ATLAS_COMMANDS.dashboard);
  }

  atlasPinShown(): boolean {
    return this.host.atlasPin();
  }

  closeAtlas() {
    for (const leaf of this.sync().atlas) leaf.detach();
  }

  /** Open a file in a new tab (or the current empty one), or beside the current tab as a split view. */
  async openFile(file: TFile, split = false) {
    const snap = this.sync();
    const anchor = snap.active;
    const splittable = !!anchor && isInRootSplit(this.app, anchor) && anchor.getViewState().type !== "empty";
    if (split && anchor && splittable && !snap.atlas.includes(anchor)) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: false });
      const group = this.splitOfLeaf(anchor);
      if (!group) return this.split([anchor, leaf], "vertical", leaf);
      if (group.leafIds.length < MAX_SPLIT) return this.addToSplit(group, leaf);
      new Notice(`Split view shows up to ${MAX_SPLIT} tabs, so this opened in a new tab.`);
      return this.focus(leaf);
    }
    const leaf = this.reusableLeaf(snap) ?? this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: false });
    await this.focus(leaf);
  }

  async cycle(step: 1 | -1) {
    const snap = this.sync();
    const order = this.visualOrder(snap);
    if (order.length < 2) return;
    const at = snap.active ? order.indexOf(snap.active) : -1;
    await this.focus(order[(at + step + order.length) % order.length]);
  }

  // ── Moving things around ────────────────────────────────────────────

  canDrop(src: DragSource, target: DropTarget): boolean {
    if (target.zone === "space") {
      if (src.kind === "files") return src.paths.length > 0;
      return target.spaceId !== this.activeSpaceId && (src.kind !== "node" || !!this.where(src.id));
    }
    if (src.kind === "files") return src.paths.length > 0;
    if (src.kind === "split") return target.zone === "tabs" && !!this.findSplit(src.id);
    if (src.kind === "tab") {
      if (target.zone === "tabs") return true;
      const leaf = this.sync().leaves.get(src.leafId);
      return !!leaf && leaf.getViewState().type !== "empty";
    }
    const from = this.where(src.id);
    if (!from) return false;
    const node = from.list[from.index];
    if (node.kind === "pin") return true;
    if (target.zone !== "pinned") return false;
    if (target.parentId === null) return true;
    if (target.parentId === node.id || contains(node, target.parentId)) return false;
    return this.depthOf(target.parentId) + folderHeight(node) <= MAX_FOLDER_DEPTH;
  }

  async move(src: DragSource, target: DropTarget) {
    if (!this.canDrop(src, target)) return;
    if (target.zone === "space") {
      await this.moveToSpace(src, target.spaceId);
      return;
    }
    const snap = this.sync();

    if (src.kind === "files") return this.dropFiles(src.paths, target);

    if (src.kind === "split") {
      const group = this.findSplit(src.id);
      if (!group) return;
      let index = target.index;
      for (const id of group.leafIds) {
        const at = this.state.order.indexOf(id);
        if (at >= 0 && at < index) index--;
      }
      this.state.order = this.state.order.filter((id) => !group.leafIds.includes(id));
      this.state.order.splice(Math.max(0, Math.min(index, this.state.order.length)), 0, ...group.leafIds);
      return this.commit();
    }

    if (src.kind === "tab") {
      const leaf = snap.leaves.get(src.leafId);
      if (!leaf) return;
      // Pinning a tab takes it out of its split view first.
      if (target.zone !== "tabs" && snap.splitOf.has(src.leafId)) this.removeFromSplit(leaf);
      const path = leafPath(leaf);
      const existing = path ? this.allPins().find((p) => p.path === path) : undefined;
      if (target.zone === "tabs") {
        moveTo(this.state.order, src.leafId, target.index);
      } else if (existing) {
        // A note is pinned once: move its pin here, and let this tab take it over if it has no tab of its own.
        if (!snap.bound.has(existing.id)) {
          existing.leafId = src.leafId;
          this.removeFromOrder(src.leafId);
        }
        this.relocate(existing.id, target);
      } else {
        const pin = pinFromLeaf(leaf);
        if (!pin) return;
        this.removeFromOrder(src.leafId);
        this.listFor(target)?.splice(target.index, 0, pin);
      }
      return this.commit();
    }

    if (target.zone === "tabs") {
      const from = this.where(src.id);
      const node = from?.list[from.index];
      if (!from || node?.kind !== "pin") return;
      from.list.splice(from.index, 1);
      const leaf = snap.bound.get(node.id);
      if (leaf) moveTo(this.state.order, leafId(leaf), target.index);
      this.commit();
      if (!leaf) await this.openUnpinned(node, target.index);
      return;
    }

    this.relocate(src.id, target);
    this.commit();
  }

  /**
   * Move several tabs and pins to one place, keeping their order. Each lands just before the first item at
   * the drop point that isn't moving (or at the end of the list when nothing follows), so it follows the one
   * moved before it and earlier moves can't shift where later ones go. Items that can't go there stay put.
   */
  async moveMany(sources: DragSource[], target: DropTarget) {
    const items = this.bulkItems(sources, target);
    if (!items.length) return;
    if (target.zone === "space") {
      // Follow the tab in front only once everything has moved, or the rest would count as already there.
      let front = false;
      for (const src of items) front = (await this.moveToSpace(src, target.spaceId, false)) || front;
      if (front) await this.switchSpace(target.spaceId, false);
      return;
    }
    const ids = (): string[] =>
      target.zone === "tabs" ? this.state.order : (this.listFor(target) ?? []).map((node) => node.id);
    const moving = new Set(items.flatMap((src) => this.idsAt(src, target)));
    const anchor = ids()
      .slice(target.index)
      .find((id) => !moving.has(id));
    for (const src of items) {
      const at = anchor ? ids().indexOf(anchor) : -1;
      await this.move(src, { ...target, index: at >= 0 ? at : ids().length });
    }
  }

  canDropMany(sources: DragSource[], target: DropTarget): boolean {
    return this.bulkItems(sources, target).length > 0;
  }

  /** Gather tabs and pins into a new folder, where the first pinned one was (or at the end of pinned). */
  async folderAroundMany(sources: DragSource[]) {
    const first = this.topLevel(sources)
      .map((src) => (src.kind === "node" ? this.where(src.id) : null))
      .find((at) => at?.zone === "pinned");
    const folder = this.addFolder(first?.parent?.id ?? null, first?.index);
    if (folder) await this.moveMany(sources, { zone: "pinned", parentId: folder.id, index: 0 });
  }

  /** What actually moves: splits become their tabs when pinned, and only items that can go there. */
  private bulkItems(sources: DragSource[], target: DropTarget): DragSource[] {
    const leaves = this.sync().leaves;
    const items = this.topLevel(sources).flatMap((src): DragSource[] => {
      if (src.kind !== "split" || target.zone === "tabs" || target.zone === "space") return [src];
      return (this.findSplit(src.id)?.leafIds ?? [])
        .filter((id) => leaves.has(id))
        .map((id) => ({ kind: "tab", leafId: id }));
    });
    return items.filter((src) => this.canDrop(src, target));
  }

  /** Without duplicates, and without pins whose folder is moving with them. */
  private topLevel(sources: DragSource[]): DragSource[] {
    const key = (src: DragSource) => JSON.stringify(src);
    const nodes = new Set(sources.flatMap((src) => (src.kind === "node" ? [src.id] : [])));
    const seen = new Set<string>();
    return sources.filter((src) => {
      if (seen.has(key(src))) return false;
      seen.add(key(src));
      return src.kind !== "node" || !ancestors(this.state.pinned, src.id).some((folder) => nodes.has(folder.id));
    });
  }

  /** The ids `src` takes up in the list `target` points into, once it's there. */
  private idsAt(src: DragSource, target: PlacedTarget): string[] {
    const snap = this.sync();
    if (target.zone === "tabs") {
      if (src.kind === "tab") return [src.leafId];
      if (src.kind === "split") return this.findSplit(src.id)?.leafIds ?? [];
      const leaf = src.kind === "node" ? snap.bound.get(src.id) : undefined;
      return leaf ? [leafId(leaf)] : [];
    }
    if (src.kind === "node") return [src.id];
    if (src.kind === "tab") {
      const leaf = snap.leaves.get(src.leafId);
      const path = leaf ? leafPath(leaf) : undefined;
      const pin = path ? this.allPins().find((p) => p.path === path) : undefined;
      return pin ? [pin.id] : [];
    }
    return [];
  }

  /** The pin that owns the leaf if there is one, else the leaf as a plain tab. */
  sourceOf(leaf: WorkspaceLeaf): DragSource {
    const pin = this.sync().owner.get(leafId(leaf));
    return pin ? { kind: "node", id: pin.id } : { kind: "tab", leafId: leafId(leaf) };
  }

  /** The end of the pinned list, or of a folder's children. */
  pinnedEnd(parentId: string | null = null): DropTarget {
    const list = parentId ? this.findFolder(parentId)?.children : this.state.pinned;
    return { zone: "pinned", parentId, index: list?.length ?? 0 };
  }

  essentialsEnd(): DropTarget {
    return { zone: "essentials", index: this.state.essentials.length };
  }

  togglePin(leaf: WorkspaceLeaf) {
    const src = this.sourceOf(leaf);
    return this.move(src, src.kind === "node" ? { zone: "tabs", index: 0 } : this.pinnedEnd());
  }

  toggleEssential(leaf: WorkspaceLeaf) {
    const src = this.sourceOf(leaf);
    if (src.kind === "node" && this.isEssential(src.id)) return this.move(src, { zone: "tabs", index: 0 });
    return this.move(src, this.essentialsEnd());
  }

  // ── Spaces ──────────────────────────────────────────────────────────

  spaces(): Space[] {
    return this.state.spaces;
  }

  activeSpace(): Space {
    return this.state.spaces.find((s) => s.id === this.activeSpaceId) ?? this.state.spaces[0];
  }

  /** Show another space. With `focus`, its last used tab comes to the front (or a fresh one, if it has none). */
  async switchSpace(id: string, focus = true) {
    const target = this.state.spaces.find((s) => s.id === id);
    if (!target || id === this.activeSpaceId) return;
    const direction = this.spaceIndex(id) > this.spaceIndex(this.activeSpaceId) ? 1 : -1;
    this.activeSpaceId = id;
    this.state.pinned = target.pinned;
    this.trigger("space-switched", direction);
    this.commit();
    if (focus) await this.focusSpace(target);
  }

  /** Step through spaces; without `wrap` the first and last space are the ends (a swipe stops there). */
  async stepSpace(step: 1 | -1, wrap = true): Promise<boolean> {
    const spaces = this.state.spaces;
    let index = this.spaceIndex(this.activeSpaceId) + step;
    if (index < 0 || index >= spaces.length) {
      if (!wrap || spaces.length < 2) return false;
      index = (index + spaces.length) % spaces.length;
    }
    await this.switchSpace(spaces[index].id);
    return true;
  }

  canStepSpace(step: 1 | -1): boolean {
    const index = this.spaceIndex(this.activeSpaceId) + step;
    return index >= 0 && index < this.state.spaces.length;
  }

  async addSpace(): Promise<Space> {
    const count = this.state.spaces.length;
    const space = newSpace("New space", SPACE_ICONS[count % SPACE_ICONS.length]);
    this.state.spaces.push(space);
    await this.switchSpace(space.id);
    this.trigger("space-created", space.id);
    return space;
  }

  renameSpace(id: string, name: string) {
    const space = this.state.spaces.find((s) => s.id === id);
    if (!space || !name.trim()) return;
    space.name = name.trim();
    this.commit();
  }

  setSpaceIcon(id: string, icon: string) {
    const space = this.state.spaces.find((s) => s.id === id);
    if (!space) return;
    space.icon = icon;
    this.commit();
  }

  moveSpace(id: string, step: 1 | -1) {
    const spaces = this.state.spaces;
    const from = this.spaceIndex(id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= spaces.length) return;
    spaces.splice(to, 0, ...spaces.splice(from, 1));
    this.commit();
  }

  /** Remove a space with its pins and folders. Its open notes stay open, as tabs of the space beside it. */
  async deleteSpace(id: string) {
    const spaces = this.state.spaces;
    const index = this.spaceIndex(id);
    if (index < 0 || spaces.length < 2) return;
    const fallback = spaces[index === 0 ? 1 : index - 1];
    const snap = this.sync();
    for (const [leaf, space] of snap.spaceOf) if (space === id) this.leafSpace[leaf] = fallback.id;
    for (const pin of walkPins(spaces[index].pinned)) pin.leafId = undefined;
    spaces.splice(index, 1);
    delete this.spaceFocus[id];
    if (this.activeSpaceId === id) await this.switchSpace(fallback.id, false);
    this.commit();
  }

  /**
   * Move a tab, split, pin or folder into another space (the end of its pinned list, or its tabs). Moving the
   * tab in front takes you along, unless `follow` is off; returns whether it was the tab in front.
   */
  private async moveToSpace(src: DragSource, spaceId: string, follow = true): Promise<boolean> {
    const target = this.state.spaces.find((s) => s.id === spaceId);
    if (!target) return false;
    const snap = this.sync();
    let moved: WorkspaceLeaf[] = [];
    if (src.kind === "tab") {
      const leaf = snap.leaves.get(src.leafId);
      if (!leaf) return false;
      if (snap.splitOf.has(src.leafId)) this.removeFromSplit(leaf);
      this.leafSpace[src.leafId] = spaceId;
      moved = [leaf];
    } else if (src.kind === "split") {
      for (const id of this.findSplit(src.id)?.leafIds ?? []) {
        this.leafSpace[id] = spaceId;
        const leaf = snap.leaves.get(id);
        if (leaf) moved.push(leaf);
      }
    } else if (src.kind === "files") {
      const taken = new Set(this.allPins().map((p) => p.path));
      for (const path of src.paths) {
        if (!taken.has(path) && this.app.vault.getAbstractFileByPath(path) instanceof TFile) {
          target.pinned.push({ kind: "pin", id: uid(), path });
        }
      }
    } else {
      const from = this.where(src.id);
      if (!from) return false;
      const [node] = from.list.splice(from.index, 1);
      target.pinned.push(node);
      const pins = node.kind === "pin" ? [node] : [...walkPins(node.children)];
      moved = pins.map((p) => snap.bound.get(p.id)).filter((l): l is WorkspaceLeaf => !!l);
    }
    this.commit();
    const front = !!snap.active && moved.includes(snap.active);
    if (front && follow) await this.switchSpace(spaceId, false);
    return front;
  }

  private spaceIndex(id: string): number {
    return this.state.spaces.findIndex((s) => s.id === id);
  }

  /** Pin id → the space that holds it; Essentials belong to none. */
  private pinSpaces(): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const pin of this.state.essentials) map.set(pin.id, null);
    for (const space of this.state.spaces) for (const pin of walkPins(space.pinned)) map.set(pin.id, space.id);
    return map;
  }

  private async focusSpace(space: Space) {
    const snap = this.sync();
    const inSpace = (leaf: WorkspaceLeaf | undefined): leaf is WorkspaceLeaf =>
      !!leaf && snap.spaceOf.get(leafId(leaf)) === space.id;
    const last = snap.leaves.get(this.spaceFocus[space.id] ?? "");
    const pinned = [...walkPins(space.pinned)].map((p) => snap.bound.get(p.id)).find(inSpace);
    const target = inSpace(last) ? last : (pinned ?? snap.unpinned[0]);
    if (target) return this.focus(target);
    // An empty space gets a fresh tab, so the last space's note doesn't stay on screen.
    const leaf = this.reusableLeaf(snap) ?? this.app.workspace.getLeaf("tab");
    this.leafSpace[leafId(leaf)] = space.id;
    await this.focus(leaf);
  }

  // ── Split view ──────────────────────────────────────────────────────
  //
  // Invariant: each split member has a tab group (pane) of its own. Regular tabs live in other panes,
  // so the main area can show either the focused tab's pane or the focused split's panes, like Zen.

  findSplit(id: string): SplitGroup | undefined {
    return this.splits.find((g) => g.id === id);
  }

  splitOfLeaf(leaf: WorkspaceLeaf): SplitGroup | undefined {
    const id = leafId(leaf);
    return this.splits.find((g) => g.leafIds.includes(id));
  }

  /** Show tabs side by side as one item. A pinned tab joins as a copy, so the pin keeps its own tab. */
  async split(leaves: WorkspaceLeaf[], direction: SplitDirection = "vertical", focus?: WorkspaceLeaf) {
    if (!supportsSplitMoves(this.app)) {
      new Notice("Split view isn't available in this version of Obsidian.");
      return;
    }
    const snap = this.sync();
    const candidates = [...new Set(leaves)].filter(
      (leaf) => isInRootSplit(this.app, leaf) && leaf.getViewState().type !== "empty" && !snap.atlas.includes(leaf)
    );
    if (candidates.length < 2) {
      new Notice("Choose at least two tabs in the main window to split.");
      return;
    }
    if (candidates.length > MAX_SPLIT) new Notice(`Split view shows up to ${MAX_SPLIT} tabs.`);

    const members: WorkspaceLeaf[] = [];
    for (const leaf of candidates.slice(0, MAX_SPLIT)) {
      const member = snap.owner.has(leafId(leaf)) ? await this.duplicate(leaf) : leaf;
      if (leaf === focus) focus = member;
      this.forgetSplitMember(leafId(member));
      members.push(member);
    }
    members.slice(1).forEach((leaf, i) => placeBeside(this.app, members[i], leaf, direction));
    const group: SplitGroup = { id: uid(), leafIds: members.map(leafId), direction };
    this.splits.push(group);
    this.enforcePanes();
    equalize(members.map(tabGroupOf));
    this.commit();
    await this.showSplit(group, focus && members.includes(focus) ? focus : members[0]);
  }

  async addToSplit(group: SplitGroup, leaf: WorkspaceLeaf) {
    if (group.leafIds.includes(leafId(leaf))) return;
    if (group.leafIds.length >= MAX_SPLIT) {
      new Notice(`Split view shows up to ${MAX_SPLIT} tabs.`);
      return;
    }
    const member = this.sync().owner.has(leafId(leaf)) ? await this.duplicate(leaf) : leaf;
    // The split may have changed while the copy loaded.
    const snap = this.sync();
    const last = snap.leaves.get(group.leafIds[group.leafIds.length - 1]);
    if (!this.splits.includes(group) || !last) return;
    this.forgetSplitMember(leafId(member));
    placeBeside(this.app, last, member, group.direction);
    group.leafIds.push(leafId(member));
    this.enforcePanes();
    equalize(group.leafIds.map((id) => this.sync().leaves.get(id)).map((l) => (l ? tabGroupOf(l) : null)));
    this.commit();
    await this.showSplit(group, member);
  }

  /**
   * How many panes the main area would show after dropping a tab in: 2 when nothing is split yet, one more
   * than the split on screen, or null when nothing can be dropped (a full split, Atlas, an empty tab, the
   * dragged tab already on screen).
   */
  splitDropCount(src: DragSource): number | null {
    const snap = this.sync();
    const anchor = this.rootActive(snap);
    if (!anchor || anchor.getViewState().type === "empty" || snap.atlas.includes(anchor)) return null;
    const dragged = this.dragLeaf(src, snap);
    if (src.kind === "node" ? !this.findPin(src.id) : !dragged) return null;
    if (dragged && (dragged === anchor || snap.atlas.includes(dragged))) return null;
    const group = snap.splitOf.get(leafId(anchor));
    if (!group) return 2;
    if (dragged && group.leafIds.includes(leafId(dragged))) return null;
    return group.leafIds.length < MAX_SPLIT ? group.leafIds.length + 1 : null;
  }

  /** Drop a dragged tab or pin beside what's on screen, on `side` (Zen's drag-to-split). */
  async dropIntoSplit(src: DragSource, side: SplitSide) {
    if (this.splitDropCount(src) === null) return;
    const snap = this.sync();
    const anchor = this.rootActive(snap);
    if (!anchor) return;
    let leaf = this.dragLeaf(src, snap);
    if (!leaf && src.kind === "node") {
      // A pin that isn't open joins as a fresh tab of its note.
      const pin = this.findPin(src.id);
      if (!pin || this.isMissing(pin)) return;
      leaf = this.app.workspace.getLeaf("tab");
      await this.loadInto(pin, leaf);
    }
    if (!leaf) return;
    const direction: SplitDirection = side === "left" || side === "right" ? "vertical" : "horizontal";
    const before = side === "left" || side === "top";
    const group = snap.splitOf.get(leafId(anchor));
    if (!group) return this.split(before ? [leaf, anchor] : [anchor, leaf], direction, leaf);

    const member = snap.owner.has(leafId(leaf)) ? await this.duplicate(leaf) : leaf;
    if (snap.splitOf.has(leafId(member))) this.removeFromSplit(member);
    this.forgetSplitMember(leafId(member));
    const leaves = this.sync().leaves;
    const edge = leaves.get(before ? group.leafIds[0] : group.leafIds[group.leafIds.length - 1]);
    if (!edge || !this.splits.includes(group)) return;
    placeBeside(this.app, edge, member, direction, before);
    if (before) group.leafIds.unshift(leafId(member));
    else group.leafIds.push(leafId(member));
    this.enforcePanes();
    equalize(group.leafIds.map((id) => this.sync().leaves.get(id)).map((l) => (l ? tabGroupOf(l) : null)));
    this.commit();
    await this.showSplit(group, member);
  }

  /** Lay a split out again side by side ("vertical") or stacked ("horizontal"), keeping its order. */
  async setSplitDirection(group: SplitGroup, direction: SplitDirection) {
    if (group.direction === direction) return;
    const leaves = this.sync().leaves;
    const members = group.leafIds.map((id) => leaves.get(id)).filter((l): l is WorkspaceLeaf => !!l);
    members.slice(1).forEach((leaf, i) => placeBeside(this.app, members[i], leaf, direction));
    group.direction = direction;
    this.enforcePanes();
    equalize(members.map(tabGroupOf));
    this.commit();
    await this.showSplit(group, this.sync().active ?? undefined);
  }

  /** Swap two panes of the split on screen (dragging a pane by its handle onto another). */
  swapSplitMembers(a: string, b: string) {
    const leaves = this.sync().leaves;
    const la = leaves.get(a);
    const lb = leaves.get(b);
    const group = la ? this.splitOfLeaf(la) : undefined;
    if (!la || !lb || !group || !group.leafIds.includes(b)) return;
    const pa = tabGroupOf(la);
    const pb = tabGroupOf(lb);
    if (!pa || !pb || !swapPanes(pa, pb)) {
      new Notice("Those panes can't trade places.");
      return;
    }
    const i = group.leafIds.indexOf(a);
    const j = group.leafIds.indexOf(b);
    [group.leafIds[i], group.leafIds[j]] = [group.leafIds[j], group.leafIds[i]];
    this.commit();
  }

  private dragLeaf(src: DragSource, snap: Snapshot): WorkspaceLeaf | undefined {
    if (src.kind === "tab") return snap.leaves.get(src.leafId);
    if (src.kind === "node") {
      const pin = this.findPin(src.id);
      return pin ? snap.bound.get(pin.id) : undefined;
    }
    return undefined;
  }

  /** Bring every member of the split to the front and focus one of them. */
  async showSplit(group: SplitGroup, focus?: WorkspaceLeaf) {
    const leaves = this.sync().leaves;
    for (const id of group.leafIds) {
      const leaf = leaves.get(id);
      if (leaf) showInGroup(leaf);
    }
    const target = focus ?? leaves.get(group.leafIds[0]);
    if (target) await this.focus(target);
  }

  /** Turn the split back into regular tabs in the home pane. */
  unsplit(group: SplitGroup) {
    const leaves = this.sync().leaves;
    this.splits = this.splits.filter((g) => g !== group);
    const members = group.leafIds.map((id) => leaves.get(id)).filter((l): l is WorkspaceLeaf => !!l);
    const own = new Set(members.map(tabGroupOf));
    const home = homeGroup(this.app, new Set([...this.memberPanes().keys(), ...own])) ?? tabGroupOf(members[0]);
    if (home) for (const leaf of members) moveToGroup(leaf, home);
    this.commit();
    const active = this.sync().active;
    if (active) showInGroup(active);
  }

  removeFromSplit(leaf: WorkspaceLeaf) {
    const group = this.splitOfLeaf(leaf);
    if (!group) return;
    if (group.leafIds.length <= 2) return this.unsplit(group);
    group.leafIds = group.leafIds.filter((id) => id !== leafId(leaf));
    this.moveHome([leaf]);
    const leaves = this.sync().leaves;
    equalize(group.leafIds.map((id) => leaves.get(id)).map((l) => (l ? tabGroupOf(l) : null)));
    this.commit();
  }

  closeSplit(group: SplitGroup) {
    const leaves = this.sync().leaves;
    for (const id of group.leafIds) leaves.get(id)?.detach();
  }

  scheduleLayout() {
    if (!this.layoutFrame) {
      this.layoutFrame = window.requestAnimationFrame(() => {
        this.layoutFrame = 0;
        this.applyLayout();
      });
    }
  }

  clearLayout() {
    window.cancelAnimationFrame(this.layoutFrame);
    window.clearTimeout(this.repairTimer);
    clearVisibility(this.app);
    document.body.removeClass("zen-split-showing");
    for (const leaf of this.mainLeaves()) tabHeaderOf(leaf)?.removeClass("zen-other-space");
  }

  /**
   * Show what's in focus, Zen style: the focused split's panes alone, or the regular panes with every split
   * tucked away. `focusing` lets a caller unhide a pane before moving keyboard focus into it.
   */
  private applyLayout(focusing?: WorkspaceLeaf) {
    if (!this.app.workspace.layoutReady) return;
    this.enforcePanes();
    const snap = this.sync();
    const active = focusing ?? this.rootActive(snap);
    const showing = active ? snap.splitOf.get(leafId(active)) : undefined;
    const panes = allTabGroups(this.app);
    let hidden: Set<Parent>;
    if (showing) {
      const keep = new Set<Parent | null>();
      for (const id of showing.leafIds) {
        const leaf = snap.leaves.get(id);
        if (!leaf) continue;
        keep.add(tabGroupOf(leaf));
        showInGroup(leaf);
      }
      hidden = new Set(panes.filter((p) => !keep.has(p)));
    } else {
      hidden = new Set(this.memberPanes().keys());
      if (active) hidden.delete(tabGroupOf(active) as Parent);
    }
    if (panes.every((p) => hidden.has(p))) hidden.clear();
    applyVisibility(this.app, hidden);
    const showingPanes = (showing?.leafIds ?? [])
      .map((id) => snap.leaves.get(id))
      .map((leaf) => (leaf ? tabGroupOf(leaf) : null))
      .filter((p): p is Parent => !!p);
    const info: SplitLayoutInfo = {
      group: showing ?? null,
      panes: showingPanes,
      focused: active && showing ? tabGroupOf(active) : null,
    };
    this.trigger("split-layout", info);
    // Obsidian's own tab bar (when shown) lists only this space's tabs, too.
    for (const [id, leaf] of snap.leaves) {
      const space = snap.spaceOf.get(id);
      tabHeaderOf(leaf)?.toggleClass("zen-other-space", !!space && space !== this.activeSpaceId);
    }
    document.body.toggleClass("zen-split-showing", !!showing);
  }

  /** The focused tab in the main window. Focus in a sidebar or popout keeps the last one. */
  private rootActive(snap: Snapshot): WorkspaceLeaf | null {
    if (snap.active && isInRootSplit(this.app, snap.active)) return (this.lastRoot = snap.active);
    const last = this.lastRoot;
    return last && snap.leaves.has(leafId(last)) && isInRootSplit(this.app, last) ? last : null;
  }

  /** Pane → the split members it holds. */
  private memberPanes(): Map<Parent, WorkspaceLeaf[]> {
    const leaves = this.sync().leaves;
    const panes = new Map<Parent, WorkspaceLeaf[]>();
    for (const group of this.splits) {
      for (const id of group.leafIds) {
        const leaf = leaves.get(id);
        const pane = leaf ? tabGroupOf(leaf) : null;
        if (leaf && pane) panes.set(pane, [...(panes.get(pane) ?? []), leaf]);
      }
    }
    return panes;
  }

  /**
   * Keep the invariant: tabs that landed in a split's pane (opened while it had focus) move to the home
   * pane, which is created when no other pane exists.
   */
  private enforcePanes() {
    if (!this.splits.length) return;
    const panes = this.memberPanes();
    const strays: WorkspaceLeaf[] = [];
    for (const [pane, members] of panes) {
      for (const item of pane.children) {
        const leaf = item as unknown as WorkspaceLeaf;
        if (!members.includes(leaf)) strays.push(leaf);
      }
    }
    if (strays.length) this.moveHome(strays, panes);
  }

  /** Move tabs into the home pane, keeping the focused one focused. */
  private moveHome(leaves: WorkspaceLeaf[], panes = this.memberPanes()) {
    const ws = this.app.workspace;
    const focused = ws.activeLeaf;
    let home = homeGroup(this.app, new Set(panes.keys()));
    for (const leaf of leaves) {
      if (!home) {
        // No regular pane left: give the first stray one, next to the first split pane.
        const anchor = [...panes.values()][0]?.[0];
        if (!anchor) return;
        home = newPaneBefore(this.app, anchor, leaf);
      } else moveToGroup(leaf, home);
    }
    if (focused && leaves.includes(focused)) {
      showInGroup(focused);
      ws.setActiveLeaf(focused, { focus: true });
    }
  }

  /** Drop splits whose members closed, moved windows or ended up sharing a pane. Returns whether anything changed. */
  private validateSplits(leaves: Map<string, WorkspaceLeaf>): boolean {
    let dirty = false;
    const kept: SplitGroup[] = [];
    for (const group of this.splits) {
      const live = group.leafIds.filter((id) => {
        const leaf = leaves.get(id);
        return !!leaf && isInRootSplit(this.app, leaf);
      });
      const panes = new Set(live.map((id) => tabGroupOf(leaves.get(id) as WorkspaceLeaf)));
      if (live.length >= 2 && panes.size === live.length) {
        if (live.length !== group.leafIds.length) {
          group.leafIds = live;
          dirty = true;
        }
        kept.push(group);
        continue;
      }
      dirty = true;
      this.orphans.push(...live);
    }
    if (dirty) {
      this.splits = kept;
      if (this.orphans.length && !this.repairTimer) {
        this.repairTimer = window.setTimeout(() => this.repairOrphans());
      }
    }
    return dirty;
  }

  /** Tabs left over from a split that broke up return to the home pane. */
  private repairOrphans() {
    this.repairTimer = 0;
    const leaves = this.sync().leaves;
    const orphans = this.orphans
      .map((id) => leaves.get(id))
      .filter((l): l is WorkspaceLeaf => !!l && isInRootSplit(this.app, l) && !this.splitOfLeaf(l));
    this.orphans = [];
    const panes = this.memberPanes();
    for (const leaf of orphans) {
      const home = homeGroup(this.app, new Set([...panes.keys(), tabGroupOf(leaf)]));
      if (home) moveToGroup(leaf, home);
    }
    this.commit();
  }

  private forgetSplitMember(id: string) {
    for (const group of this.splits) group.leafIds = group.leafIds.filter((m) => m !== id);
  }

  private async duplicate(leaf: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    const pane = tabGroupOf(leaf);
    const index = pane ? pane.children.indexOf(leaf as never) + 1 : 0;
    const copy = this.app.workspace.createLeafInParent(pane as unknown as WorkspaceSplit, index);
    await copy.setViewState({ ...leaf.getViewState(), active: false });
    copy.setEphemeralState(leaf.getEphemeralState());
    return copy;
  }

  // ── Folders and labels ──────────────────────────────────────────────

  addFolder(parentId: string | null = null, index?: number): FolderNode | null {
    if (parentId && this.depthOf(parentId) + 1 > MAX_FOLDER_DEPTH) {
      new Notice(`Folders can be nested ${MAX_FOLDER_DEPTH} levels deep.`);
      return null;
    }
    const list = this.listFor({ zone: "pinned", parentId, index: 0 });
    if (!list) return null;
    const folder: FolderNode = { kind: "folder", id: uid(), name: "New folder", collapsed: false, children: [] };
    list.splice(index ?? list.length, 0, folder);
    this.commit();
    this.trigger("folder-created", folder.id);
    return folder;
  }

  /** Wrap a tab or pin in a new folder at its current place. */
  async folderAround(src: DragSource) {
    let parentId: string | null = null;
    let index: number | undefined;
    if (src.kind === "node") {
      const from = this.where(src.id);
      if (from?.zone === "pinned") {
        parentId = from.parent?.id ?? null;
        index = from.index;
      }
    }
    const folder = this.addFolder(parentId, index);
    if (folder) await this.move(src, { zone: "pinned", parentId: folder.id, index: 0 });
  }

  renameFolder(id: string, name: string) {
    const folder = this.findFolder(id);
    if (!folder || !name.trim()) return;
    folder.name = name.trim();
    this.commit();
  }

  setFolderColor(id: string, color: FolderColor | undefined) {
    const folder = this.findFolder(id);
    if (!folder) return;
    folder.color = color;
    this.commit();
  }

  setCollapsed(id: string, collapsed: boolean) {
    const folder = this.findFolder(id);
    if (!folder || folder.collapsed === collapsed) return;
    folder.collapsed = collapsed;
    this.commit();
  }

  /** Remove the folder but keep its contents in its place. */
  ungroup(id: string) {
    const loc = locate(this.state.pinned, id);
    const folder = loc?.list[loc.index];
    if (!loc || folder?.kind !== "folder") return;
    loc.list.splice(loc.index, 1, ...folder.children);
    this.commit();
  }

  /** Remove the folder and unpin everything in it. Open tabs stay open as regular tabs. */
  deleteFolder(id: string) {
    const loc = locate(this.state.pinned, id);
    if (!loc) return;
    loc.list.splice(loc.index, 1);
    this.commit();
  }

  setIcon(id: string, icon: string | undefined) {
    const node = this.findPin(id) ?? this.findFolder(id);
    if (!node) return;
    node.icon = icon;
    this.commit();
  }

  setPinTitle(id: string, title: string | undefined) {
    const pin = this.findPin(id);
    if (!pin) return;
    pin.title = title?.trim() || undefined;
    this.commit();
  }

  unpin(id: string) {
    void this.move({ kind: "node", id }, { zone: "tabs", index: 0 });
  }

  /** Keep pins pointing at files that were renamed or moved. */
  onRename(file: TAbstractFile, oldPath: string) {
    let changed = false;
    for (const pin of this.allPins()) {
      if (!pin.path) continue;
      if (pin.path === oldPath) {
        pin.path = file.path;
        changed = true;
      } else if (file instanceof TFolder && pin.path.startsWith(oldPath + "/")) {
        pin.path = file.path + pin.path.slice(oldPath.length);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private isMainLeaf(leaf: WorkspaceLeaf): boolean {
    const ws = this.app.workspace;
    const root = leaf.getRoot() as unknown;
    return root !== ws.leftSplit && root !== ws.rightSplit;
  }

  private mainLeaves(): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (this.isMainLeaf(leaf)) out.push(leaf);
    });
    return out;
  }

  private activeLeaf(leaves: Map<string, WorkspaceLeaf>): WorkspaceLeaf | null {
    const ws = this.app.workspace;
    const active = ws.activeLeaf;
    if (active && this.isMainLeaf(active)) return active;
    // Focus is in a sidebar (often this one): keep highlighting the last tab the user worked in.
    if (this.lastMain && leaves.has(leafId(this.lastMain))) return this.lastMain;
    return ws.getMostRecentLeaf();
  }

  private reusableLeaf(snap: Snapshot): WorkspaceLeaf | null {
    const leaf = snap.active;
    if (!leaf || snap.owner.has(leafId(leaf))) return null;
    return leaf.getViewState().type === "empty" ? leaf : null;
  }

  private async loadInto(pin: PinNode, leaf: WorkspaceLeaf) {
    const file = pin.path ? this.app.vault.getAbstractFileByPath(pin.path) : null;
    if (file instanceof TFile) await leaf.openFile(file, { active: false });
    else if (pin.view) await leaf.setViewState({ type: pin.view.type, state: pin.view.state, active: false });
  }

  private async openUnpinned(pin: PinNode, index: number) {
    if (this.isMissing(pin)) return;
    const leaf = this.app.workspace.getLeaf("tab");
    moveTo(this.state.order, leafId(leaf), index);
    await this.loadInto(pin, leaf);
    this.commit();
  }

  private async dropFiles(paths: string[], target: PlacedTarget) {
    const files = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
    let index = target.index;

    if (target.zone === "tabs") {
      for (const file of files) {
        const leaf = this.app.workspace.getLeaf("tab");
        moveTo(this.state.order, leafId(leaf), index++);
        await leaf.openFile(file, { active: false });
      }
      return this.commit();
    }

    for (const file of files) {
      const existing = this.allPins().find((p) => p.path === file.path);
      const node = existing ?? { kind: "pin" as const, id: uid(), path: file.path };
      if (existing) this.relocate(existing.id, { ...target, index });
      else this.listFor(target)?.splice(index, 0, node);
      index = (this.listFor(target)?.indexOf(node) ?? index) + 1;
    }
    this.commit();
  }

  /** Move a pin or folder within or between the pinned tree and essentials. */
  private relocate(id: string, target: PlacedTarget) {
    const from = this.where(id);
    const dest = this.listFor(target);
    if (!from || !dest) return;
    const node = from.list[from.index];
    let index = target.index;
    if (dest === from.list && from.index < index) index--;
    from.list.splice(from.index, 1);
    dest.splice(Math.max(0, Math.min(index, dest.length)), 0, node);
  }

  private removeFromOrder(id: string) {
    this.state.order = this.state.order.filter((o) => o !== id);
  }

  private where(id: string): NodeLocation | null {
    const index = this.state.essentials.findIndex((p) => p.id === id);
    if (index >= 0) return { list: this.state.essentials, index, parent: null, zone: "essentials" };
    const loc = locate(this.state.pinned, id);
    return loc ? { ...loc, zone: "pinned" } : null;
  }

  private listFor(target: PlacedTarget): TreeNode[] | null {
    if (target.zone === "essentials") return this.state.essentials;
    if (target.zone !== "pinned") return null;
    if (target.parentId === null) return this.state.pinned;
    return this.findFolder(target.parentId)?.children ?? null;
  }
}

function tabHeaderOf(leaf: WorkspaceLeaf): HTMLElement | undefined {
  return (leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
}

export function leafTitle(leaf: WorkspaceLeaf): string {
  return leaf.getViewState().type === "empty" ? "New tab" : leaf.getDisplayText();
}

function pinFromLeaf(leaf: WorkspaceLeaf): PinNode | null {
  const vs = leaf.getViewState();
  if (vs.type === "empty") {
    new Notice("Open a note in this tab before pinning it.");
    return null;
  }
  const path = leafPath(leaf);
  if (path) return { kind: "pin", id: uid(), path, leafId: leafId(leaf) };
  return {
    kind: "pin",
    id: uid(),
    view: { type: vs.type, state: vs.state },
    title: leaf.getDisplayText(),
    icon: leaf.getIcon(),
    leafId: leafId(leaf),
  };
}

function sanitizeLocal(raw: unknown): LocalBindings {
  const value = (typeof raw === "object" && raw ? raw : {}) as Partial<LocalBindings>;
  const pins: Record<string, string> = {};
  if (typeof value.pins === "object" && value.pins) {
    for (const [pin, leaf] of Object.entries(value.pins)) if (typeof leaf === "string") pins[pin] = leaf;
  }
  const order = Array.isArray(value.order) ? value.order.filter((id): id is string => typeof id === "string") : [];
  const splits: SplitGroup[] = [];
  for (const raw of Array.isArray(value.splits) ? value.splits : []) {
    const g = raw as Partial<SplitGroup>;
    const ids = Array.isArray(g.leafIds) ? g.leafIds.filter((id): id is string => typeof id === "string") : [];
    if (typeof g.id === "string" && ids.length >= 2) {
      splits.push({ id: g.id, leafIds: ids, direction: g.direction === "horizontal" ? "horizontal" : "vertical" });
    }
  }
  const opened: Record<string, number> = {};
  if (typeof value.opened === "object" && value.opened) {
    for (const [pin, time] of Object.entries(value.opened)) if (Number.isFinite(time)) opened[pin] = time as number;
  }
  const record = (v: unknown): Record<string, string> =>
    Object.fromEntries(
      Object.entries(typeof v === "object" && v ? v : {}).filter((e): e is [string, string] => typeof e[1] === "string")
    );
  const activeSpace = typeof value.activeSpace === "string" ? value.activeSpace : undefined;
  return { pins, order, splits, opened, activeSpace, leafSpace: record(value.leafSpace), spaceFocus: record(value.spaceFocus) };
}

/** Keep each split's members next to each other, at the position of the first one. */
function groupSplits(order: string[], splitOf: Map<string, SplitGroup>): string[] {
  const present = new Set(order);
  const placed = new Set<SplitGroup>();
  const out: string[] = [];
  for (const id of order) {
    const group = splitOf.get(id);
    if (!group) out.push(id);
    else if (!placed.has(group)) {
      placed.add(group);
      out.push(...group.leafIds.filter((m) => present.has(m)));
    }
  }
  return out;
}

function moveTo(list: string[], id: string, index: number) {
  const from = list.indexOf(id);
  if (from >= 0) {
    list.splice(from, 1);
    if (from < index) index--;
  }
  list.splice(Math.max(0, Math.min(index, list.length)), 0, id);
}

function sameItems(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
