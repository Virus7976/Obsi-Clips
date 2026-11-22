// Meaning search on this device: gets the small model once, keeps a meaning vector for each clip, and finds the
// clips closest in meaning to a search or a note. No AI app, no key, no tokens.
import { Events, normalizePath, requestUrl, type App } from "obsidian";
import { pack, readSafetensors, similarity, StaticModel, unpack, WordPiece } from "./embed";
import type { Clip } from "./model";
import type { IndexSettings } from "./settings";

// One fixed version of the model, so every device gets the same bytes.
const REV = "bf8b056651a2c21b8d2565580b8569da283cab23";
const BASE = `https://huggingface.co/minishlab/potion-base-8M/resolve/${REV}/`;
const MODEL = { url: BASE + "model.safetensors", sha: "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2", size: 30236760 };
const VOCAB = { url: BASE + "vocab.txt", sha: "1394523a67ddd404a825428018c0582a6998bcfa044ecbcbf1f4d71adb94c61c" };
const KEPT = "potion-base-8M.bin";
const KEPT_VOCAB = "vocab.txt";

/** The download and what is kept, for Settings. */
export const GET_MB = 30;
export const KEEP_MB = 8;

/** How close a clip must be, for each choice in Settings. */
const NEAR: Record<IndexSettings["near"], number> = { close: 0.45, some: 0.36, loose: 0.28 };

export type MeaningState = "off" | "missing" | "getting" | "loading" | "ready" | "failed";

export interface Near {
	clip: Clip;
	sim: number;
}

export class MeaningIndex extends Events {
	state: MeaningState = "off";
	error = "";
	/** The model files are on this device. */
	present = false;
	private model: StaticModel | null = null;
	private vecs = new Map<string, { key: string; v: Float32Array | null }>();
	private warmTimer = 0;
	private job: Promise<void> | null = null;

	constructor(
		private app: App,
		private dir: string,
		private s: () => IndexSettings,
		private clips: () => Clip[],
	) {
		super();
	}

	private get folder() {
		return normalizePath(this.dir + "/meaning");
	}

	/** On, with the model loaded. */
	get ready(): boolean {
		return this.s().on && this.state === "ready" && !!this.model;
	}

	/** Ready, and the setting for this place (search or side bar) is on. */
	usable(where: "search" | "sidebar"): boolean {
		return this.ready && this.s()[where];
	}

	/** How many clips have a meaning now. */
	get count(): number {
		let n = 0;
		for (const x of this.vecs.values()) if (x.v) n++;
		return n;
	}

	private set(state: MeaningState, error = "") {
		this.state = state;
		this.error = error;
		this.trigger("state");
	}

	/** When Obsidian opens: loads the model, or gets it when this device has none and the settings say to. */
	async start(): Promise<void> {
		this.present = await this.hasFiles();
		if (!this.s().on) {
			this.set("off");
			return;
		}
		if (this.present) return this.load();
		if (this.s().auto) return this.get();
		this.set("missing");
	}

	private async hasFiles(): Promise<boolean> {
		const a = this.app.vault.adapter;
		return (await a.exists(this.folder + "/" + KEPT)) && (await a.exists(this.folder + "/" + KEPT_VOCAB));
	}

	/** Downloads the model once (30 MB), checks it, and keeps a small copy (8 MB) in the plugin folder. */
	get(): Promise<void> {
		if (this.job) return this.job;
		this.job = (async () => {
			this.set("getting");
			try {
				const [m, v] = await Promise.all([requestUrl({ url: MODEL.url }), requestUrl({ url: VOCAB.url })]);
				const model = m.arrayBuffer;
				const vocab = v.arrayBuffer;
				if (model.byteLength !== MODEL.size) throw new Error("The download was cut short. Try again.");
				if (!(await sameHash(model, MODEL.sha)) || !(await sameHash(vocab, VOCAB.sha))) throw new Error("The download is not the right file.");
				const t = readSafetensors(model);
				const small = pack(t.rows, t.dim, t.data);
				const a = this.app.vault.adapter;
				if (!(await a.exists(this.folder))) await a.mkdir(this.folder);
				await a.writeBinary(this.folder + "/" + KEPT, small);
				await a.writeBinary(this.folder + "/" + KEPT_VOCAB, vocab);
				this.present = true;
				await this.load();
			} catch (e) {
				this.set("failed", e instanceof Error ? e.message : String(e));
			}
		})().finally(() => (this.job = null));
		return this.job;
	}

