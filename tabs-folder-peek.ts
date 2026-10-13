import { setIcon } from "obsidian";
import { srLabel } from "./a11y";
import { TabsManager } from "./tabs-manager";
import { FolderNode, PinNode, TreeNode, relativeTime } from "./tabs-model";

/** How long the pointer rests on a collapsed folder before its tabs show, as in Zen. */
const OPEN_DELAY_MS = 450;
/** Grace period for crossing the gap between the folder and the popup. */
const HIDE_DELAY_MS = 220;
const GAP_PX = 10;
const EDGE_PX = 8;

type Entry = { pin: PinNode; haystack: string; el: HTMLElement };

/**
 * Zen's folder popup: rest the pointer on a collapsed folder to see its tabs, with a search field to
 * filter them. Once something is typed it stays open until a tab is chosen, Escape, or a click elsewhere.
 */
export class FolderPeek {
  private el: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private folderId: string | null = null;
  private entries: Entry[] = [];
  private selected = -1;
  private engaged = false;
  private openTimer = 0;
  private hideTimer = 0;
  private returnFocus: HTMLElement | null = null;
  private offPress: (() => void) | null = null;

  constructor(private readonly tabs: TabsManager) {}

  get openFor(): string | null {
    return this.folderId;
  }

  /** The pointer entered a folder's header. */
  hoverFolder(row: HTMLElement, folder: FolderNode) {
    window.clearTimeout(this.hideTimer);
    if (this.folderId === folder.id) return;
    window.clearTimeout(this.openTimer);
    if (!folder.collapsed) return;
    // Moving from one open popup to the next folder shows the next one at once.
    const delay = this.el ? 0 : OPEN_DELAY_MS;
    this.openTimer = window.setTimeout(() => this.open(row, folder.id), delay);
  }

  leaveFolder() {
    window.clearTimeout(this.openTimer);
    this.scheduleHide();
  }

  close(restoreFocus = true) {
    window.clearTimeout(this.openTimer);
    window.clearTimeout(this.hideTimer);
    if (!this.el) return;
    const el = this.el;
    this.el = null;
    this.offPress?.();
    this.offPress = null;
    this.anchor?.removeClass("is-peeking");
    this.anchor = null;
    this.folderId = null;
    this.entries = [];
    this.engaged = false;
    if (restoreFocus && el.contains(el.doc.activeElement)) this.returnFocus?.focus();
    this.returnFocus = null;
    el.addClass("is-closing");
    window.setTimeout(() => el.remove(), 120);
  }

