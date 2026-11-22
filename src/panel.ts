// The side bar: clips that fit the note you are writing. In a clip note it lists that note's clips and their uses.
import { ItemView, MarkdownView, Platform, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import type ClipsPlugin from "./main";
import { blend, Relater } from "./relate";
import { GET_MB } from "./meaning";
import { clipCard, clipsByMeaning, type CardOptions } from "./ui";
import type { Clip } from "./model";
import { fuzzyMatch, plural } from "./text";
import { holdFocus, listKeys, searchKeys, viewScope } from "./vim";

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
	/** How many clips for this note are shown. Starts small so the side bar stays calm. */
	private shown = 0;
	/** Find by meaning for one search: null while AI looks. */
	private meaning: { query: string; clips: Clip[] | null } | null = null;

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
		const keys = { plugin: this.plugin, list: this.bodyEl, search: this.searchEl };
		this.registerDomEvent(this.searchEl, "keydown", searchKeys(keys, () => {
			this.searchEl.value = "";
			void this.draw();
		}));
		this.registerDomEvent(this.bodyEl, "keydown", listKeys(keys));
		viewScope(this, keys);

		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf?.view instanceof MarkdownView) this.follow(leaf.view.file);
		}));
		this.registerEvent(this.app.workspace.on("file-open", (f) => {
			if (f && f.extension === "md") this.follow(f);
		}));
		this.registerEvent(this.app.workspace.on("editor-change", (_e, info) => {
			if (!info.file || info.file !== this.file) return;
			const when = this.plugin.settings.panelUpdate;
			if (when !== "switch") this.soon(when === "live" ? 1500 : 8000);
		}));
		this.registerEvent(this.plugin.store.on("change", () => this.soon(200)));
		this.registerEvent(this.plugin.store.on("state", () => this.soon(200)));
		this.follow(this.plugin.target.file());
	}

	private follow(f: TFile | null) {
		if (f === this.file && f) return;
		this.file = f;
		this.picks = null;
		this.showUsed = this.plugin.settings.panelUsed === "open";
		this.shown = 0;
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
		const back = holdFocus(this.bodyEl);
		await this.drawNow();
		back();
	}

	private async drawNow() {
		const store = this.plugin.store;
		const body = this.bodyEl;
		const head = this.headEl;
		head.empty();
		body.empty();
		const f = this.file;
		const query = this.searchEl.value.trim();

		if (this.plugin.store.needsFolders) {
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
			for (const h of hits) clipCard(body, this.plugin, h.c, { ...this.look(), ranges: h.m?.ranges.filter((r) => r[1] <= h.c.text.length) });
			// Meaning search on this device: clips close in meaning, right away, with no AI.
			const meaning = this.plugin.meaning;
			if (meaning.usable("search")) {
				const pool = store.clips.filter((c) => !store.state(c.id).arch);
				const near = meaning.near(query, pool, new Set(hits.map((h) => h.c.id)), 40);
				if (near.length) {
					body.createDiv({ cls: "oc-divider", text: "Close in meaning" });
					for (const n of near) clipCard(body, this.plugin, n.clip, this.look());
				} else if (meaning.waking) {
					body.createDiv({ cls: "oc-loading oc-pad", text: meaning.state === "getting" ? "Getting the meaning model…" : "Starting meaning search…" });
					return;
				}
				this.deeper(body, query, new Set([...hits.map((h) => h.c.id), ...near.map((n) => n.clip.id)]));
				return;
			}
			const m = this.meaning?.query === query ? this.meaning : null;
			if (m) {
				if (!m.clips) body.createDiv({ cls: "oc-loading oc-pad", text: "AI is looking…" });
				else if (!m.clips.length)
					body.createDiv({ cls: "oc-muted oc-pad", text: this.plugin.ai.lastError ? "AI did not answer. " + this.plugin.ai.lastError : "Nothing close in meaning either. Try other words." });
				else {
					body.createDiv({ cls: "oc-divider", text: "Found by AI" });
					for (const c of m.clips.slice(0, 40)) clipCard(body, this.plugin, c, this.look());
				}
			} else if (!hits.length) {
				const ai = this.plugin.ai.usable();
				const getting = meaning.waking;
				this.empty(
					"No clips match",
					ai ? "Try other words, or let AI look for clips that mean the same thing." : getting ? "Getting the meaning model…" : `Try other words. Or find clips that mean the same thing. This gets a small model once (${GET_MB} MB).`,
					getting ? "" : "Find by meaning",
					() => (ai ? void this.findByMeaning(query) : void this.plugin.getMeaning()),
				);
			}
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

		// A drawing is not writing: no clips for it, but search still works.
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
		if (!this.plugin.settings.panelDrawings && (f.path.endsWith(".excalidraw.md") || fm?.["excalidraw-plugin"] !== undefined)) {
			this.empty("A drawing", "Clips show for notes you write. Search above to find one.", "", () => undefined);
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
		// Meaning search on this device: clips close in meaning join the clips that share words.
		const byMeaning = this.plugin.meaning.usable("sidebar") && text.trim().split(/\s+/).length >= 5;
		if (byMeaning) {
			const near = this.plugin.meaning.near(f.basename + ". " + text, store.clips, skip, this.plugin.settings.panelCount + 10, 1024);
			order = blend(ranked, near.map((n) => n.clip.id));
		}
		if (!byMeaning && this.picks && this.picksFor === f.path) {
			const pickSet = new Set(this.picks);
			order = [...this.picks.map((id) => ranked.find((r) => r.id === id)).filter((r): r is (typeof ranked)[number] => !!r), ...ranked.filter((r) => !pickSet.has(r.id))];
		}
		const max = Math.min(order.length, this.plugin.settings.panelCount);
		order = order.slice(0, Math.min(this.shown || this.step, max));

		head.createDiv({ cls: "oc-panel-title", text: "For this note" });
		head.createDiv({ cls: "oc-panel-sub", text: f.basename });

		if (usedHere.length && this.plugin.settings.panelUsed !== "hidden") {
			const sec = body.createDiv({ cls: "oc-used-here" + (this.showUsed ? " is-open" : "") });
			const h = sec.createEl("button", { cls: "oc-used-here-head", attr: { type: "button", "aria-expanded": String(this.showUsed) } });
			setIcon(h.createSpan({ cls: "oc-group-chev" }), "chevron-right");
			h.createSpan({ text: `Used in this note (${usedHere.length})` });
			h.addEventListener("click", () => {
				this.showUsed = !this.showUsed;
				void this.draw();
			});
			if (this.showUsed) for (const c of usedHere) clipCard(sec, this.plugin, c, this.look());
		}

		if (!order.length) {
			body.createDiv({ cls: "oc-muted oc-pad", text: text.trim().split(/\s+/).length < 5 ? "Write a few lines, and clips that fit show here." : "No clips fit this note yet. Search above to find one." });
		}
		for (const r of order) {
			const c = store.byId.get(r.id);
			if (c) clipCard(body, this.plugin, c, this.look(r.why));
		}
		if (order.length < max) {
			const more = body.createEl("button", { cls: "oc-link-btn oc-more", text: this.plugin.settings.panelMore === "all" ? `Show all ${max}` : `Show ${Math.min(this.step, max - order.length)} more`, attr: { type: "button" } });
			more.addEventListener("click", () => {
				this.shown = this.plugin.settings.panelMore === "all" ? max : (this.shown || this.step) + this.step;
				void this.draw();
			});
		}

		// Quietly reorder by meaning when AI is set up: once per note, after the text settles.
		if (!byMeaning && this.plugin.ai.usable() && this.plugin.settings.ai.meaning && this.plugin.settings.ai.order && !this.picks && ranked.length >= 3 && text.split(/\s+/).length >= 25) {
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

	/** How many clips show at first and with each Show more. */
	private get step(): number {
		return Math.max(1, this.plugin.settings.panelFirst || 5);
	}

	/** Card options for the look picked in Settings. */
	private look(why?: string[]): CardOptions {
		const look = this.plugin.settings.panelLook;
		if (look === "detailed") return { compact: true, why };
		if (look === "text") return { quiet: true, textOnly: true };
		return { quiet: true };
	}

	/** The cursor in the search box, from the command. */
	focusSearch() {
		this.searchEl.focus();
		this.searchEl.select();
	}

	private async findByMeaning(query: string) {
		this.meaning = { query, clips: null };
		void this.draw();
		const store = this.plugin.store;
		const pool = store.clips.filter((c) => !store.state(c.id).arch);
		const clips = await clipsByMeaning(this.plugin, query, pool, new Set(), true);
		if (this.meaning?.query !== query) return;
		this.meaning = { query, clips };
		void this.draw();
	}

	/**
	 * Under the results from this device: AI can look deeper, when it is set up. With nothing found, a box with a
	 * button. With results, a small link under them. AI's finds go in their own part, without repeats.
	 */
	private deeper(body: HTMLElement, query: string, shown: Set<string>) {
		const m = this.meaning?.query === query ? this.meaning : null;
		const ai = this.plugin.ai;
		const none = shown.size === 0;
		if (m && !m.clips) {
			body.createDiv({ cls: "oc-loading oc-pad", text: "AI is looking…" });
			return;
		}
		if (m) {
			const fresh = (m.clips ?? []).filter((c) => !shown.has(c.id));
			if (fresh.length) {
				body.createDiv({ cls: "oc-divider", text: "Found by AI" });
				for (const c of fresh.slice(0, 40)) clipCard(body, this.plugin, c, this.look());
			} else if (none) this.empty("No clips match", ai.lastError ? "AI did not answer. " + ai.lastError : "AI found nothing either. Try other words.", "", () => undefined);
			else body.createDiv({ cls: "oc-muted oc-pad", text: ai.lastError ? "AI did not answer. " + ai.lastError : "AI found nothing more." });
			return;
		}
		if (!ai.usable()) {
			if (none) this.empty("No clips match", "Nothing close in meaning either. Try other words.", "", () => undefined);
			return;
		}
		if (none) this.empty("No clips match", "Nothing close in meaning either. AI can look deeper.", "Search deeper with AI", () => void this.findByMeaning(query));
		else body.createEl("button", { cls: "oc-link-btn oc-more oc-deeper", text: "Search deeper with AI", attr: { type: "button" } }).addEventListener("click", () => void this.findByMeaning(query));
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

