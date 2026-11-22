// The clip library: every clip, with search, sort (and reverse), filters, groups and select-many.
import { ItemView, Menu, Modal, Notice, Platform, setIcon, type WorkspaceLeaf } from "obsidian";
import type ClipsPlugin from "./main";
import { COLORS, GROUPS, KINDS, SORTS, filterCount, groupHits, runQuery, splitSearch, type Clip, type Hit, type Query } from "./model";
import { clipCard, iconButton, kindName, ListPicker, TagsModal } from "./ui";
import { fuzzyMatch, plural } from "./text";
import { GET_MB } from "./meaning";

export const LIBRARY_VIEW = "clips-library";
const PAGE = 60;

export class LibraryView extends ItemView {
	private q: Query;
	private searchEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private chipsEl!: HTMLElement;
	private statsEl!: HTMLElement;
	private countEl!: HTMLElement;
	private sortBtn!: HTMLButtonElement;
	private revBtn!: HTMLButtonElement;
	private filterBtn!: HTMLButtonElement;
	private groupBtn!: HTMLButtonElement;
	private selectBar!: HTMLElement;
	private hits: Hit[] = [];
	private extra: Hit[] = [];
	private shown = 0;
	private selecting = false;
	private selected = new Set<string>();
	private collapsed = new Set<string>();
	private observer: IntersectionObserver | null = null;
	private redrawTimer = 0;
	private meaningTimer = 0;
	private meaningFor = "";
	/** The search AI is looking at after Find by meaning was pressed. */
	private meaningLooking = "";

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ClipsPlugin,
	) {
		super(leaf);
		this.q = { ...plugin.settings.query };
	}

	getViewType() {
		return LIBRARY_VIEW;
	}
	getDisplayText() {
		return "Clips";
	}
	getIcon() {
		return "quote";
	}

	/** Sets the search (and optional filters) from outside, like a tag tapped on a card. */
	setQuery(part: Partial<Query>) {
		this.q = { ...this.q, ...part };
		if (this.searchEl) this.searchEl.value = this.q.text;
		this.saveQuery();
		this.refresh(true);
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("oc-library");
		if (Platform.isMobile) root.addClass("is-mobile");

		const head = root.createDiv({ cls: "oc-lib-head" });
		const top = head.createDiv({ cls: "oc-lib-top" });
		top.createEl("h2", { cls: "oc-lib-title", text: "Clips" });
		this.statsEl = top.createDiv({ cls: "oc-lib-stats" });

		const search = head.createDiv({ cls: "oc-search" });
		setIcon(search.createSpan({ cls: "oc-search-icon" }), "search");
		this.searchEl = search.createEl("input", { attr: { type: "search", placeholder: "Search clips, #tag, is:unused", "aria-label": "Search clips", enterkeyhint: "search", spellcheck: "false" } });
		this.searchEl.value = this.q.text;
		const clear = iconButton(search, "x", "Clear search", () => {
			this.searchEl.value = "";
			this.onSearch();
			this.searchEl.focus();
		}, "oc-search-clear");
		this.searchEl.addEventListener("input", () => {
			clear.toggleClass("is-hidden", !this.searchEl.value);
			this.onSearch();
		});
		clear.toggleClass("is-hidden", !this.q.text);
		this.searchEl.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.listEl.querySelector<HTMLElement>(".oc-card")?.focus();
			} else if (e.key === "Escape" && this.searchEl.value) {
				e.preventDefault();
				this.searchEl.value = "";
				this.onSearch();
			}
		});

		const bar = head.createDiv({ cls: "oc-toolbar" });
		this.sortBtn = bar.createEl("button", { cls: "oc-tool", attr: { type: "button", "aria-label": "Sort" } });
		this.sortBtn.addEventListener("click", (e) => this.sortMenu(e));
		this.revBtn = bar.createEl("button", { cls: "oc-tool oc-tool-icon", attr: { type: "button" } });
		this.revBtn.addEventListener("click", () => {
			this.q.reverse = !this.q.reverse;
			this.saveQuery();
			this.refresh();
		});
		this.filterBtn = bar.createEl("button", { cls: "oc-tool", attr: { type: "button", "aria-label": "Filter" } });
		this.filterBtn.addEventListener("click", () => new FilterModal(this.plugin, this.q, (q) => this.setQuery(q)).open());
		this.groupBtn = bar.createEl("button", { cls: "oc-tool", attr: { type: "button", "aria-label": "Group" } });
		this.groupBtn.addEventListener("click", (e) => this.groupMenu(e));
		bar.createDiv({ cls: "oc-spacer" });
		iconButton(bar, "more-vertical", "More", (e) => this.moreMenu(e), "oc-tool oc-tool-icon");

		this.chipsEl = head.createDiv({ cls: "oc-chips" });
		this.selectBar = head.createDiv({ cls: "oc-select-bar is-hidden" });
		this.countEl = root.createDiv({ cls: "oc-count" });
		this.listEl = root.createDiv({ cls: "oc-list", attr: { role: "feed", "aria-label": "Clips" } });
		this.listEl.addEventListener("keydown", (e) => this.listKeys(e));

		this.registerEvent(this.plugin.store.on("change", () => this.refreshSoon()));
		this.registerEvent(this.plugin.store.on("state", () => this.refreshSoon()));
		this.registerDomEvent(this.containerEl, "keydown", (e) => {
			if (e.key === "/" && activeDocument.activeElement !== this.searchEl && !(e.target as HTMLElement).closest("input, textarea")) {
				e.preventDefault();
				this.searchEl.focus();
			}
		});
		this.refresh(true);
	}

	async onClose() {
		this.observer?.disconnect();
	}

	private saveQuery() {
		this.plugin.settings.query = { ...this.q };
		this.plugin.saveSoon();
	}

	private onSearch() {
		// Starting a search sorts by best match; the chosen sort comes back when the search is cleared.
		const had = !!splitSearch(this.q.text).words.trim();
		const has = !!splitSearch(this.searchEl.value).words.trim();
		if (!had && has && this.q.sort === "clipped") this.q.sort = "relevance";
		if (had && !has && this.q.sort === "relevance") this.q.sort = "clipped";
		this.q.text = this.searchEl.value;
		this.saveQuery();
		this.refresh(true);
	}

	private refreshSoon() {
		window.clearTimeout(this.redrawTimer);
		this.redrawTimer = window.setTimeout(() => this.refresh(), 150);
	}

	/** Runs the query and draws. Keeps the scroll place unless the search changed. */
	refresh(reset = false) {
		if (!this.listEl) return;
		const store = this.plugin.store;
		this.hits = runQuery(store.clips, this.plugin.data.clips, this.q);
		const words = splitSearch(this.q.text).words.trim();
		if (words !== this.meaningFor) this.extra = [];
		// Meaning search on this device is fast, so it runs before the list is drawn.
		if (words && this.plugin.meaning.usable("search")) this.nearLocal(words);
		this.drawHead();
		const scroll = this.listEl.scrollTop;
		this.draw();
		if (!reset) this.listEl.scrollTop = scroll;
		else this.listEl.scrollTop = 0;
		if (words && this.plugin.ai.usable() && this.plugin.settings.ai.meaning && words !== this.meaningFor && !this.plugin.meaning.usable("search")) {
			window.clearTimeout(this.meaningTimer);
			this.meaningTimer = window.setTimeout(() => void this.addMeaning(words), 700);
		}
	}

	/** Clips close in meaning, from meaning search on this device. */
	private nearLocal(words: string) {
		this.meaningFor = words;
		const have = new Set(this.hits.map((h) => h.clip.id));
		const base = runQuery(this.plugin.store.clips, this.plugin.data.clips, { ...this.q, text: this.q.text.replace(words, "").trim() });
		this.extra = this.plugin.meaning.near(words, base.map((h) => h.clip), have, 40).map((n) => ({ clip: n.clip, score: n.sim, ranges: [] }));
	}

	/** After meaning search is turned on or off, or its model arrives. */
	meaningChanged() {
		this.meaningFor = "";
		this.extra = [];
		this.refresh(false);
	}

	/** Also finds clips close in meaning: other words for the search, matched against your clips. */
	private async addMeaning(words: string) {
		const extraWords = await this.plugin.ai.meaningWords(words, this.meaningLooking === words);
		if (splitSearch(this.q.text).words.trim() !== words) return;
		this.meaningFor = words;
		if (!extraWords.length) return;
		const have = new Set(this.hits.map((h) => h.clip.id));
		const base = runQuery(this.plugin.store.clips, this.plugin.data.clips, { ...this.q, text: this.q.text.replace(words, "").trim() });
		const out: Hit[] = [];
		for (const h of base) {
			if (have.has(h.clip.id)) continue;
			let best = 0;
			for (const w of extraWords) {
				const m = fuzzyMatch(w, h.clip.text + " " + h.clip.tags.join(" "));
				if (m && m.score >= 8) best += m.score;
			}
			if (best) out.push({ clip: h.clip, score: best, ranges: [] });
		}
		out.sort((a, b) => b.score - a.score);
		this.extra = out.slice(0, 40);
		if (this.extra.length) this.draw();
	}

	private drawHead() {
		const store = this.plugin.store;
		const all = store.clips.filter((c) => !store.state(c.id).arch);
		const used = all.filter((c) => c.uses.length).length;
		const week = Date.now() - 7 * 86400000;
		const thisWeek = all.filter((c) => c.uses.some((u) => u.since >= week)).length;
		this.statsEl.empty();
		if (!store.ready) {
			this.statsEl.setText(!this.plugin.store.needsFolders ? "Reading your clips…" : "");
		} else {
			const stat = (label: string, onClick?: () => void) => {
				const b = this.statsEl.createEl(onClick ? "button" : "span", { cls: "oc-stat", text: label });
				if (onClick) b.addEventListener("click", onClick);
			};
			stat(plural(all.length, "clip"));
			stat(`${used.toLocaleString()} used${all.length ? ` (${Math.round((used / all.length) * 100)}%)` : ""}`, () => this.setQuery({ use: "used", sort: "lastUsed", reverse: false }));
			if (thisWeek) stat(`${thisWeek} this week`, () => this.setQuery({ use: "used", sort: "lastUsed", reverse: false }));
			const due = this.plugin.reviewLeft();
			if (due) {
				const r = this.statsEl.createEl("button", { cls: "oc-stat oc-review-btn", text: `Review ${due}` });
				r.addEventListener("click", () => this.plugin.openReview());
			}
			if (store.scanning) this.statsEl.createSpan({ cls: "oc-stat oc-muted", text: "Counting uses…" });
		}

		const sort = SORTS.find((s) => s.id === this.q.sort) ?? SORTS[1];
		const searching = !!splitSearch(this.q.text).words;
		const shownSort = this.q.sort === "relevance" && !searching ? SORTS[1] : sort;
		this.sortBtn.empty();
		setIcon(this.sortBtn.createSpan({ cls: "oc-tool-ico" }), "arrow-up-down");
		this.sortBtn.createSpan({ cls: "oc-tool-label", text: shownSort.name });
		this.revBtn.empty();
		setIcon(this.revBtn, this.q.reverse ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
		this.revBtn.setAttr("aria-label", this.q.reverse ? "Reversed: tap for normal order" : "Reverse the order");
		this.revBtn.toggleClass("is-active", this.q.reverse);

		const n = filterCount(this.q);
		this.filterBtn.empty();
		setIcon(this.filterBtn.createSpan({ cls: "oc-tool-ico" }), "list-filter");
		this.filterBtn.createSpan({ cls: "oc-tool-label", text: "Filter" });
		if (n) this.filterBtn.createSpan({ cls: "oc-badge", text: String(n) });
		this.filterBtn.toggleClass("is-active", n > 0);

		this.groupBtn.empty();
		setIcon(this.groupBtn.createSpan({ cls: "oc-tool-ico" }), "layers");
		this.groupBtn.createSpan({ cls: "oc-tool-label", text: this.q.group === "none" ? "Group" : GROUPS.find((g) => g.id === this.q.group)?.name ?? "Group" });
		this.groupBtn.toggleClass("is-active", this.q.group !== "none");

		this.drawChips();
		this.drawSelectBar();
	}

	private drawChips() {
		const q = this.q;
		const el = this.chipsEl;
		el.empty();
		const chip = (label: string, off: () => void) => {
			const c = el.createEl("button", { cls: "oc-chip", attr: { type: "button", "aria-label": "Remove filter " + label } });
			c.createSpan({ text: label });
			setIcon(c.createSpan({ cls: "oc-chip-x" }), "x");
			c.addEventListener("click", () => {
				off();
				this.saveQuery();
				this.refresh(true);
			});
		};
		for (const k of q.kinds) chip(KINDS.find((x) => x.id === k)?.name ?? k, () => (q.kinds = q.kinds.filter((x) => x !== k)));
		for (const c of q.colors) chip(c[0].toUpperCase() + c.slice(1), () => (q.colors = q.colors.filter((x) => x !== c)));
		if (q.use !== "any") chip(q.use === "unused" ? "Not used yet" : q.use === "used" ? "Used" : "Used 3+ times", () => (q.use = "any"));
		if (q.saved !== "any") chip(q.saved === "starred" ? "Starred" : "Archived", () => (q.saved = "any"));
		if (q.noted !== "any") chip(q.noted === "yes" ? "Has my note" : "No note", () => (q.noted = "any"));
		if (q.since !== "any") chip(q.since === "365" ? "Last year" : `Last ${q.since} days`, () => (q.since = "any"));
		for (const t of q.tags) chip("#" + t, () => (q.tags = q.tags.filter((x) => x !== t)));
		for (const s of q.sources) chip(this.plugin.store.titleOf(s), () => (q.sources = q.sources.filter((x) => x !== s)));
		if (filterCount(q) > 1) {
			const all = el.createEl("button", { cls: "oc-chip-clear", text: "Clear all", attr: { type: "button" } });
			all.addEventListener("click", () => this.setQuery(clearFilters()));
		}
		el.toggleClass("is-hidden", el.childElementCount === 0);
	}

	/** Draws the list again, after a look changes in Settings. */
	redraw() {
		this.shown = 0;
		this.draw();
	}

	private draw() {
		const list = this.listEl;
		this.observer?.disconnect();
		list.empty();
		this.shown = 0;
		const store = this.plugin.store;
		const total = this.hits.length;
		this.countEl.setText(store.ready ? (total === 0 && !this.extra.length ? "" : plural(total, "clip")) : "");

		if (this.plugin.store.needsFolders) {
			this.empty("No clip folders yet", "Pick the folders that hold your clips.", "Set up", () => this.plugin.openSetup());
			return;
		}
		if (!store.ready) {
			list.createDiv({ cls: "oc-loading", text: "Reading your clips…" });
			return;
		}
		if (!store.clips.length) {
			this.empty("No clips found", "Your clip folders have no highlights yet. Clip something in ObsiTube, ObsiRead, Readest or the Web Clipper.", "Change folders", () => this.plugin.openSettings());
			return;
		}
		const words = splitSearch(this.q.text).words.trim();
		if (!total && !this.extra.length && words && !filterCount(this.q)) {
			const clear = () => {
				this.searchEl.value = "";
				this.setQuery({ ...clearFilters(), text: "" });
			};
			if (this.meaningLooking === words) {
				this.empty("Looking by meaning…", "AI is looking for clips that mean the same thing.", "", () => undefined);
				return;
			}
			if (this.meaningFor === words) {
				const err = this.plugin.ai.lastError;
				this.empty("Nothing close in meaning either", err ? "AI did not answer. " + err : "Try other words.", "Clear search", clear);
				return;
			}
			const ai = this.plugin.ai.usable();
			const m = this.plugin.meaning;
			if (m.state === "getting" || m.state === "loading") {
				this.empty("Getting the meaning model…", "Then clips that mean the same thing show here.", "", () => undefined);
				return;
			}
			this.empty(
				"No clips match",
				ai ? "Try other words, or let AI look for clips that mean the same thing." : `Try other words. Or find clips that mean the same thing. This gets a small model once (${GET_MB} MB).`,
				"Find by meaning",
				() => (ai ? void this.findByMeaning(words) : void this.plugin.getMeaning()),
			);
			return;
		}
		if (!total && !this.extra.length) {
			this.empty("No clips match", filterCount(this.q) ? "Try fewer filters." : "Try other words.", filterCount(this.q) || this.q.text ? "Clear search and filters" : "", () => {
				this.searchEl.value = "";
				this.setQuery({ ...clearFilters(), text: "" });
			});
			return;
		}

		// With results by meaning, they go right after the close matches and before the loose ones.
		const nWords = splitSearch(this.q.text).words.split(/\s+/).filter(Boolean).length;
		const strong = this.extra.length ? this.hits.filter((h) => h.score >= 8 * nWords) : this.hits;
		const loose = this.extra.length ? this.hits.filter((h) => h.score < 8 * nWords) : [];
		const groups = groupHits(strong, this.q.group, kindName);
		// Cards are drawn a page at a time as you scroll, so a big library opens fast.
		const queue: (() => void)[] = [];
		for (const g of groups) {
			let body: HTMLElement = list;
			if (g.label) {
				const sec = list.createDiv({ cls: "oc-group" + (this.collapsed.has(g.key) ? " is-collapsed" : "") });
				const h = sec.createEl("button", { cls: "oc-group-head", attr: { type: "button", "aria-expanded": String(!this.collapsed.has(g.key)) } });
				setIcon(h.createSpan({ cls: "oc-group-chev" }), "chevron-down");
				h.createSpan({ cls: "oc-group-label", text: g.label });
				h.createSpan({ cls: "oc-group-count", text: String(g.hits.length) });
				h.addEventListener("click", () => {
					if (this.collapsed.has(g.key)) this.collapsed.delete(g.key);
					else this.collapsed.add(g.key);
					this.draw();
				});
				body = sec.createDiv({ cls: "oc-group-body" });
				if (this.collapsed.has(g.key)) continue;
			}
			for (const h of g.hits) queue.push(() => this.card(body, h));
		}
		if (this.extra.length) {
			queue.push(() => list.createDiv({ cls: "oc-divider", text: "Close in meaning" }));
			for (const h of this.extra) queue.push(() => this.card(list, h));
			if (loose.length) {
				queue.push(() => list.createDiv({ cls: "oc-divider", text: "Loose matches" }));
				for (const h of loose) queue.push(() => this.card(list, h));
			}
		}
		const more = () => {
			const until = Math.min(queue.length, this.shown + PAGE);
			for (; this.shown < until; this.shown++) queue[this.shown]();
			sentinel.remove();
			if (this.shown < queue.length) list.appendChild(sentinel);
		};
		const sentinel = createDiv({ cls: "oc-sentinel" });
		this.observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) more();
		}, { root: list, rootMargin: "600px" });
		this.observer.observe(sentinel);
		more();
	}

	private card(parent: HTMLElement, h: Hit) {
		const look = this.plugin.settings.libraryLook;
		clipCard(parent, this.plugin, h.clip, {
			compact: look === "compact",
			quiet: look === "text",
			textOnly: look === "text",
			ranges: h.ranges,
			selected: this.selected.has(h.clip.id),
			onSelect: this.selecting
				? (on) => {
						if (on) this.selected.add(h.clip.id);
						else this.selected.delete(h.clip.id);
						this.drawSelectBar();
					}
				: undefined,
		});
	}

	private empty(title: string, text: string, button: string, onClick: () => void) {
		const box = this.listEl.createDiv({ cls: "oc-empty" });
		setIcon(box.createDiv({ cls: "oc-empty-icon" }), "quote");
		box.createDiv({ cls: "oc-empty-title", text: title });
		box.createDiv({ cls: "oc-empty-text", text });
		if (button) box.createEl("button", { cls: "mod-cta", text: button }).addEventListener("click", onClick);
	}

	private listKeys(e: KeyboardEvent) {
		const cards = [...this.listEl.querySelectorAll<HTMLElement>(".oc-card")];
		const i = cards.indexOf(activeDocument.activeElement as HTMLElement);
		if (i < 0) return;
		if (e.key === "ArrowDown" || e.key === "j") {
			e.preventDefault();
			cards[Math.min(i + 1, cards.length - 1)].focus();
		} else if (e.key === "ArrowUp" || e.key === "k") {
			e.preventDefault();
			if (i === 0) this.searchEl.focus();
			else cards[i - 1].focus();
		}
	}

	private async findByMeaning(words: string) {
		this.meaningLooking = words;
		this.draw();
		await this.addMeaning(words);
		this.meaningLooking = "";
		this.meaningFor = words;
		this.draw();
	}

	focusSearch() {
		this.searchEl.focus();
		this.searchEl.select();
	}

	private sortMenu(e: MouseEvent) {
		const m = new Menu();
		const searching = !!splitSearch(this.q.text).words;
		for (const s of SORTS) {
			if (s.id === "relevance" && !searching) continue;
			m.addItem((i) =>
				i
					.setTitle(`${s.name}`)
					.setChecked(this.q.sort === s.id || (this.q.sort === "relevance" && !searching && s.id === "clipped"))
					.onClick(() => {
						this.q.sort = s.id;
						if (s.id === "shuffle") this.q.seed = Math.floor(Math.random() * 1e9);
						this.saveQuery();
						this.refresh(true);
					}),
			);
		}
		m.addSeparator();
		m.addItem((i) =>
			i
				.setTitle("Reverse order")
				.setIcon("arrow-up-down")
				.setChecked(this.q.reverse)
				.onClick(() => {
					this.q.reverse = !this.q.reverse;
					this.saveQuery();
					this.refresh(true);
				}),
		);
		m.showAtMouseEvent(e);
	}

	private groupMenu(e: MouseEvent) {
		const m = new Menu();
		for (const g of GROUPS)
			m.addItem((i) =>
				i
					.setTitle(g.name)
					.setChecked(this.q.group === g.id)
					.onClick(() => {
						this.q.group = g.id;
						this.collapsed.clear();
						this.saveQuery();
						this.refresh(true);
					}),
			);
		if (this.q.group !== "none") {
			m.addSeparator();
			m.addItem((i) => i.setTitle("Fold all groups").setIcon("chevrons-down-up").onClick(() => this.foldAll(true)));
			m.addItem((i) => i.setTitle("Open all groups").setIcon("chevrons-up-down").onClick(() => this.foldAll(false)));
		}
		m.showAtMouseEvent(e);
	}

	private foldAll(fold: boolean) {
		this.collapsed.clear();
		if (fold) for (const g of groupHits(this.hits, this.q.group, kindName)) this.collapsed.add(g.key);
		this.draw();
	}

	private moreMenu(e: MouseEvent) {
		const m = new Menu();
		m.addItem((i) => i.setTitle(this.selecting ? "Stop selecting" : "Select clips").setIcon("check-square").onClick(() => this.toggleSelect()));
		m.addItem((i) => i.setTitle("Review clips").setIcon("calendar-check").onClick(() => this.plugin.openReview(true)));
		m.addItem((i) => i.setTitle("Tidy clips").setIcon("wand").onClick(() => this.plugin.openTidy()));
		m.addSeparator();
		m.addItem((i) => i.setTitle("Count uses again").setIcon("refresh-cw").onClick(() => void this.plugin.store.rebuild()));
		m.addItem((i) => i.setTitle("Settings").setIcon("settings").onClick(() => this.plugin.openSettings()));
		m.showAtMouseEvent(e);
	}

	private toggleSelect() {
		this.selecting = !this.selecting;
		this.selected.clear();
		this.containerEl.toggleClass("is-selecting", this.selecting);
		this.drawSelectBar();
		this.draw();
	}

	private drawSelectBar() {
		const bar = this.selectBar;
		bar.empty();
		bar.toggleClass("is-hidden", !this.selecting);
		if (!this.selecting) return;
		const n = this.selected.size;
		bar.createSpan({ cls: "oc-select-count", text: n ? `${n} selected` : "Tap clips to select" });
		const picked = (): Clip[] => [...this.selected].map((id) => this.plugin.store.byId.get(id)).filter((c): c is Clip => !!c);
		const btn = (icon: string, label: string, run: () => void) => {
			const b = iconButton(bar, icon, label, run, "oc-tool oc-tool-icon");
			b.disabled = !n;
		};
		const allBtn = bar.createEl("button", { cls: "oc-tool", text: "All", attr: { type: "button" } });
		allBtn.addEventListener("click", () => {
			const every = this.hits.every((h) => this.selected.has(h.clip.id));
			this.selected.clear();
			if (!every) for (const h of this.hits) this.selected.add(h.clip.id);
			this.draw();
			this.drawSelectBar();
		});
		btn("star", "Star", () => {
			for (const c of picked()) this.plugin.store.setState(c.id, { ...this.plugin.store.state(c.id), star: 1 });
			new Notice(`Starred ${plural(n, "clip")}`);
		});
		btn("tags", "Tags", () => new TagsModal(this.plugin, picked()).open());
		btn("copy", "Copy as quotes", () => void this.plugin.copyMany(picked()));
		btn(this.q.saved === "archived" ? "archive-restore" : "archive", this.q.saved === "archived" ? "Bring back" : "Archive", () => {
			const back = this.q.saved === "archived";
			for (const c of picked()) {
				const st = { ...this.plugin.store.state(c.id) };
				if (back) delete st.arch;
				else st.arch = 1;
				this.plugin.store.setState(c.id, st);
			}
			new Notice(`${back ? "Brought back" : "Archived"} ${plural(n, "clip")}`);
			this.selected.clear();
		});
		iconButton(bar, "x", "Stop selecting", () => this.toggleSelect(), "oc-tool oc-tool-icon");
	}
}

