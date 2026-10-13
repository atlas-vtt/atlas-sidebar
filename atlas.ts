import { App, WorkspaceLeaf } from "obsidian";
import atlasSword from "./assets/atlas-sword.webp";

/** Atlas Sidebar is Atlas VTT's companion: these are the parts of Atlas it knows about. */
export const ATLAS_PLUGIN_ID = "atlas-vtt";
export const ATLAS_MAP_VIEW = "atlas-vtt";
export const ATLAS_DASHBOARD_VIEW = "atlas-vtt-dashboard";
export const ATLAS_ART = atlasSword;

export const ATLAS_COMMANDS = {
  dashboard: `${ATLAS_PLUGIN_ID}:open-dashboard`,
  scenes: `${ATLAS_PLUGIN_ID}:open-scene-browser`,
  playerWindow: `${ATLAS_PLUGIN_ID}:open-player-window`,
} as const;

export function atlasEnabled(app: App): boolean {
  const plugins = (app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
  return !!plugins?.enabledPlugins?.has(ATLAS_PLUGIN_ID);
}

export function isAtlasLeaf(leaf: WorkspaceLeaf): boolean {
  const type = leaf.getViewState().type;
  return type === ATLAS_MAP_VIEW || type === ATLAS_DASHBOARD_VIEW;
}

export function isAtlasMap(leaf: WorkspaceLeaf): boolean {
  return leaf.getViewState().type === ATLAS_MAP_VIEW;
}
