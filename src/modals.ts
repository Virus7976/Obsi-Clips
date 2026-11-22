// Review, Tidy, the quick clip search, and first-time setup.
import { Modal, Notice, Platform, SuggestModal, setIcon, type App } from "obsidian";
import type ClipsPlugin from "./main";
import { nearCopies } from "./match";
import { keepLater, KEEP_STEPS, runQuery, EMPTY_QUERY, type Clip, type Hit } from "./model";
import { parseClips } from "./parse";
import { clipCard, FolderPicker, kindIcon, markText, NotePicker, usedLabel, when } from "./ui";
import { clip as cut, plural } from "./text";

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * A few clips a day, the ones you have not used first. For each: put it in a note now, keep it for later
 * (it comes back in 7, 21, 60, then 180 days), star it, or archive it.
 */
export class ReviewModal extends Modal {
	private at = 0;
	private ids: string[] = [];
	private tally = { used: 0, kept: 0, archived: 0 };

	constructor(private plugin: ClipsPlugin) {
		super(plugin.app);
	}

	onOpen() {
		this.modalEl.addClass("oc-modal", "oc-review-modal");
		const d = this.plugin.daily();
		this.ids = d.ids.filter((id) => this.plugin.store.byId.has(id) && !d.done.includes(id));
		this.draw();
		this.scope.register([], "ArrowRight", () => this.act("keep"));
		this.scope.register([], "k", () => this.act("keep"));
		this.scope.register([], "u", () => this.act("use"));
		this.scope.register([], "s", () => this.act("star"));
		this.scope.register([], "a", () => this.act("archive"));
	}

	private current(): Clip | undefined {
		return this.plugin.store.byId.get(this.ids[this.at]);
	}

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		const c = this.current();
		if (!c) {
			this.setTitle("Review");
			this.done();
			return;
		}
		this.setTitle(`Review · ${this.at + 1} of ${this.ids.length}`);
		const dots = contentEl.createDiv({ cls: "oc-dots" });
		this.ids.forEach((_, i) => dots.createSpan({ cls: "oc-dot" + (i < this.at ? " is-done" : i === this.at ? " is-now" : "") }));

		const p = c.places[0];
		const card = contentEl.createDiv({ cls: "oc-review-card" });
		if (p.color) card.dataset.color = p.color;
		card.createDiv({ cls: "oc-review-text", text: c.text });
		if (p.note.trim()) card.createDiv({ cls: "oc-note", text: p.note.trim() });
		const meta = card.createDiv({ cls: "oc-meta" });
		const src = meta.createEl("button", { cls: "oc-src is-link", attr: { type: "button" } });
		setIcon(src.createSpan({ cls: "oc-src-icon" }), kindIcon(c.kind));
		src.createSpan({ text: c.source + (p.where ? " · " + p.where : "") });
		src.addEventListener("click", () => {
			this.close();
			void this.plugin.openPlace(c);
		});
		meta.createSpan({ cls: "oc-used" + (c.uses.length ? " is-used" : ""), text: usedLabel(c) });
		meta.createSpan({ cls: "oc-date", text: "Clipped " + when(c.clipped) });