function clearFilters(): Partial<Query> {
	return { kinds: [], colors: [], use: "any", saved: "any", noted: "any", since: "any", tags: [], sources: [] };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** All filters on one sheet. Changes show at once; the button says how many clips match. */
export class FilterModal extends Modal {
	private q: Query;

	constructor(
		private plugin: ClipsPlugin,
		q: Query,
		private apply: (q: Query) => void,
	) {
		super(plugin.app);
		this.q = { ...q, kinds: [...q.kinds], colors: [...q.colors], tags: [...q.tags], sources: [...q.sources] };
	}

	onOpen() {
		this.modalEl.addClass("oc-modal", "oc-filter-modal");
		this.setTitle("Filter clips");
		this.draw();
	}

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		const q = this.q;
		const store = this.plugin.store;
		const section = (title: string) => {
			const s = contentEl.createDiv({ cls: "oc-f-section" });
			s.createDiv({ cls: "oc-f-title", text: title });
			return s.createDiv({ cls: "oc-f-row" });
		};
		const toggleChip = (row: HTMLElement, label: string, on: boolean, flip: () => void, count?: number, cls = "") => {
			const b = row.createEl("button", { cls: "oc-fchip " + cls + (on ? " is-on" : ""), attr: { type: "button", "aria-pressed": String(on) } });
			b.createSpan({ text: label });
			if (count !== undefined) b.createSpan({ cls: "oc-fchip-n", text: String(count) });
			b.addEventListener("click", () => {
				flip();
				this.draw();
			});
		};
		const segment = <T extends string>(title: string, value: T, options: [T, string][], set: (v: T) => void) => {
			const row = section(title);
			row.addClass("oc-seg");
			for (const [v, label] of options) toggleChip(row, label, value === v, () => set(v));
		};

		const live = store.clips.filter((c) => !store.state(c.id).arch);
		const kindCounts = new Map<string, number>();
		for (const c of live) kindCounts.set(c.kind, (kindCounts.get(c.kind) ?? 0) + 1);
		const kinds = section("Type");
		for (const k of KINDS) {
			const n = kindCounts.get(k.id) ?? 0;
			if (!n && !q.kinds.includes(k.id)) continue;
			toggleChip(kinds, k.name, q.kinds.includes(k.id), () => (q.kinds = q.kinds.includes(k.id) ? q.kinds.filter((x) => x !== k.id) : [...q.kinds, k.id]), n);
		}

		const colorCounts = new Map<string, number>();
		for (const c of live) for (const col of new Set(c.places.map((p) => p.color).filter(Boolean))) colorCounts.set(col, (colorCounts.get(col) ?? 0) + 1);
		if (colorCounts.size || q.colors.length) {
			const colors = section("Colour");
			for (const col of COLORS) {
				const n = colorCounts.get(col) ?? 0;
				if (!n && !q.colors.includes(col)) continue;
				toggleChip(colors, col[0].toUpperCase() + col.slice(1), q.colors.includes(col), () => (q.colors = q.colors.includes(col) ? q.colors.filter((x) => x !== col) : [...q.colors, col]), n, "oc-color-chip oc-c-" + col);
			}
		}

		segment("Used", q.use, [["any", "Any"], ["unused", "Not used yet"], ["used", "Used"], ["often", "3+ times"]], (v) => (q.use = v));
		segment("Saved", q.saved, [["any", "Any"], ["starred", "Starred"], ["archived", "Archived"]], (v) => (q.saved = v));
		segment("My note", q.noted, [["any", "Any"], ["yes", "Has my note"], ["no", "No note"]], (v) => (q.noted = v));
		segment("Clipped", q.since, [["any", "Any time"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["365", "A year"]], (v) => (q.since = v));

		const tagRow = section("Tags (all must match)");
		for (const t of q.tags) toggleChip(tagRow, "#" + t, true, () => (q.tags = q.tags.filter((x) => x !== t)));
		const addTag = tagRow.createEl("button", { cls: "oc-fchip oc-add", text: "Add tag…", attr: { type: "button" } });
		addTag.addEventListener("click", () => {
			const items = store.allTags().filter((t) => !q.tags.includes(t.tag)).map((t) => ({ label: "#" + t.tag, hint: String(t.count), value: t.tag }));
			new ListPicker(this.app, items, (v) => {
				q.tags.push(v);
				this.draw();
			}, "Pick a tag").open();
		});

		const srcRow = section("Sources (any of them)");
		for (const s of q.sources) toggleChip(srcRow, store.titleOf(s), true, () => (q.sources = q.sources.filter((x) => x !== s)));
		const addSrc = srcRow.createEl("button", { cls: "oc-fchip oc-add", text: "Add source…", attr: { type: "button" } });
		addSrc.addEventListener("click", () => {
			const items = store.allSources().filter((s) => !q.sources.includes(s.path)).map((s) => ({ label: s.title, hint: String(s.count), value: s.path }));
			new ListPicker(this.app, items, (v) => {
				q.sources.push(v);
				this.draw();
			}, "Pick a source").open();
		});

		const n = runQuery(store.clips, this.plugin.data.clips, q).length;
		const bar = contentEl.createDiv({ cls: "modal-button-container oc-f-foot" });
		const reset = bar.createEl("button", { text: "Reset" });
		reset.disabled = filterCount(q) === 0;
		reset.addEventListener("click", () => {
			Object.assign(q, clearFilters());
			this.draw();
		});
		bar.createEl("button", { text: `Show ${plural(n, "clip")}`, cls: "mod-cta" }).addEventListener("click", () => {
			this.apply(q);
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
