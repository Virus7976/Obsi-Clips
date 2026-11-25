// Optional AI help. It never writes text for you: it only helps find your own clips and suggests tags.
// Off until set up. Every call sends little text, asks for a short answer, and the answer is kept.
import { requestUrl, type App } from "obsidian";
import { clip as cut, hashId } from "./text";
import { addressProblem } from "./safety";
import { PHONE_SECRET, PROVIDERS, type AiSettings, type PluginData } from "./settings";

const MAX_MEMO = 400;
/** Search deeper: at most this many clips, read in two steps (skim, then rank), each with its size of ask and cut. */
const FIND_MAX = 2000;
const SKIM_BATCH = 80;
const SKIM_CUT = 110;
const RANK_BATCH = 40;
const RANK_CUT = 300;

/** A clip as search deeper sends it: its words, where it is from, and the person's own note on it. */
export interface FindClip {
	id: string;
	text: string;
	source: string;
	note?: string;
}

/** Cuts a list into even parts of at most n: 90 goes as 45 and 45, not 80 and 10. */
function evenParts<T>(list: T[], n: number): T[][] {
	const size = Math.ceil(list.length / Math.ceil(list.length / n));
	const out: T[][] = [];
	for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
	return out;
}

/** "1. words (source) [note: …]", one clip a line. */
function numbered(list: FindClip[], textCut: number, noteCut: number): string {
	const flat = (t: string) => t.replace(/\s+/g, " ").trim();
	return list.map((c, i) => `${i + 1}. ${cut(flat(c.text), textCut)} (${cut(c.source, 40)})${c.note?.trim() ? " [note: " + cut(flat(c.note), noteCut) + "]" : ""}`).join("\n");
}

/** The ids for the numbers AI gave, in its order. Numbers out of range are dropped. */
function toIds(v: unknown, list: FindClip[]): string[] {
	if (!Array.isArray(v)) return [];
	const ns = v.map((n) => (typeof n === "number" ? n : parseInt(String(n), 10))).filter((n) => n >= 1 && n <= list.length);
	return [...new Set(ns.map((n) => list[n - 1].id))];
}

/** What one call needs: where it goes and which model. */
export type AiTarget = Pick<AiSettings, "provider" | "app" | "baseUrl" | "model">;

export class Ai {
	/** Set when the last call failed, for Settings to explain. Never shown in place of results. */
	lastError = "";
	private busy = new Map<string, Promise<unknown>>();

	constructor(
		private app: App,
		private data: () => PluginData,
		private save: () => void,
	) {}

	private get s() {
		return this.data().settings.ai;
	}

	/** The key for a service, or the link token for an Obsi app on the phone. Never kept in data.json. */
	key(): string {
		const id = this.s.provider === "phone" ? PHONE_SECRET : PROVIDERS[this.s.provider]?.key ? this.s.keyName : "";
		if (!id) return "";
		try {
			return this.app.secretStorage.getSecret(id) ?? "";
		} catch {
			return "";
		}
	}

	/** The saved key for a service, whatever is in use now. */
	savedKey(): string {
		try {
			return this.app.secretStorage.getSecret(this.s.keyName) ?? "";
		} catch {
			return "";
		}
	}

	/** Ready to use: turned on, a safe address, a model, and a key or link when it needs one. */
	usable(): boolean {
		const s = this.s;
		if (!s.on || !s.baseUrl.trim() || !s.model.trim()) return false;
		const key = this.key();
		const needsKey = PROVIDERS[s.provider]?.key !== false || s.provider === "phone";
		if (needsKey && !key) return false;
		return addressProblem(s.baseUrl, key !== "") === null;
	}

	/** One chat call with the saved setup. Returns the answer text, or "" on any failure. */
	async ask(system: string, user: string, maxTokens: number): Promise<string> {
		if (!this.usable()) return "";
		return this.call(this.s, this.key(), system, user, maxTokens);
	}

	/**
	 * Tries a setup before it is saved. Returns null when it answers, else the reason in plain words.
	 * Setup only saves a choice that has passed this.
	 */
	async check(cfg: AiTarget, key: string): Promise<string | null> {
		const answer = await this.call(cfg, key, "Answer with the single word: ready", "Are you there?", 8);
		return answer ? null : this.lastError || "No answer came back.";
	}

