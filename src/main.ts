import { ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, Platform, Plugin, TFile, type Editor, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import CHANGELOG from "../CHANGELOG.md";
import { Ai } from "./ai";
import { badgeExtension, badgePostProcessor, redrawBadges } from "./badges";
import { insertAtCursor, originalLink, Target, textFor, formatClip } from "./insert";
import { LIBRARY_VIEW, LibraryView } from "./library";
import { ClipSuggest, ReviewModal, SetupModal, TidyModal } from "./modals";
import { dayKey, pickDaily, type Clip, type Place, type Query } from "./model";
import { PANEL_VIEW, PanelView } from "./panel";
import { mergeData, type InsertFormat, type PluginData, type Settings } from "./settings";
import { ClipsSettingTab, providerChanged } from "./settingsTab";
import { ClipStore } from "./store";
import { normalize, plural } from "./text";
import { likeQuery, NotePicker, UsesModal } from "./ui";

export default class ObsiClips extends Plugin {
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
		this.store = new ClipStore({ app: this.app, data: this.data, saveSoon: () => this.saveSoon(), dir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/obsi-clips` });

		this.registerView(LIBRARY_VIEW, (leaf) => new LibraryView(leaf, this));
		this.registerView(PANEL_VIEW, (leaf) => new PanelView(leaf, this));
		this.registerView(WHATS_NEW_VIEW, (leaf) => new WhatsNewView(leaf, this));
		this.settingTab = new ClipsSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
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
		if (!this.settings.folders.length) {
			if (fresh) new SetupModal(this).open();
		} else await this.store.rebuild();
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
		if (["marks", "plainQuotes", "minWords", "countQuotes"].includes(key)) void this.store.rebuild();
		if (key === "badges") redrawBadges(this);
		if (key === "statusBar") {
			if (this.settings.statusBar && !Platform.isMobile) this.makeStatus();
			else {
				this.statusEl?.remove();
				this.statusEl = null;
			}
		}
		if (key === "reviewCount") this.data.daily = { day: "", ids: [], done: [] };
		if (key === "ai.provider") {
			providerChanged(this);
			void this.saveNow();
		}
		if (key.startsWith("ai.") || key === "folders") this.settingTab.update();
		this.updateStatus();
	}

	async setFolders(folders: string[], openAfter = false) {
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

	private addCommands() {
		this.addCommand({ id: "open-library", name: "Open clip library", callback: () => this.openLibrary() });
		this.addCommand({ id: "open-panel", name: "Show clips for this note", callback: () => void this.openPanel(true) });
		this.addCommand({
			id: "put-clip",
			name: "Put a clip in this note",
			editorCallback: () => new ClipSuggest(this).open(),
		});
		this.addCommand({ id: "review", name: "Review today's clips", callback: () => this.openReview() });
		this.addCommand({ id: "tidy", name: "Tidy clips", callback: () => this.openTidy() });
		this.addCommand({
			id: "like-selection",
			name: "Find clips like the selected text",
			editorCheckCallback: (checking, editor) => {
				const sel = editor.getSelection().trim();
				if (!sel) return false;
				if (!checking) this.findLike(sel);
				return true;
			},
		});
		this.addCommand({
			id: "uses-here",
			name: "Show where the clip at the cursor is used",
			editorCheckCallback: (checking, editor, ctx) => {
				const c = ctx.file ? this.store.clipAt(ctx.file.path, editor.getCursor().line) : null;
				if (!c) return false;
				if (!checking) {
					if (c.uses.length) new UsesModal(this, c).open();
					else new Notice("This clip is not used yet.");
				}
				return true;
			},
		});
		this.addCommand({ id: "count-again", name: "Count clip uses again", callback: () => void this.store.rebuild().then(() => new Notice("Uses counted")) });
		this.addCommand({ id: "setup", name: "Pick clip folders", callback: () => this.openSetup() });
		this.addCommand({ id: "whats-new", name: "What's new", callback: () => void this.openWhatsNew() });
	}

	private addMenus() {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info) => {
				const sel = editor.getSelection().trim();
				if (sel) menu.addItem((i) => i.setSection("action").setTitle("Find clips like this").setIcon("quote").onClick(() => this.findLike(sel)));
				menu.addItem((i) => i.setSection("action").setTitle("Put a clip here").setIcon("quote").onClick(() => new ClipSuggest(this).open()));
				const c = info.file ? this.store.clipAt(info.file.path, editor.getCursor().line) : null;
				if (c) menu.addItem((i) => i.setSection("action").setTitle(c.uses.length ? `Show uses of this clip (${c.uses.length})` : "This clip is not used yet").setIcon("list").onClick(() => c.uses.length && new UsesModal(this, c).open()));
			}),
		);
	}

	private findLike(text: string) {
		const words = normalize(text).split(" ").filter((w) => w.length > 3);
		if (words.length <= 4) {
			this.openLibrary({ text: words.join(" "), sort: "relevance" });
			return;
		}
		// A long selection: the side bar ranks clips against it.
		const temp = { id: "", text, norm: normalize(text), places: [], kind: "note", source: "", author: "", url: "", clipped: 0, tags: [], words: [], uses: [] } as unknown as Clip;
		temp.words = normalize(text).split(" ");
		this.openLibrary({ text: likeQuery(temp), sort: "relevance" });
	}

	// -----------------------------------------------------------------------
	// Views
	// -----------------------------------------------------------------------

	openLibrary(part: Partial<Query> = {}) {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(LIBRARY_VIEW)[0];
		const done = () => {
			const view = leaf?.view;
			if (view instanceof LibraryView && Object.keys(part).length) view.setQuery(part);
			if (leaf) void ws.revealLeaf(leaf);
		};
		if (leaf) return done();
		leaf = ws.getLeaf("tab");
		void leaf.setViewState({ type: LIBRARY_VIEW, active: true }).then(done);
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

	openReview() {
		if (!this.store.ready) {
			new Notice(this.settings.folders.length ? "Still reading your clips. Try again in a moment." : "Pick your clip folders first.");
			if (!this.settings.folders.length) this.openSetup();
			return;
		}
		if (!this.reviewLeft()) {
			new Notice("Nothing to review today. New clips come tomorrow.");
			return;
		}
		new ReviewModal(this).open();
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

export const WHATS_NEW_VIEW = "obsi-clips-whats-new";

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
		private plugin: ObsiClips,
	) {
		super(leaf);
	}

	getViewType() {
		return WHATS_NEW_VIEW;
	}
	getDisplayText() {
		return "What's new in Obsi Clips";
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
		page.createEl("p", { cls: "oc-wn-lead", text: fresh.length ? `Obsi Clips is now ${latest}. Here is what changed since ${this.since}.` : `Obsi Clips ${latest}.` });
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
				new Notice("Turn it on again in Settings, Obsi Clips");
			});
		}
	}
}
