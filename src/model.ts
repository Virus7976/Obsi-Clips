// The shapes of clips and the rules for sorting, filtering and picking them. No Obsidian parts.
import type { ClipFormat } from "./parse";
import { fuzzyMatch, hashId, type Range } from "./text";

export type Kind = "video" | "article" | "book" | "bible" | "course" | "podcast" | "note";
export const KINDS: { id: Kind; name: string }[] = [
	{ id: "video", name: "Videos" },
	{ id: "article", name: "Articles" },
	{ id: "book", name: "Books" },
	{ id: "bible", name: "Bible" },
	{ id: "course", name: "Courses" },
	{ id: "podcast", name: "Podcasts" },
	{ id: "note", name: "Notes" },
];
export const COLORS = ["yellow", "red", "green", "blue", "purple", "orange", "pink"];

/** Where a clip sits: one note can hold many clips, and one clip can sit in more than one note. */
export interface Place {
	path: string;
	line: number;
	endLine: number;
	blockId: string;
	format: ClipFormat;
	where: string;
	link: string;
	color: string;
	note: string;
	tags: string[];
	writtenOver: boolean;
}

export type UseHow = "embed" | "link" | "quote";
export interface Use {
	path: string;
	how: UseHow;
	/** When this use was first seen, in ms. */
	since: number;
}

export interface Clip {
	id: string;
	text: string;
	norm: string;
	places: Place[];
	kind: Kind;
	/** The title of the note it came from. */
	source: string;
	author: string;
	url: string;
	/** When it was clipped, in ms. */
	clipped: number;
	/** Tags from the clip, its note, and tags added in this plugin. */
	tags: string[];
	words: string[];
	uses: Use[];
}

/** What the plugin remembers about a clip. Short keys: this sits in data.json for every clip. */
export interface ClipState {
	star?: 1;
	arch?: 1;
	/** Not shown in review before this day (ms). */
	snooze?: number;
	/** How many times it was kept in review. */
	step?: number;
	/** Last time it was shown in review (ms). */
	seen?: number;
	/** Tags added in this plugin. */
	tags?: string[];
	/** Note path to when the use was first seen (ms). */
	uses?: Record<string, number>;
	/** Last time it was put into a note from this plugin (ms). */
	put?: number;
}

export type SortKey = "relevance" | "clipped" | "used" | "lastUsed" | "source" | "length" | "color" | "shuffle";
export const SORTS: { id: SortKey; name: string; desc: string }[] = [
	{ id: "relevance", name: "Best match", desc: "Closest to your search" },
	{ id: "clipped", name: "Date clipped", desc: "Newest first" },
	{ id: "used", name: "Times used", desc: "Most used first" },
	{ id: "lastUsed", name: "Last used", desc: "Most recent first" },
	{ id: "source", name: "Source", desc: "A to Z" },
	{ id: "length", name: "Length", desc: "Shortest first" },
	{ id: "color", name: "Colour", desc: "In marker order" },
	{ id: "shuffle", name: "Shuffle", desc: "A new mix each time" },
];

export type GroupKey = "none" | "source" | "kind" | "tag" | "month" | "color" | "use";
export const GROUPS: { id: GroupKey; name: string }[] = [
	{ id: "none", name: "No groups" },
	{ id: "source", name: "Source" },
	{ id: "kind", name: "Type" },
	{ id: "tag", name: "Tag" },
	{ id: "month", name: "Month clipped" },
	{ id: "color", name: "Colour" },
	{ id: "use", name: "Used or not" },
];

export type UseFilter = "any" | "unused" | "used" | "often";
export type SavedFilter = "any" | "starred" | "archived";
export type NoteFilter = "any" | "yes" | "no";
export type SinceFilter = "any" | "7" | "30" | "90" | "365";

export interface Query {
	text: string;
	sort: SortKey;
	reverse: boolean;
	group: GroupKey;
	kinds: Kind[];
	colors: string[];
	use: UseFilter;
	saved: SavedFilter;
	noted: NoteFilter;
	since: SinceFilter;
	tags: string[];
	/** Source note paths. */
	sources: string[];
	/** Changes on each Shuffle. */
	seed: number;
}

export const EMPTY_QUERY: Query = {
	text: "",
	sort: "clipped",
	reverse: false,
	group: "none",
	kinds: [],
	colors: [],
	use: "any",
	saved: "any",
	noted: "any",
	since: "any",
	tags: [],
	sources: [],
	seed: 1,
};

/** How many filters are on, not counting search, sort and groups. */
export function filterCount(q: Query): number {
	return (
		(q.kinds.length ? 1 : 0) +
		(q.colors.length ? 1 : 0) +
		(q.use !== "any" ? 1 : 0) +
		(q.saved !== "any" ? 1 : 0) +
		(q.noted !== "any" ? 1 : 0) +
		(q.since !== "any" ? 1 : 0) +
		(q.tags.length ? 1 : 0) +
		(q.sources.length ? 1 : 0)
	);
}

