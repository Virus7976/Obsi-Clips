// The clip index: reads clips out of the clip folders and counts where each one is used.
import { Events, TFile, type App, type CachedMetadata } from "obsidian";
import { QuoteMatcher } from "./match";
import { type Clip, type ClipState, type Kind, type Place, type Use, type UseHow } from "./model";
import { isWrittenOver, parseClips, type ParsedClip } from "./parse";
import type { PluginData } from "./settings";
import { hashId, keywords, normalize } from "./text";

export interface Host {
	app: App;
	data: PluginData;
	/** Saves data.json soon (several calls in a row save once). */
	saveSoon(): void;
	/** The plugin's own folder, for the use cache. */
	dir: string;
}

interface FileClips {
	mtime: number;
	parsed: ParsedClip[];
	writtenOver: boolean;
	meta: { title: string; author: string; url: string; clipped: number; tags: string[]; kind: Kind };
}

interface UseCache {
	v: number;
	sig: string;
	files: Record<string, [number, number, string[]]>;
}

const GENERIC_TAGS = new Set(["clippings", "clipping", "clip", "book", "books", "bible", "highlights", "highlight", "readest", "source", "article", "video"]);

const sleep = () => new Promise<void>((r) => window.setTimeout(r, 0));

export class ClipStore extends Events {
	clips: Clip[] = [];
	byId = new Map<string, Clip>();
	/** Clip note path to its clips, in note order. */
	byPath = new Map<string, Clip[]>();
	ready = false;
	scanning = false;

	private files = new Map<string, FileClips>();
	private quoteHits = new Map<string, Set<string>>();
	private sig = "";
	private matcher = new QuoteMatcher([]);
	private pending = new Set<string>();
	private timer = 0;
	private useTimer = 0;
	private generation = 0;

	constructor(private host: Host) {
		super();
	}

	private get app() {
		return this.host.app;
	}
	private get settings() {
		return this.host.data.settings;
	}
	state(id: string): ClipState {
		return this.host.data.clips[id] ?? {};
	}
	setState(id: string, next: ClipState) {
		const clean: ClipState = {};
		for (const [k, v] of Object.entries(next) as [keyof ClipState, ClipState[keyof ClipState]][]) {
			if (v === undefined || v === 0 || (Array.isArray(v) && !v.length) || (typeof v === "object" && v && !Array.isArray(v) && !Object.keys(v).length)) continue;
			(clean as Record<string, unknown>)[k] = v;
		}
		if (Object.keys(clean).length) this.host.data.clips[id] = clean;
		else delete this.host.data.clips[id];
		this.host.saveSoon();
		this.trigger("state", id);
	}

	/** True when this note path is inside one of the clip folders. */
	inFolders(path: string): boolean {
		const f = this.settings.folders;
		if (!f.length) return false;
		return f.some((d) => d === "/" || d === "" || path === d || path.startsWith(d.replace(/\/$/, "") + "/"));
	}

	private ignored(path: string): boolean {
		return this.settings.ignoreFolders.some((d) => d && (path === d || path.startsWith(d.replace(/\/$/, "") + "/")));
	}

	/** Reads every clip note again and counts uses. */
	async rebuild(): Promise<void> {
		const gen = ++this.generation;
		this.scanning = true;
		this.trigger("change");
		this.files.clear();
		const notes = this.app.vault.getMarkdownFiles().filter((f) => this.inFolders(f.path));
		let n = 0;
		for (const f of notes) {
			await this.readFile(f);
			if (++n % 40 === 0) {
				await sleep();
				if (gen !== this.generation) return;
			}
		}
		this.merge();
		this.ready = true;
		this.trigger("change");
		await this.scanUses(gen);
		if (gen === this.generation) {
			this.scanning = false;
			this.trigger("change");
		}
	}