	async load(): Promise<void> {
		this.set("loading");
		try {
			const a = this.app.vault.adapter;
			const packed = unpack(await a.readBinary(this.folder + "/" + KEPT));
			const words = (await a.read(this.folder + "/" + KEPT_VOCAB)).split(/\r?\n/);
			this.model = new StaticModel(packed, new WordPiece(words));
			this.vecs.clear();
			this.set("ready");
			this.warmSoon(0);
		} catch (e) {
			this.model = null;
			this.set("failed", e instanceof Error ? e.message : String(e));
		}
	}

	/** Deletes the model from this device. */
	async remove(): Promise<void> {
		this.model = null;
		this.vecs.clear();
		const a = this.app.vault.adapter;
		if (await a.exists(this.folder)) await a.rmdir(this.folder, true);
		this.present = false;
		this.set("off");
	}

	/** After the setting changes. */
	async turned(on: boolean): Promise<void> {
		if (!on) {
			this.model = null;
			this.vecs.clear();
			this.set("off");
		} else if (!this.model) await this.start();
	}

	embed(text: string): Float32Array | null {
		return this.model?.embed(text) ?? null;
	}

	/** The clip's meaning, made once and made again only when its words or tags change. */
	vector(c: Clip): Float32Array | null {
		if (!this.model) return null;
		const key = c.text + "\n" + c.tags.join(" ");
		const have = this.vecs.get(c.id);
		if (have && have.key === key) return have.v;
		const v = this.model.embed(key);
		this.vecs.set(c.id, { key, v });
		return v;
	}

	/** The clips closest in meaning, best first. Only clips past the closeness set in Settings. */
	near(what: string | Float32Array, pool: Clip[], skip: Set<string> = new Set(), limit = 40, loosen = 1): Near[] {
		if (!this.model) return [];
		const q = typeof what === "string" ? this.embed(what) : what;
		if (!q) return [];
		const min = NEAR[this.s().near] * loosen;
		const out: Near[] = [];
		for (const c of pool) {
			if (skip.has(c.id)) continue;
			const v = this.vector(c);
			if (!v) continue;
			const sim = similarity(q, v);
			if (sim >= min) out.push({ clip: c, sim });
		}
		out.sort((a, b) => b.sim - a.sim);
		return out.slice(0, limit);
	}

	/** New clips get their meaning in the background, a few at a time, so the first search is fast. */
	warmSoon(ms = 500) {
		if (!this.model) return;
		window.clearTimeout(this.warmTimer);
		this.warmTimer = window.setTimeout(() => {
			const clips = this.clips();
			let i = 0;
			const step = () => {
				if (!this.model) return;
				const end = Math.min(clips.length, i + 400);
				for (; i < end; i++) this.vector(clips[i]);
				if (i < clips.length) this.warmTimer = window.setTimeout(step, 0);
				else {
					// Clips that are gone lose their vector.
					const ids = new Set(clips.map((c) => c.id));
					for (const id of [...this.vecs.keys()]) if (!ids.has(id)) this.vecs.delete(id);
					this.trigger("warm");
				}
			};
			step();
		}, ms);
	}

	stop() {
		window.clearTimeout(this.warmTimer);
	}
}

async function sameHash(buf: ArrayBuffer, sha: string): Promise<boolean> {
	const subtle = window.crypto?.subtle;
	// Without a hash tool the size check above still stands.
	if (!subtle) return true;
	const d = new Uint8Array(await subtle.digest("SHA-256", buf));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("") === sha;
}
