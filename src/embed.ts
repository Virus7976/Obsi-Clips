// Meaning vectors on this device, with no AI app: a small "static" model (Model2Vec potion-base-4M, MIT).
// Each word piece has a fixed list of 128 numbers. A text's vector is the mean of its pieces' lists, made unit length.
// Two texts close in meaning have vectors that point the same way. No Obsidian parts, so tests can run it.

const MAGIC = 0x314d4c43; // "CLM1"

/** The model as it is kept on disk: one scale per row and 8-bit numbers, a quarter of the download's size. */
export interface Packed {
	rows: number;
	dim: number;
	scales: Float32Array;
	q: Int8Array;
}

/** Reads the one F32 table in a .safetensors file. */
export function readSafetensors(buf: ArrayBuffer): { rows: number; dim: number; data: Float32Array } {
	const view = new DataView(buf);
	const headLen = Number(view.getBigUint64(0, true));
	const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen))) as Record<string, { dtype?: string; shape?: number[]; data_offsets?: number[] }>;
	const t = Object.entries(head).find(([k, v]) => k !== "__metadata__" && v.dtype === "F32" && v.shape?.length === 2)?.[1];
	if (!t?.shape || !t.data_offsets) throw new Error("The model file has no table.");
	const [rows, dim] = t.shape;
	const start = 8 + headLen + t.data_offsets[0];
	// A view when the table starts on a 4-byte line, so 15 MB is not copied.
	const data = start % 4 === 0 ? new Float32Array(buf, start, rows * dim) : new Float32Array(buf.slice(start, start + rows * dim * 4));
	return { rows, dim, data };
}

/** Makes the small 8-bit copy. The same input always gives the same bytes, so two devices make the same file. */
export function pack(rows: number, dim: number, data: Float32Array): ArrayBuffer {
	const out = new ArrayBuffer(12 + rows * 4 + rows * dim);
	const v = new DataView(out);
	v.setUint32(0, MAGIC, true);
	v.setUint32(4, rows, true);
	v.setUint32(8, dim, true);
	const scales = new Float32Array(out, 12, rows);
	const q = new Int8Array(out, 12 + rows * 4, rows * dim);
	for (let r = 0; r < rows; r++) {
		let max = 0;
		for (let d = 0; d < dim; d++) max = Math.max(max, Math.abs(data[r * dim + d]));
		const s = max / 127 || 1;
		scales[r] = s;
		for (let d = 0; d < dim; d++) q[r * dim + d] = Math.round(data[r * dim + d] / s);
	}
	return out;
}

export function unpack(buf: ArrayBuffer): Packed {
	const v = new DataView(buf);
	if (v.getUint32(0, true) !== MAGIC) throw new Error("The meaning model file is not right.");
	const rows = v.getUint32(4, true);
	const dim = v.getUint32(8, true);
	if (buf.byteLength !== 12 + rows * 4 + rows * dim) throw new Error("The meaning model file is cut short.");
	return { rows, dim, scales: new Float32Array(buf.slice(12, 12 + rows * 4)), q: new Int8Array(buf, 12 + rows * 4, rows * dim) };
}

const isPunct = (ch: string, code: number) => (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126) || /\p{P}/u.test(ch);
const isCjk = (c: number) =>
	(c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) || (c >= 0x2a700 && c <= 0x2b81f) || (c >= 0x2b820 && c <= 0x2ceaf) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f);

/** BERT's uncased word pieces, the way the model was made: lowercase, no accents, punctuation on its own. */
export class WordPiece {
	private ids = new Map<string, number>();
	private unk: number;

	constructor(vocab: string[]) {
		vocab.forEach((w, i) => {
			if (w && !this.ids.has(w)) this.ids.set(w, i);
		});
		this.unk = this.ids.get("[UNK]") ?? -1;
	}

	get size() {
		return this.ids.size;
	}

	/** Words of the text, before they are cut into pieces. */
	words(text: string): string[] {
		let clean = "";
		for (const ch of text) {
			const c = ch.codePointAt(0) ?? 0;
			if (c === 0 || c === 0xfffd || (/\p{Cc}|\p{Cf}/u.test(ch) && ch !== "\t" && ch !== "\n" && ch !== "\r")) continue;
			if (/\s/.test(ch)) clean += " ";
			else if (isCjk(c)) clean += " " + ch + " ";
			else clean += ch;
		}
		clean = clean.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
		const out: string[] = [];
		for (const part of clean.split(" ")) {
			if (!part) continue;
			let cur = "";
			for (const ch of part) {
				if (isPunct(ch, ch.codePointAt(0) ?? 0)) {
					if (cur) out.push(cur);
					out.push(ch);
					cur = "";
				} else cur += ch;
			}
			if (cur) out.push(cur);
		}
		return out;
	}

	/** Piece numbers for the text. Words it cannot cut, and numbers, are left out. */
	encode(text: string, max = Infinity): number[] {
		const out: number[] = [];
		for (const w of this.words(text)) {
			if (out.length >= max) break;
			const chars = [...w];
			// Numbers, like a year or a page, say nothing about meaning.
			if (chars.length > 100 || /^[0-9]+$/.test(w)) continue;
			const pieces: number[] = [];
			let start = 0;
			let bad = false;
			while (start < chars.length) {
				let end = chars.length;
				let found = -1;
				while (start < end) {
					const sub = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
					const id = this.ids.get(sub);
					if (id !== undefined) {
						found = id;
						break;
					}
					end--;
				}
				if (found < 0) {
					bad = true;
					break;
				}
				pieces.push(found);
				start = end;
			}
			if (!bad) for (const p of pieces) if (p !== this.unk) out.push(p);
		}
		return out.slice(0, max);
	}
}

export class StaticModel {
	readonly dim: number;
	constructor(
		private m: Packed,
		readonly pieces: WordPiece,
	) {
		this.dim = m.dim;
	}

	/** The text's meaning vector, unit length. Null when no word is known. */
	embed(text: string, maxPieces = 2048): Float32Array | null {
		const ids = this.pieces.encode(text, maxPieces);
		const { dim, q, scales } = this.m;
		const v = new Float32Array(dim);
		let n = 0;
		for (const id of ids) {
			if (id >= this.m.rows) continue;
			const s = scales[id];
			const o = id * dim;
			for (let d = 0; d < dim; d++) v[d] += q[o + d] * s;
			n++;
		}
		if (!n) return null;
		let len = 0;
		for (let d = 0; d < dim; d++) len += v[d] * v[d];
		len = Math.sqrt(len);
		if (!len) return null;
		for (let d = 0; d < dim; d++) v[d] /= len;
		return v;
	}
}

/** How close two unit vectors are: 1 is the same meaning, 0 is unrelated. */
export function similarity(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}
