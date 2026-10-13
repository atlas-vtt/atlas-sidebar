import {
  App,
  Command,
  Notice,
  SearchResult,
  SuggestModal,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  prepareFuzzySearch,
  renderResults,
  setIcon,
} from "obsidian";
import { TabsManager, executeCommand, leafPath } from "./tabs-manager";
import { iconForPath } from "./tabs-model";

export type LauncherMode = "open" | "split";

type CreatableType = { ext: string; label: string; icon: string };

/** File types the launcher can create, offered only when Obsidian can create them (Canvas and Bases are core plugins). */
const CREATABLE: CreatableType[] = [
  { ext: "md", label: "note", icon: "file-plus" },
  { ext: "canvas", label: "canvas", icon: "layout-dashboard" },
  { ext: "base", label: "base", icon: "table" },
];

type Item =
  | { kind: "file"; file: TFile; leaf?: WorkspaceLeaf; match: SearchResult | null; onPath: boolean }
  | { kind: "create"; type: CreatableType; name: string }
  | { kind: "command"; command: Command; match: SearchResult | null };

const MAX_RESULTS = 40;
const RECENT_COUNT = 12;
/** Characters Obsidian won't allow in file names. */
const ILLEGAL_NAME = /[\\:*?"<>|#^[\]]/;

/**
 * Zen's floating address bar, for notes: search the vault, switch to an open tab, create a note, canvas or
 * base, or type ">" to run a command. Shift+Enter opens the result in split view.
 */
export class Launcher extends SuggestModal<Item> {
  constructor(
    app: App,
    private readonly tabs: TabsManager,
    private readonly mode: LauncherMode = "open"
  ) {
    super(app);
    this.limit = MAX_RESULTS;
    this.emptyStateText = "No matching notes.";
    this.modalEl.addClass("zen-launcher");
    this.containerEl.addClass("zen-launcher-container");
    this.setPlaceholder(mode === "split" ? "Open in split view…" : "Search notes, or type a name to create one…");
    const searchIcon = createDiv({ cls: "zen-launcher-search-icon" });
    setIcon(searchIcon, "search");
    this.inputEl.before(searchIcon);

    const instructions = [
      { command: "↵", purpose: mode === "split" ? "open in split view" : "open" },
      { command: "esc", purpose: "close" },
      { command: ">", purpose: "commands" },
    ];
    if (mode === "open") instructions.splice(1, 0, { command: "⇧ ↵", purpose: "open in split view" });
    this.setInstructions(instructions);
    this.scope.register(["Shift"], "Enter", (e) => {
      this.selectActiveSuggestion(e);
      return false;
    });
  }

  getSuggestions(input: string): Item[] {
    const query = input.trim();
    if (query.startsWith(">")) return this.commands(query.slice(1).trim());
    if (!query) return this.recent();

    const openLeaves = this.openLeaves();
    const fuzzy = prepareFuzzySearch(query);
    const files: (Item & { kind: "file"; score: number })[] = [];
    for (const file of this.app.vault.getFiles()) {
      const onName = fuzzy(file.basename);
      const onPath = onName ? null : fuzzy(file.path);
      const match = onName ?? onPath;
      if (!match) continue;
      // Name matches rank above path matches.
      files.push({
        kind: "file",
        file,
        leaf: openLeaves.get(file.path),
        match,
        onPath: !onName,
        score: match.score + (onName ? 1 : 0),
      });
    }
    files.sort((a, b) => b.score - a.score);
    const results: Item[] = files.slice(0, MAX_RESULTS);

    const create = this.creatable(query);
    // When nothing really contains the text, the user is most likely naming something new.
    const lower = query.toLowerCase();
    const literal = files.some((f) => f.file.basename.toLowerCase().includes(lower));
    return literal ? [...results, ...create] : [...create, ...results];
  }

  renderSuggestion(item: Item, el: HTMLElement) {
    el.addClass("zen-launcher-item");
    const icon = el.createDiv({ cls: "zen-launcher-icon" });
    const text = el.createDiv({ cls: "zen-launcher-text" });
    const title = text.createDiv({ cls: "zen-launcher-title" });
    let action = this.mode === "split" ? "Split" : "Open";

    if (item.kind === "file") {
      setIcon(icon, iconForPath(item.file.path));
      if (item.match && !item.onPath) renderResults(title, item.file.basename, item.match);
      else title.setText(item.file.basename);
      const folder = item.file.parent && !item.file.parent.isRoot() ? item.file.parent.path : "";
      const ext = item.file.extension === "md" ? "" : item.file.extension;
      const detail = [folder, ext].filter(Boolean).join(" · ");
      if (item.match && item.onPath) renderResults(text.createDiv({ cls: "zen-launcher-path" }), item.file.path, item.match);
      else if (detail) text.createDiv({ cls: "zen-launcher-path", text: detail });
      if (item.leaf && this.mode === "open") action = "Switch to tab";
    } else if (item.kind === "create") {
      el.addClass("is-create");
      setIcon(icon, item.type.icon);
      title.appendText(`Create ${item.type.label} `);
      title.createSpan({ cls: "zen-launcher-quote", text: `“${item.name}”` });
      text.createDiv({ cls: "zen-launcher-path", text: this.targetFolderLabel(item.name) });
      action = "Create";
    } else {
      setIcon(icon, item.command.icon ?? "terminal");
      if (item.match) renderResults(title, item.command.name, item.match);
      else title.setText(item.command.name);
      action = "Run";
    }
    el.createDiv({ cls: "zen-launcher-action", text: action });
  }

  async onChooseSuggestion(item: Item, evt: MouseEvent | KeyboardEvent) {
    const split = this.mode === "split" || evt.shiftKey;
    try {
      if (item.kind === "command") executeCommand(this.app, item.command.id);
      else if (item.kind === "file") {
        if (item.leaf && !split) await this.tabs.focus(item.leaf);
        else await this.tabs.openFile(item.file, split);
      } else {
        await this.tabs.openFile(await this.create(item.type, item.name), split);
      }
    } catch (err) {
      const what = item.kind === "create" ? `create “${item.name}”` : "open that";
      new Notice(`Couldn't ${what}: ${(err as Error).message}`);
    }
  }

  private recent(): Item[] {
    const openLeaves = this.openLeaves();
    const items: Item[] = [];
    for (const path of this.app.workspace.getLastOpenFiles()) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) items.push({ kind: "file", file, leaf: openLeaves.get(path), match: null, onPath: false });
      if (items.length >= RECENT_COUNT) break;
    }
    return items;
  }

  private commands(query: string): Item[] {
    const all = (this.app as unknown as { commands: { listCommands: () => Command[] } }).commands.listCommands();
    if (!query) return all.slice(0, MAX_RESULTS).map((command) => ({ kind: "command", command, match: null }));
    const fuzzy = prepareFuzzySearch(query);
    return all
      .map((command) => ({ command, match: fuzzy(command.name) }))
      .filter((c): c is { command: Command; match: SearchResult } => !!c.match)
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, MAX_RESULTS)
      .map(({ command, match }) => ({ kind: "command", command, match }));
  }

  /** "Create …" rows for a typed name, unless a file with that exact name already exists. */
  private creatable(query: string): Item[] {
    const fileManager = this.app.fileManager as unknown as { canCreateFileWithExt?: (ext: string) => boolean };
    const typed = CREATABLE.find((t) => query.toLowerCase().endsWith(`.${t.ext}`));
    const name = typed ? query.slice(0, -(typed.ext.length + 1)).trim() : query;
    const segments = name.split("/").map((part) => part.trim());
    const valid = segments.every((part) => part && part !== "." && part !== ".." && !ILLEGAL_NAME.test(part));
    if (!valid) return [];
    return CREATABLE.filter((type) => (typed ? type === typed : true))
      .filter((type) => type.ext === "md" || fileManager.canCreateFileWithExt?.(type.ext))
      .filter((type) => !this.app.vault.getAbstractFileByPath(this.targetPath(name, type.ext)))
      .map((type) => ({ kind: "create", type, name }));
  }

  /** Names with a slash are vault paths; plain names go where Obsidian puts new notes. */
  private targetPath(name: string, ext: string): string {
    if (name.includes("/")) return normalizePath(`${name}.${ext}`);
    const folder = this.defaultFolder();
    return normalizePath(`${folder.isRoot() ? "" : folder.path + "/"}${name}.${ext}`);
  }

  private targetFolderLabel(name: string): string {
    const path = this.targetPath(name, "md");
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return folder ? `in ${folder}` : "in vault root";
  }

  private defaultFolder() {
    return this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
  }

  private async create(type: CreatableType, name: string): Promise<TFile> {
    const fileManager = this.app.fileManager as unknown as {
      createNewFile?: (folder: unknown, name: string, ext: string, content?: string) => Promise<TFile>;
    };
    const root = this.app.vault.getRoot();
    if (fileManager.createNewFile) {
      return name.includes("/")
        ? fileManager.createNewFile(root, name, type.ext)
        : fileManager.createNewFile(this.defaultFolder(), name, type.ext);
    }
    return this.app.vault.create(this.targetPath(name, type.ext), "");
  }

  private openLeaves(): Map<string, WorkspaceLeaf> {
    const byPath = new Map<string, WorkspaceLeaf>();
    for (const leaf of this.tabs.sync().leaves.values()) {
      const path = leafPath(leaf);
      if (path && !byPath.has(path)) byPath.set(path, leaf);
    }
    return byPath;
  }
}
