// Finds which clips a note quotes, by their words. No Obsidian parts.
import { normalize } from "./text";

/** A run of this many same words counts as a quote of a long clip. Shorter clips must appear whole. */
export const RUN = 8;

/**
 * Looks for clips inside other notes. Each clip is keyed by its runs of RUN words (or by its whole text when
 * it is shorter), so one pass over a note's words finds every clip it quotes.
 */
export class QuoteMatcher {
	private long = new Map<string, string[]>();
	private short = new Map<string, string[]>();
	private shortLengths = new Set<number>();

	constructor(clips: { id: string; norm: string }[]) {
		for (const c of clips) {
			const w = c.norm.split(" ").filter(Boolean);
			if (w.length < 3) continue;
			if (w.length < RUN) {
				const key = w.join(" ");
				const list = this.short.get(key) ?? [];
				if (!list.includes(c.id)) list.push(c.id);
				this.short.set(key, list);
				this.shortLengths.add(w.length);
				continue;
			}
			for (let i = 0; i + RUN <= w.length; i++) {
				const key = w.slice(i, i + RUN).join(" ");
				const list = this.long.get(key) ?? [];
				if (!list.includes(c.id)) list.push(c.id);
				this.long.set(key, list);
			}
		}
	}

	get empty(): boolean {
		return this.long.size === 0 && this.short.size === 0;
	}

	/** The ids of the clips this text quotes. */
	find(text: string): Set<string> {
		const found = new Set<string>();
		if (this.empty) return found;
		const w = normalize(text).split(" ").filter(Boolean);
		for (let i = 0; i + RUN <= w.length; i++) {
			const ids = this.long.get(w.slice(i, i + RUN).join(" "));
			if (ids) for (const id of ids) found.add(id);
		}
		for (const n of this.shortLengths) {
			for (let i = 0; i + n <= w.length; i++) {
				const ids = this.short.get(w.slice(i, i + n).join(" "));
				if (ids) for (const id of ids) found.add(id);
			}
		}
		return found;
	}
}

/** Word shingles for near-copy checks. */
export function shingles(norm: string, n = 3): Set<string> {
	const w = norm.split(" ").filter(Boolean);
	const out = new Set<string>();
	if (w.length < n) {
		if (w.length) out.add(w.join(" "));
		return out;
	}
	for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
	return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let both = 0;
	const [small, big] = a.size < b.size ? [a, b] : [b, a];
	for (const s of small) if (big.has(s)) both++;
	return both / (a.size + b.size - both);
}

/**
 * Pairs of clips that say almost the same thing (one copied with a small change, or one inside the other).
 * Uses a word-run index so it does not compare every pair.
 */
export function nearCopies(clips: { id: string; norm: string }[], min = 0.6): [string, string, number][] {
	const sh = new Map<string, Set<string>>();
	const index = new Map<string, string[]>();
	for (const c of clips) {
		const s = shingles(c.norm);
		sh.set(c.id, s);
		for (const k of s) {
			const list = index.get(k);
			if (list) {
				if (list.length < 40) list.push(c.id);
			} else index.set(k, [c.id]);
		}
	}
	const seen = new Set<string>();
	const out: [string, string, number][] = [];
	for (const c of clips) {
		const mine = sh.get(c.id);
		if (!mine) continue;
		const counts = new Map<string, number>();
		for (const k of mine) for (const other of index.get(k) ?? []) if (other !== c.id) counts.set(other, (counts.get(other) ?? 0) + 1);
		for (const [other, n] of counts) {
			if (n < 2) continue;
			const key = c.id < other ? c.id + other : other + c.id;
			if (seen.has(key)) continue;
			seen.add(key);
			const theirs = sh.get(other);
			if (!theirs) continue;
			// One inside the other counts as a copy too.
			const contain = n / Math.min(mine.size, theirs.size);
			const score = Math.max(jaccard(mine, theirs), contain >= 0.9 ? 0.9 : 0);
			if (score >= min) out.push([c.id, other, score]);
		}
	}
	return out.sort((a, b) => b[2] - a[2]);
}
