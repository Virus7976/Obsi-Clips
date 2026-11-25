// Search deeper with AI, kept apart from the screen code so it can be tested on its own.
import type { Clip } from "./model";
import { fuzzyMatch } from "./text";

/** What search deeper needs from AI. */
export interface DeepAi {
	meaningWords(query: string, asked?: boolean): Promise<string[]>;
	findClips(query: string, clips: { id: string; text: string; source: string }[]): Promise<string[] | null>;
}

/** What search deeper needs from meaning search on this device. */
export interface DeepMeaning {
	readonly ready: boolean;
	usable(where: "search" | "sidebar"): boolean;
	wake(): Promise<void>;
	near(what: string, pool: Clip[], skip?: Set<string>, limit?: number, maxPieces?: number, min?: number): { clip: Clip; sim: number }[];
}

/** At most this many clips go to AI. A library this small (after the clips already shown) goes whole. */
export const DEEP_MAX = 60;

/**
 * Search deeper with AI. When few clips are left to look at, AI reads them all. Else Clips first gathers likely
 * clips on this device: close in meaning to the search and to AI's other words, and clips with those words.
 * Then AI keeps the ones about the same topic, best first. Returns null when AI did not answer.
 */
export async function deepFind(ai: DeepAi, meaning: DeepMeaning, query: string, pool: Clip[], skip: Set<string>): Promise<Clip[] | null> {
	const left = pool.filter((c) => !skip.has(c.id));
	const cands = left.length <= DEEP_MAX ? onceEach([left]) : await gather(ai, meaning, query, left);
	const ids = await ai.findClips(query, cands.map((c) => ({ id: c.id, text: c.text, source: c.source })));
	if (!ids) return null;
	const byId = new Map(cands.map((c) => [c.id, c]));
	return ids.map((id) => byId.get(id)).filter((c): c is Clip => !!c);
}

/** Likely clips from a big library: each way of finding gets a fair share. */
async function gather(ai: DeepAi, meaning: DeepMeaning, query: string, pool: Clip[]): Promise<Clip[]> {
	const words = await ai.meaningWords(query, true);
	const lists: Clip[][] = [];
	const none = new Set<string>();
	if (!meaning.ready && meaning.usable("search")) await meaning.wake();
	if (meaning.ready) {
		lists.push(meaning.near(query, pool, none, 30, 2048, 0.25).map((n) => n.clip));
		if (words.length) lists.push(meaning.near(query + " " + words.join(" "), pool, none, 30, 2048, 0.25).map((n) => n.clip));
	}
	if (words.length) {
		const scored: { c: Clip; score: number }[] = [];
		for (const c of pool) {
			const hay = c.text + " " + c.tags.join(" ") + " " + c.source;
			let best = 0;
			for (const w of words) {
				const m = fuzzyMatch(w, hay);
				if (m && m.score >= 8) best += m.score;
			}
			if (best) scored.push({ c, score: best });
		}
		lists.push(scored.sort((a, b) => b.score - a.score).slice(0, 30).map((x) => x.c));
	}
	return onceEach(lists);
}

/** Takes from each list in turn, up to DEEP_MAX. The same clip, or the same words, once only. */
function onceEach(lists: Clip[][]): Clip[] {
	const seen = new Set<string>();
	const texts = new Set<string>();
	const out: Clip[] = [];
	for (let i = 0; out.length < DEEP_MAX && lists.some((l) => i < l.length); i++) {
		for (const l of lists) {
			const c = l[i];
			if (!c || seen.has(c.id) || out.length >= DEEP_MAX) continue;
			seen.add(c.id);
			const t = c.text.replace(/\s+/g, " ").trim().toLowerCase();
			if (texts.has(t)) continue;
			texts.add(t);
			out.push(c);
		}
	}
	return out;
}
