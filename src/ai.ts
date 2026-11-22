// Optional AI help. It never writes text for you: it only helps find your own clips and suggests tags.
// Off until set up. Every call sends little text, asks for a short answer, and the answer is kept.
import { requestUrl, type App } from "obsidian";
import { clip as cut, hashId } from "./text";
import { PROVIDERS, type PluginData } from "./settings";

const MAX_MEMO = 400;

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

	key(): string {
		try {
			return this.app.secretStorage.getSecret(this.s.keyName) ?? "";
		} catch {
			return "";
		}
	}

	/** Ready to use: turned on, an address and a model, and a key when the service needs one. */
	usable(): boolean {
		const s = this.s;
		if (!s.on || !s.baseUrl.trim() || !s.model.trim()) return false;
		return PROVIDERS[s.provider]?.key === false || this.key() !== "";
	}

	/** One chat call. Returns the answer text, or "" on any failure. */
	async ask(system: string, user: string, maxTokens: number): Promise<string> {
		if (!this.usable()) return "";
		const s = this.s;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		const key = this.key();
		if (key) headers.Authorization = `Bearer ${key}`;
		if (s.provider === "openrouter") {
			headers["HTTP-Referer"] = "https://github.com/Virus7976/Obsi-Clips";
			headers["X-Title"] = "Obsi Clips";
		}
		try {
			const res = await requestUrl({
				url: s.baseUrl.replace(/\/+$/, "") + "/chat/completions",
				method: "POST",
				headers,
				body: JSON.stringify({
					model: s.model,
					temperature: 0.2,
					max_tokens: maxTokens,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
				}),
				throw: false,
			});
			if (res.status >= 400) {
				const msg = (res.json as { error?: { message?: string } } | null)?.error?.message;
				this.lastError = `The service said ${res.status}${msg ? ": " + msg : ""}`;
				return "";
			}
			const text = (res.json as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
			this.lastError = "";
			return text.trim();
		} catch (e) {
			this.lastError = e instanceof Error ? e.message : "Could not reach the service";
			return "";
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
	async meaningWords(query: string): Promise<string[]> {
		const q = query.trim().toLowerCase().slice(0, 200);
		if (!q || !this.usable() || !this.s.meaning) return [];
		const memo = this.data().memo.words;
		const key = hashId(q);
		if (memo[key]) return memo[key];
		return this.once("w" + key, async () => {
			const out = await this.askJson<{ words?: unknown }>(
				"You help a person search their own saved quotes. Give other words for what this search means: close words, " +
					"related ideas, and the plain words a quote about it would use. Single words only, lowercase. " +
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