export function lastUsed(c: Clip): number {
	return c.uses.reduce((m, u) => Math.max(m, u.since), 0);
}

/** Search words may hold filters: #tag, is:unused, is:used, is:starred, is:archived, is:noted, color:red, type:book. */
export function splitSearch(text: string): { words: string; tags: string[]; is: string[]; colors: string[]; kinds: string[] } {
	const tags: string[] = [];
	const is: string[] = [];
	const colors: string[] = [];
	const kinds: string[] = [];
	const words: string[] = [];
	for (const t of text.split(/\s+/).filter(Boolean)) {
		const low = t.toLowerCase();
		if (/^#[\p{L}\p{N}_/-]+$/u.test(t)) tags.push(low.slice(1));
		else if (low.startsWith("is:") && low.length > 3) is.push(low.slice(3));
		else if ((low.startsWith("color:") || low.startsWith("colour:")) && low.includes(":", 0)) colors.push(low.split(":")[1]);
		else if (low.startsWith("type:") && low.length > 5) kinds.push(low.slice(5));
		else words.push(t);
	}
	return { words: words.join(" "), tags, is, colors, kinds };
}

export interface Hit {
	clip: Clip;
	score: number;
	ranges: Range[];
}

/** The clip's searchable text: the clip itself first (its ranges are used to mark matches), then the rest. */
export function haystack(c: Clip): string {
	return [c.text, c.places[0]?.note ?? "", c.source, c.author, c.tags.map((t) => "#" + t).join(" "), c.places[0]?.where ?? ""].join("\n");
}

function matchesStateFilters(c: Clip, s: ClipState | undefined, q: Query, is: string[], now: number): boolean {
	const archived = !!s?.arch;
	const wantArchived = q.saved === "archived" || is.includes("archived");
	if (archived !== wantArchived) return false;
	if ((q.saved === "starred" || is.includes("starred")) && !s?.star) return false;
	const used = c.uses.length;
	if ((q.use === "unused" || is.includes("unused")) && used > 0) return false;
	if ((q.use === "used" || is.includes("used")) && used === 0) return false;
	if (q.use === "often" && used < 3) return false;
	const hasNote = c.places.some((p) => p.note.trim() !== "");
	if ((q.noted === "yes" || is.includes("noted")) && !hasNote) return false;
	if (q.noted === "no" && hasNote) return false;
	if (q.since !== "any" && c.clipped < now - Number(q.since) * 86400000) return false;
	return true;
}

/** Applies search, filters and sort. Archived clips show only when asked for. */
export function runQuery(clips: Clip[], state: Record<string, ClipState>, q: Query, now = Date.now()): Hit[] {
	const s = splitSearch(q.text);
	const kinds = new Set<string>([...q.kinds, ...s.kinds]);
	const colors = new Set<string>([...q.colors, ...s.colors]);
	const tags = [...q.tags, ...s.tags].map((t) => t.toLowerCase());
	const sources = new Set(q.sources);
	const out: Hit[] = [];
	for (const c of clips) {
		if (!matchesStateFilters(c, state[c.id], q, s.is, now)) continue;
		if (kinds.size && !kinds.has(c.kind)) continue;
		if (colors.size && !c.places.some((p) => colors.has(p.color))) continue;
		if (tags.length) {
			const mine = c.tags.map((t) => t.toLowerCase());
			if (!tags.every((t) => mine.some((m) => m === t || m.startsWith(t + "/")))) continue;
		}
		if (sources.size && !c.places.some((p) => sources.has(p.path))) continue;
		if (s.words) {
			const m = fuzzyMatch(s.words, haystack(c));
			if (!m) continue;
			// Only ranges inside the clip text are kept, for marking it.
			out.push({ clip: c, score: m.score, ranges: m.ranges.filter((r) => r[1] <= c.text.length) });
		} else out.push({ clip: c, score: 0, ranges: [] });
	}
	sortHits(out, q, state, !!s.words);
	return out;
}

const colorRank = (c: Clip) => {
	const i = COLORS.indexOf(c.places[0]?.color ?? "");
	return i < 0 ? 99 : i;
};

export function sortHits(hits: Hit[], q: Query, _state: Record<string, ClipState>, searching: boolean): void {
	const sort = q.sort === "relevance" && !searching ? "clipped" : q.sort;
	const byDate = (a: Hit, b: Hit) => b.clip.clipped - a.clip.clipped || a.clip.text.localeCompare(b.clip.text);
	let cmp: (a: Hit, b: Hit) => number;
	switch (sort) {
		case "relevance":
			cmp = (a, b) => b.score - a.score || byDate(a, b);
			break;
		case "used":
			cmp = (a, b) => b.clip.uses.length - a.clip.uses.length || lastUsed(b.clip) - lastUsed(a.clip) || byDate(a, b);
			break;
		case "lastUsed":
			cmp = (a, b) => lastUsed(b.clip) - lastUsed(a.clip) || byDate(a, b);
			break;
		case "source":
			cmp = (a, b) => a.clip.source.localeCompare(b.clip.source) || (a.clip.places[0]?.line ?? 0) - (b.clip.places[0]?.line ?? 0);
			break;
		case "length":
			cmp = (a, b) => a.clip.text.length - b.clip.text.length || byDate(a, b);
			break;
		case "color":
			cmp = (a, b) => colorRank(a.clip) - colorRank(b.clip) || byDate(a, b);
			break;
		case "shuffle": {
			const key = (h: Hit) => hashId(q.seed + h.clip.id);
			cmp = (a, b) => key(a).localeCompare(key(b));
			break;
		}
		default:
			cmp = byDate;
	}
	hits.sort(cmp);
	if (q.reverse) hits.reverse();
}

export interface Group {
	key: string;
	label: string;
	hits: Hit[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Groups hits, keeping the sort order inside each group. A clip with three tags shows under each tag. */
export function groupHits(hits: Hit[], by: GroupKey, kindName: (k: Kind) => string): Group[] {
	if (by === "none") return [{ key: "", label: "", hits }];
	const map = new Map<string, Group>();
	const add = (key: string, label: string, h: Hit) => {
		let g = map.get(key);
		if (!g) map.set(key, (g = { key, label, hits: [] }));
		g.hits.push(h);
	};
	for (const h of hits) {
		const c = h.clip;
		switch (by) {
			case "source":
				add(c.places[0]?.path ?? "", c.source, h);
				break;
			case "kind":
				add(c.kind, kindName(c.kind), h);
				break;
			case "tag":
				if (!c.tags.length) add("~", "No tags", h);
				for (const t of c.tags) add(t.toLowerCase(), "#" + t, h);
				break;
			case "month": {
				const d = new Date(c.clipped);
				const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
				add(k, `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, h);
				break;
			}
			case "color": {
				const col = c.places[0]?.color || "";
				add(col || "~", col ? col[0].toUpperCase() + col.slice(1) : "No colour", h);
				break;
			}
			case "use":
				if (c.uses.length) add("used", "Used", h);
				else add("unused", "Not used yet", h);
				break;
		}
	}
	const groups = [...map.values()];
	if (by === "month") groups.sort((a, b) => b.key.localeCompare(a.key));
	else if (by === "tag") groups.sort((a, b) => (a.key === "~" ? 1 : b.key === "~" ? -1 : b.hits.length - a.hits.length || a.label.localeCompare(b.label)));
	else if (by === "color") groups.sort((a, b) => (COLORS.indexOf(a.key) + 99) % 99 - (COLORS.indexOf(b.key) + 99) % 99);
	else if (by === "use") groups.sort((a) => (a.key === "unused" ? -1 : 1));
	else groups.sort((a, b) => a.label.localeCompare(b.label));
	return groups;
}

// ---------------------------------------------------------------------------
// Review: a few clips a day, the forgotten ones first.
// ---------------------------------------------------------------------------

export const KEEP_STEPS = [7, 21, 60, 180];
const DAY = 86400000;

export function dayKey(t: number): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Picks today's clips. Unused clips come first, then the ones not shown for longest. Starred clips come a bit
 * more often. The pick is the same all day (seeded by the date), so reopening review does not reshuffle it.
 */
export function pickDaily(clips: Clip[], state: Record<string, ClipState>, n: number, now = Date.now()): string[] {
	const today = dayKey(now);
	const scored: [string, number][] = [];
	for (const c of clips) {
		const s = state[c.id];
		if (s?.arch) continue;
		if (s?.snooze && s.snooze > now) continue;
		let score = 0;
		if (!c.uses.length) score += 3;
		if (!s?.seen) score += 2;
		else score += Math.min(3, (now - s.seen) / (30 * DAY));
		if (s?.star) score += 1.5;
		score += Math.min(1.5, (now - c.clipped) / (90 * DAY));
		// The same small mix-up all day.
		const jitter = parseInt(hashId(today + c.id).slice(0, 6), 36) / 36 ** 6;
		score += jitter * 2;
		scored.push([c.id, score]);
	}
	scored.sort((a, b) => b[1] - a[1]);
	return scored.slice(0, n).map((x) => x[0]);
}

/** The new state after "Keep for later": shown again after 7, 21, 60, then 180 days. */
export function keepLater(s: ClipState | undefined, now = Date.now()): ClipState {
	const step = Math.min((s?.step ?? 0) + 1, KEEP_STEPS.length);
	return { ...s, step, seen: now, snooze: now + KEEP_STEPS[step - 1] * DAY };
}