		const st = this.plugin.store.state(c.id);
		const next = KEEP_STEPS[Math.min(st.step ?? 0, KEEP_STEPS.length - 1)];
		const bar = contentEl.createDiv({ cls: "oc-review-actions" });
		const btn = (label: string, hint: string, icon: string, act: string, cta = false) => {
			const b = bar.createEl("button", { cls: "oc-review-btn" + (cta ? " mod-cta" : ""), attr: { type: "button" } });
			setIcon(b.createSpan({ cls: "oc-review-ico" }), icon);
			b.createSpan({ cls: "oc-review-label", text: label });
			if (hint && !Platform.isMobile) b.createSpan({ cls: "oc-review-key", text: hint });
			b.addEventListener("click", () => this.act(act));
		};
		btn("Put in a note", "U", "corner-down-left", "use", true);
		btn(`Keep · back in ${next} days`, "K", "clock", "keep");
		btn(st.star ? "Starred" : "Star", "S", "star", "star");
		btn("Archive", "A", "archive", "archive");
	}

	private act(what: string) {
		const c = this.current();
		if (!c) return;
		const store = this.plugin.store;
		const st = store.state(c.id);
		if (what === "star") {
			store.setState(c.id, { ...st, star: st.star ? undefined : 1 });
			this.draw();
			return;
		}
		if (what === "use") {
			new NotePicker(this.app, (f) => {
				void this.plugin.putInFile(c, f).then((ok) => {
					if (!ok) return;
					store.setState(c.id, { ...store.state(c.id), seen: Date.now() });
					this.tally.used++;
					this.next(c.id);
				});
			}).open();
			return;
		}
		if (what === "keep") {
			store.setState(c.id, keepLater(st));
			this.tally.kept++;
		} else if (what === "archive") {
			store.setState(c.id, { ...st, arch: 1, seen: Date.now() });
			this.tally.archived++;
		}
		this.next(c.id);
	}

	private next(id: string) {
		this.plugin.markReviewed(id);
		this.at++;
		this.draw();
	}

	private done() {
		const { contentEl } = this;
		const box = contentEl.createDiv({ cls: "oc-empty" });
		setIcon(box.createDiv({ cls: "oc-empty-icon" }), "check-circle");
		box.createDiv({ cls: "oc-empty-title", text: "All done for today" });
		const t = this.tally;
		const parts = [t.used && `${t.used} put in notes`, t.kept && `${t.kept} kept for later`, t.archived && `${t.archived} archived`].filter(Boolean);
		box.createDiv({ cls: "oc-empty-text", text: parts.length ? parts.join(", ") + "." : "New clips come tomorrow." });
		const row = box.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: "Open the library", cls: "mod-cta" }).addEventListener("click", () => {
			this.close();
			this.plugin.openLibrary({ use: "unused" });
		});
		row.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Quick search: put a clip in
// ---------------------------------------------------------------------------

/**
 * Search every clip like the quick switcher and put one in the note. Enter puts it in as a quote,
 * Shift+Enter as an embed, Ctrl/Cmd+Enter copies it.
 */
export class ClipSuggest extends SuggestModal<Hit> {
	constructor(
		private plugin: ClipsPlugin,
		private onPick?: (c: Clip, how: "quote" | "embed" | "copy") => void,
		private initial = "",
	) {
		super(plugin.app);
		this.modalEl.addClass("oc-suggest");
		this.setPlaceholder("Search clips, #tag, is:unused");
		this.limit = 80;
		this.setInstructions([
			{ command: "↵", purpose: "put in" },
			{ command: "shift ↵", purpose: "embed" },
			{ command: Platform.isMacOS ? "cmd ↵" : "ctrl ↵", purpose: "copy" },
		]);
		this.scope.register(["Shift"], "Enter", (e) => this.pickWith(e, "embed"));
		this.scope.register(["Mod"], "Enter", (e) => this.pickWith(e, "copy"));
		// With no search, the clips that fit the open note come first.
		const f = plugin.target.file();
		if (f) {
			void plugin.rankForNote(f).then((ids) => {
				this.forNote = ids;
				if (!this.inputEl.value.trim()) this.inputEl.dispatchEvent(new Event("input"));
			});
		}
	}

	private forNote: string[] = [];

	onOpen() {
		void super.onOpen();
		// Set after opening: opening clears the box.
		if (this.initial) {
			this.inputEl.value = this.initial;
			this.inputEl.select();
			this.inputEl.dispatchEvent(new Event("input"));
		}
	}

	private pickWith(e: KeyboardEvent, how: "embed" | "copy") {
		e.preventDefault();
		const chooser = (this as unknown as { chooser?: { values?: Hit[]; selectedItem?: number } }).chooser;
		const h = chooser?.values?.[chooser.selectedItem ?? 0];
		if (!h) return false;
		this.close();
		this.choose(h.clip, how);
		return false;
	}

	private choose(c: Clip, how: "quote" | "embed" | "copy") {
		if (this.onPick) this.onPick(c, how);
		else if (how === "copy") void this.plugin.copyClip(c, "quote");
		else void this.plugin.putClip(c, how);
	}

	getSuggestions(query: string): Hit[] {
		const q = { ...EMPTY_QUERY, text: query, sort: query.trim() ? ("relevance" as const) : ("lastUsed" as const) };
		const hits = runQuery(this.plugin.store.clips, this.plugin.data.clips, q);
		if (!query.trim()) {
			// With no search: the clips that fit this note, then clips used lately, then the newest.
			const rank = new Map(this.forNote.map((id, i) => [id, i]));
			hits.sort(
				(a, b) =>
					(rank.get(a.clip.id) ?? 1e9) - (rank.get(b.clip.id) ?? 1e9) ||
					(b.clip.uses[0]?.since ?? 0) - (a.clip.uses[0]?.since ?? 0) ||
					b.clip.clipped - a.clip.clipped,
			);
		}
		return hits.slice(0, this.limit);
	}

