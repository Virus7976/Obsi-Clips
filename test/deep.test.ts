import { test } from "node:test";
import assert from "node:assert/strict";
import { DEEP_MAX, deepFind, type DeepAi, type DeepMeaning } from "../src/deep";
import type { Clip } from "../src/model";

const clip = (id: string, text: string): Clip => ({ id, text, norm: text.toLowerCase(), places: [], kind: "book", source: "Book", author: "", url: "", clipped: 0, tags: [], words: [], uses: [] });

const noMeaning: DeepMeaning = { ready: false, usable: () => false, wake: async () => {}, near: () => [] };

function fakeAi(pick: (ids: string[]) => string[], words: string[] = []) {
	const sent: string[][] = [];
	let asked = 0;
	const ai: DeepAi = {
		meaningWords: async () => {
			asked++;
			return words;
		},
		findClips: async (_q, list) => {
			sent.push(list.map((c) => c.id));
			return pick(list.map((c) => c.id));
		},
	};
	return { ai, sent, asked: () => asked };
}

test("A small library goes to AI whole, without the clips shown already, and with no ask for other words", async () => {
	const pool = Array.from({ length: 34 }, (_, i) => clip("c" + i, "quote number " + i));
	const f = fakeAi((ids) => ids.slice(0, 3));
	const found = await deepFind(f.ai, noMeaning, "men and women", pool, new Set(["c0", "c1"]));
	assert.equal(f.sent[0].length, 32);
	assert.ok(!f.sent[0].includes("c0") && !f.sent[0].includes("c1"));
	assert.equal(f.asked(), 0);
	assert.deepEqual(found?.map((c) => c.id), ["c2", "c3", "c4"]);
});

test("AI's order is kept: its best first", async () => {
	const pool = [clip("a", "one"), clip("b", "two"), clip("c", "three")];
	const f = fakeAi(() => ["c", "a"]);
	const found = await deepFind(f.ai, noMeaning, "x", pool, new Set());
	assert.deepEqual(found?.map((c) => c.id), ["c", "a"]);
});

test("A big library sends at most DEEP_MAX likely clips, found by AI's other words", async () => {
	const pool = Array.from({ length: 500 }, (_, i) => clip("c" + i, i % 5 === 0 ? "the husband shall rule " + i : "a recipe for bread " + i));
	const f = fakeAi((ids) => ids, ["husband", "rule"]);
	await deepFind(f.ai, noMeaning, "who leads at home", pool, new Set());
	assert.equal(f.asked(), 1);
	assert.ok(f.sent[0].length > 0 && f.sent[0].length <= DEEP_MAX);
	assert.ok(f.sent[0].every((id) => Number(id.slice(1)) % 5 === 0));
});

test("Same words twice go to AI once", async () => {
	const pool = [clip("a", "Same words."), clip("b", "same   words."), clip("c", "Other")];
	const f = fakeAi((ids) => ids);
	await deepFind(f.ai, noMeaning, "x", pool, new Set());
	assert.deepEqual(f.sent[0], ["a", "c"]);
});

test("No answer from AI gives null", async () => {
	const ai: DeepAi = { meaningWords: async () => [], findClips: async () => null };
	assert.equal(await deepFind(ai, noMeaning, "x", [clip("a", "one")], new Set()), null);
});