  private scheduleHide() {
    if (!this.el) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (!this.el || this.engaged) return;
      if (this.el.matches(":hover") || this.anchor?.matches(":hover")) return;
      this.close();
    }, HIDE_DELAY_MS);
  }

  private open(row: HTMLElement, folderId: string) {
    const folder = this.tabs.findFolder(folderId);
    if (!folder?.collapsed || !row.isConnected) return;
    const snap = this.tabs.sync();
    // The tab already shown under the collapsed folder is left out, as in Zen.
    const pins = pinsWithParent(folder).filter(({ pin }) => {
      const leaf = snap.bound.get(pin.id);
      return !leaf || leaf !== snap.active;
    });
    this.close(false);
    const doc = row.doc;
    this.returnFocus = doc.activeElement instanceof doc.defaultView!.HTMLElement ? (doc.activeElement as HTMLElement) : null;
    this.anchor = row;
    this.folderId = folderId;
    row.addClass("is-peeking");

    const el = (this.el = doc.body.createDiv({ cls: "zen-folder-popup", attr: { role: "dialog" } }));
    if (!pins.length) {
      // Nothing to search: say so, and how to fill it.
      el.addClass("is-empty");
      const note = el.createDiv({ cls: "zen-folder-popup-empty-state" });
      note.createDiv({ cls: "zen-folder-popup-empty-title", text: `${folder.name} is empty` });
      note.createDiv({ cls: "zen-folder-popup-empty-hint", text: "Drag tabs onto the folder to add them." });
      el.addEventListener("mouseenter", () => window.clearTimeout(this.hideTimer));
      el.addEventListener("mouseleave", () => this.scheduleHide());
      this.place(row, el);
      return;
    }
    const search = el.createDiv({ cls: "zen-folder-popup-search" });
    setIcon(search.createSpan({ cls: "zen-folder-popup-search-icon" }), "search");
    const input = search.createEl("input", {
      type: "text",
      attr: { placeholder: `Search ${folder.name}…`, spellcheck: "false" },
    });
    const clear = search.createDiv({ cls: "zen-folder-popup-clear clickable-icon", attr: { role: "button" } });
    setIcon(clear, "x");
    srLabel(clear, "Clear search");
    const list = el.createDiv({ cls: "zen-folder-popup-list", attr: { role: "listbox" } });
    const empty = el.createDiv({ cls: "zen-folder-popup-empty", text: "No tabs match" });
    empty.hide();

    this.entries = pins.map(({ pin, parent }) => {
      const leaf = snap.bound.get(pin.id);
      const title = this.tabs.pinTitle(pin, leaf);
      const item = list.createDiv({ cls: "zen-folder-popup-item", attr: { role: "option" } });
      setIcon(item.createDiv({ cls: "zen-folder-popup-icon" }), this.tabs.pinIcon(pin));
      const labels = item.createDiv({ cls: "zen-folder-popup-labels" });
      labels.createDiv({ cls: "zen-folder-popup-title", text: title });
      const used = this.tabs.lastUsed(pin);
      labels.createDiv({
        cls: "zen-folder-popup-detail",
        text: [used ? relativeTime(used) : null, parent.name].filter(Boolean).join(" • "),
      });
      item.toggleClass("is-loaded", !!leaf);
      const entry: Entry = { pin, haystack: `${title} ${pin.path ?? ""}`.toLowerCase(), el: item };
      item.addEventListener("mouseenter", () => this.select(this.entries.indexOf(entry)));
      item.addEventListener("click", () => this.choose(entry));
      return entry;
    });

    const filter = () => {
      const query = input.value.trim().toLowerCase();
      this.engaged = query.length > 0;
      clear.toggleClass("is-hidden", !query);
      let first = -1;
      this.entries.forEach((entry, i) => {
        const shown = entry.haystack.includes(query);
        entry.el.toggle(shown);
        if (shown && first < 0) first = i;
      });
      empty.toggle(first < 0);
      this.select(first);
    };
    input.addEventListener("input", filter);
    clear.addEventListener("click", () => {
      input.value = "";
      filter();
      input.focus();
    });
    input.addEventListener("keydown", (e) => this.onKey(e));
    el.addEventListener("mouseenter", () => window.clearTimeout(this.hideTimer));
    el.addEventListener("mouseleave", () => this.scheduleHide());

    // A press anywhere else closes it, without taking the press away from what it lands on.
    const onPress = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (el.contains(target) || row.contains(target))) return;
      this.close(false);
    };
    doc.addEventListener("mousedown", onPress, true);
    this.offPress = () => doc.removeEventListener("mousedown", onPress, true);

    clear.addClass("is-hidden");
    this.place(row, el);
    this.select(0);
    input.focus();
  }

  /** Beside the folder, centred on it, kept on screen; on the other side when there's no room. */
  private place(row: HTMLElement, el: HTMLElement) {
    const win = row.win;
    const r = row.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const fitsRight = r.right + GAP_PX + width <= win.innerWidth - EDGE_PX;
    const left = fitsRight ? r.right + GAP_PX : Math.max(EDGE_PX, r.left - GAP_PX - width);
    const top = Math.min(Math.max(EDGE_PX, r.top + r.height / 2 - height / 2), win.innerHeight - height - EDGE_PX);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.transformOrigin = `${fitsRight ? "left" : "right"} ${r.top + r.height / 2 - top}px`;
  }

  private onKey(e: KeyboardEvent) {
    const visible = this.entries.map((entry, i) => ({ entry, i })).filter(({ entry }) => entry.el.isShown());
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
      e.preventDefault();
      if (!visible.length) return;
      const up = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
      const at = visible.findIndex(({ i }) => i === this.selected);
      const next = (at + (up ? -1 : 1) + visible.length) % visible.length;
      this.engaged = true;
      this.select(visible[next].i, true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = this.entries[this.selected];
      if (entry?.el.isShown()) this.choose(entry);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  private select(index: number, scroll = false) {
    this.selected = index;
    this.entries.forEach((entry, i) => {
      entry.el.toggleClass("is-selected", i === index);
      entry.el.setAttr("aria-selected", i === index ? "true" : "false");
    });
    if (scroll) this.entries[index]?.el.scrollIntoView({ block: "nearest" });
  }

  private choose(entry: Entry) {
    this.close(false);
    void this.tabs.open(entry.pin);
  }
}

/** Every pin in the folder and its subfolders, with the folder that holds it. */
function pinsWithParent(folder: FolderNode): { pin: PinNode; parent: FolderNode }[] {
  const out: { pin: PinNode; parent: FolderNode }[] = [];
  const visit = (nodes: TreeNode[], parent: FolderNode) => {
    for (const node of nodes) {
      if (node.kind === "pin") out.push({ pin: node, parent });
      else visit(node.children, node);
    }
  };
  visit(folder.children, folder);
  return out;
}
