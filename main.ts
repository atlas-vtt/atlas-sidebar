import {
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  WorkspaceLeaf,
  WorkspaceSplit,
  setIcon,
} from "obsidian";
import { srLabel } from "./a11y";
import { TabsView, TABS_VIEW_TYPE } from "./tabs-view";
import { TabsManager } from "./tabs-manager";
import { Launcher, LauncherMode } from "./tabs-launcher";
import { atlasEnabled } from "./atlas";
import { SplitChrome } from "./split-chrome";
import { SplitLayoutInfo } from "./tabs-manager";
import { FolderPicker, SpacePicker } from "./tabs-modals";
import { FantasyIconPicker } from "./space-icons";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Prec } from "@codemirror/state";

/** View type of the Git sync tab earlier versions had; leftover tabs of it are closed at startup. */
const RETIRED_SYNC_VIEW = "zen-sync";

interface ZenSettings {
  // Sidebar layout
  tabHeaderBottom: boolean;
  tabHeaderRightAlign: boolean;
  splitTabHeader: boolean;
  roomySidebar: boolean;
  showTreeLines: boolean;
  defaultLeftSidebarTabs: boolean;
  // Vertical tabs
  zenNewTab: boolean;
  atlasPin: boolean;
  /** The Tabs view has been placed once; after that its position and visibility are the user's. */
  // Sidebar header
  dailyNoteButton: boolean;
  showFilesTab: boolean;
  showSearchTab: boolean;
  showNewTab: boolean;
  showTabList: boolean;
  showSidebarToggle: boolean;
  showFileNavHeader: boolean;
  // Window chrome
  showRootTabBar: boolean;
  showRibbon: boolean;
  showViewHeader: boolean;
  showTrafficLights: boolean;
  showStatusBar: boolean;
  showVaultName: boolean;
  showScrollbars: boolean;
  showTooltips: boolean;
  // Editor
  highlightActiveLine: boolean;
  showPropertiesReading: boolean;
  scrollOffsetEnabled: boolean;
  scrollOffsetPercentage: boolean;
  scrollOffsetValue: string;
  // Search & modals
  showSearchSuggestions: boolean;
  showSearchCounts: boolean;
  showModalInstructions: boolean;
}

const DEFAULT_SETTINGS: ZenSettings = {
  tabHeaderBottom: true,
  tabHeaderRightAlign: true,
  splitTabHeader: false,
  roomySidebar: true,
  showTreeLines: false,
  defaultLeftSidebarTabs: false,
  zenNewTab: true,
  atlasPin: true,
  dailyNoteButton: true,
  showFilesTab: true,
  showSearchTab: true,
  showNewTab: true,
  showTabList: true,
  showSidebarToggle: true,
  showFileNavHeader: true,
  showRootTabBar: false,
  showRibbon: false,
  showViewHeader: true,
  showTrafficLights: false,
  showStatusBar: false,
  showVaultName: false,
  showScrollbars: false,
  showTooltips: true,
  highlightActiveLine: true,
  showPropertiesReading: false,
  scrollOffsetEnabled: true,
  scrollOffsetPercentage: true,
  scrollOffsetValue: "25",
  showSearchSuggestions: false,
  showSearchCounts: true,
  showModalInstructions: true,
};

type Group =
  | "Sidebar tabs"
  | "Vertical tabs"
  | "Sidebar buttons"
  | "Sidebar layout"
  | "Window"
  | "Editor"
  | "Search & modals";

type ToggleDef = {
  key: keyof ZenSettings;
  name: string;
  desc: string;
  group: Group;
  /** CSS class added to body when the rule fires. Omit for non-visual settings. */
  className?: string;
  /** "on" = add class when setting is true; "off" = add class when setting is false */
  when?: "on" | "off";
  /** Rendered by a custom control instead of a toggle. */
  custom?: true;
};

