// Meaning search on this device: gets the small model once, keeps a meaning vector for each clip, and finds the
// clips closest in meaning to a search or a note. No AI app, no key, no tokens.
// Kept light: nothing loads until a search or the side bar needs it, and each clip's meaning is 128 bytes.
import { Events, normalizePath, requestUrl, type App } from "obsidian";
import { pack, readSafetensors, StaticModel, unpack, WordPiece } from "./embed";
import type { Clip } from "./model";
import type { IndexSettings } from "./settings";

// One fixed version of the model, so every device gets the same bytes.
const REV = "9b3cff412d30be9ae8603fe10224c224f3401869";
const BASE = `https://huggingface.co/minishlab/potion-base-4M/resolve/${REV}/`;
const MODEL = { url: BASE + "model.safetensors", sha: "8a7140edd17ffab30ddcff1135eda127df57abfae856203dbd7b3d061295c31a", size: 15118424 };
const VOCAB = { url: BASE + "vocab.txt", sha: "1394523a67ddd404a825428018c0582a6998bcfa044ecbcbf1f4d71adb94c61c" };
const KEPT = "potion-base-4M.bin";
const KEPT_VOCAB = "vocab.txt";
/** Model files from earlier versions, removed when found. */
const OLD = ["potion-base-8M.bin"];

/** The download and what is kept, for Settings. */
export const GET_MB = 15;
export const KEEP_MB = 4;

/** How close a clip must be, for each choice in Settings. Measured on a real library: unrelated clips score about 0.2. */
const NEAR: Record<IndexSettings["near"], number> = { close: 0.5, some: 0.41, loose: 0.33 };

/** "idle": the model is on this device but not loaded yet. It loads the first time it is needed. */
export type MeaningState = "off" | "missing" | "idle" | "getting" | "loading" | "ready" | "failed";

export interface Near {
	clip: Clip;
	sim: number;
}

interface Vec {
	text: string;
	tags: string[];
	v: Int8Array | null;
}

export class MeaningIndex extends Events {
	state: MeaningState = "off";
	error = "";
	/** The model files are on this device. */
	present = false;
	private model: StaticModel | null = null;
	private vecs = new Map<string, Vec>();
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

	/** Turned on, but the model is still on its way: getting, loading, or waiting to load. */
	get waking(): boolean {
		return this.s().on && !this.model && (this.state === "idle" || this.state === "getting" || this.state === "loading" || (this.state === "missing" && this.s().auto));
	}

	/** Meaning search answers here (search or side bar): ready, or ready in a moment. */
	usable(where: "search" | "sidebar"): boolean {
		return this.s()[where] && (this.ready || this.waking);
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

	/** When Obsidian opens: only looks for the files. Nothing is loaded or downloaded until it is needed. */
	async start(): Promise<void> {
		const a = this.app.vault.adapter;
		for (const f of OLD) if (await a.exists(this.folder + "/" + f)) await a.remove(this.folder + "/" + f);
		this.present = (await a.exists(this.folder + "/" + KEPT)) && (await a.exists(this.folder + "/" + KEPT_VOCAB));
		if (!this.s().on) this.set("off");
		else this.set(this.present ? "idle" : "missing");
	}

	/** Loads the model, or gets it first when this device has none and the settings allow it. */
	wake(): Promise<void> {
		if (this.model || this.job || !this.s().on || this.state === "failed") return this.job ?? Promise.resolve();
		if (this.present) return this.load();
		if (this.s().auto) return this.get();
		return Promise.resolve();
	}

	/** Downloads the model once (15 MB), checks it, and keeps a small copy (4 MB) in the plugin folder. */
	get(): Promise<void> {
		if (this.job) return this.job;
		// One step later, so this.job is set before the state event: a redraw that asks again waits for this one.
		this.job = Promise.resolve().then(async () => {
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
				this.job = null;
				await this.load();
			} catch (e) {
				this.set("failed", e instanceof Error ? e.message : String(e));
			}
		}).finally(() => (this.job = null));
		return this.job;
	}

