// Pieces shared by the screens: the clip card, the clip menu, and small pickers.
import { FuzzySuggestModal, Menu, Modal, Notice, Platform, TFile, TFolder, setIcon, type App, type FuzzyMatch } from "obsidian";
import type ClipsPlugin from "./main";
import { KINDS, type Clip, type Kind, type Place } from "./model";
import { originalLink } from "./insert";
import { fuzzyMatch, plural, type Range } from "./text";

export const kindName = (k: Kind) => KINDS.find((x) => x.id === k)?.name.replace(/s$/, "") ?? k;

const KIND_ICON: Record<Kind, string> = {
	video: "play-circle",
	article: "newspaper",
	book: "book-open",
	bible: "book-marked",
	course: "graduation-cap",
	podcast: "podcast",
	note: "file-text",
};
export const kindIcon = (k: Kind) => KIND_ICON[k] ?? "file-text";

/** "today", "yesterday", "3 days ago", "12 Nov", "12 Nov 2025". */
export function when(t: number, now = Date.now()): string {
	if (!t) return "";
	const d = new Date(t);
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const days = Math.floor((today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days} days ago`;
	const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
	if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
	return d.toLocaleDateString(undefined, opts);
}

export function usedLabel(c: Clip): string {
	return c.uses.length ? `Used ${c.uses.length}×` : "Not used yet";
}

/** Writes text with the matched ranges marked. */
export function markText(el: HTMLElement, text: string, ranges: Range[] = []): void {
	let at = 0;
	for (const [a, b] of ranges) {
		if (a < at || b > text.length) continue;
		if (a > at) el.appendText(text.slice(at, a));
		el.createEl("mark", { cls: "oc-hit", text: text.slice(a, b) });
		at = b;
	}
	if (at < text.length) el.appendText(text.slice(at));
}

export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
	const b = parent.createEl("button", { cls: "clickable-icon oc-icon-btn " + cls, attr: { "aria-label": label, type: "button" } });
	setIcon(b, icon);
	b.addEventListener("click", (e) => {
		e.stopPropagation();
		onClick(e);
	});
	return b;
}

export interface CardOptions {
	ranges?: Range[];
	/** Short card for the side bar. */
	compact?: boolean;
	/** Words that made it match, shown small. */
	why?: string[];
	/** Shown instead of the source line, for clips listed inside their own note. */
	here?: boolean;
	/** Clicking the card does this instead of opening it. */
	onOpen?: () => void;
	selected?: boolean;
	onSelect?: (on: boolean) => void;
}

/** One clip as a card: colour bar, text, note, details, tags and actions. */
/** Clips close in meaning to a search: other words from AI, matched against the clips. Best first. */
export async function clipsByMeaning(plugin: ClipsPlugin, query: string, pool: Clip[], skip: Set<string>, asked = false): Promise<Clip[]> {
	const words = await plugin.ai.meaningWords(query, asked);
	if (!words.length) return [];
	const out: { c: Clip; score: number }[] = [];
	for (const c of pool) {
		if (skip.has(c.id)) continue;
		let best = 0;
		for (const w of words) {
			const m = fuzzyMatch(w, c.text + " " + c.tags.join(" "));
			if (m && m.score >= 8) best += m.score;
		}
		if (best) out.push({ c, score: best });
	}
	return out.sort((a, b) => b.score - a.score).map((x) => x.c);
}

export function clipCard(parent: HTMLElement, plugin: ClipsPlugin, c: Clip, o: CardOptions = {}): HTMLElement {
	const st = plugin.store.state(c.id);
	const p = c.places[0];
	const card = parent.createDiv({ cls: "oc-card" + (o.compact ? " is-compact" : "") + (st.arch ? " is-archived" : "") });
	card.dataset.id = c.id;
	card.tabIndex = 0;
	card.setAttr("role", "article");
	if (p.color) card.dataset.color = p.color;
	if (o.onSelect) {
		const box = card.createEl("input", { cls: "oc-select", attr: { type: "checkbox", "aria-label": "Select" } });
		box.checked = !!o.selected;
		box.addEventListener("click", (e) => e.stopPropagation());
		box.addEventListener("change", () => o.onSelect?.(box.checked));
	}
	const main = card.createDiv({ cls: "oc-card-main" });
	const text = main.createDiv({ cls: "oc-text" });
	markText(text, c.text, o.ranges);
	const note = p.note.trim();
	if (note && !o.compact) main.createDiv({ cls: "oc-note", text: note });

	const meta = main.createDiv({ cls: "oc-meta" });
	if (!o.here) {
		const src = meta.createSpan({ cls: "oc-src" });
		setIcon(src.createSpan({ cls: "oc-src-icon" }), kindIcon(c.kind));
		src.createSpan({ text: c.source });
	}
	if (p.where) meta.createSpan({ cls: "oc-where", text: p.where });
	const used = meta.createEl("button", { cls: "oc-used" + (c.uses.length ? " is-used" : ""), text: usedLabel(c), attr: { type: "button" } });
	used.addEventListener("click", (e) => {
		e.stopPropagation();
		if (c.uses.length) new UsesModal(plugin, c).open();
	});
	if (!o.compact) meta.createSpan({ cls: "oc-date", text: when(c.clipped), attr: { title: "Clipped " + new Date(c.clipped).toLocaleDateString() } });
	if (c.places.length > 1) meta.createSpan({ cls: "oc-dupes", text: `In ${c.places.length} notes` });
	if (st.star) setIcon(meta.createSpan({ cls: "oc-star-mark", attr: { "aria-label": "Starred" } }), "star");

	if (o.why?.length) main.createDiv({ cls: "oc-why", text: "Matches " + o.why.join(", ") });
	else if (c.tags.length && !o.compact) {
		const tags = main.createDiv({ cls: "oc-tags" });
		for (const t of c.tags.slice(0, 8)) {
			const chip = tags.createEl("button", { cls: "oc-tag", text: "#" + t, attr: { type: "button" } });
			chip.addEventListener("click", (e) => {
				e.stopPropagation();
				plugin.openLibrary({ text: "#" + t });
			});
		}
	}

	const actions = card.createDiv({ cls: "oc-actions" });
	iconButton(actions, "corner-down-left", "Put in note", () => void plugin.putClip(c), "oc-put");
	iconButton(actions, "copy", "Copy as quote", () => void plugin.copyClip(c, "quote"));
	iconButton(actions, st.star ? "star-off" : "star", st.star ? "Unstar" : "Star", () => plugin.toggleStar(c));
	iconButton(actions, "more-horizontal", "More", (e) => clipMenu(plugin, c, e));

	card.addEventListener("click", (e) => {
		if ((e.target as HTMLElement).closest("button, a, input")) return;
		if (o.onOpen) o.onOpen();
		else card.toggleClass("is-open", !card.hasClass("is-open"));
	});
	card.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		clipMenu(plugin, c, e);
	});
	card.addEventListener("keydown", (e) => {
		if (e.target !== card) return;
		if (e.key === "Enter") {
			e.preventDefault();
			void plugin.putClip(c, e.shiftKey ? "embed" : undefined);
		} else if (e.key === "c" && !e.ctrlKey && !e.metaKey) void plugin.copyClip(c, "quote");
		else if (e.key === "o") void plugin.openPlace(c);
		else if (e.key === "s") plugin.toggleStar(c);
		else if (e.key === "u" && c.uses.length) new UsesModal(plugin, c).open();
		else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
			const r = card.getBoundingClientRect();
			clipMenu(plugin, c, { x: r.left + 24, y: r.top + 24 });
		}
	});
	// Drag a clip into a note: it lands as a quote.
	if (!Platform.isMobile) {
		card.draggable = true;
		card.addEventListener("dragstart", (e) => {
			const from = plugin.target.file()?.path ?? "";
			e.dataTransfer?.setData("text/plain", plugin.quoteText(c, from));
		});
	}
	return card;
}

/** Everything you can do with a clip, as one menu. */
export function clipMenu(plugin: ClipsPlugin, c: Clip, at: MouseEvent | { x: number; y: number }): void {
	const st = plugin.store.state(c.id);
	const p = c.places[0];
	const m = new Menu();
	m.addItem((i) => i.setSection("put").setTitle("Put in note").setIcon("corner-down-left").onClick(() => void plugin.putClip(c, "quote")));
	m.addItem((i) => i.setSection("put").setTitle("Put in as embed").setIcon("file-input").onClick(() => void plugin.putClip(c, "embed")));
	m.addItem((i) => i.setSection("put").setTitle("Put in as plain text").setIcon("type").onClick(() => void plugin.putClip(c, "plain")));
	m.addItem((i) => i.setSection("put").setTitle("Put in another note…").setIcon("file-plus").onClick(() => plugin.putInOther(c)));
	m.addItem((i) => i.setSection("copy").setTitle("Copy as quote").setIcon("copy").onClick(() => void plugin.copyClip(c, "quote")));
	m.addItem((i) => i.setSection("copy").setTitle("Copy text only").setIcon("clipboard").onClick(() => void plugin.copyClip(c, "text")));
	m.addItem((i) => i.setSection("copy").setTitle("Copy embed link").setIcon("link").onClick(() => void plugin.copyClip(c, "embed")));
	for (const pl of c.places.slice(0, 5)) {
		m.addItem((i) =>
			i
				.setSection("open")
				.setTitle(c.places.length > 1 ? `Open in ${plugin.store.titleOf(pl.path)}` : "Open where it was clipped")
				.setIcon("file-search")
				.onClick(() => void plugin.openPlace(c, pl)),
		);
	}
	const link = originalLink(p, c);
	if (link) m.addItem((i) => i.setSection("open").setTitle(p.where ? `Open the original at ${p.where}` : "Open the original").setIcon("external-link").onClick(() => openLink(link)));
	if (c.uses.length) m.addItem((i) => i.setSection("open").setTitle(`Show uses (${c.uses.length})`).setIcon("list").onClick(() => new UsesModal(plugin, c).open()));
	m.addItem((i) => i.setSection("keep").setTitle(st.star ? "Unstar" : "Star").setIcon(st.star ? "star-off" : "star").onClick(() => plugin.toggleStar(c)));
	m.addItem((i) => i.setSection("keep").setTitle("Edit tags…").setIcon("tags").onClick(() => new TagsModal(plugin, [c]).open()));
	m.addItem((i) => i.setSection("keep").setTitle("Clips like this").setIcon("sparkle").onClick(() => plugin.openLibrary({ text: likeQuery(c) })));
	m.addItem((i) => i.setSection("danger").setTitle(st.arch ? "Bring back" : "Archive").setIcon(st.arch ? "archive-restore" : "archive").onClick(() => plugin.toggleArchive(c)));
	if (at instanceof MouseEvent) m.showAtMouseEvent(at);
	else m.showAtPosition(at);
}

/** A search for clips like this one: its rarest words. */
export function likeQuery(c: Clip): string {
	const seen = new Set<string>();
	return c.words.filter((w) => w.length > 4 && !seen.has(w) && seen.add(w)).slice(0, 3).join(" ");
}

export function openLink(url: string): void {
	window.open(url, "_blank");
}

// ---------------------------------------------------------------------------
// Uses
// ---------------------------------------------------------------------------

const HOW_LABEL = { embed: "Embedded", link: "Linked", quote: "Quoted" } as const;

/** Where a clip is used, newest first. Tap one to open that note at the clip. */
export class UsesModal extends Modal {
	constructor(
		private plugin: ClipsPlugin,
		private clip: Clip,
	) {
		super(plugin.app);
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("oc-modal");
		this.setTitle(plural(this.clip.uses.length, "use"));
		contentEl.createDiv({ cls: "oc-uses-quote", text: this.clip.text });
		const list = contentEl.createDiv({ cls: "oc-uses" });
		for (const u of this.clip.uses) {
			const f = this.app.vault.getFileByPath(u.path);
			const row = list.createEl("button", { cls: "oc-use-row", attr: { type: "button" } });
			setIcon(row.createSpan({ cls: "oc-use-icon" }), u.how === "embed" ? "file-input" : u.how === "link" ? "link" : "quote");
			const body = row.createDiv({ cls: "oc-use-body" });
			body.createDiv({ cls: "oc-use-title", text: f?.basename ?? u.path });
			body.createDiv({ cls: "oc-use-meta", text: `${HOW_LABEL[u.how]} · ${when(u.since)}${f?.parent && f.parent.path !== "/" ? " · " + f.parent.path : ""}` });
			row.addEventListener("click", () => {
				this.close();
				void this.plugin.openUse(this.clip, u.path);
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Tags kept by this plugin for one or more clips. Tags already in the note are shown and cannot be removed
 * here (they live in the note). Tag ideas show when AI is set up.
 */
export class TagsModal extends Modal {
	private added = new Set<string>();
	private removed = new Set<string>();

	constructor(
		private plugin: ClipsPlugin,
		private clips: Clip[],
	) {
		super(plugin.app);
	}

	private own(c: Clip): string[] {
		return this.plugin.store.state(c.id).tags ?? [];
	}

	onOpen() {
		this.modalEl.addClass("oc-modal");
		this.setTitle(this.clips.length === 1 ? "Tags" : `Tags for ${plural(this.clips.length, "clip")}`);
		this.draw();
		if (this.plugin.ai.usable() && this.clips.length <= 24) void this.ideas();
	}

	private current(): string[] {
		const all = new Map<string, string>();
		for (const c of this.clips) for (const t of [...c.tags.filter((x) => !this.own(c).includes(x)), ...this.own(c)]) all.set(t.toLowerCase(), t);
		for (const t of this.added) all.set(t.toLowerCase(), t);
		for (const t of this.removed) all.delete(t.toLowerCase());
		return [...all.values()];
	}

	private fromNotes(t: string): boolean {
		return this.clips.some((c) => c.tags.some((x) => x.toLowerCase() === t.toLowerCase()) && !this.own(c).some((x) => x.toLowerCase() === t.toLowerCase()));
	}

	private ideaList: string[] = [];

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		const chips = contentEl.createDiv({ cls: "oc-tag-edit" });
		const cur = this.current();
		if (!cur.length) chips.createSpan({ cls: "oc-muted", text: "No tags yet." });
		for (const t of cur) {
			const chip = chips.createSpan({ cls: "oc-tag is-static", text: "#" + t });
			if (this.fromNotes(t)) chip.setAttr("aria-label", "From the note");
			else iconButton(chip, "x", "Remove", () => {
				this.added.delete(t);
				this.removed.add(t);
				this.draw();
			});
		}
		const input = contentEl.createEl("input", { cls: "oc-tag-input", attr: { type: "text", placeholder: "Add a tag, then Enter", enterkeyhint: "done" } });
		const sugg = contentEl.createDiv({ cls: "oc-tag-sugg" });
		const all = this.plugin.store.allTags();
		const showSugg = () => {
			sugg.empty();
			const q = input.value.trim().toLowerCase().replace(/^#/, "");
			const have = new Set(this.current().map((t) => t.toLowerCase()));
			const list = (q ? all.filter((t) => t.tag.toLowerCase().includes(q)) : all).filter((t) => !have.has(t.tag.toLowerCase())).slice(0, 12);
			for (const t of list) {
				const b = sugg.createEl("button", { cls: "oc-tag", text: "#" + t.tag, attr: { type: "button" } });
				b.addEventListener("click", () => add(t.tag));
			}
		};
		const add = (raw: string) => {
			const t = raw.trim().replace(/^#/, "").replace(/\s+/g, "-");
			if (!t) return;
			this.removed.delete(t);
			this.added.add(t);
			this.draw();
			window.setTimeout(() => this.contentEl.querySelector<HTMLInputElement>(".oc-tag-input")?.focus(), 0);
		};
		input.addEventListener("input", showSugg);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				add(input.value);
			}
		});
		showSugg();
		if (this.ideaList.length) {
			const have = new Set(this.current().map((t) => t.toLowerCase()));
			const fresh = this.ideaList.filter((t) => !have.has(t.toLowerCase()));
			if (fresh.length) {
				const box = contentEl.createDiv({ cls: "oc-ideas" });
				box.createDiv({ cls: "oc-ideas-label", text: "Ideas" });
				const row = box.createDiv({ cls: "oc-tag-sugg" });
				for (const t of fresh) row.createEl("button", { cls: "oc-tag is-idea", text: "#" + t, attr: { type: "button" } }).addEventListener("click", () => add(t));
			}
		}
		const bar = contentEl.createDiv({ cls: "modal-button-container" });
		bar.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => {
			this.save();
			this.close();
		});
		bar.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		if (!Platform.isMobile) window.setTimeout(() => input.focus(), 0);
	}

	private async ideas() {
		const ideas = await this.plugin.ai.tagIdeas(
			this.clips.map((c) => ({ id: c.id, text: c.text, note: c.places[0].note })),
			this.plugin.store.allTags().map((t) => t.tag),
		);
		const count = new Map<string, number>();
		for (const list of Object.values(ideas)) for (const t of list) count.set(t, (count.get(t) ?? 0) + 1);
		this.ideaList = [...count.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 10);
		if (this.ideaList.length && this.modalEl.isConnected) this.draw();
	}

	private save() {
		for (const c of this.clips) {
			const own = new Set(this.own(c));
			for (const t of this.added) if (!c.tags.some((x) => x.toLowerCase() === t.toLowerCase()) || own.has(t)) own.add(t);
			for (const t of this.removed) for (const o of [...own]) if (o.toLowerCase() === t.toLowerCase()) own.delete(o);
			const st = this.plugin.store.state(c.id);
			this.plugin.store.setState(c.id, { ...st, tags: [...own] });
			this.plugin.store.refreshTags(c.id);
		}
		new Notice(this.clips.length === 1 ? "Tags saved" : `Tags saved for ${plural(this.clips.length, "clip")}`);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/** Pick a note, recent ones first. Type to search like the quick switcher. */
export class NotePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private onPick: (f: TFile) => void,
		placeholder = "Put it in which note?",
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFile[] {
		const recent = this.app.workspace.getLastOpenFiles();
		const files = this.app.vault.getMarkdownFiles();
		const rank = (f: TFile) => {
			const i = recent.indexOf(f.path);
			return i < 0 ? 1000 : i;
		};
		return files.sort((a, b) => rank(a) - rank(b) || b.stat.mtime - a.stat.mtime);
	}

	getItemText(f: TFile): string {
		return f.path.replace(/\.md$/, "");
	}

	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

/** Pick a folder. */
export class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private onPick: (f: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder("Pick a folder");
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(true);
	}

	getItemText(f: TFolder): string {
		return f.path === "/" ? "(Whole vault)" : f.path;
	}

	onChooseItem(f: TFolder): void {
		this.onPick(f);
	}
}

/** Pick from a list with search (sources, tags). Used by filters. */
export class ListPicker<T> extends FuzzySuggestModal<{ label: string; hint: string; value: T }> {
	constructor(
		app: App,
		private items: { label: string; hint: string; value: T }[],
		private onPick: (v: T) => void,
		placeholder: string,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems() {
		return this.items;
	}

	getItemText(i: { label: string }) {
		return i.label;
	}

	renderSuggestion(m: FuzzyMatch<{ label: string; hint: string; value: T }>, el: HTMLElement) {
		el.addClass("oc-pick-row");
		el.createSpan({ text: m.item.label });
		if (m.item.hint) el.createSpan({ cls: "oc-pick-hint", text: m.item.hint });
	}

	onChooseItem(i: { value: T }) {
		this.onPick(i.value);
	}
}

export function placeLabel(plugin: ClipsPlugin, p: Place): string {
	return plugin.store.titleOf(p.path) + (p.where ? " · " + p.where : "");
}
