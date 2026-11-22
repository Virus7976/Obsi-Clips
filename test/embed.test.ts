import { test } from "node:test";
import assert from "node:assert/strict";
import { pack, similarity, StaticModel, unpack, WordPiece } from "../src/embed";
import { blend } from "../src/relate";

const VOCAB = ["[PAD]", "[UNK]", "cafe", "un", "##afford", "##able", ",", "!", "fear", "courage", "bread", "1854"];

test("word pieces: lowercase, no accents, punctuation on its own", () => {
	const wp = new WordPiece(VOCAB);
	assert.deepEqual(wp.words("Café, FEAR!"), ["cafe", ",", "fear", "!"]);
	assert.deepEqual(wp.encode("Unaffordable"), [3, 4, 5]);
	// A word it cannot cut is left out, not half kept.
	assert.deepEqual(wp.encode("unknownword fear"), [8]);
	assert.deepEqual(wp.encode("fear fear fear", 2), [8, 8]);
	assert.deepEqual(wp.encode("fear 1854"), [8]);
});

test("the 8-bit copy keeps the numbers close and is the same every time", () => {
	const rows = 11, dim = 4;
	const data = new Float32Array(rows * dim).map((_, i) => Math.sin(i * 1.7) * (1 + (i % 3)));
	const a = new Uint8Array(pack(rows, dim, data));
	const b = new Uint8Array(pack(rows, dim, data));
	assert.deepEqual(a, b);
	const p = unpack(a.buffer);
	for (let i = 0; i < rows * dim; i++) assert.ok(Math.abs(p.q[i] * p.scales[Math.floor(i / dim)] - data[i]) < 0.03);
	assert.throws(() => unpack(a.buffer.slice(0, 40)));
});

test("a text's vector is unit length, and the same text is the closest", () => {
	const rows = VOCAB.length, dim = 3;
	const data = new Float32Array(rows * dim);
	data.set([1, 0, 0], 8 * dim); // fear
	data.set([0.9, 0.3, 0], 9 * dim); // courage
	data.set([0, 0, 1], 10 * dim); // bread
	const m = new StaticModel(unpack(pack(rows, dim, data)), new WordPiece(VOCAB));
	const fear = m.embed("Fear")!;
	assert.ok(Math.abs(similarity(fear, fear) - 1) < 1e-3);
	assert.ok(similarity(fear, m.embed("courage")!) > similarity(fear, m.embed("bread")!));
	assert.equal(m.embed("nothing known here"), null);
});

test("blend: a clip in both lists ranks first, and word reasons stay", () => {
	const words = [{ id: "a", score: 3, why: ["time"] }, { id: "b", score: 2, why: ["money"] }];
	const out = blend(words, ["c", "b"]);
	assert.equal(out[0].id, "b");
	assert.deepEqual(out[0].why, ["money"]);
	assert.deepEqual(out.map((r) => r.id).sort(), ["a", "b", "c"]);
});