	renderSuggestion(h: Hit, el: HTMLElement) {
		el.addClass("oc-sugg");
		const c = h.clip;
		if (c.places[0].color) el.dataset.color = c.places[0].color;
		markText(el.createDiv({ cls: "oc-sugg-text" }), cut(c.text, 240), h.ranges.filter((r) => r[1] <= Math.min(240, c.text.length)));
		const meta = el.createDiv({ cls: "oc-meta" });
		const src = meta.createSpan({ cls: "oc-src" });
		setIcon(src.createSpan({ cls: "oc-src-icon" }), kindIcon(c.kind));
		src.createSpan({ text: c.source + (c.places[0].where ? " · " + c.places[0].where : "") });
		meta.createSpan({ cls: "oc-used" + (c.uses.length ? " is-used" : ""), text: usedLabel(c) });
	}

	onChooseSuggestion(h: Hit) {
		this.choose(h.clip, "quote");
	}
}

// ---------------------------------------------------------------------------
// Tidy
// ---------------------------------------------------------------------------

type TidyTab = "same" | "near" | "untagged" | "broken";

/** Problems worth a look: the same clip in two notes, near copies, clips with no tags, and broken clip links. */
export class TidyModal extends Modal {
	private tab: TidyTab = "same";

	constructor(private plugin: ClipsPlugin) {
		super(plugin.app);
	}

	onOpen() {
		this.modalEl.addClass("oc-modal", "oc-tidy-modal");
		this.setTitle("Tidy clips");
		this.draw();
	}

	private live(): Clip[] {
		return this.plugin.store.clips.filter((c) => !this.plugin.store.state(c.id).arch);
	}

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		const live = this.live();
		const same = live.filter((c) => c.places.length > 1);
		const near = nearCopies(live.map((c) => ({ id: c.id, norm: c.norm })));
		const untagged = live.filter((c) => !c.tags.length);
		const broken = this.broken();
		const tabs = contentEl.createDiv({ cls: "oc-tabs", attr: { role: "tablist" } });
		const tab = (id: TidyTab, label: string, n: number) => {
			const b = tabs.createEl("button", { cls: "oc-tab" + (this.tab === id ? " is-on" : ""), attr: { type: "button", role: "tab", "aria-selected": String(this.tab === id) } });
			b.createSpan({ text: label });
			b.createSpan({ cls: "oc-fchip-n", text: String(n) });
			b.addEventListener("click", () => {
				this.tab = id;
				this.draw();
			});
		};
		tab("same", "In two notes", same.length);
		tab("near", "Near copies", near.length);
		tab("untagged", "No tags", untagged.length);
		tab("broken", "Broken links", broken.length);
		const body = contentEl.createDiv({ cls: "oc-tidy-body" });
		const none = (t: string) => body.createDiv({ cls: "oc-muted oc-pad", text: t });

