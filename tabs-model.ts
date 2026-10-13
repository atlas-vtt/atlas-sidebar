/** A pinned tab. File-backed pins store a vault path; other views (graph, etc.) store their view state. */
export type PinNode = {
  kind: "pin";
  id: string;
  path?: string;
  view?: { type: string; state?: Record<string, unknown> };
  /** Custom title. Falls back to the file name, or to the view's name at pin time. */
  title?: string;
  /** Custom Lucide icon id. */
  icon?: string;
  /** The leaf this pin currently owns. Obsidian restores leaf ids, so bindings survive restarts. */
  leafId?: string;
};

export type FolderColor = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple" | "pink";

export const FOLDER_COLORS: FolderColor[] = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];

export type FolderNode = {
  kind: "folder";
  id: string;
  name: string;
  icon?: string;
  color?: FolderColor;
  collapsed: boolean;
  children: TreeNode[];
};

export type TreeNode = PinNode | FolderNode;

/** A space (Zen's workspaces): its own pinned tabs and folders, and its own open tabs. Essentials are shared. */
export type Space = {
  id: string;
  name: string;
  /** Id from the fantasy icon set (fantasy-icons.ts). */
  icon?: string;
  pinned: TreeNode[];
};

export type TabsState = {
  essentials: PinNode[];
  spaces: Space[];
  /** The active space's pinned tree: the same array as that space's `pinned`, never a copy. */
  pinned: TreeNode[];
  /** Leaf ids of unpinned tabs, in sidebar order, across every space. */
  order: string[];
};

/** Icons new spaces start with, in turn. */
export const SPACE_ICONS = ["castle", "map", "tower", "forest", "village", "dungeon", "port", "mountain"];

export type Location = { list: TreeNode[]; index: number; parent: FolderNode | null };

export const MAX_FOLDER_DEPTH = 5;

export function newSpace(name: string, icon?: string): Space {
  return { id: uid(), name, icon, pinned: [] };
}

export function emptyState(): TabsState {
  const home = newSpace("Home", SPACE_ICONS[0]);
  return { essentials: [], spaces: [home], pinned: home.pinned, order: [] };
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function locate(nodes: TreeNode[], id: string, parent: FolderNode | null = null): Location | null {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.id === id) return { list: nodes, index, parent };
    if (node.kind === "folder") {
      const found = locate(node.children, id, node);
      if (found) return found;
    }
  }
  return null;
}

/** Folders from the root down to (excluding) the node with `id`. */
export function ancestors(nodes: TreeNode[], id: string): FolderNode[] {
  for (const node of nodes) {
    if (node.id === id) return [];
    if (node.kind === "folder") {
      const below = ancestors(node.children, id);
      if (below.length || node.children.some((c) => c.id === id)) return [node, ...below];
    }
  }
  return [];
}

export function* walkPins(nodes: TreeNode[]): Generator<PinNode> {
  for (const node of nodes) {
    if (node.kind === "pin") yield node;
    else yield* walkPins(node.children);
  }
}

export function* walkFolders(nodes: TreeNode[], depth = 0): Generator<{ folder: FolderNode; depth: number }> {
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    yield { folder: node, depth };
    yield* walkFolders(node.children, depth + 1);
  }
}

/** Levels of folders a node occupies: 0 for a pin, 1 for an empty folder, and so on. */
export function folderHeight(node: TreeNode): number {
  if (node.kind === "pin") return 0;
  return 1 + Math.max(0, ...node.children.map(folderHeight));
}

export function contains(folder: FolderNode, id: string): boolean {
  return folder.children.some((c) => c.id === id || (c.kind === "folder" && contains(c, id)));
}

export function pinFileName(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

const EXTENSION_ICONS: Record<string, string> = {
  md: "file-text",
  canvas: "layout-dashboard",
  base: "table",
  pdf: "file-text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  avif: "image",
  bmp: "image",
  mp3: "file-audio",
  wav: "file-audio",
  m4a: "file-audio",
  ogg: "file-audio",
  flac: "file-audio",
  webm: "file-video",
  mp4: "file-video",
  mov: "file-video",
  mkv: "file-video",
};

export function iconForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_ICONS[ext] ?? "file";
}

/** Parse persisted data defensively: drop anything malformed instead of failing to load. */
export function sanitizeState(raw: unknown): TabsState {
  const state = emptyState();
  if (!isRecord(raw)) return state;
  const seen = new Set<string>();
  if (Array.isArray(raw.essentials)) {
    for (const item of raw.essentials) {
      const pin = sanitizePin(item, seen);
      if (pin) state.essentials.push(pin);
    }
  }
  if (Array.isArray(raw.spaces)) {
    const spaces: Space[] = [];
    const ids = new Set<string>();
    for (const item of raw.spaces) {
      if (!isRecord(item) || !isString(item.id) || ids.has(item.id)) continue;
      ids.add(item.id);
      spaces.push({
        id: item.id,
        name: isString(item.name) ? item.name : "Space",
        icon: isString(item.icon) ? item.icon : undefined,
        pinned: Array.isArray(item.pinned) ? sanitizeNodes(item.pinned, seen, 0) : [],
      });
    }
    if (spaces.length) state.spaces = spaces;
  } else if (Array.isArray(raw.pinned)) {
    // Data from before spaces: everything pinned becomes the first space.
    state.spaces[0].pinned = sanitizeNodes(raw.pinned, seen, 0);
  }
  state.pinned = state.spaces[0].pinned;
  if (Array.isArray(raw.order)) state.order = [...new Set(raw.order.filter(isString))];
  return state;
}

function sanitizeNodes(items: unknown[], seen: Set<string>, depth: number): TreeNode[] {
  const out: TreeNode[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.kind === "folder") {
      if (!isString(item.id) || seen.has(item.id) || depth >= MAX_FOLDER_DEPTH) continue;
      seen.add(item.id);
      out.push({
        kind: "folder",
        id: item.id,
        name: isString(item.name) ? item.name : "Folder",
        icon: isString(item.icon) ? item.icon : undefined,
        color: FOLDER_COLORS.includes(item.color as FolderColor) ? (item.color as FolderColor) : undefined,
        collapsed: item.collapsed === true,
        children: Array.isArray(item.children) ? sanitizeNodes(item.children, seen, depth + 1) : [],
      });
    } else {
      const pin = sanitizePin(item, seen);
      if (pin) out.push(pin);
    }
  }
  return out;
}

function sanitizePin(item: unknown, seen: Set<string>): PinNode | null {
  if (!isRecord(item) || !isString(item.id) || seen.has(item.id)) return null;
  const path = isString(item.path) ? item.path : undefined;
  const view =
    isRecord(item.view) && isString(item.view.type)
      ? { type: item.view.type, state: isRecord(item.view.state) ? item.view.state : undefined }
      : undefined;
  if (!path && !view) return null;
  seen.add(item.id);
  return {
    kind: "pin",
    id: item.id,
    path,
    view: path ? undefined : view,
    title: isString(item.title) ? item.title : undefined,
    icon: isString(item.icon) ? item.icon : undefined,
    leafId: isString(item.leafId) ? item.leafId : undefined,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 months ago", "yesterday", "just now". */
export function relativeTime(time: number, now = Date.now()): string {
  const seconds = (time - now) / 1000;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of TIME_UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "just now";
}
