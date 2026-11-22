import { ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, Platform, Plugin, TFile, type Editor, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import CHANGELOG from "../CHANGELOG.md";
import { Ai } from "./ai";
import { badgeExtension, badgePostProcessor, redrawBadges } from "./badges";
import { insertAtCursor, originalLink, Target, textFor, formatClip } from "./insert";
import { LIBRARY_VIEW, LibraryView } from "./library";
import { ClipSuggest, ReviewModal, SetupModal, TidyModal } from "./modals";
import { dayKey, pickDaily, type Clip, type Place, type Query } from "./model";
import { PANEL_VIEW, PanelView } from "./panel";
import { Relater } from "./relate";
import { mergeData, PHONE_SECRET, type InsertFormat, type PluginData, type Settings } from "./settings";
import { ClipsSettingTab } from "./settingsTab";
import { AiSetupModal, finishPhoneLink } from "./aiSetup";
import type { AiTarget } from "./ai";
import { ClipStore } from "./store";
import { keywords, normalize, plural } from "./text";
import { NotePicker, UsesModal } from "./ui";

export default class ClipsPlugin extends Plugin {
	data!: PluginData;
	store!: ClipStore;
	ai!: Ai;
	target!: Target;
	private saveTimer = 0;
	private statusEl: HTMLElement | null = null;
	private settingTab!: ClipsSettingTab;
	private autoTagging = false;

	/** The same object as data.settings. */
	settings!: Settings;

	async onload() {
		this.data = mergeData(await this.loadData());
		this.settings = this.data.settings;
		this.target = new Target(this.app);
		this.ai = new Ai(this.app, () => this.data, () => this.saveSoon());
		this.store = new ClipStore({ app: this.app, data: this.data, saveSoon: () => this.saveSoon(), dir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/clips` });

		this.registerView(LIBRARY_VIEW, (leaf) => new LibraryView(leaf, this));
		this.registerView(PANEL_VIEW, (leaf) => new PanelView(leaf, this));
		this.registerView(WHATS_NEW_VIEW, (leaf) => new WhatsNewView(leaf, this));
		this.settingTab = new ClipsSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		// An Obsi app on the phone answers a link request here.
		this.registerObsidianProtocolHandler("clips-ai", (params) => void this.handleLink(params));
		this.registerEditorExtension(badgeExtension(this));
		this.registerMarkdownPostProcessor(badgePostProcessor(this));

		this.addRibbonIcon("quote", "Open clip library", () => this.openLibrary());
		this.addCommands();
		this.addMenus();

		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.target.track(leaf)));
		this.registerEvent(this.app.vault.on("modify", (f) => f instanceof TFile && f.extension === "md" && this.store.noteChanged(f.path)));
		this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && f.extension === "md" && this.store.noteChanged(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => f instanceof TFile && this.store.noteDeleted(f.path)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => f instanceof TFile && this.store.noteRenamed(f.path, old)));
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.store.usesSoon()));
		this.registerEvent(this.store.on("change", () => {
			redrawBadges(this);
			this.updateStatus();
		}));
		this.registerEvent(this.store.on("state", () => this.updateStatus()));
		this.registerEvent(this.app.secretStorage.on("changed", () => this.settingTab.update()));

		this.app.workspace.onLayoutReady(() => void this.start());
	}

	onunload() {
		window.clearTimeout(this.saveTimer);
		void this.saveData(this.data);
	}

	private async start() {
		this.target.track(this.app.workspace.getMostRecentLeaf());
		if (!Platform.isMobile && this.settings.statusBar) this.makeStatus();
		const fresh = !this.data.welcomed;
		if (fresh) new SetupModal(this).open();
		if (!this.store.needsFolders) await this.store.rebuild();
		this.afterBuild(fresh);
		if (this.settings.panelOnStart) void this.openPanel(false);
		this.whatsNewAfterUpdate(fresh);
	}

	private afterBuild(fresh: boolean) {
		if (!this.store.ready || fresh) return;
		const left = this.reviewLeft();
		if (this.settings.reviewNudge && left && this.data.daily.done.length === 0) {
			const frag = createFragment((f) => {
				f.appendText(`${plural(left, "clip")} to look at today. `);
				const a = f.createEl("a", { text: "Review", href: "#" });
				a.addEventListener("click", (e) => {
					e.preventDefault();
					this.openReview();
				});
			});
			new Notice(frag, 8000);
		}
		void this.autoTags();
	}

	saveSoon() {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.saveData(this.data), 600);
	}

	async saveNow() {
		window.clearTimeout(this.saveTimer);
		await this.saveData(this.data);
	}

	/** Called after a setting changes in Settings. */
	settingChanged(key: string) {
		if (["marks", "plainQuotes", "minWords", "countQuotes", "scope", "ignoreFolders"].includes(key)) void this.store.rebuild();
		if (key === "scope" && this.store.needsFolders) this.openSetup();
		if (key === "badges" || key === "hideIds") redrawBadges(this);
		if (key.startsWith("panel") || key === "ai.order") this.redrawPanel();
		if (key === "libraryLook") for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW)) if (leaf.view instanceof LibraryView) leaf.view.redraw();
		if (key === "statusBar") {
			if (this.settings.statusBar && !Platform.isMobile) this.makeStatus();
			else {
				this.statusEl?.remove();
				this.statusEl = null;
			}
		}
		if (key === "reviewCount") this.data.daily = { day: "", ids: [], done: [] };
		if (key.startsWith("ai.") || key === "folders") this.settingTab.update();
		this.updateStatus();
	}

	/** Saves an AI choice that has passed its test, and turns AI on. */
	useAi(t: AiTarget) {
		this.settings.ai = { ...this.settings.ai, ...t, on: true };
		void this.saveNow();
		this.settingTab.update();
	}

	/** The answer from an Obsi app on this phone, by obsidian://clips-ai. */
	handleLink(params: Record<string, string>) {
		return finishPhoneLink(this, params);
	}

	openAiSetup() {
		new AiSetupModal(this).open();
	}

	/** Turns AI off and removes its key and phone link from this device. */
	forgetAi() {
		const s = this.settings.ai;
		try {
			this.app.secretStorage.setSecret(s.keyName, "");
			this.app.secretStorage.setSecret(PHONE_SECRET, "");
		} catch {
			// Nothing saved.
		}
		this.settings.ai = { ...s, on: false };
		void this.saveNow();
		this.settingTab.update();
		new Notice("AI is off. Its key and links are removed from this device.");
	}

	/** Clips are read from every note. */
	async useWholeVault(openAfter = false) {
		this.settings.scope = "vault";
		this.data.welcomed = true;
		await this.saveNow();
		await this.store.rebuild();
		if (openAfter) {
			new Notice(`Found ${plural(this.store.clips.length, "clip")}`);
			this.openLibrary();
			void this.openPanel(false);
		}
		this.settingTab.update();
	}

	async setFolders(folders: string[], openAfter = false) {
		this.settings.scope = "folders";
		this.settings.folders = folders;
		this.data.welcomed = true;
		await this.saveNow();
		await this.store.rebuild();
		if (openAfter) {
			new Notice(`Found ${plural(this.store.clips.length, "clip")}`);
			this.openLibrary();
			void this.openPanel(false);
		}
		this.updateStatus();
	}

	// -----------------------------------------------------------------------
	// Commands and menus
	// -----------------------------------------------------------------------

	// Four commands, each one complete. Everything else is in the library's menu, the editor's
	// right-click menu and Settings, so the command list stays short.
	private addCommands() {
		this.addCommand({ id: "put-clip", name: "Put a clip in", callback: () => this.openPicker() });
		this.addCommand({ id: "open-library", name: "Open library", callback: () => this.openLibrary({}, true) });
		this.addCommand({ id: "open-panel", name: "Search in side bar", callback: () => void this.searchPanel() });
		this.addCommand({ id: "review", name: "Review", callback: () => this.openReview(true) });
	}

	/**
	 * The clip picker. With text selected, it searches for clips like that text and puts the pick
	 * after the selection. With no search, it lists the clips that fit the open note first.
	 */
	openPicker() {
		if (!this.store.ready) {
			new Notice(this.store.needsFolders ? "Pick your clip folders first." : "Still reading your clips. Try again in a moment.");
			if (this.store.needsFolders) this.openSetup();
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) this.target.track(view.leaf);
		const sel = view?.getMode() === "source" ? view.editor.getSelection().trim() : "";
		new ClipSuggest(this, undefined, sel ? this.likeText(sel) : "").open();
	}

	private addMenus() {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info) => {
				const sel = editor.getSelection().trim();
				menu.addItem((i) =>
					i
						.setSection("action")
						.setTitle(sel ? "Put a clip like this here" : "Put a clip here")
						.setIcon("quote")
						.onClick(() => this.openPicker()),
				);
				const c = info.file ? this.store.clipAt(info.file.path, editor.getCursor().line) : null;
				if (c) menu.addItem((i) => i.setSection("action").setTitle(c.uses.length ? `Show uses of this clip (${c.uses.length})` : "This clip is not used yet").setIcon("list").onClick(() => c.uses.length && new UsesModal(this, c).open()));
			}),
		);
	}

	private relater: { n: number; r: Relater } | null = null;

	/** The clips that fit a note, best first, by their words and tags. Clips already used there are left out. */
	async rankForNote(f: TFile, limit = 40): Promise<string[]> {
		const store = this.store;
		if (!store.ready || store.byPath.get(f.path)?.length) return [];
		if (!this.relater || this.relater.n !== store.clips.length) {
			this.relater = { n: store.clips.length, r: new Relater(store.clips.map((c) => ({ id: c.id, words: c.words, tags: c.tags }))) };
		}
		const open = this.app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v): v is MarkdownView => v instanceof MarkdownView && v.file === f);
		const body = (open ? open.editor.getValue() : await this.app.vault.cachedRead(f)).replace(/^---\n[\s\S]*?\n---\n?/, "");
		const cache = this.app.metadataCache.getFileCache(f);
		const fm = cache?.frontmatter?.tags as unknown;
		const tags = [...(cache?.tags ?? []).map((t) => t.tag.slice(1)), ...(Array.isArray(fm) ? fm.map(String) : typeof fm === "string" ? [fm] : [])];
		const skip = new Set(store.clips.filter((c) => store.state(c.id).arch || c.uses.some((u) => u.path === f.path)).map((c) => c.id));
		return this.relater.r.rank(f.basename + "\n" + f.basename + "\n" + body, tags, [], skip, limit).map((r) => r.id);
	}

	/** A search made from selected text: its few strongest words. */
	private likeText(text: string): string {
		const words = [...new Set(keywords(text))];
		if (words.length <= 2) return words.join(" ");
		// Every search word must match, so keep the two that say most: words your clips use, but rarely.
		const df = new Map<string, number>();
		for (const c of this.store.clips) for (const w of new Set(c.words)) df.set(w, (df.get(w) ?? 0) + 1);
		const known = words.filter((w) => df.has(w)).sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || b.length - a.length);
		return (known.length ? known : words.sort((a, b) => b.length - a.length)).slice(0, 2).join(" ");
	}

	// -----------------------------------------------------------------------
	// Views
	// -----------------------------------------------------------------------

	/** Opens the library, or goes to it when it is open. With focus, the cursor goes to its search. */
	openLibrary(part: Partial<Query> = {}, focus = false) {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(LIBRARY_VIEW)[0];
		const done = () => {
			const view = leaf?.view;
			if (view instanceof LibraryView && Object.keys(part).length) view.setQuery(part);
			if (leaf) void ws.revealLeaf(leaf).then(() => {
				if (focus && leaf) ws.setActiveLeaf(leaf, { focus: true });
				if (focus && view instanceof LibraryView) view.focusSearch();
			});
		};
		if (leaf) return done();
		leaf = ws.getLeaf("tab");
		void leaf.setViewState({ type: LIBRARY_VIEW, active: true }).then(done);
	}

	/** Draws the side bar again, after its look changes. */
	redrawPanel() {
		for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW)) if (leaf.view instanceof PanelView) void leaf.view.draw();
	}

	/** Opens the side bar with the cursor in its search. Escape there goes back to the note. */
	async searchPanel() {
		await this.openPanel(true);
		const view = this.app.workspace.getLeavesOfType(PANEL_VIEW)[0]?.view;
		if (view instanceof PanelView) view.focusSearch();
	}

	async openPanel(reveal: boolean) {
		const ws = this.app.workspace;
		let leaf: WorkspaceLeaf | null = ws.getLeavesOfType(PANEL_VIEW)[0] ?? null;
		if (!leaf) {
			leaf = ws.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: PANEL_VIEW, active: false });
		}
		if (reveal) await ws.revealLeaf(leaf);
	}

	/** Today's clips. With more, and today's are done, it adds a few more instead of stopping. */
	openReview(more = false) {
		if (!this.store.ready) {
			new Notice(this.store.needsFolders ? "Pick your clip folders first." : "Still reading your clips. Try again in a moment.");
			if (this.store.needsFolders) this.openSetup();
			return;
		}
		if (!this.reviewLeft()) {
			if (!more || !this.addMoreReview()) {
				new Notice("Nothing to review today. New clips come tomorrow.");
				return;
			}
			new Notice("Today's clips are done. Here are a few more.");
		}
		new ReviewModal(this).open();
	}

	/** Adds the next few clips to today's review. False when there are none left to add. */
	private addMoreReview(): boolean {
		const d = this.daily();
		const skip = new Set([...d.ids, ...d.done]);
		const rest = this.store.clips.filter((c) => !skip.has(c.id));
		const ids = pickDaily(rest, this.data.clips, this.settings.reviewCount);
		if (!ids.length) return false;
		d.ids.push(...ids);
		this.saveSoon();
		this.updateStatus();
		return true;
	}

	openTidy() {
		if (!this.store.ready) return void new Notice("Still reading your clips.");
		new TidyModal(this).open();
	}

	openSetup() {
		new SetupModal(this).open();
	}

	openSettings() {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	// -----------------------------------------------------------------------
	// Review
	// -----------------------------------------------------------------------

	/** Today's review pick, made once a day. */
	daily(): PluginData["daily"] {
		const today = dayKey(Date.now());
		if (this.data.daily.day !== today || !this.data.daily.ids.length) {
			const ids = this.store.ready ? pickDaily(this.store.clips, this.data.clips, this.settings.reviewCount) : [];
			this.data.daily = { day: today, ids, done: this.data.daily.day === today ? this.data.daily.done : [] };
			this.saveSoon();
		}
		return this.data.daily;
	}

	reviewLeft(): number {
		if (!this.store.ready || !this.store.clips.length) return 0;
		const d = this.daily();
		return d.ids.filter((id) => !d.done.includes(id) && this.store.byId.has(id) && !this.store.state(id).arch).length;
	}

	markReviewed(id: string) {
		const d = this.daily();
		if (!d.done.includes(id)) d.done.push(id);
		const st = this.store.state(id);
		if (!st.seen || Date.now() - st.seen > 1000) this.store.setState(id, { ...st, seen: Date.now() });
		this.saveSoon();
		this.updateStatus();
	}

	private makeStatus() {
		if (this.statusEl) return;
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("oc-status", "mod-clickable");
		this.statusEl.setAttr("aria-label", "Review today's clips");
		this.statusEl.addEventListener("click", () => this.openReview());
		this.updateStatus();
	}

	private updateStatus() {
		if (!this.statusEl) return;
		const n = this.reviewLeft();
		this.statusEl.setText(n ? `${n} to review` : "");
		this.statusEl.toggleClass("is-hidden", !n);
	}

	// -----------------------------------------------------------------------
	// Clip actions
	// -----------------------------------------------------------------------

	async putClip(c: Clip, how?: InsertFormat, place?: Place) {
		// No note to put it in: pick one, rather than stop.
		if (!this.target.file()) {
			this.putInOther(c);
			return false;
		}
		const ok = await this.target.put(c, how ?? this.settings.insertFormat, this.settings, place);
		if (ok) {
			this.store.setState(c.id, { ...this.store.state(c.id), put: Date.now() });
			new Notice("Clip put in " + (this.target.file()?.basename ?? "the note"));
		}
		return ok;
	}

	/** Puts a clip at the end of a note that may not be open. */
	async putInFile(c: Clip, f: TFile): Promise<boolean> {
		if (c.places.some((p) => p.path === f.path)) {
			new Notice("This clip is already in that note.");
			return false;
		}
		const open = this.app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v): v is MarkdownView => v instanceof MarkdownView && v.file === f && v.getMode() === "source");
		const text = await textFor(this.app, c, this.settings.insertFormat, f.path, this.settings);
		if (open) insertAtCursor(open.editor, text);
		else await this.app.vault.process(f, (body) => body.replace(/\s*$/, "") + "\n\n" + text + "\n");
		this.store.setState(c.id, { ...this.store.state(c.id), put: Date.now() });
		new Notice("Clip put in " + f.basename);
		return true;
	}

	putInOther(c: Clip) {
		new NotePicker(this.app, (f) => void this.putInFile(c, f)).open();
	}

	/** The quote text, used for drag and drop. */
	quoteText(c: Clip, fromPath: string): string {
		return formatClip(this.app, c, "quote", fromPath, this.settings);
	}

	async copyClip(c: Clip, how: "quote" | "text" | "embed") {
		const from = this.target.file()?.path ?? "";
		const text = how === "text" ? c.text : await textFor(this.app, c, how === "embed" ? "embed" : "quote", from, this.settings);
		await navigator.clipboard.writeText(text);
		new Notice(how === "text" ? "Clip text copied" : how === "embed" ? "Embed link copied" : "Clip copied as a quote");
	}

	async copyMany(clips: Clip[]) {
		const from = this.target.file()?.path ?? "";
		const parts = clips.map((c) => formatClip(this.app, c, "quote", from, this.settings));
		await navigator.clipboard.writeText(parts.join("\n\n"));
		new Notice(`Copied ${plural(clips.length, "clip")}`);
	}

	toggleStar(c: Clip) {
		const st = { ...this.store.state(c.id) };
		if (st.star) delete st.star;
		else st.star = 1;
		this.store.setState(c.id, st);
	}

	toggleArchive(c: Clip) {
		const st = { ...this.store.state(c.id) };
		const was = !!st.arch;
		if (was) delete st.arch;
		else st.arch = 1;
		this.store.setState(c.id, st);
		const n = new Notice(was ? "Clip brought back" : "Clip archived. ", 5000);
		if (!was) {
			const undo = n.messageEl.createEl("a", { text: "Undo", href: "#" });
			undo.addEventListener("click", (e) => {
				e.preventDefault();
				const s2 = { ...this.store.state(c.id) };
				delete s2.arch;
				this.store.setState(c.id, s2);
				n.hide();
			});
		}
	}

	/** Opens the clip's note at the clip. */
	async openPlace(c: Clip, p: Place = c.places[0]) {
		const f = this.app.vault.getFileByPath(p.path);
		if (!f) return;
		const leaf = this.leafFor(f);
		await leaf.openFile(f, { eState: { line: p.line }, active: true });
		const view = leaf.view;
		if (view instanceof MarkdownView && view.getMode() === "source") {
			const end = view.editor.getLine(p.line)?.length ?? 0;
			view.editor.setSelection({ line: p.line, ch: 0 }, { line: p.line, ch: end });
			view.editor.scrollIntoView({ from: { line: p.line, ch: 0 }, to: { line: Math.min(p.endLine, view.editor.lineCount() - 1), ch: 0 } }, true);
		}
	}

	/** Opens a note that uses the clip, at the place it is used. */
	async openUse(c: Clip, path: string) {
		const f = this.app.vault.getFileByPath(path);
		if (!f) return;
		const body = await this.app.vault.cachedRead(f);
		const lines = body.split("\n");
		const first = normalize(c.text).split(" ").slice(0, 5).join(" ");
		let line = lines.findIndex((l) => normalize(l).includes(first));
		if (line < 0) line = lines.findIndex((l) => c.places.some((p) => p.blockId && l.includes("^" + p.blockId)));
		const leaf = this.leafFor(f);
		await leaf.openFile(f, { eState: line >= 0 ? { line } : undefined, active: true });
	}

	/** An open tab of the note, else a new tab (on phones, the current one). */
	private leafFor(f: TFile): WorkspaceLeaf {
		const ws = this.app.workspace;
		const open = ws.getLeavesOfType("markdown").find((l) => l.view instanceof MarkdownView && l.view.file === f);
		if (open) return open;
		if (Platform.isMobile) return ws.getLeaf(false);
		const recent = this.target.view()?.leaf;
		return recent && recent.view instanceof MarkdownView ? ws.getLeaf("tab") : ws.getLeaf(false);
	}

	openOriginal(c: Clip, p: Place = c.places[0]) {
		const url = originalLink(p, c);
		if (url) window.open(url, "_blank");
	}

	// -----------------------------------------------------------------------
	// Tag ideas by themselves
	// -----------------------------------------------------------------------

	/** New clips with no tags get tag ideas in the background, a few at a time. Only when chosen in Settings. */
	private async autoTags() {
		const s = this.settings.ai;
		if (this.autoTagging || !this.ai.usable() || s.tags !== "auto") return;
		this.autoTagging = true;
		try {
			const done = new Set(this.data.memo.tagged);
			const todo = this.store.clips.filter((c) => !c.tags.length && !done.has(c.id) && !this.store.state(c.id).arch).slice(0, 24);
			if (!todo.length) return;
			const ideas = await this.ai.tagIdeas(todo.map((c) => ({ id: c.id, text: c.text, note: c.places[0].note })), this.store.allTags().map((t) => t.tag));
			for (const c of todo) {
				this.data.memo.tagged.push(c.id);
				const tags = ideas[c.id];
				if (tags?.length) {
					this.store.setState(c.id, { ...this.store.state(c.id), tags });
					this.store.refreshTags(c.id);
				}
			}
			this.saveSoon();
		} finally {
			this.autoTagging = false;
		}
	}

	// -----------------------------------------------------------------------
	// What's new
	// -----------------------------------------------------------------------

	async openWhatsNew(since = "") {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(WHATS_NEW_VIEW)[0];
		if (!leaf) leaf = ws.getLeaf("tab");
		await leaf.setViewState({ type: WHATS_NEW_VIEW, active: true, state: { since } });
		await ws.revealLeaf(leaf);
	}

	private whatsNewAfterUpdate(fresh: boolean) {
		const now = this.manifest.version;
		const was = this.data.seenVersion;
		this.data.seenVersion = now;
		this.saveSoon();
		if (!fresh && was && was !== now && this.settings.showWhatsNew && compareVersions(now, was) > 0) void this.openWhatsNew(was);
	}
}

// ---------------------------------------------------------------------------
// What's new
// ---------------------------------------------------------------------------

export const WHATS_NEW_VIEW = "clips-whats-new";

function compareVersions(a: string, b: string): number {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return Math.sign(d);
	}
	return 0;
}

function releases(): { version: string; body: string }[] {
	return CHANGELOG.split(/^## /m)
		.slice(1)
		.map((part) => ({ version: /^[0-9.]+/.exec(part)?.[0] ?? "", body: "## " + part.trim() }))
		.filter((r) => r.version);
}

class WhatsNewView extends ItemView {
	private since = "";

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ClipsPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return WHATS_NEW_VIEW;
	}
	getDisplayText() {
		return "What's new in Clips";
	}
	getIcon() {
		return "gift";
	}

	async setState(state: unknown, result: ViewStateResult) {
		const since = (state as { since?: unknown } | null)?.since;
		this.since = typeof since === "string" ? since : "";
		await super.setState(state, result);
		await this.draw();
	}

	getState(): Record<string, unknown> {
		return { since: this.since };
	}

	async onOpen() {
		await this.draw();
	}

	private async draw() {
		const root = this.contentEl;
		root.empty();
		root.addClass("oc-whats-new");
		const page = root.createDiv({ cls: "oc-wn-page" });
		page.createEl("h1", { text: "What's new" });
		const list = releases();
		const latest = list[0]?.version ?? "";
		const fresh = list.filter((r) => this.since && compareVersions(r.version, this.since) > 0);
		page.createEl("p", { cls: "oc-wn-lead", text: fresh.length ? `Clips is now ${latest}. Here is what changed since ${this.since}.` : `Clips ${latest}.` });
		for (const r of list) {
			const isNew = fresh.includes(r);
			const box = page.createDiv({ cls: isNew ? "oc-wn-release is-new" : "oc-wn-release" });
			await MarkdownRenderer.render(this.app, r.body, box, "", this);
			if (isNew) box.querySelector("h2")?.createSpan({ cls: "oc-wn-badge", text: "New" });
		}
		if (this.plugin.settings.showWhatsNew) {
			const off = page.createDiv({ cls: "oc-wn-foot" }).createEl("button", { text: "Do not open this after updates" });
			off.addEventListener("click", () => {
				this.plugin.settings.showWhatsNew = false;
				this.plugin.saveSoon();
				off.remove();
				new Notice("Turn it on again in Settings, Clips");
			});
		}
	}
}