	private async readFile(f: TFile): Promise<void> {
		const body = await this.app.vault.cachedRead(f);
		const parsed = parseClips(body, { marks: this.settings.marks, minWords: this.settings.minWords, plainQuotes: this.settings.plainQuotes });
		if (!parsed.length) {
			this.files.delete(f.path);
			return;
		}
		this.files.set(f.path, { mtime: f.stat.mtime, parsed, writtenOver: isWrittenOver(body), meta: this.metaOf(f, parsed) });
	}

	private metaOf(f: TFile, parsed: ParsedClip[]): FileClips["meta"] {
		const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(f);
		const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : Array.isArray(v) ? v.map(str).filter(Boolean).join(", ") : "");
		const unlink = (s: string) => s.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").trim();
		const title = unlink(str(fm.title)) || prettyName(f.basename);
		const author = unlink(str(fm.author ?? fm.authors ?? fm.channel ?? fm.creator));
		const url = str(fm.url ?? fm.source ?? fm.link);
		let clipped = 0;
		for (const k of ["dateCreated", "created", "clipped", "date", "readest_updated", "saved"]) {
			const v = str(fm[k]);
			const t = v ? Date.parse(v.slice(0, 10)) : NaN;
			if (!isNaN(t)) {
				clipped = t + 12 * 3600000;
				break;
			}
		}
		if (!clipped) clipped = f.stat.ctime;
		const tags = new Set<string>();
		const fmTags = fm.tags;
		const list = Array.isArray(fmTags) ? fmTags : typeof fmTags === "string" ? fmTags.split(/[,\s]+/) : [];
		for (const t of list) {
			const s = str(t).replace(/^#/, "").trim();
			if (s && !GENERIC_TAGS.has(s.toLowerCase())) tags.add(s);
		}
		const topics = fm.topics;
		for (const t of Array.isArray(topics) ? topics : typeof topics === "string" ? [topics] : []) {
			const s = unlink(str(t));
			if (s && s.split(/\s+/).length <= 2) tags.add(s.toLowerCase().replace(/\s+/g, "-"));
		}
		return { title, author, url, clipped, tags: [...tags], kind: kindOf(f.path, fm, url, parsed) };
	}

	/** Joins clips with the same words into one clip with several places. */
	private merge(): void {
		const byId = new Map<string, Clip>();
		const byPath = new Map<string, Clip[]>();
		for (const [path, fc] of this.files) {
			const here: Clip[] = [];
			for (const p of fc.parsed) {
				const norm = normalize(p.text);
				const id = hashId(norm);
				const place: Place = { path, line: p.line, endLine: p.endLine, blockId: p.blockId, format: p.format, where: p.where, link: p.link, color: p.color, note: p.note, tags: p.tags, writtenOver: fc.writtenOver };
				let c = byId.get(id);
				if (!c) {
					c = { id, text: p.text, norm, places: [], kind: fc.meta.kind, source: fc.meta.title, author: fc.meta.author, url: fc.meta.url, clipped: fc.meta.clipped, tags: [], words: [], uses: [] };
					byId.set(id, c);
				} else if (fc.meta.clipped < c.clipped) {
					// The oldest place is the main one.
					c.kind = fc.meta.kind;
					c.source = fc.meta.title;
					c.author = fc.meta.author;
					c.url = fc.meta.url;
					c.clipped = fc.meta.clipped;
				}
				if (!c.places.some((x) => x.path === path && x.line === place.line)) {
					c.places.push(place);
					const tags = new Set([...c.tags, ...p.tags, ...fc.meta.tags]);
					c.tags = [...tags];
				}
				if (!here.includes(c)) here.push(c);
			}
			byPath.set(path, here);
		}
		for (const c of byId.values()) {
			c.places.sort((a, b) => (this.files.get(a.path)?.meta.clipped ?? 0) - (this.files.get(b.path)?.meta.clipped ?? 0));
			const own = this.state(c.id).tags ?? [];
			const all = new Map<string, string>();
			for (const t of [...c.tags, ...own]) if (!all.has(t.toLowerCase())) all.set(t.toLowerCase(), t);
			c.tags = [...all.values()];
			c.words = keywords(c.text + " " + c.places.map((p) => p.note).join(" "));
			c.uses = this.byId.get(c.id)?.uses ?? [];
		}
		this.byId = byId;
		this.byPath = byPath;
		this.clips = [...byId.values()];
		const sig = hashId(this.clips.map((c) => c.id).sort().join(","));
		if (sig !== this.sig) {
			this.sig = sig;
			this.matcher = new QuoteMatcher(this.clips.map((c) => ({ id: c.id, norm: c.norm })));
		}
	}

