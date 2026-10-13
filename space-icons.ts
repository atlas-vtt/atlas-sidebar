import { App, Modal, setIcon } from "obsidian";
import { srLabel } from "./a11y";
import { FANTASY_ICON_GROUPS, FantasyIcon } from "./fantasy-icons";

const ICONS = new Map<string, FantasyIcon>(FANTASY_ICON_GROUPS.flatMap((g) => g.icons).map((i) => [i.id, i]));
const COLUMNS = 8;

/** Draw a fantasy-set glyph into `el` in the current text color; a neutral icon when there's none. */
export function renderFantasyIcon(el: HTMLElement, id: string | undefined) {
  const icon = id ? ICONS.get(id) : undefined;
  const key = icon?.id ?? "";
  if (el.dataset.fantasyIcon === key && el.firstChild) return;
  el.dataset.fantasyIcon = key;
  el.empty();
  if (!icon) {
    setIcon(el, "layers");
    return;
  }
  const svg = el.createSvg("svg", { cls: "zen-fantasy-icon", attr: { viewBox: "0 0 512 512", "aria-hidden": "true" } });
  svg.createSvg("path", { attr: { d: icon.path, fill: "currentColor" } });
}

export function fantasyIconName(id: string | undefined): string | undefined {
  return id ? ICONS.get(id)?.name : undefined;
}

/** Pick a space's icon from the fantasy set, laid out like Atlas's place picker. */
export class FantasyIconPicker extends Modal {
  private buttons: { icon: FantasyIcon; el: HTMLElement }[] = [];
  private status!: HTMLElement;

  constructor(
    app: App,
    private readonly title: string,
    private readonly current: string | undefined,
    private readonly onPick: (id: string) => void
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("zen-icon-grid-modal");
    this.setTitle(this.title);
    const { contentEl } = this;
    const search = contentEl.createEl("input", {
      cls: "zen-icon-grid-search",
      type: "text",
      attr: { placeholder: "Search icons…", spellcheck: "false" },
    });
    const body = contentEl.createDiv({ cls: "zen-icon-grid-body" });
    const empty = body.createDiv({ cls: "zen-icon-grid-empty", text: "No icons match" });
    empty.hide();

    const sections: { heading: HTMLElement; grid: HTMLElement; icons: FantasyIcon[] }[] = [];
    for (const group of FANTASY_ICON_GROUPS) {
      const heading = body.createDiv({ cls: "zen-icon-grid-heading", text: group.name });
      const grid = body.createDiv({ cls: "zen-icon-grid", attr: { role: "listbox" } });
      for (const icon of group.icons) {
        const el = grid.createDiv({
          cls: "zen-icon-grid-item",
          attr: { role: "option", tabindex: "-1", "data-icon": icon.id },
        });
        renderFantasyIcon(el, icon.id);
        srLabel(el, icon.name);
        el.toggleClass("is-current", icon.id === this.current);
        el.addEventListener("click", () => this.choose(icon));
        el.addEventListener("mouseenter", () => this.describe(icon));
        el.addEventListener("focus", () => this.describe(icon));
        el.addEventListener("keydown", (e) => this.onKey(e, el));
        this.buttons.push({ icon, el });
      }
      sections.push({ heading, grid, icons: group.icons });
    }
    this.status = contentEl.createDiv({ cls: "zen-icon-grid-status" });
    this.describe(this.current ? ICONS.get(this.current) : undefined);

    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      let any = false;
      for (const section of sections) {
        let shown = 0;
        for (const { icon, el } of this.buttons.filter((b) => section.icons.includes(b.icon))) {
          const match = !query || icon.name.toLowerCase().includes(query) || icon.id.includes(query);
          el.toggle(match);
          if (match) shown++;
        }
        section.heading.toggle(shown > 0);
        section.grid.toggle(shown > 0);
        any ||= shown > 0;
      }
      empty.toggle(!any);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        const first = this.visible()[0];
        if (!first) return;
        e.preventDefault();
        if (e.key === "Enter") this.choose(first.icon);
        else first.el.focus();
      }
    });
    (this.buttons.find((b) => b.icon.id === this.current)?.el ?? search).focus();
  }

  onClose() {
    this.contentEl.empty();
  }

  private visible() {
    return this.buttons.filter((b) => b.el.isShown());
  }

  private describe(icon: FantasyIcon | undefined) {
    this.status.setText(icon ? icon.name : "");
  }

  /** Arrows move through the grid as laid out; Enter or Space picks. */
  private onKey(e: KeyboardEvent, el: HTMLElement) {
    const visible = this.visible();
    const at = visible.findIndex((b) => b.el === el);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      visible[Math.max(0, Math.min(visible.length - 1, at + step))]?.el.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (visible[at]) this.choose(visible[at].icon);
    }
  }

  private choose(icon: FantasyIcon) {
    this.close();
    this.onPick(icon.id);
  }
}

/** A small confirmation in Obsidian's own style, for deleting a space. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly message: string,
    private readonly action: string,
    private readonly onConfirm: () => void
  ) {
    super(app);
  }

  onOpen() {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const confirm = buttons.createEl("button", { cls: "mod-warning", text: this.action });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    cancel.addEventListener("click", () => this.close());
    cancel.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}
