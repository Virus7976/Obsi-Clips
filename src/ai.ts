// Optional AI help. It never writes text for you: it only helps find your own clips and suggests tags.
// Off until set up. Every call sends little text, asks for a short answer, and the answer is kept.
import { requestUrl, type App } from "obsidian";
import { clip as cut, hashId } from "./text";
import { addressProblem } from "./safety";
import { PHONE_SECRET, PROVIDERS, type AiSettings, type PluginData } from "./settings";

const MAX_MEMO = 400;
/** Search deeper: how many likely clips AI reads, and how much of each. */
const FIND_MAX = 36;
const FIND_CUT = 140;

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

	/** Other words for what a search means, so a search for "fear" also finds "courage". */
	async meaningWords(query: string, asked = false): Promise<string[]> {
		const q = query.trim().toLowerCase().slice(0, 200);
		// "asked": the person pressed Find by meaning, so it runs even with Find by meaning turned off.
		if (!q || !this.usable() || (!this.s.meaning && !asked)) return [];
		const memo = this.data().memo.words;
		// "2|": the ask changed in 0.9.1 (names of people and books), so old answers are asked again.
		const key = hashId("2|" + q);
		if (memo[key]) return memo[key];
		return this.once("w" + key, async () => {
			const out = await this.askJson<{ words?: unknown }>(
				"You help a person search their own saved quotes. Give other words for what this search means: close words, " +
					"related ideas, and the plain words a quote about it would use. When the search hints at who said it, add the likely " +
					"names of people or books, like plato or nietzsche. The person may remember it wrong. Single words only, lowercase. " +
					'Answer with JSON only: {"words": ["..."]} with 6 to 10 words.',
				q,
				80,
			);
			const words = Array.isArray(out?.words) ? out.words.filter((w): w is string => typeof w === "string").map((w) => w.toLowerCase().trim()).filter((w) => w && !w.includes(" ")).slice(0, 10) : [];
			if (words.length) this.remember(memo, key, words);
			return words;
		});
	}

	/**
	 * Search deeper: AI reads a short list of likely clips and keeps only the ones that truly fit the search.
	 * Each clip is cut short, so a search costs about 1,500 tokens. Remembered, so the same search costs nothing again.
	 * Returns null when AI did not answer.
	 */
	async findClips(query: string, clips: { id: string; text: string; source: string }[]): Promise<string[] | null> {
		const q = query.replace(/\s+/g, " ").trim().slice(0, 200);
		if (!q || !this.usable() || !clips.length) return clips.length ? null : [];
		const list = clips.slice(0, FIND_MAX);
		const key = hashId("f|" + q.toLowerCase() + "|" + list.map((c) => c.id).join(","));
		const memo = this.data().memo.picks;
		if (memo[key]) return memo[key];
		return this.once("f" + key, async () => {
			const user = "I am looking for: " + q + "\n\nMy saved quotes:\n" + list.map((c, i) => `${i + 1}. ${cut(c.text.replace(/\s+/g, " "), FIND_CUT)} (${cut(c.source, 40)})`).join("\n");
			const out = await this.askJson<{ ids?: unknown }>(
				"A person searches their own saved quotes. Pick the numbered quotes that are about what they are looking for, " +
					"even in other words. They may remember it wrong or only in part: match the idea, the context and who said it " +
					"(the source is in brackets). Leave out quotes that only share a word with the search, or are about something else. " +
					"Best first. If none fit, give an empty list. " +
					'Answer with JSON only: {"ids": [numbers]}.',
				user,
				80,
			);
			if (!Array.isArray(out?.ids)) return null;
			const ids = [...new Set(out.ids.map((n) => (typeof n === "number" ? n : parseInt(String(n), 10))).filter((n) => n >= 1 && n <= list.length).map((n) => list[n - 1].id))];
			this.remember(memo, key, ids);
			return ids;
		});
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