const TOGGLES: ToggleDef[] = [
  // Sidebar tabs
  { key: "showFilesTab", name: "Files", desc: "File explorer tab.", group: "Sidebar tabs" },
  { key: "showSearchTab", name: "Search", desc: "Search tab.", group: "Sidebar tabs" },
  {
    key: "defaultLeftSidebarTabs",
    name: "Remove other tabs on startup",
    desc: "Close any sidebar tab not enabled above. You can still open others manually.",
    group: "Sidebar tabs",
  },
  // Vertical tabs
  {
    key: "atlasPin",
    name: "Atlas pin",
    desc: "Keep Atlas VTT pinned across the top of the tabs sidebar, holding its map and dashboard tabs. Shown while the Atlas VTT plugin is enabled.",
    group: "Vertical tabs",
  },
  {
    key: "zenNewTab",
    name: "Launcher on new tab",
    desc: "Ctrl/Cmd+T and New tab open a floating search to find, open or create notes, like a browser's address bar.",
    group: "Vertical tabs",
  },
  // Sidebar buttons
  {
    key: "dailyNoteButton",
    name: "Daily note",
    desc: "Opens today's daily note. Requires the core Daily notes plugin.",
    group: "Sidebar buttons",
  },
  {
    key: "showNewTab",
    className: "zen-hide-new-tab",
    when: "off",
    name: "New tab (+)",
    desc: "Adds a tab to the sidebar.",
    group: "Sidebar buttons",
  },
  {
    key: "showTabList",
    className: "zen-hide-tab-list",
    when: "off",
    name: "Tab list",
    desc: "Dropdown listing all sidebar tabs.",
    group: "Sidebar buttons",
  },
  {
    key: "showSidebarToggle",
    className: "zen-hide-sidebar-toggle",
    when: "off",
    name: "Sidebar toggle",
    desc: "Collapses and expands the sidebars.",
    group: "Sidebar buttons",
  },
  {
    key: "showFileNavHeader",
    className: "zen-hide-file-nav-header",
    when: "off",
    name: "File explorer actions",
    desc: "New note, new folder and sort buttons above the file tree.",
    group: "Sidebar buttons",
  },
  // Sidebar layout
  {
    key: "tabHeaderBottom",
    className: "zen-tab-header-bottom",
    when: "on",
    name: "",
    desc: "",
    group: "Sidebar layout",
    custom: true,
  },
  {
    key: "splitTabHeader",
    className: "zen-split-tab-header",
    when: "on",
    name: "",
    desc: "",
    group: "Sidebar layout",
    custom: true,
  },
  {
    key: "tabHeaderRightAlign",
    className: "zen-tab-header-right",
    when: "on",
    name: "Right-align tab bar",
    desc: "Push tabs and buttons to the right edge.",
    group: "Sidebar layout",
  },
  {
    key: "roomySidebar",
    className: "zen-roomy-sidebar",
    when: "on",
    name: "Roomy file tree",
    desc: "Extra padding between files and folders.",
    group: "Sidebar layout",
  },
  {
    key: "showTreeLines",
    className: "zen-hide-tree-lines",
    when: "off",
    name: "Indent lines",
    desc: "Vertical guide lines for nested folders.",
    group: "Sidebar layout",
  },
  // Window
  {
    key: "showRootTabBar",
    className: "zen-hide-root-tabs",
    when: "off",
    name: "Editor tab bar",
    desc: "Tabs above the main editor.",
    group: "Window",
  },
  {
    key: "showRibbon",
    name: "Ribbon",
    desc: "Icon strip on the far left. Same as Appearance → Show ribbon.",
    group: "Window",
  },
  {
    key: "showViewHeader",
    name: "Note title bar",
    desc: "Bar above each note with its title. It's also where you drag the window; when off, drag by the empty part of a sidebar tab bar instead.",
    group: "Window",
  },
  {
    key: "showTrafficLights",
    className: "zen-hide-traffic-lights",
    when: "off",
    name: "Window buttons",
    desc: "Close, minimize and zoom buttons on macOS. When off, use Cmd+W and Cmd+Q.",
    group: "Window",
  },
  {
    key: "showStatusBar",
    className: "zen-hide-status-bar",
    when: "off",
    name: "Status bar",
    desc: "Word count and plugin info at the bottom of the window.",
    group: "Window",
  },
  {
    key: "showVaultName",
    className: "zen-hide-vault-name",
    when: "off",
    name: "Vault name",
    desc: "Vault switcher and settings icons. When off, use hotkeys or the command palette.",
    group: "Window",
  },
  {
    key: "showScrollbars",
    className: "zen-hide-scrollbars",
    when: "off",
    name: "Scrollbars",
    desc: "All scrollbars across the app.",
    group: "Window",
  },
  {
    key: "showTooltips",
    className: "zen-hide-tooltips",
    when: "off",
    name: "Tooltips",
    desc: "Hover labels on icons and buttons.",
    group: "Window",
  },
  // Editor
  {
    key: "highlightActiveLine",
    className: "zen-no-line-highlight",
    when: "off",
    name: "Current line highlight",
    desc: "Tint the line with the cursor.",
    group: "Editor",
  },
  {
    key: "showPropertiesReading",
    className: "zen-hide-properties-reading",
    when: "off",
    name: "Properties in reading view",
    desc: "Frontmatter block at the top of notes in reading mode.",
    group: "Editor",
  },
  {
    key: "scrollOffsetEnabled",
    name: "Typewriter scrolling",
    desc: "Keep the cursor away from the top and bottom edges.",
    group: "Editor",
  },
  // Search & modals
  {
    key: "showSearchSuggestions",
    className: "zen-hide-search-suggestions",
    when: "off",
    name: "Search suggestions",
    desc: "Popover under the search input.",
    group: "Search & modals",
  },
  {
    key: "showSearchCounts",
    className: "zen-hide-search-counts",
    when: "off",
    name: "Match counts",
    desc: "Number of matches per search result.",
    group: "Search & modals",
  },
  {
    key: "showModalInstructions",
    className: "zen-hide-modal-instructions",
    when: "off",
    name: "Modal hints",
    desc: "Keyboard hint row at the bottom of the command palette and other modals.",
    group: "Search & modals",
  },
];