	/** Adds tags kept by this plugin to a clip, so they show at once. */
	refreshTags(id: string): void {
		const c = this.byId.get(id);
		if (!c) return;
		const fromNotes = new Set<string>();
		for (const p of c.places) {
			for (const t of p.tags) fromNotes.add(t);
			for (const t of this.files.get(p.path)?.meta.tags ?? []) fromNotes.add(t);
		}
		const all = new Map<string, string>();
		for (const t of [...fromNotes, ...(this.state(id).tags ?? [])]) if (!all.has(t.toLowerCase())) all.set(t.toLowerCase(), t);
		c.tags = [...all.values()];
		this.trigger("change");
	}

	// -----------------------------------------------------------------------
	// Uses
	// -----------------------------------------------------------------------

	private cachePath(): string {
		return this.host.dir + "/cache.json";
	}

	private async loadCache(): Promise<UseCache | null> {
		try {
			const raw = await this.app.vault.adapter.read(this.cachePath());
			const c = JSON.parse(raw) as UseCache;
			return c.v === 1 ? c : null;
		} catch {
			return null;
		}
	}

	/** Counts embeds, block links and pasted text of every clip in every other note. */
	async scanUses(gen = this.generation): Promise<void> {
		const cache = (await this.loadCache()) ?? { v: 1, sig: "", files: {} };
		const fresh: UseCache = { v: 1, sig: this.sig, files: {} };
		const sameClips = cache.sig === this.sig;
		this.quoteHits.clear();
		const notes = this.app.vault.getMarkdownFiles();
		let n = 0;
		if (this.settings.countQuotes && !this.matcher.empty) {
			for (const f of notes) {
				// Clip notes are sources, not writing: the same quote in two books is not a use.
				if (this.ignored(f.path) || this.inFolders(f.path)) continue;
				const old = cache.files[f.path];
				let ids: string[];
				if (sameClips && old && old[0] === f.stat.mtime && old[1] === f.stat.size) ids = old[2];
				else {
					ids = [...this.matcher.find(await this.app.vault.cachedRead(f))];
					if (++n % 25 === 0) {
						await sleep();
						if (gen !== this.generation) return;
					}
				}
				if (ids.length) this.quoteHits.set(f.path, new Set(ids));
				fresh.files[f.path] = [f.stat.mtime, f.stat.size, ids];
			}
			try {
				await this.app.vault.adapter.write(this.cachePath(), JSON.stringify(fresh));
			} catch {
				// The cache only saves time. Without it the next start reads the notes again.
			}
		}
		this.applyUses();
	}