	/** The headers for a service: its key, and what OpenRouter asks for. */
	private headers(s: AiTarget, key: string): Record<string, string> {
		const h: Record<string, string> = { "Content-Type": "application/json" };
		if (PROVIDERS[s.provider]?.style === "anthropic") {
			if (key) h["x-api-key"] = key;
			h["anthropic-version"] = "2023-06-01";
		} else if (key) h.Authorization = `Bearer ${key}`;
		if (s.provider === "openrouter") {
			h["HTTP-Referer"] = "https://github.com/Virus7976/Obsi-Clips";
			h["X-Title"] = "Clips";
		}
		return h;
	}

	private async call(s: AiTarget, key: string, system: string, user: string, maxTokens: number): Promise<string> {
		this.lastError = "";
		// Checked again at each call: a key never goes to an address that could be read on the way.
		const problem = addressProblem(s.baseUrl, key !== "");
		if (problem) {
			this.lastError = problem;
			return "";
		}
		const anthropic = PROVIDERS[s.provider]?.style === "anthropic";
		const base = s.baseUrl.replace(/\/+$/, "");
		const own = s.provider === "local" || s.provider === "network";
		try {
			const res = await requestUrl({
				url: base + (anthropic ? "/messages" : "/chat/completions"),
				method: "POST",
				headers: this.headers(s, key),
				body: JSON.stringify(
					anthropic
						? { model: s.model, max_tokens: maxTokens, temperature: 0.2, system, messages: [{ role: "user", content: user }] }
						: {
								model: s.model,
								temperature: 0.2,
								max_tokens: maxTokens,
								// Thinking models in Ollama (like qwen3) would spend every token thinking. These jobs are small.
								...(own ? { reasoning_effort: "none" } : {}),
								messages: [
									{ role: "system", content: system },
									{ role: "user", content: user },
								],
							},
				),
				throw: false,
			});
			if (res.status === 401 && s.provider === "phone") {
				this.lastError = `The link to ${s.app || "the Obsi app"} has ended. Set up AI again to link it.`;
				return "";
			}
			let json: unknown = null;
			try {
				json = res.json as unknown;
			} catch {
				json = null;
			}
			if (res.status === 401 || res.status === 403) {
				this.lastError = own ? `${s.app || "The model app"} asked for a key.` : "The key was not accepted.";
				return "";
			}
			if (res.status >= 400) {
				const msg = (json as { error?: { message?: string } | string } | null)?.error;
				const text = typeof msg === "string" ? msg : msg?.message;
				this.lastError = `The service said ${res.status}${text ? ": " + text.slice(0, 160) : ""}`;
				return "";
			}
			const text = anthropic
				? ((json as { content?: { type?: string; text?: string }[] } | null)?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
				: ((json as { choices?: { message?: { content?: string } }[] } | null)?.choices?.[0]?.message?.content ?? "");
			// Some models write their thinking into the answer: keep only what comes after it.
			const answer = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
			this.lastError = answer ? "" : "This model gave no answer. A small model that does not think first works best.";
			return answer;
		} catch (e) {
			this.lastError =
				s.provider === "phone"
					? `${s.app || "The Obsi app"} is not lending its model right now. Open it once to start.`
					: own
						? `${s.app || "The model app"} is not running${s.provider === "network" ? " on that computer, or it does not let other computers in" : ""}.`
						: e instanceof Error
							? e.message
							: "Could not reach the service";
			return "";
		}
	}

	/**
	 * The models a service offers, best for these jobs first: small and fast, and never one that thinks first.
	 * Returns null with lastError set when the list could not be read.
	 */
	async listModels(s: AiTarget, key: string): Promise<ServiceModel[] | null> {
		const problem = addressProblem(s.baseUrl, key !== "");
		if (problem) {
			this.lastError = problem;
			return null;
		}
		try {
			const res = await requestUrl({ url: s.baseUrl.replace(/\/+$/, "") + "/models", method: "GET", headers: this.headers(s, key), throw: false });
			if (res.status === 401 || res.status === 403) {
				this.lastError = "The key was not accepted.";
				return null;
			}
			if (res.status >= 400) {
				this.lastError = `The service said ${res.status}`;
				return null;
			}
			const raw = (res.json as { data?: unknown[]; models?: unknown[] } | null) ?? {};
			return rankModels(s.provider, (raw.data ?? raw.models ?? []) as RawModel[]);
		} catch (e) {
			this.lastError = e instanceof Error ? e.message : "Could not reach the service";
			return null;
		}
	}
	/** Asks and reads one JSON object out of the answer. */
	private async askJson<T>(system: string, user: string, maxTokens: number): Promise<T | null> {
		const text = await this.ask(system, user, maxTokens);
		const m = /\{[\s\S]*\}/.exec(text);
		if (!m) return null;
		try {
			return JSON.parse(m[0]) as T;
		} catch {
			return null;
		}
	}

	/** Runs one job per key at a time; a second ask for the same thing waits for the first. */
	private once<T>(key: string, job: () => Promise<T>): Promise<T> {
		const running = this.busy.get(key) as Promise<T> | undefined;
		if (running) return running;
		const p = job().finally(() => this.busy.delete(key));
		this.busy.set(key, p);
		return p;
	}

	private remember(bucket: Record<string, string[]>, key: string, value: string[]) {
		bucket[key] = value;
		const keys = Object.keys(bucket);
		if (keys.length > MAX_MEMO) for (const k of keys.slice(0, keys.length - MAX_MEMO)) delete bucket[k];
		this.save();
	}

	/**
	 * Other words for what a search means, so a search for "fear" also finds "courage". It asks for the idea behind the
	 * search too: the words a quote on that topic would use, for it or against it, and who might have said it.
	 */
	async meaningWords(query: string, asked = false): Promise<string[]> {
		const q = query.trim().toLowerCase().slice(0, 200);
		// "asked": the person pressed Find by meaning, so it runs even with Find by meaning turned off.
		if (!q || !this.usable() || (!this.s.meaning && !asked)) return [];
		const memo = this.data().memo.words;
		// "3|": the ask changed in 0.9.2 (the idea behind the search), so old answers are asked again.
		const key = hashId("3|" + q);
		if (memo[key]) return memo[key];
		return this.once("w" + key, async () => {
			const out = await this.askJson<{ words?: unknown }>(
				"You help a person search their own saved quotes from books. First find the topic behind the search. " +
					"Then give the plain words that quotes on that topic use, for it or against it: the people, roles and " +
					"actions in them. Example: for 'is money the root of evil' give greed, wealth, rich, poor, gold, love, sin, coin. When the search hints at who said it, add the likely names of people or books. " +
					"The person may remember it wrong. Single words only, lowercase. " +
					'Answer with JSON only: {"words": ["..."]} with 8 to 14 words.',
				q,
				110,
			);
			const words = Array.isArray(out?.words) ? out.words.filter((w): w is string => typeof w === "string").map((w) => w.toLowerCase().trim()).filter((w) => w && !w.includes(" ")).slice(0, 14) : [];
			if (words.length) this.remember(memo, key, words);
			return words;
		});
	}

	/**
	 * Search deeper: AI finds the clips about the topic of a search, best first. Two steps:
	 * 1. Skim: AI reads a short piece of every clip, 80 at a time, and keeps the ones that may fit.
	 * 2. Rank: AI reads those in full, up to 40 at a time, and orders the ones that fit.
	 * About 35 tokens a clip. Remembered, so the same search costs nothing again. Returns null when AI did not answer.
	 */
	async findClips(query: string, clips: FindClip[]): Promise<string[] | null> {
		const q = query.replace(/\s+/g, " ").trim().slice(0, 200);
		if (!q || !this.usable() || !clips.length) return clips.length ? null : [];
		const list = clips.slice(0, FIND_MAX);
		const key = hashId("f3|" + q.toLowerCase() + "|" + list.map((c) => c.id).join(","));
		const memo = this.data().memo.picks;
		if (memo[key]) return memo[key];
		return this.once("f" + key, async () => {
			let short = list;
			if (list.length > RANK_BATCH) {
				const got = await Promise.all(evenParts(list, SKIM_BATCH).map((part) => this.skim(q, part)));
				if (got.every((g) => !g)) return null;
				const keep = new Set(got.flatMap((g) => g ?? []));
				short = list.filter((c) => keep.has(c.id));
			}
			if (!short.length) {
				this.remember(memo, key, []);
				return [];
			}
			const got = await Promise.all(evenParts(short, RANK_BATCH).map((part) => this.rank(q, part)));
			if (got.every((g) => !g)) return null;
			// Highest score first, across every ask.
			const ids = [...new Set(got.flatMap((g) => g ?? []).sort((a, b) => b.s - a.s).map((x) => x.id))];
			this.remember(memo, key, ids);
			return ids;
		});
	}

	/** Step 1 of search deeper: the numbered clips that may be about the topic. Generous: step 2 looks closer. */
	private async skim(q: string, list: FindClip[]): Promise<string[] | null> {
		const out = await this.askJson<{ ids?: unknown }>(
			"A person searches their own saved quotes for a topic. Pick every numbered quote that may be about that topic, " +
				"even in other words, for it or against it, or showing it in a story. Leave out quotes plainly about something " +
				"else. When unsure, pick it: a second step looks closer. " +
				'Answer with JSON only: {"ids": [numbers]}.',
			"I am looking for: " + q + "\n\nMy saved quotes:\n" + numbered(list, SKIM_CUT, 60),
			240,
		);
		if (!out || !Array.isArray(out.ids)) return null;
		return toIds(out.ids, list);
	}

	/**
	 * Step 2 of search deeper: AI scores each clip from 0 to 5 and the ones at 3 and up are kept.
	 * A score for every clip makes AI judge each one, which keeps out more of the clips that only share a word.
	 */
	private async rank(q: string, list: FindClip[]): Promise<{ id: string; s: number }[] | null> {
		const out = await this.askJson<{ scores?: unknown }>(
			"A person searches their own saved quotes. Write the topic they mean in a few words. Then score each numbered quote: " +
				"5 = exactly what they look for; 4 = clearly about that topic, even in other words; 3 = partly about it; " +
				"2 = same wider field only; 1 = only shares a word; 0 = about something else. A quote that agrees, disagrees, or shows the topic in a story is about it. They may " +
				"remember it wrong or only in part: match the idea, the context and who said it (the source is in brackets, and " +
				"their own note on a quote after it). " +
				'Answer with JSON only: {"topic": "...", "scores": [one number for each quote, in order]}.',
			"I am looking for: " + q + "\n\nMy saved quotes:\n" + numbered(list, RANK_CUT, 120),
			60 + list.length * 3,
		);
		if (!out || !Array.isArray(out.scores)) return null;
		const score = out.scores.map((n) => (typeof n === "number" ? n : parseInt(String(n), 10)));
		return list.map((c, i) => ({ id: c.id, s: score[i] })).filter((x) => x.s >= 3);
	}

	/**
	 * Picks, from up to 16 numbered clips, the ones that fit what the person is writing, best first.
	 * Sends a short piece of the note and a short piece of each clip.
	 */
	async pickRelated(noteText: string, clips: { id: string; text: string }[]): Promise<string[] | null> {
		if (!this.usable() || !this.s.meaning || clips.length < 2) return null;
		const note = cut(noteText.replace(/\s+/g, " ").trim(), 350);
		const list = clips.slice(0, 16);
		const key = hashId(note + "|" + list.map((c) => c.id).join(","));
		const memo = this.data().memo.picks;
		if (memo[key]) return memo[key];
		return this.once("p" + key, async () => {
			const user = "What I am writing:\n" + note + "\n\nMy saved quotes:\n" + list.map((c, i) => `${i + 1}. ${cut(c.text.replace(/\s+/g, " "), 160)}`).join("\n");
			const out = await this.askJson<{ ids?: unknown }>(
				"Pick the numbered items that would help the person with what they are writing: quotes they could use, " +
					"support, or argue against. Best first. Leave out the ones that do not fit. " +
					'Answer with JSON only: {"ids": [numbers]}.',
				user,
				60,
			);
			if (!Array.isArray(out?.ids)) return null;
			const ids = out.ids
				.map((n) => (typeof n === "number" ? n : parseInt(String(n), 10)))
				.filter((n) => n >= 1 && n <= list.length)
				.map((n) => list[n - 1].id);
			const unique = [...new Set(ids)];
			this.remember(memo, key, unique);
			return unique;
		});
	}

	/**
	 * Tag ideas for clips. Tags are single words about the topic. The person's own tags come first; a new tag only
	 * for a topic none of theirs covers. Up to 12 clips per call.
	 */
	async tagIdeas(items: { id: string; text: string; note: string }[], theirTags: string[]): Promise<Record<string, string[]>> {
		const out: Record<string, string[]> = {};
		if (!this.usable() || !items.length) return out;
		const memo = this.data().memo.tags;
		const todo = items.filter((i) => !memo[i.id]);
		for (const i of items) if (memo[i.id]) out[i.id] = memo[i.id];
		for (let at = 0; at < todo.length; at += 12) {
			const batch = todo.slice(at, at + 12);
			const user =
				"My tags: " + theirTags.slice(0, 150).join(", ") + "\n\nQuotes:\n" +
				batch.map((b, n) => `${n + 1}. ${cut(b.text.replace(/\s+/g, " "), 300)}${b.note ? " (my note: " + cut(b.note.replace(/\s+/g, " "), 120) + ")" : ""}`).join("\n");
			const ans = await this.askJson<Record<string, unknown>>(
				"Suggest up to 5 tags for each numbered quote. A tag is ONE lowercase word naming a topic: a theme, field or " +
					"person (jung, not carl-jung). Use my tags first, every one that fits. Add a new tag only for a topic my tags " +
					"do not cover. Never copy a phrase from the quote. No filler words like note, quote, idea, life. " +
					'Answer with JSON only: {"1": ["tag"], "2": ["tag"]}.',
				user,
				40 + batch.length * 30,
			);
			if (!ans) break;
			batch.forEach((b, n) => {
				const raw = ans[String(n + 1)];
				const tags = keepTags(Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [], theirTags, b.text);
				out[b.id] = tags;
				this.remember(memo, b.id, tags);
			});
		}
		return out;
	}
}

const FILLER = new Set(["note", "notes", "quote", "quotes", "idea", "ideas", "life", "thought", "thoughts", "clip", "clips", "clipping", "clippings", "general", "misc", "other", "important", "insight", "wisdom", "highlight"]);

/**
 * The tag rules, enforced in code and not only asked for: one word, lowercase, no filler, not a phrase from the
 * quote, and a near match to one of the person's tags becomes their tag (habit becomes habits).
 */
export function keepTags(ideas: string[], theirs: string[], text: string): string[] {
	const own = new Map(theirs.map((t) => [t.toLowerCase(), t]));
	const lower = text.toLowerCase();
	const out: string[] = [];
	for (const raw of ideas) {
		let t = raw.toLowerCase().replace(/^#/, "").trim();
		if (!t || /\s/.test(t)) continue;
		if (t.includes("-") && !own.has(t)) {
			// "carl-jung" is a phrase: keep the last part only if it is a name-like single word.
			const parts = t.split("-");
			t = parts[parts.length - 1];
		}
		if (t.length < 3 || FILLER.has(t)) continue;
		const near = own.get(t) ?? own.get(t + "s") ?? own.get(t.replace(/s$/, "")) ?? own.get(t.replace(/ies$/, "y")) ?? own.get(t.replace(/y$/, "ies"));
		if (near) t = near;
		else if (lower.includes(t) && t.length > 12) continue;
		if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
		if (out.length >= 5) break;
	}
	return out;
}

export interface ServiceModel {
	id: string;
	/** Price or a short note, for the picker. */
	hint: string;
	/** Thinks before it answers: slower, and uses many more tokens. */
	thinks: boolean;
}

interface RawModel {
	id?: string;
	name?: string;
	pricing?: { prompt?: string; completion?: string };
	architecture?: { output_modalities?: string[] };
	supported_parameters?: string[];
}

const THINKS = /(^|[/-])(o\d|r1|qwq)\b|think|reason/i;
const NOT_TEXT = /embed|whisper|tts|dall-e|image|audio|realtime|moderation|transcribe|search|vision-preview|guard|rerank|veo|imagen|aqa/i;
const SMALL = /mini|nano|lite|flash|haiku|small|8b|instant|tiny|3b|1b|ministral|chat$/i;

/** Text models only, the small fast ones first, models that think first last. */
export function rankModels(provider: string, list: RawModel[]): ServiceModel[] {
	const out: (ServiceModel & { score: number; price: number })[] = [];
	const seen = new Set<string>();
	for (const m of list) {
		const id = (m.id ?? m.name ?? "").replace(/^models\//, "");
		if (!id || seen.has(id) || NOT_TEXT.test(id)) continue;
		if (m.architecture?.output_modalities && !m.architecture.output_modalities.includes("text")) continue;
		seen.add(id);
		const thinks = THINKS.test(id);
		const inP = parseFloat(m.pricing?.prompt ?? "");
		const outP = parseFloat(m.pricing?.completion ?? "");
		const price = isFinite(inP) && isFinite(outP) ? inP + outP : NaN;
		const hint = isFinite(price)
			? price === 0
				? "free"
				: `$${(inP * 1e6).toFixed(2)} / $${(outP * 1e6).toFixed(2)} per 1M tokens`
			: "";
		const score = (thinks ? 100 : 0) + (SMALL.test(id) ? 0 : 10);
		out.push({ id, hint: thinks ? (hint ? hint + " · thinks first, uses more" : "thinks first, uses more") : hint, thinks, score, price: isFinite(price) && price > 0 ? price : 1 });
	}
	return out
		.sort((a, b) => a.score - b.score || a.price - b.price || a.id.localeCompare(b.id))
		.map(({ id, hint, thinks }) => ({ id, hint, thinks }));
}