const GROUP_ORDER: Group[] = [
  "Sidebar tabs",
  "Vertical tabs",
  "Sidebar buttons",
  "Sidebar layout",
  "Window",
  "Editor",
  "Search & modals",
];

export default class ObsidianZenPlugin extends Plugin {
  declare settings: ZenSettings;
  declare tabs: TabsManager;
  private placingTabsView = false;

  async onload() {
    this.tabs = new TabsManager({
      app: this.app,
      save: () => this.persist(),
      zenNewTab: () => this.settings.zenNewTab,
      openLauncher: () => this.openLauncher(),
      atlasPin: () => this.settings.atlasPin && atlasEnabled(this.app),
    });
    await this.loadSettings();
    this.applyAll();
    this.addSettingTab(new ZenSettingTab(this.app, this));
    this.registerView(TABS_VIEW_TYPE, (leaf) => new TabsView(leaf, this.tabs));
    this.registerTabCommands();
    this.takeOverNewTabCommand();
    this.registerSplitChrome();

    this.registerEditorExtension(buildScrollOffsetExtension(this));

    this.addCommand({
      id: "zenmode-toggle",
      name: "Zenmode toggle",
      callback: () => this.toggleZenMode(),
    });

    this.app.workspace.onLayoutReady(() => {
      this.removeRetiredViews();
      if (this.settings.defaultLeftSidebarTabs) {
        void this.ensureDefaultSidebarTabs();
      } else {
        void this.showTabsViewAtStartup();
      }
      this.refreshDailyNoteButtons();
    });

    this.registerEvent(
      this.app.workspace.on("window-open", (_w, win) => {
        setWindowButtons(win, this.settings.showTrafficLights);
        this.revealWindowButtonsOnHover(win);
      })
    );
    this.revealWindowButtonsOnHover(window);

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshDailyNoteButtons();
        this.dedupeSidebarViews();
        void this.ensureTabsView();
        this.tabs.scheduleLayout();
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.tabs.noteActive(leaf);
        this.tabs.scheduleLayout();
      })
    );
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.tabs.onRename(file, oldPath)));
  }

  registerTabCommands() {
    const withLeaf =
      (run: (leaf: WorkspaceLeaf) => unknown, available: (leaf: WorkspaceLeaf) => boolean = () => true) =>
      (checking: boolean) => {
        const leaf = this.tabs.sync().active;
        if (!leaf || leaf.getViewState().type === "empty" || !available(leaf)) return false;
        if (!checking) void run(leaf);
        return true;
      };

    this.addCommand({
      id: "tabs-show",
      name: "Show tabs sidebar",
      callback: () => void this.revealTabsView(),
    });
    this.addCommand({
      id: "tabs-toggle-pin",
      name: "Pin or unpin current tab",
      checkCallback: withLeaf((leaf) => this.tabs.togglePin(leaf)),
    });
    this.addCommand({
      id: "tabs-toggle-essential",
      name: "Add or remove current tab from Essentials",
      checkCallback: withLeaf((leaf) => this.tabs.toggleEssential(leaf)),
    });
    this.addCommand({
      id: "tabs-move-to-folder",
      name: "Move current tab to folder…",
      checkCallback: withLeaf((leaf) =>
        new FolderPicker(
          this.app,
          this.tabs.folders(),
          (parentId) => void this.tabs.move(this.tabs.sourceOf(leaf), this.tabs.pinnedEnd(parentId))
        ).open()
      ),
    });
    this.addCommand({
      id: "tabs-new-folder",
      name: "New tab folder",
      callback: async () => {
        await this.revealTabsView();
        this.tabs.addFolder();
      },
    });
    this.addCommand({
      id: "tabs-new-tab",
      name: "New tab",
      callback: () => void this.tabs.newTab(),
    });
    this.addCommand({
      id: "tabs-split-with",
      name: "Open in split view…",
      callback: () => this.openLauncher("split"),
    });
    this.addCommand({
      id: "tabs-unsplit",
      name: "Unsplit current split view",
      checkCallback: withLeaf(
        (leaf) => {
          const group = this.tabs.splitOfLeaf(leaf);
          if (group) this.tabs.unsplit(group);
        },
        (leaf) => !!this.tabs.splitOfLeaf(leaf)
      ),
    });
    this.addCommand({
      id: "tabs-space-next",
      name: "Switch to next space",
      checkCallback: (checking) => {
        if (this.tabs.spaces().length < 2) return false;
        if (!checking) void this.tabs.stepSpace(1);
        return true;
      },
    });
    this.addCommand({
      id: "tabs-space-previous",
      name: "Switch to previous space",
      checkCallback: (checking) => {
        if (this.tabs.spaces().length < 2) return false;
        if (!checking) void this.tabs.stepSpace(-1);
        return true;
      },
    });
    for (let n = 1; n <= 9; n++) {
      this.addCommand({
        id: `tabs-space-${n}`,
        name: `Switch to space ${n}`,
        checkCallback: (checking) => {
          const space = this.tabs.spaces()[n - 1];
          if (!space) return false;
          if (!checking) void this.tabs.switchSpace(space.id);
          return true;
        },
      });
    }
    this.addCommand({
      id: "tabs-space-new",
      name: "New space",
      callback: async () => {
        await this.revealTabsView();
        await this.tabs.addSpace();
      },
    });
    this.addCommand({
      id: "tabs-space-rename",
      name: "Rename current space",
      callback: async () => {
        await this.revealTabsView();
        this.tabs.trigger("space-rename");
      },
    });
    this.addCommand({
      id: "tabs-space-icon",
      name: "Change current space's icon",
      callback: () => {
        const space = this.tabs.activeSpace();
        new FantasyIconPicker(this.app, `Icon for ${space.name}`, space.icon, (icon) =>
          this.tabs.setSpaceIcon(space.id, icon)
        ).open();
      },
    });
    this.addCommand({
      id: "tabs-move-to-space",
      name: "Move current tab to space…",
      checkCallback: withLeaf(
        (leaf) => {
          const others = this.tabs.spaces().filter((s) => s.id !== this.tabs.activeSpace().id);
          new SpacePicker(this.app, others, (space) =>
            void this.tabs.move(this.tabs.sourceOf(leaf), { zone: "space", spaceId: space.id })
          ).open();
        },
        () => this.tabs.spaces().length > 1
      ),
    });
    this.addCommand({
      id: "tabs-close-unpinned",
      name: "Close all unpinned tabs",
      callback: () => this.tabs.closeUnpinned(),
    });
    this.addCommand({
      id: "tabs-next",
      name: "Go to next tab in sidebar order",
      callback: () => void this.tabs.cycle(1),
    });
    this.addCommand({
      id: "tabs-previous",
      name: "Go to previous tab in sidebar order",
      callback: () => void this.tabs.cycle(-1),
    });
  }

  /** Zen's split view chrome: drag-to-split preview, pane cards with a focus ring, and pane handles. */
  registerSplitChrome() {
    const chrome = new SplitChrome(this.app, this.tabs);
    this.registerEvent(this.tabs.on("split-layout", (...data: unknown[]) => chrome.decorate(data[0] as SplitLayoutInfo)));
    // Capture phase: ahead of Obsidian's own drop overlay on the panes.
    this.registerDomEvent(document, "dragover", (e) => chrome.onDragOver(e), true);
    this.registerDomEvent(document, "drop", (e) => void chrome.onDrop(e), true);
    this.registerDomEvent(document, "dragend", () => chrome.onDragEnd(), true);
    this.register(() => chrome.destroy());
  }

  openLauncher(mode: LauncherMode = "open") {
    new Launcher(this.app, this.tabs, mode).open();
  }

  /**
   * Route Obsidian's own "New tab" command (Ctrl/Cmd+T by default, or whatever the user bound it to)
   * to the Zen launcher while the setting is on. The original is restored on unload.
   */
  takeOverNewTabCommand() {
    const commands = (this.app as unknown as {
      commands: { commands: Record<string, { checkCallback?: (checking: boolean) => boolean | void }> };
    }).commands.commands;
    const command = commands["workspace:new-tab"];
    const original = command?.checkCallback;
    if (!command || !original) return;
    command.checkCallback = (checking) => {
      if (!this.settings.zenNewTab) return original.call(command, checking);
      if (!checking) this.openLauncher();
      return true;
    };
    this.register(() => {
      command.checkCallback = original;
    });
  }

  async revealTabsView() {
    const ws = this.app.workspace;
    const leaf = ws.getLeavesOfType(TABS_VIEW_TYPE)[0] ?? (await this.placeTabsView());
    if (leaf) await ws.revealLeaf(leaf);
  }

  /** With the window buttons hidden, show them while the pointer is in their corner. */
  revealWindowButtonsOnHover(win: Window) {
    let shown = false;
    this.registerDomEvent(win.document, "mousemove", (e) => {
      if (this.settings.showTrafficLights) return;
      // No hide on mouseleave: the buttons are native and lie over the page, so the pointer leaves the page to reach them.
      const near = e.clientX <= WINDOW_BUTTON_ZONE.width && e.clientY <= WINDOW_BUTTON_ZONE.height;
      if (near === shown) return;
      shown = near;
      setWindowButtons(win, near);
    });
  }

  onunload() {
    this.tabs.flush();
    this.tabs.clearLayout();
    for (const t of TOGGLES) {
      if (t.className) document.body.classList.remove(t.className);
    }
    this.removeDailyNoteButtons();
    if (!this.settings.showRibbon) this.setVaultConfig("showRibbon", true);
    if (!this.settings.showViewHeader) this.setVaultConfig("showViewHeader", true);
    setWindowButtons(window, true);
  }

  getVaultConfig(key: string): unknown {
    return (this.app.vault as unknown as { getConfig: (k: string) => unknown }).getConfig(key);
  }

  setVaultConfig(key: string, value: unknown) {
    (this.app.vault as unknown as { setConfig: (k: string, v: unknown) => void }).setConfig(key, value);
  }

  async loadSettings(keepTabBindings = false) {
    const { tabs, ...settings } = ((await this.loadData()) ?? {}) as Partial<ZenSettings> & { tabs?: unknown };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    this.tabs.load(tabs, keepTabBindings);
  }

  /** Settings and the pin tree share data.json; tab bindings are per device and stored separately. */
  async persist() {
    await this.saveData({ ...this.settings, tabs: this.tabs.serialize() });
  }

  /** data.json changed on disk, e.g. synced from another device. Reload without writing it back. */
  async onExternalSettingsChange() {
    await this.loadSettings(true);
    this.applyAll();
    this.tabs.trigger("changed");
  }

  async saveSettings() {
    await this.persist();
    this.applyAll();
    this.refreshDailyNoteButtons();
    await this.ensureTabsView();
    this.tabs.trigger("changed");
  }

  /**
   * Our sidebar views are singletons. After a plugin reload (e.g. an update) Obsidian revives the
   * old leaves only after onload has run, which can race the startup placement and leave duplicates.
   */
  dedupeSidebarViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(TABS_VIEW_TYPE).slice(1)) leaf.detach();
  }

  /** Close the Git sync tab earlier versions placed; that feature is gone. */
  removeRetiredViews() {
    const retired: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.getViewState().type === RETIRED_SYNC_VIEW) retired.push(leaf);
    });
    for (const leaf of retired) leaf.detach();
  }

  /** The Tabs view is the sidebar: while the plugin runs it always exists, so closing it brings it back. */
  async ensureTabsView() {
    const ws = this.app.workspace;
    // Before the layout is ready the saved leaves are not there yet, and placing one would double it.
    if (!ws.layoutReady || this.placingTabsView || ws.getLeavesOfType(TABS_VIEW_TYPE).length) return;
    this.placingTabsView = true;
    try {
      const leaf = await this.placeTabsView();
      if (leaf) await ws.revealLeaf(leaf);
    } finally {
      this.placingTabsView = false;
    }
  }

  /**
   * Obsidian restores the sidebar tab that was in front when the vault closed, often Files.
   * Bring the Tabs view to the front instead; a sidebar the user collapsed stays collapsed.
   */
  async showTabsViewAtStartup() {
    await this.ensureTabsView();
    const ws = this.app.workspace;
    const leaf = ws.getLeavesOfType(TABS_VIEW_TYPE)[0];
    if (!leaf) return;
    const root = leaf.getRoot();
    const side = [ws.leftSplit, ws.rightSplit].find((s) => (s as unknown) === root);
    const collapsed = side?.collapsed;
    await ws.revealLeaf(leaf);
    if (collapsed) side?.collapse();
  }

  /** Create the Tabs view as the first tab next to Files. The user is free to move it. */
  async placeTabsView(): Promise<WorkspaceLeaf | null> {
    const ws = this.app.workspace;
    const anchor = ws.getLeavesOfType("file-explorer")[0] ?? ws.getLeavesOfType("search")[0];
    const group = anchor?.parent as unknown as WorkspaceSplit | undefined;
    const leaf = group ? ws.createLeafInParent(group, 0) : ws.getLeftLeaf(false);
    await leaf?.setViewState({ type: TABS_VIEW_TYPE, active: false });
    return leaf;
  }

  applyAll() {
    // Use Obsidian's own settings so the window frame and layout update with them.
    if (this.getVaultConfig("showRibbon") !== this.settings.showRibbon) {
      this.setVaultConfig("showRibbon", this.settings.showRibbon);
    }
    if (this.getVaultConfig("showViewHeader") !== this.settings.showViewHeader) {
      this.setVaultConfig("showViewHeader", this.settings.showViewHeader);
    }
    setWindowButtons(window, this.settings.showTrafficLights);
    for (const t of TOGGLES) {
      if (!t.className || !t.when) continue;
      const v = this.settings[t.key] as boolean;
      const shouldAdd = t.when === "on" ? v : !v;
      document.body.classList.toggle(t.className, shouldAdd);
    }
  }

  calcScrollMargin(containerHeight: number, cursorHeight: number): number {
    if (!this.settings.scrollOffsetEnabled) return 0;
    const max = (containerHeight - cursorHeight) / 2;
    const raw = parseFloat(this.settings.scrollOffsetValue);
    if (!isFinite(raw) || raw <= 0) return 0;
    const requested = this.settings.scrollOffsetPercentage
      ? (containerHeight * raw) / 100
      : raw;
    return Math.min(requested, max);
  }

  toggleZenMode() {
    const ws = this.app.workspace;
    const isFullscreen = !!document.fullscreenElement;
    const leftCollapsed = ws.leftSplit?.collapsed;
    const rightCollapsed = ws.rightSplit?.collapsed;
    const enteringZen = !isFullscreen || !leftCollapsed || !rightCollapsed;

    if (enteringZen) {
      if (!leftCollapsed) ws.leftSplit?.collapse();
      if (!rightCollapsed) ws.rightSplit?.collapse();
      if (!isFullscreen) void document.documentElement.requestFullscreen?.();
    } else {
      ws.leftSplit?.expand();
      ws.rightSplit?.expand();
      if (document.fullscreenElement) void document.exitFullscreen?.();
    }
  }

  refreshDailyNoteButtons() {
    if (!this.settings.dailyNoteButton) {
      this.removeDailyNoteButtons();
      return;
    }
    const containers = document.querySelectorAll<HTMLElement>(
      ".workspace-split.mod-left-split .workspace-tab-header-container, " +
        ".workspace-split.mod-right-split .workspace-tab-header-container"
    );
    containers.forEach((c) => this.injectDailyNoteButton(c));
  }

  injectDailyNoteButton(container: HTMLElement) {
    if (container.querySelector(".zen-daily-note-button")) return;
    const btn = container.createDiv({ cls: "clickable-icon zen-daily-note-button", attr: { role: "button" } });
    setIcon(btn, "calendar-check");
    srLabel(btn, "Open today's daily note");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      this.openDailyNote();
    });
    const newTab = container.querySelector(".workspace-tab-header-new-tab");
    if (newTab) container.insertBefore(btn, newTab);
    else container.appendChild(btn);
  }

  removeDailyNoteButtons() {
    document
      .querySelectorAll(".zen-daily-note-button")
      .forEach((el) => el.remove());
  }

  openDailyNote() {
    const cmds = (this.app as unknown as {
      commands: { executeCommandById: (id: string) => boolean };
    }).commands;
    if (!cmds.executeCommandById("daily-notes")) {
      new Notice("Atlas Sidebar: enable the daily notes core plugin to use this button.");
    }
  }

  async ensureDefaultSidebarTabs() {
    const ws = this.app.workspace;
    const allowed = new Set<string>([TABS_VIEW_TYPE]);
    if (this.settings.showFilesTab) allowed.add("file-explorer");
    if (this.settings.showSearchTab) allowed.add("search");

    const sideLeaves: WorkspaceLeaf[] = [];
    ws.iterateAllLeaves((leaf) => {
      const root = leaf.getRoot();
      if (root === ws.leftSplit || root === ws.rightSplit) sideLeaves.push(leaf);
    });
    for (const leaf of sideLeaves) {
      if (!allowed.has(leaf.view.getViewType())) leaf.detach();
    }

    const ensure = async (type: string, active: boolean) => {
      if (ws.getLeavesOfType(type).length > 0) return;
      const leaf = ws.getLeftLeaf(true);
      if (leaf) await leaf.setViewState({ type, active });
    };
    if (this.settings.showFilesTab) await ensure("file-explorer", true);
    if (this.settings.showSearchTab) await ensure("search", false);
    if (!ws.getLeavesOfType(TABS_VIEW_TYPE).length) await this.placeTabsView();

    const first = ws.getLeavesOfType(TABS_VIEW_TYPE)[0];
    if (first) void ws.revealLeaf(first);
  }
}