	/** Builds each clip's use list from the quote hits and Obsidian's link index. */
	private applyUses(): void {
		const found = new Map<string, Map<string, UseHow>>();
		const add = (id: string, path: string, how: UseHow) => {
			const c = this.byId.get(id);
			if (!c || c.places.some((p) => p.path === path)) return;
			let m = found.get(id);
			if (!m) found.set(id, (m = new Map<string, UseHow>()));
			const was = m.get(path);
			// An embed says more than a link, and a link more than pasted text.
			if (!was || rank(how) > rank(was)) m.set(path, how);
		};
		if (this.settings.countQuotes) for (const [path, ids] of this.quoteHits) for (const id of ids) add(id, path, "quote");

		// Block ids of clips, by note.
		const blocks = new Map<string, Map<string, string>>();
		for (const c of this.clips) for (const p of c.places) if (p.blockId) {
			let m = blocks.get(p.path);
			if (!m) blocks.set(p.path, (m = new Map<string, string>()));
			m.set(p.blockId.toLowerCase(), c.id);
		}
		const mc = this.app.metadataCache;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.ignored(f.path)) continue;
			const cache = mc.getFileCache(f);
			if (!cache) continue;
			for (const [list, how] of [[cache.embeds ?? [], "embed"], [cache.links ?? [], "link"]] as const) {
				for (const l of list) {
					const at = l.link.indexOf("#^");
					if (at < 0) continue;
					const dest = mc.getFirstLinkpathDest(l.link.slice(0, at), f.path);
					if (!dest) continue;
					const id = blocks.get(dest.path)?.get(l.link.slice(at + 2).toLowerCase());
					if (id) add(id, f.path, how);
				}
			}
		}

		const now = Date.now();
		let changed = false;
		for (const c of this.clips) {
			const live = found.get(c.id);
			const st = this.state(c.id);
			const seen = { ...(st.uses ?? {}) };
			const uses: Use[] = [];
			let mine = false;
			for (const [path, how] of live ?? []) {
				if (!seen[path]) {
					const f = this.app.vault.getFileByPath(path);
					seen[path] = Math.min(now, f?.stat.mtime ?? now);
					mine = true;
				}
				uses.push({ path, how, since: seen[path] });
			}
			for (const p of Object.keys(seen)) if (!live?.has(p)) {
				delete seen[p];
				mine = true;
			}
			c.uses = uses.sort((a, b) => b.since - a.since);
			if (mine) {
				changed = true;
				this.setStateQuiet(c.id, { ...st, uses: seen });
			}
		}
		if (changed) this.host.saveSoon();
		this.trigger("change");
	}

	private setStateQuiet(id: string, next: ClipState) {
		const u = next.uses && Object.keys(next.uses).length ? next.uses : undefined;
		const s: ClipState = { ...next, uses: u };
		if (!u) delete s.uses;
		if (Object.keys(s).length) this.host.data.clips[id] = s;
		else delete this.host.data.clips[id];
	}

	// -----------------------------------------------------------------------
	// Keeping up with changes
	// -----------------------------------------------------------------------

	/** Called when a note changes. Clip notes are read again; other notes only get their uses counted. */
	noteChanged(path: string): void {
		if (!this.ready) return;
		this.pending.add(path);
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.flush(), 700);
	}

	noteDeleted(path: string): void {
		if (!this.ready) return;
		const had = this.files.delete(path);
		this.quoteHits.delete(path);
		if (had) this.merge();
		this.usesSoon();
	}

	noteRenamed(path: string, oldPath: string): void {
		if (!this.ready) return;
		const fc = this.files.get(oldPath);
		if (fc) {
			this.files.delete(oldPath);
			if (this.inFolders(path)) this.files.set(path, fc);
		} else if (this.inFolders(path)) this.pending.add(path);
		const hits = this.quoteHits.get(oldPath);
		if (hits) {
			this.quoteHits.delete(oldPath);
			this.quoteHits.set(path, hits);
		}
		// Uses remember the note path: move them with the note.
		for (const st of Object.values(this.host.data.clips)) {
			if (st.uses?.[oldPath]) {
				st.uses[path] = st.uses[oldPath];
				delete st.uses[oldPath];
			}
		}
		this.host.saveSoon();
		this.merge();
		if (this.pending.size) void this.flush();
		else this.usesSoon();
	}

	private async flush(): Promise<void> {
		const paths = [...this.pending];
		this.pending.clear();
		let clipsChanged = false;
		for (const path of paths) {
			const f = this.app.vault.getFileByPath(path);
			if (!f || f.extension !== "md") continue;
			if (this.inFolders(path)) {
				const before = JSON.stringify(this.files.get(path)?.parsed ?? []);
				await this.readFile(f);
				if (JSON.stringify(this.files.get(path)?.parsed ?? []) !== before) clipsChanged = true;
			}
			if (this.settings.countQuotes && !this.ignored(path) && !this.inFolders(path)) {
				const ids = [...this.matcher.find(await this.app.vault.cachedRead(f))];
				if (ids.length) this.quoteHits.set(path, new Set(ids));
				else this.quoteHits.delete(path);
			}
		}
		if (clipsChanged) {
			const oldSig = this.sig;
			this.merge();
			this.trigger("change");
			// New clips may already be quoted somewhere: look again everywhere.
			if (this.sig !== oldSig) {
				void this.scanUses();
				return;
			}
		}
		this.usesSoon();
	}

	/** Links changed (Obsidian's index caught up): count uses again shortly. */
	usesSoon(): void {
		if (!this.ready) return;
		window.clearTimeout(this.useTimer);
		this.useTimer = window.setTimeout(() => this.applyUses(), 400);
	}

	/** The clip at a line of a clip note, if any. */
	clipAt(path: string, line: number): Clip | null {
		for (const c of this.byPath.get(path) ?? []) for (const p of c.places) if (p.path === path && line >= p.line && line <= p.endLine) return c;
		return null;
	}

	place(c: Clip, path?: string): Place {
		return (path && c.places.find((p) => p.path === path)) || c.places[0];
	}

	/** Every tag in use, most used first. */
	allTags(): { tag: string; count: number }[] {
		const m = new Map<string, { tag: string; count: number }>();
		for (const c of this.clips) for (const t of c.tags) {
			const k = t.toLowerCase();
			const e = m.get(k);
			if (e) e.count++;
			else m.set(k, { tag: t, count: 1 });
		}
		return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
	}

	/** Every clip note, with how many clips it holds. */
	allSources(): { path: string; title: string; count: number }[] {
		const out: { path: string; title: string; count: number }[] = [];
		for (const [path, list] of this.byPath) out.push({ path, title: this.files.get(path)?.meta.title ?? path, count: list.length });
		return out.sort((a, b) => a.title.localeCompare(b.title));
	}

	titleOf(path: string): string {
		return this.files.get(path)?.meta.title ?? prettyName(path.split("/").pop()?.replace(/\.md$/, "") ?? path);
	}
}

