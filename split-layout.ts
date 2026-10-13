import { App, SplitDirection, WorkspaceLeaf, WorkspaceTabs } from "obsidian";

/**
 * Obsidian internals used to move existing leaves between tab groups. Moving (rather than recreating)
 * keeps each tab's view, scroll position and undo history.
 */
type Item = {
  parent: Parent | null;
  direction?: SplitDirection;
  containerEl: HTMLElement;
  setDimension?: (dimension: number | null) => void;
};
export type Parent = Item & {
  children: Item[];
  currentTab?: number;
  removeChild: (item: Item) => void;
  insertChild: (index: number, item: Item) => void;
  selectTab?: (leaf: WorkspaceLeaf) => void;
};
type Internals = {
  rootSplit: Parent;
  splitLeaf?: (anchor: WorkspaceLeaf, leaf: WorkspaceLeaf, direction?: SplitDirection, before?: boolean) => void;
};

const HIDDEN = "zen-split-hidden";
const LAST_VISIBLE = "zen-split-last-visible";

function internals(app: App): Internals {
  return app.workspace as unknown as Internals;
}

export function supportsSplitMoves(app: App): boolean {
  const ws = internals(app);
  return typeof ws.splitLeaf === "function" && typeof ws.rootSplit?.insertChild === "function";
}

export function tabGroupOf(leaf: WorkspaceLeaf): Parent | null {
  return (leaf.parent as unknown as Parent | null) ?? null;
}

export function isInRootSplit(app: App, leaf: WorkspaceLeaf): boolean {
  return (leaf.getRoot() as unknown) === internals(app).rootSplit;
}

/** Move an existing leaf into a new tab group beside `anchor`. Emptied tab groups remove themselves. */
export function placeBeside(
  app: App,
  anchor: WorkspaceLeaf,
  leaf: WorkspaceLeaf,
  direction: SplitDirection,
  before = false
) {
  tabGroupOf(leaf)?.removeChild(leaf as unknown as Item);
  internals(app).splitLeaf?.(anchor, leaf, direction, before);
}

/** Give `leaf` a tab group of its own just before `anchor`'s, as a sibling (no extra nesting). */
export function newPaneBefore(app: App, anchor: WorkspaceLeaf, leaf: WorkspaceLeaf): Parent | null {
  const direction = tabGroupOf(anchor)?.parent?.direction ?? "vertical";
  placeBeside(app, anchor, leaf, direction, true);
  return tabGroupOf(leaf);
}

export function moveToGroup(leaf: WorkspaceLeaf, group: Parent, index = group.children.length) {
  if ((leaf.parent as unknown) === group) return;
  tabGroupOf(leaf)?.removeChild(leaf as unknown as Item);
  group.insertChild(index, leaf as unknown as Item);
}

/** Make the leaf the visible tab of its tab group without focusing it. */
export function showInGroup(leaf: WorkspaceLeaf) {
  const group = tabGroupOf(leaf);
  if (group && group.children[group.currentTab ?? -1] !== (leaf as unknown)) group.selectTab?.(leaf);
}

/**
 * Share space evenly between a split's panes. Equal weights are enough: whatever else shares their parent
 * is hidden while the split shows.
 */
export function equalize(groups: (Parent | null)[]) {
  for (const group of groups) group?.setDimension?.(100 / Math.max(groups.length, 2));
}

/** Every tab group in the main area, in layout order. */
export function allTabGroups(app: App): Parent[] {
  const out: Parent[] = [];
  const visit = (item: Item) => {
    if (item instanceof WorkspaceTabs) out.push(item as unknown as Parent);
    else for (const child of (item as Partial<Parent>).children ?? []) visit(child);
  };
  visit(internals(app).rootSplit);
  return out;
}

/** The tab group holding the most tabs, outside `exclude`: where regular tabs live while splits exist. */
export function homeGroup(app: App, exclude: Set<Parent | null>): Parent | null {
  let best: Parent | null = null;
  for (const group of allTabGroups(app)) {
    if (!exclude.has(group) && (!best || group.children.length > best.children.length)) best = group;
  }
  return best;
}

/**
 * Hide tab groups so the main area shows one thing at a time, like Zen: the focused tab, or the split it
 * belongs to. Splits that become empty are hidden too, and the last visible pane drops its resize handle.
 */
export function applyVisibility(app: App, hidden: Set<Parent>) {
  const root = internals(app).rootSplit;
  const visit = (item: Item): boolean => {
    let isHidden: boolean;
    if (item instanceof WorkspaceTabs) {
      isHidden = hidden.has(item as unknown as Parent);
    } else {
      const children = (item as Parent).children ?? [];
      const states = children.map(visit);
      isHidden = states.length > 0 && states.every(Boolean);
      const last = states.lastIndexOf(false);
      children.forEach((child, i) => child.containerEl.toggleClass(LAST_VISIBLE, i === last && i < children.length - 1));
    }
    if (item !== root) item.containerEl.toggleClass(HIDDEN, isHidden);
    return isHidden;
  };
  visit(root);
}

export function clearVisibility(app: App) {
  applyVisibility(app, new Set());
}

/** The element holding the main area's panes. */
export function rootSplitEl(app: App): HTMLElement {
  return internals(app).rootSplit.containerEl;
}

/** Swap two panes that share a parent split, keeping each pane (and its tabs and size) whole. */
export function swapPanes(a: Parent, b: Parent): boolean {
  const parent = a.parent;
  if (!parent || parent !== b.parent || a === b) return false;
  const i = parent.children.indexOf(a);
  const j = parent.children.indexOf(b);
  const [first, second] = i < j ? [a, b] : [b, a];
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  parent.removeChild(second);
  parent.insertChild(lo, second);
  parent.removeChild(first);
  parent.insertChild(hi, first);
  return true;
}