/** The corner, in CSS pixels, where the pointer brings hidden window buttons back. */
const WINDOW_BUTTON_ZONE = { width: 100, height: 48 };

/** Show or hide the macOS traffic lights. Obsidian exposes the Electron window as `electronWindow`. */
function setWindowButtons(win: Window, visible: boolean) {
  if (!Platform.isMacOS) return;
  const ew = (win as unknown as {
    electronWindow?: { setWindowButtonVisibility?: (v: boolean) => void };
  }).electronWindow;
  ew?.setWindowButtonVisibility?.(visible);
}

function buildScrollOffsetExtension(plugin: ObsidianZenPlugin) {
  return Prec.highest(
    ViewPlugin.fromClass(
      class {
        margin = 0;
        ignoreNext = false;
        constructor(_view: EditorView) {}
        update(u: ViewUpdate) {
          if (!u.selectionSet) return;
          const view = u.view;
          view.requestMeasure({
            read: () => ({
              cursor: view.coordsAtPos(view.state.selection.main.head),
            }),
            write: ({ cursor }) => {
              if (!cursor) return;
              if (this.ignoreNext) {
                this.margin = 0;
                this.ignoreNext = false;
                return;
              }
              const cursorHeight = cursor.bottom - cursor.top + 5;
              this.margin = plugin.calcScrollMargin(
                view.dom.offsetHeight,
                cursorHeight
              );
            },
          });
        }
      },
      {
        eventHandlers: {
          mousedown(this: { ignoreNext: boolean }) {
            this.ignoreNext = true;
          },
          keydown(this: { ignoreNext: boolean }) {
            this.ignoreNext = false;
          },
        },
        provide: (vp) =>
          EditorView.scrollMargins.of((view) => {
            const value = view.plugin(vp) as { margin: number } | null;
            if (!value) return null;
            return { top: value.margin, bottom: value.margin };
          }),
      }
    )
  );
}