function rank(h: UseHow): number {
	return h === "embed" ? 3 : h === "link" ? 2 : 1;
}

/** A clip note name like 2026-11-15_clipping_stop-using-tomorrow_v1 becomes "Stop using tomorrow". */
export function prettyName(base: string): string {
	const m = /^\d{4}-\d{2}-\d{2}_[a-z]+_(.+?)_v\d+( \d+)?$/i.exec(base);
	if (!m) return base;
	const s = m[1]
		.replace(/-/g, " ")
		.replace(/ (m|s|t|re|ll|ve|d) /g, "'$1 ")
		.replace(/ s$/, "'s");
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function kindOf(path: string, fm: Record<string, unknown>, url: string, parsed: ParsedClip[]): Kind {
	const p = path.toLowerCase();
	const type = typeof fm.type === "string" ? fm.type.toLowerCase() : "";
	if (parsed.some((c) => c.format === "bible") || /(^|\/)bible\//.test(p)) return "bible";
	if (type.includes("obsilearn") || parsed.some((c) => c.link.startsWith("obsilearn:"))) return "course";
	if (fm["readest-hash"] || parsed.some((c) => c.format === "readest" || c.format === "readest-old") || /(^|\/)(readest|books?)\//.test(p)) return "book";
	if (type.includes("podcast") || /podcast/.test(p)) return "podcast";
	if (/youtube\.com|youtu\.be|vimeo\.com/.test(url) || parsed.some((c) => /youtube\.com|youtu\.be/.test(c.link))) return "video";
	if (url || parsed.some((c) => c.format === "obsiread")) return "article";
	return "note";
}