		if (this.tab === "same") {
			body.createDiv({ cls: "oc-tidy-help", text: "The same words saved in more than one note. They count as one clip. Open a note to remove the copy you do not want." });
			if (!same.length) none("No clip is saved twice.");
			for (const c of same.slice(0, 200)) {
				const box = body.createDiv({ cls: "oc-tidy-item" });
				box.createDiv({ cls: "oc-tidy-text", text: cut(c.text, 220) });
				const row = box.createDiv({ cls: "oc-tidy-places" });
				for (const p of c.places) row.createEl("button", { cls: "oc-chip", text: this.plugin.store.titleOf(p.path), attr: { type: "button" } }).addEventListener("click", () => {
					this.close();
					void this.plugin.openPlace(c, p);
				});
			}
		} else if (this.tab === "near") {
			body.createDiv({ cls: "oc-tidy-help", text: "Clips that say almost the same thing. Archive the one you do not need; your notes are not changed." });
			if (!near.length) none("No near copies found.");
			for (const [a, b] of near.slice(0, 150)) {
				const ca = this.plugin.store.byId.get(a);
				const cb = this.plugin.store.byId.get(b);
				if (!ca || !cb) continue;
				const box = body.createDiv({ cls: "oc-tidy-pair" });
				for (const c of [ca, cb]) {
					const side = box.createDiv({ cls: "oc-tidy-side" });
					side.createDiv({ cls: "oc-tidy-text", text: cut(c.text, 200) });
					side.createDiv({ cls: "oc-meta", text: `${c.source} · ${usedLabel(c)}` });
					const row = side.createDiv({ cls: "oc-tidy-places" });
					row.createEl("button", { cls: "oc-chip", text: "Open", attr: { type: "button" } }).addEventListener("click", () => {
						this.close();
						void this.plugin.openPlace(c);
					});
					row.createEl("button", { cls: "oc-chip", text: "Archive this", attr: { type: "button" } }).addEventListener("click", () => {
						this.plugin.toggleArchive(c);
						this.draw();
					});
				}
			}
		} else if (this.tab === "untagged") {
			body.createDiv({ cls: "oc-tidy-help", text: "Clips with no tags are harder to find. Add tags to many at once." });
			if (!untagged.length) none("Every clip has a tag.");
			else {
				const row = body.createDiv({ cls: "modal-button-container" });
				row.createEl("button", { text: `Tag these in the library (${untagged.length})`, cls: "mod-cta" }).addEventListener("click", () => {
					this.close();
					this.plugin.openLibrary({ text: "", group: "source" });
					new Notice("Use More, Select clips, then Tags.");
				});
			}
			for (const c of untagged.slice(0, 60)) clipCard(body, this.plugin, c, { compact: true });
		} else {
			body.createDiv({ cls: "oc-tidy-help", text: "Links and embeds to a clip block that no longer exists, so they show nothing." });
			if (!broken.length) none("No broken clip links.");
			for (const b of broken.slice(0, 200)) {
				const row = body.createEl("button", { cls: "oc-use-row", attr: { type: "button" } });
				setIcon(row.createSpan({ cls: "oc-use-icon" }), "unlink");
				const t = row.createDiv({ cls: "oc-use-body" });
				t.createDiv({ cls: "oc-use-title", text: b.from.replace(/\.md$/, "") });
				t.createDiv({ cls: "oc-use-meta", text: b.link });
				row.addEventListener("click", () => {
					this.close();
					void this.app.workspace.openLinkText(b.from, "", false, { eState: { line: b.line } });
				});
			}
		}
	}

	/** Embeds and links like [[note#^id]] into a clip note where that block id is gone. */
	private broken(): { from: string; link: string; line: number }[] {
		const out: { from: string; link: string; line: number }[] = [];
		const mc = this.app.metadataCache;
		for (const f of this.app.vault.getMarkdownFiles()) {
			const cache = mc.getFileCache(f);
			for (const l of [...(cache?.embeds ?? []), ...(cache?.links ?? [])]) {
				const at = l.link.indexOf("#^");
				if (at < 0) continue;
				const dest = mc.getFirstLinkpathDest(l.link.slice(0, at), f.path);
				if (!dest || !this.plugin.store.isSource(dest.path)) continue;
				const id = l.link.slice(at + 2).toLowerCase();
				const blocks = mc.getFileCache(dest)?.blocks ?? {};
				if (!Object.keys(blocks).some((b) => b.toLowerCase() === id)) out.push({ from: f.path, link: l.original, line: l.position.start.line });
			}
		}
		return out;
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface FolderGuess {
	path: string;
	clips: number;
	notes: number;
	on: boolean;
}

/** Finds folders that hold clips, by reading the vault once. */
export async function guessFolders(app: App): Promise<FolderGuess[]> {
	const counts = new Map<string, { clips: number; notes: number; app: number }>();
	const files = app.vault.getMarkdownFiles();
	let n = 0;
	for (const f of files) {
		const parts = f.path.split("/");
		if (parts.length < 2) continue;
		const body = await app.vault.cachedRead(f);
		if (!/==|^>|\*page |^- /m.test(body)) continue;
		const clips = parseClips(body, { marks: false });
		if (!clips.length) continue;
		// Count under the top folder, and under the second level when the top is big (like Bible/Highlights).
		const keys = [parts[0]];
		if (parts.length > 2) keys.push(parts.slice(0, 2).join("/"));
		for (const k of keys) {
			const e = counts.get(k) ?? { clips: 0, notes: 0, app: 0 };
			e.clips += clips.length;
			e.notes++;
			if (clips.some((c) => c.format !== "quote")) e.app++;
			counts.set(k, e);
		}
		if (++n % 30 === 0) await new Promise((r) => window.setTimeout(r, 0));
	}
	const out: FolderGuess[] = [];
	for (const [path, e] of counts) {
		if (e.clips < 3) continue;
		// A sub folder only shows when its parent is not offered already.
		const parent = path.includes("/") ? path.split("/")[0] : "";
		if (parent && counts.get(parent) && (counts.get(parent)?.clips ?? 0) - e.clips < 3) continue;
		if (parent && out.some((o) => o.path === parent)) continue;
		out.push({ path, clips: e.clips, notes: e.notes, on: e.app >= Math.max(1, e.notes / 3) || /clip|readest|highlight|book/i.test(path) });
	}
	return out.sort((a, b) => b.clips - a.clips).slice(0, 12);
}

/** First run: pick the clip folders. Shown on phones and computers alike. */
export class SetupModal extends Modal {
	private guesses: FolderGuess[] | null = null;

	constructor(private plugin: ClipsPlugin) {
		super(plugin.app);
	}

	onOpen() {
		this.modalEl.addClass("oc-modal", "oc-setup");
		this.setTitle("Clips");
		this.draw();
		void guessFolders(this.app).then((g) => {
			const have = this.plugin.settings.folders;
			if (have.length) for (const x of g) x.on = have.includes(x.path);
			for (const p of have) if (!g.some((x) => x.path === p)) g.unshift({ path: p, clips: 0, notes: 0, on: true });
			this.guesses = g;
			this.draw();
		});
	}

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: "Find the right clip while you write, see how often each one is used, and bring back the ones you forgot." });
		contentEl.createEl("p", { cls: "oc-setup-q", text: "Where are your clips?" });
		const whole = contentEl.createDiv({ cls: "oc-setup-row oc-setup-whole" });
		const wt = whole.createDiv({ cls: "oc-setup-label" });
		wt.createDiv({ text: "Anywhere in my vault" });
		wt.createDiv({ cls: "oc-muted", text: "Every note with highlights counts. No folders needed." });
		const wb = whole.createEl("button", { text: "Use my whole vault", cls: "mod-cta", attr: { type: "button" } });
		wb.addEventListener("click", () => {
			this.close();
			void this.plugin.useWholeVault(true);
		});
		contentEl.createEl("p", { cls: "oc-setup-q", text: "Or only in these folders:" });
		const list = contentEl.createDiv({ cls: "oc-setup-list" });
		if (!this.guesses) {
			list.createDiv({ cls: "oc-loading", text: "Looking through your vault…" });
			return;
		}
		if (!this.guesses.length) list.createDiv({ cls: "oc-muted", text: "No clip folders found. Add one below." });
		for (const g of this.guesses) {
			const row = list.createEl("label", { cls: "oc-setup-row" });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = g.on;
			box.addEventListener("change", () => (g.on = box.checked));
			const t = row.createDiv({ cls: "oc-setup-label" });
			t.createDiv({ text: g.path });
			if (g.clips) t.createDiv({ cls: "oc-muted", text: `${plural(g.clips, "clip")} in ${plural(g.notes, "note")}` });
		}
		const add = contentEl.createEl("button", { cls: "oc-link-btn", text: "Add another folder…", attr: { type: "button" } });
		add.addEventListener("click", () => {
			new FolderPicker(this.app, (f) => {
				if (!this.guesses?.some((g) => g.path === f.path)) this.guesses?.push({ path: f.path, clips: 0, notes: 0, on: true });
				this.draw();
			}).open();
		});
		const bar = contentEl.createDiv({ cls: "modal-button-container" });
		const go = bar.createEl("button", { text: "Use these folders" });
		go.addEventListener("click", () => {
			const picked = (this.guesses ?? []).filter((g) => g.on).map((g) => g.path);
			if (!picked.length) {
				new Notice("Pick at least one folder.");
				return;
			}
			this.close();
			void this.plugin.setFolders(picked, true);
		});
		bar.createEl("button", { text: "Not now" }).addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
		this.plugin.data.welcomed = true;
		this.plugin.saveSoon();
	}
}

