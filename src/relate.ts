// Finds the clips that fit a note: shared words (rarer words count more), shared tags and topics. No Obsidian parts.
import { keywords } from "./text";

export interface RelateClip {
	id: string;
	words: string[];
	tags: string[];
}

export interface Related {
	id: string;
	score: number;
	/** The words and tags that matched, best first, to show why. */
	why: string[];
}

export class Relater {
	private df = new Map<string, number>();
	private n = 0;
	private byId = new Map<string, { words: Map<string, number>; tags: Set<string> }>();

	constructor(clips: RelateClip[]) {
		this.n = clips.length;
		for (const c of clips) {
			const counts = new Map<string, number>();
			for (const w of c.words) counts.set(w, (counts.get(w) ?? 0) + 1);
			for (const w of counts.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
			this.byId.set(c.id, { words: counts, tags: new Set(c.tags.map((t) => t.toLowerCase())) });
		}
	}

	idf(w: string): number {
		const d = this.df.get(w) ?? 0;
		return Math.log((this.n + 1) / (d + 1)) + 0.2;
	}

	/**
	 * Scores every clip against the note's words and tags. Extra words (from a search by meaning) count at
	 * half weight. A word in only one clip of a big library counts most; a word in most clips hardly counts.
	 */
	rank(noteText: string, noteTags: string[], extra: string[] = [], skip: Set<string> = new Set(), limit = 30): Related[] {
		const counts = new Map<string, number>();
		for (const w of keywords(noteText)) counts.set(w, (counts.get(w) ?? 0) + 1);
		const weight = new Map<string, number>();
		for (const [w, c] of counts) weight.set(w, (1 + Math.log(c)) * this.idf(w));
		for (const e of extra) for (const w of keywords(e)) if (!weight.has(w)) weight.set(w, 0.5 * this.idf(w));
		const tags = new Set(noteTags.map((t) => t.toLowerCase().replace(/^#/, "")));
		// Tags also count as words, so a note about "jung" finds clips tagged #jung.
		for (const t of tags) for (const w of keywords(t)) if (!weight.has(w)) weight.set(w, 0.8 * this.idf(w));

		const out: Related[] = [];
		for (const [id, c] of this.byId) {
			if (skip.has(id)) continue;
			let score = 0;
			const hits: [string, number][] = [];
			for (const [w, cw] of c.words) {
				const nw = weight.get(w);
				if (!nw) continue;
				const s = nw * this.idf(w) * (1 + Math.log(cw));
				score += s;
				hits.push([w, s]);
			}
			for (const t of c.tags) {
				if (tags.has(t)) {
					score += 6;
					hits.push(["#" + t, 6]);
				}
			}
			if (score <= 0) continue;
			// Long clips share more words by chance: a gentle length cut keeps short sharp clips in the race.
			const len = [...c.words.values()].reduce((a, b) => a + b, 0);
			score /= Math.pow(Math.max(len, 8), 0.35);
			// One shared common word is noise.
			if (hits.length < 2 && !hits.some((h) => h[0].startsWith("#")) && score < 1.2) continue;
			hits.sort((a, b) => b[1] - a[1]);
			out.push({ id, score, why: hits.slice(0, 4).map((h) => h[0]) });
		}
		out.sort((a, b) => b.score - a.score);
		return out.slice(0, limit);
	}
}
