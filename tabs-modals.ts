import { App, FuzzyMatch, FuzzySuggestModal, SuggestModal, getIconIds, setIcon } from "obsidian";
import { FOLDER_COLORS, FolderColor, FolderNode, Space } from "./tabs-model";
import { renderFantasyIcon } from "./space-icons";

type ColorChoice = { color: FolderColor | undefined; label: string };

export class ColorPicker extends SuggestModal<ColorChoice> {
  constructor(
    app: App,
    private readonly current: FolderColor | undefined,
    private readonly onPick: (color: FolderColor | undefined) => void
  ) {
    super(app);
    this.setPlaceholder("Folder color…");
  }

  getSuggestions(query: string): ColorChoice[] {
    const all: ColorChoice[] = [
      { color: undefined, label: "Accent" },
      ...FOLDER_COLORS.map((color) => ({ color, label: color[0].toUpperCase() + color.slice(1) })),
    ];
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
  }

  renderSuggestion(choice: ColorChoice, el: HTMLElement) {
    el.addClass("zen-color-suggestion");
    const swatch = el.createSpan({ cls: "zen-color-swatch" });
    swatch.style.setProperty("--zt-swatch", choice.color ? `var(--color-${choice.color})` : "var(--interactive-accent)");
    el.createSpan({ text: choice.label });
    if (choice.color === this.current) setIcon(el.createSpan({ cls: "zen-color-check" }), "check");
  }

  onChooseSuggestion(choice: ColorChoice) {
    this.onPick(choice.color);
  }
}

export class IconPicker extends FuzzySuggestModal<string> {
  constructor(app: App, private readonly onPick: (icon: string) => void) {
    super(app);
    this.setPlaceholder("Search icons…");
    this.modalEl.addClass("zen-icon-picker");
  }

  getItems(): string[] {
    return getIconIds();
  }

  getItemText(icon: string): string {
    return icon.replace(/^lucide-/, "").replace(/-/g, " ");
  }

  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement) {
    el.addClass("zen-icon-suggestion");
    setIcon(el.createSpan({ cls: "zen-icon-suggestion-icon" }), match.item);
    el.createSpan({ text: this.getItemText(match.item) });
  }

  onChooseItem(icon: string) {
    this.onPick(icon);
  }
}

type FolderChoice = { id: string | null; label: string };

export class FolderPicker extends FuzzySuggestModal<FolderChoice> {
  constructor(
    app: App,
    private readonly folders: { folder: FolderNode; depth: number }[],
    private readonly onPick: (folderId: string | null) => void
  ) {
    super(app);
    this.setPlaceholder("Move to folder…");
  }

  getItems(): FolderChoice[] {
    const trail: string[] = [];
    const items: FolderChoice[] = [{ id: null, label: "Pinned (no folder)" }];
    for (const { folder, depth } of this.folders) {
      trail.length = depth;
      trail.push(folder.name);
      items.push({ id: folder.id, label: trail.join(" / ") });
    }
    return items;
  }

  getItemText(item: FolderChoice): string {
    return item.label;
  }

  onChooseItem(item: FolderChoice) {
    this.onPick(item.id);
  }
}

/** Pick a space (to move a tab into), each shown with its icon. */
export class SpacePicker extends FuzzySuggestModal<Space> {
  constructor(
    app: App,
    private readonly spaces: Space[],
    private readonly onPick: (space: Space) => void
  ) {
    super(app);
    this.setPlaceholder("Move to space…");
  }

  getItems(): Space[] {
    return this.spaces;
  }

  getItemText(space: Space): string {
    return space.name;
  }

  renderSuggestion(match: FuzzyMatch<Space>, el: HTMLElement) {
    el.addClass("zen-icon-suggestion");
    renderFantasyIcon(el.createSpan({ cls: "zen-icon-suggestion-icon" }), match.item.icon);
    el.createSpan({ text: match.item.name });
  }

  onChooseItem(space: Space) {
    this.onPick(space);
  }
}
