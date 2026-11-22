// The side bar: clips that fit the note you are writing. In a clip note it lists that note's clips and their uses.
import { ItemView, MarkdownView, Platform, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import type ClipsPlugin from "./main";
import { Relater } from "./relate";
import { clipCard } from "./ui";
import { fuzzyMatch, plural } from "./text";

export const PANEL_VIEW = "clips-panel";

export class PanelView extends ItemView {
	private file: TFile | null = null;
	private relater: Relater | null = null;
	private relaterFor = -1;
	private bodyEl!: HTMLElement;
	private headEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private timer = 0;
	private picks: string[] | null = null;
	private picksFor = "";
	private showUsed = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ClipsPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return PANEL_VIEW;
	}
	getDisplayText() {
		return "Clips for this note";
	}
	getIcon() {
		return "quote";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("oc-panel");
		if (Platform.isMobile) root.addClass("is-mobile");
		this.headEl = root.createDiv({ cls: "oc-panel-head" });
		const search = root.createDiv({ cls: "oc-search is-small" });
		setIcon(search.createSpan({ cls: "oc-search-icon" }), "search");
		this.searchEl = search.createEl("input", { attr: { type: "search", placeholder: "Search all clips", "aria-label": "Search all clips", enterkeyhint: "search" } });
		this.searchEl.addEventListener("input", () => void this.draw());
		this.bodyEl = root.createDiv({ cls: "oc-panel-body" });

		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf?.view instanceof MarkdownView) this.follow(leaf.view.file);
		}));
		this.registerEvent(this.app.workspace.on("file-open", (f) => {
			if (f && f.extension === "md") this.follow(f);
		}));
		this.registerEvent(this.app.workspace.on("editor-change", (_e, info) => {
			if (info.file && info.file === this.file) this.soon(1500);
		}));
		this.registerEvent(this.plugin.store.on("change", () => this.soon(200)));
		this.registerEvent(this.plugin.store.on("state", () => this.soon(200)));
		this.follow(this.plugin.target.file());
	}

	private follow(f: TFile | null) {
		if (f === this.file && f) return;
		this.file = f;
		this.picks = null;
		this.showUsed = false;
		this.soon(50);
	}

	private soon(ms: number) {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.draw(), ms);
	}

	/** The note's text without front matter, from the open editor when it is open. */
	private async noteText(): Promise<string> {
		const f = this.file;
		if (!f) return "";
		let body = "";
		const view = this.app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v): v is MarkdownView => v instanceof MarkdownView && v.file === f);
		body = view ? view.editor.getValue() : await this.app.vault.cachedRead(f);
		return body.replace(/^---\n[\s\S]*?\n---\n?/, "");
	}

	private relaterNow(): Relater {
		const store = this.plugin.store;
		if (!this.relater || this.relaterFor !== store.clips.length) {
			this.relater = new Relater(store.clips.map((c) => ({ id: c.id, words: c.words, tags: c.tags })));
			this.relaterFor = store.clips.length;
		}
		return this.relater;
	}

	async draw() {
		if (!this.bodyEl) return;
		const store = this.plugin.store;
		const body = this.bodyEl;
		const head = this.headEl;
		head.empty();
		body.empty();
		const f = this.file;
		const query = this.searchEl.value.trim();

		if (!this.plugin.settings.folders.length) {
			this.empty("No clip folders yet", "Pick the folders that hold your clips.", "Set up", () => this.plugin.openSetup());
			return;
		}
		if (!store.ready) {
			body.createDiv({ cls: "oc-loading", text: "Reading your clips…" });
			return;
		}

		// Searching shows every clip that matches, in any note.
		if (query) {
			head.createDiv({ cls: "oc-panel-title", text: "Search" });
			const hits = store.clips
				.filter((c) => !store.state(c.id).arch)
				.map((c) => ({ c, m: fuzzyMatch(query, c.text + "\n" + c.source + "\n" + c.tags.map((t) => "#" + t).join(" ")) }))
				.filter((x) => x.m)
				.sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0) || b.c.clipped - a.c.clipped)
				.slice(0, 60);
			head.createDiv({ cls: "oc-panel-sub", text: plural(hits.length, "clip") });
			for (const h of hits) clipCard(body, this.plugin, h.c, { compact: true, ranges: h.m?.ranges.filter((r) => r[1] <= h.c.text.length) });
			if (!hits.length) body.createDiv({ cls: "oc-muted oc-pad", text: "No clips match." });
			return;
		}

		if (!f) {
			this.empty("Open a note", "Clips that fit the note you are writing show here.", "", () => undefined);
			return;
		}

		// A clip note: its clips, with how often each is used.
		const own = store.byPath.get(f.path);
		if (own?.length) {
			head.createDiv({ cls: "oc-panel-title", text: "Clips in this note" });
			const used = own.filter((c) => c.uses.length).length;
			head.createDiv({ cls: "oc-panel-sub", text: `${plural(own.length, "clip")} · ${used} used` });
			const sorted = [...own].sort((a, b) => store.place(a, f.path).line - store.place(b, f.path).line);
			for (const c of sorted) {
				clipCard(body, this.plugin, c, { compact: true, here: true, onOpen: () => void this.plugin.openPlace(c, store.place(c, f.path)) });
			}
			return;
		}

		// Any other note: the clips that fit it.
		const text = await this.noteText();
		if (this.file !== f) return;
		const cache = this.app.metadataCache.getFileCache(f);
		const tags = [...(cache?.tags ?? []).map((t) => t.tag.slice(1)), ...toList(cache?.frontmatter?.tags), ...toList(cache?.frontmatter?.topics)];
		const usedHere = store.clips.filter((c) => c.uses.some((u) => u.path === f.path));
		const skip = new Set(usedHere.map((c) => c.id));
		for (const c of store.clips) if (store.state(c.id).arch) skip.add(c.id);
		const ranked = this.relaterNow().rank(f.basename + "\n" + f.basename + "\n" + text, tags, [], skip, this.plugin.settings.panelCount + 10);
		let order = ranked;
		if (this.picks && this.picksFor === f.path) {
			const pickSet = new Set(this.picks);
			order = [...this.picks.map((id) => ranked.find((r) => r.id === id)).filter((r): r is (typeof ranked)[number] => !!r), ...ranked.filter((r) => !pickSet.has(r.id))];
		}
		order = order.slice(0, this.plugin.settings.panelCount);

		head.createDiv({ cls: "oc-panel-title", text: "For this note" });
		head.createDiv({ cls: "oc-panel-sub", text: f.basename });

		if (usedHere.length) {
			const sec = body.createDiv({ cls: "oc-used-here" + (this.showUsed ? " is-open" : "") });
			const h = sec.createEl("button", { cls: "oc-used-here-head", attr: { type: "button", "aria-expanded": String(this.showUsed) } });
			setIcon(h.createSpan({ cls: "oc-group-chev" }), "chevron-right");
			h.createSpan({ text: `Used in this note (${usedHere.length})` });
			h.addEventListener("click", () => {
				this.showUsed = !this.showUsed;
				void this.draw();
			});
			if (this.showUsed) for (const c of usedHere) clipCard(sec, this.plugin, c, { compact: true });
		}

		if (!order.length) {
			body.createDiv({ cls: "oc-muted oc-pad", text: text.trim().split(/\s+/).length < 5 ? "Write a few lines, and clips that fit show here." : "No clips fit this note yet. Search above to find one." });
		}
		for (const r of order) {
			const c = store.byId.get(r.id);
			if (c) clipCard(body, this.plugin, c, { compact: true, why: r.why });
		}

		// Quietly reorder by meaning when AI is set up: once per note, after the text settles.
		if (this.plugin.ai.usable() && this.plugin.settings.ai.meaning && !this.picks && ranked.length >= 3 && text.split(/\s+/).length >= 25) {
			const forPath = f.path;
			const cands = ranked.slice(0, 16).map((r) => ({ id: r.id, text: store.byId.get(r.id)?.text ?? "" }));
			void this.plugin.ai.pickRelated(f.basename + ". " + text, cands).then((ids) => {
				if (!ids || this.file?.path !== forPath) return;
				this.picks = ids;
				this.picksFor = forPath;
				void this.draw();
			});
		}
	}

	private empty(title: string, text: string, button: string, onClick: () => void) {
		const box = this.bodyEl.createDiv({ cls: "oc-empty is-small" });
		box.createDiv({ cls: "oc-empty-title", text: title });
		box.createDiv({ cls: "oc-empty-text", text });
		if (button) box.createEl("button", { cls: "mod-cta", text: button }).addEventListener("click", onClick);
	}
}

function toList(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((s) => s.replace(/\[\[|\]\]/g, ""));
	if (typeof v === "string") return v.split(/[,\s]+/).filter(Boolean);
	return [];
}