type SettingRow = {
  name: string;
  desc: string;
  render: (setting: Setting) => void;
  visible?: () => boolean;
};

class ZenSettingTab extends PluginSettingTab {
  plugin: ObsidianZenPlugin;

  constructor(app: App, plugin: ObsidianZenPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.containerEl.addClass("zen-settings");
  }

  /** Rendered declaratively by Obsidian and indexed for settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.groups().map(({ heading, rows }) => ({
      type: "group" as const,
      heading,
      items: rows.map((r) => ({
        name: r.name,
        desc: r.desc,
        visible: r.visible,
        render: (setting: Setting) => {
          setting.setName(r.name).setDesc(r.desc);
          r.render(setting);
        },
      })),
    }));
  }

  private groups(): { heading: string; rows: SettingRow[] }[] {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    return GROUP_ORDER.map((group) => {
      const rows: SettingRow[] = [];

      if (group === "Sidebar layout") {
        rows.push({
          name: "Tab bar position",
          desc: "Where the sidebar tabs and buttons sit. Split keeps tabs on top and buttons at the bottom.",
          render: (setting) => {
            setting.addDropdown((d) =>
              d
                .addOptions({ top: "Top", bottom: "Bottom", split: "Split" })
                .setValue(s.splitTabHeader ? "split" : s.tabHeaderBottom ? "bottom" : "top")
                .onChange((v) => {
                  s.tabHeaderBottom = v === "bottom";
                  s.splitTabHeader = v === "split";
                  void save();
                })
            );
          },
        });
      }

      for (const t of TOGGLES.filter((x) => x.group === group && !x.custom)) {
        rows.push({
          name: t.name,
          desc: t.desc,
          render: (setting) => {
            setting.addToggle((tg) =>
              tg.setValue(s[t.key] as boolean).onChange((v) => {
                (s[t.key] as boolean) = v;
                void save().then(() => {
                  if (t.key === "scrollOffsetEnabled") this.update();
                });
              })
            );
          },
        });
      }

      if (group === "Editor") {
        rows.push({
          name: "Typewriter distance",
          desc: "Distance kept above and below the cursor; use 0 to turn it off.",
          visible: () => s.scrollOffsetEnabled,
          render: (setting) => {
            setting
              .setClass("zen-setting-sub")
              .addText((t) =>
                t
                  .setPlaceholder("25")
                  .setValue(s.scrollOffsetValue)
                  .onChange((v) => {
                    s.scrollOffsetValue = v;
                    void save();
                  })
              )
              .addDropdown((d) =>
                d
                  .addOptions({ percent: "% of editor", px: "px" })
                  .setValue(s.scrollOffsetPercentage ? "percent" : "px")
                  .onChange((v) => {
                    s.scrollOffsetPercentage = v === "percent";
                    void save();
                  })
              );
          },
        });
      }

      return { heading: group, rows };
    });
  }
}