	load(): Promise<void> {
		if (this.job) return this.job;
		this.job = Promise.resolve().then(async () => {
			this.set("loading");
			try {
				const a = this.app.vault.adapter;
				const packed = unpack(await a.readBinary(this.folder + "/" + KEPT));
				const words = (await a.read(this.folder + "/" + KEPT_VOCAB)).split(/\r?\n/);
				this.model = new StaticModel(packed, new WordPiece(words));
				this.vecs.clear();
				this.set("ready");
				this.warm();
			} catch (e) {
				this.model = null;
				this.set("failed", e instanceof Error ? e.message : String(e));
			}
		}).finally(() => (this.job = null));
		return this.job;
	}

	/** Deletes the model from this device. */
	async remove(): Promise<void> {
		this.unload();
		const a = this.app.vault.adapter;
		if (await a.exists(this.folder)) await a.rmdir(this.folder, true);
		this.present = false;
		this.set("off");
	}

	/** After the setting changes. Off frees the memory at once. */
	async turned(on: boolean): Promise<void> {
		if (!on) {
			this.unload();
			this.set("off");
		} else if (!this.model) await this.start();
	}

	private unload() {
		window.clearTimeout(this.warmTimer);
		this.model = null;
		this.vecs.clear();
	}

	embed(text: string, maxPieces?: number): Float32Array | null {
		return this.model?.embed(text, maxPieces) ?? null;
	}

	/** The clip's meaning, made once and made again only when its words or tags change. */
	private vector(c: Clip): Int8Array | null {
		const have = this.vecs.get(c.id);
		if (have && have.text === c.text && sameList(have.tags, c.tags)) return have.v;
		const f = this.model?.embed(c.text + "\n" + c.tags.join(" "));
		const v = f ? toBytes(f) : null;
		this.vecs.set(c.id, { text: c.text, tags: c.tags, v });
		return v;
	}

	/**
	 * The clips closest in meaning, best first. Only clips past the closeness set in Settings.
	 * The first call loads the model and returns nothing; the side bar and library draw again when it is ready.
	 */
	/** min: the lowest closeness kept; by default the "How close" setting. */
	near(what: string, pool: Clip[], skip: Set<string> = new Set(), limit = 40, maxPieces?: number, min = NEAR[this.s().near]): Near[] {
		if (!this.model) {
			void this.wake();
			return [];
		}
		const q = this.embed(what, maxPieces);
		if (!q) return [];
		const out: Near[] = [];
		for (const c of pool) {
			if (skip.has(c.id)) continue;
			const v = this.vector(c);
			if (!v) continue;
			let s = 0;
			for (let i = 0; i < v.length; i++) s += q[i] * v[i];
			const sim = s / 127;
			if (sim >= min) out.push({ clip: c, sim });
		}
		// Clips that are gone lose their vector.
		if (this.vecs.size > this.clips().length + 200) this.prune();
		out.sort((a, b) => b.sim - a.sim);
		return out.slice(0, limit);
	}

	private prune() {
		const ids = new Set(this.clips().map((c) => c.id));
		for (const id of [...this.vecs.keys()]) if (!ids.has(id)) this.vecs.delete(id);
	}

	/** Once, after loading: every clip gets its meaning in small steps, so the first search is quick. */
	private warm() {
		const clips = this.clips();
		let i = 0;
		const step = () => {
			if (!this.model) return;
			const end = Math.min(clips.length, i + 300);
			for (; i < end; i++) this.vector(clips[i]);
			if (i < clips.length) this.warmTimer = window.setTimeout(step, 30);
		};
		this.warmTimer = window.setTimeout(step, 300);
	}

	stop() {
		window.clearTimeout(this.warmTimer);
	}
}

/** A unit vector as 8-bit numbers: a quarter of the memory, and the same order of results. */
function toBytes(f: Float32Array): Int8Array {
	const b = new Int8Array(f.length);
	for (let i = 0; i < f.length; i++) b[i] = Math.round(f[i] * 127);
	return b;
}

function sameList(a: string[], b: string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

async function sameHash(buf: ArrayBuffer, sha: string): Promise<boolean> {
	const subtle = window.crypto?.subtle;
	// Without a hash tool the size check above still stands.
	if (!subtle) return true;
	const d = new Uint8Array(await subtle.digest("SHA-256", buf));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("") === sha;
}
