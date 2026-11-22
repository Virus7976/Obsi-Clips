// Small text tools with no Obsidian parts, so they can be tested on their own.

/** Lowercase words only: no marks, accents or punctuation. Two clips with the same words get the same key. */
export function normalize(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[’‘`]/g, "'")
		.replace(/'/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** A short stable id for a text: two FNV-1a hashes in base 36. */
export function hashId(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0;
		b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
		b ^= b >>> 15;
	}
	return a.toString(36).padStart(7, "0") + b.toString(36).padStart(7, "0");
}

export function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

const STOP = new Set(
	(
		"a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing " +
		"down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more " +
		"most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs " +
		"them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with " +
		"would you your yours yourself yourselves dont doesnt didnt isnt arent wasnt werent cant couldnt wont wouldnt shouldnt im ive id youre youve theyre " +
		"thats theres heres lets also get got like one two thing things really much many even still yet ever every way go going gonna know think say said " +
		"make made see want need us"
	).split(" "),
);

/** Words that carry meaning: no stop words, at least 3 letters, a light plural cut. */
export function keywords(text: string): string[] {
	return normalize(text)
		.split(" ")
		.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
		.map(stem);
}

/** A very light stem, so "habits" meets "habit" and "running" meets "run". */
export function stem(w: string): string {
	if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
	if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3).replace(/(.)\1$/, "$1");
	if (w.length > 4 && w.endsWith("ed") && !w.endsWith("eed")) return w.slice(0, -2);
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
	return w;
}

/** Edit distance, giving up once it is over max. */
export function editDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (cur[j] < best) best = cur[j];
		}
		if (best > max) return max + 1;
		prev = cur;
	}
	return prev[b.length];
}

export type Range = [number, number];

/**
 * How well one query word matches a text, like Obsidian's quick switcher: the exact piece wins, then the
 * start of a word, then a small typo inside a word, then the letters in order. Null when it does not match.
 */
export function matchWord(word: string, lower: string): { score: number; ranges: Range[] } | null {
	const at = lower.indexOf(word);
	if (at >= 0) {
		let start = at;
		for (let s = at; s >= 0; s = lower.indexOf(word, s + 1)) {
			if (s === 0 || /[^a-z0-9]/.test(lower[s - 1])) {
				start = s;
				break;
			}
		}
		const wordStart = start === 0 || /[^a-z0-9]/.test(lower[start - 1]);
		return { score: wordStart ? 12 : 8, ranges: [[start, start + word.length]] };
	}
	// A small typo, only in longer words: in short words it matches too much ("rest" would find "best").
	if (word.length >= 5) {
		const max = word.length >= 8 ? 2 : 1;
		const re = /[a-z0-9']+/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(lower))) {
			const w = m[0];
			const piece = w.length > word.length ? w.slice(0, word.length) : w;
			if (editDistance(word, piece, max) <= max) return { score: 5, ranges: [[m.index, m.index + piece.length]] };
		}
	}
	// Letters in order inside one word, starting with its first letter: "tmrw" finds "tomorrow".
	// Never across words, or a short search would match most long clips.
	if (word.length >= 4) {
		const re = /[a-z0-9']+/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(lower))) {
			const w = m[0];
			if (w[0] !== word[0] || w.length < word.length || w.length > word.length * 3) continue;
			const ranges: Range[] = [];
			let from = 0;
			let ok = true;
			for (const ch of word) {
				const i = w.indexOf(ch, from);
				if (i < 0) {
					ok = false;
					break;
				}
				const at = m.index + i;
				if (ranges.length && ranges[ranges.length - 1][1] === at) ranges[ranges.length - 1][1] = at + 1;
				else ranges.push([at, at + 1]);
				from = i + 1;
			}
			if (ok) return { score: 2, ranges };
		}
	}
	return null;
}

/** Every query word must match. Returns the total score and the matched ranges, or null. */
export function fuzzyMatch(query: string, text: string): { score: number; ranges: Range[] } | null {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return { score: 0, ranges: [] };
	const lower = text.toLowerCase();
	let score = 0;
	const ranges: Range[] = [];
	for (const w of words) {
		const m = matchWord(w, lower);
		if (!m) return null;
		score += m.score;
		ranges.push(...m.ranges);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Range[] = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push([r[0], r[1]]);
	}
	return { score, ranges: merged };
}

/** "3 clips", "1 clip". */
export function plural(n: number, one: string, many = one + "s"): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Cuts text to about n letters at a word end, with an ellipsis. */
export function clip(text: string, n: number): string {
	if (text.length <= n) return text;
	const cut = text.slice(0, n);
	const sp = cut.lastIndexOf(" ");
	return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, "") + "…";
}
