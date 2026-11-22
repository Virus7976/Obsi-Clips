import { test } from "node:test";
import assert from "node:assert/strict";
import { QuoteMatcher, nearCopies } from "../src/match";
import { Relater } from "../src/relate";
import { EMPTY_QUERY, groupHits, keepLater, pickDaily, runQuery, splitSearch, type Clip, type ClipState } from "../src/model";
import { fuzzyMatch, hashId, keywords, normalize } from "../src/text";

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 21, 12);

function clip(id: string, text: string, extra: Partial<Clip> = {}): Clip {
	return {
		id,
		text,
		norm: normalize(text),
		places: [{ path: `Clippings/${id}.md`, line: 0, endLine: 1, blockId: "", format: "obsi", where: "", link: "", color: "yellow", note: "", tags: [] }].map((p) => ({ ...p, writtenOver: false })),
		kind: "video",
		source: id,
		author: "",
		url: "",
		clipped: NOW - DAY,
		tags: [],
		words: keywords(text),
		uses: [],
		...extra,
	};
}

test("normalize and hashId: same words, same id", () => {
	assert.equal(normalize("It’s “Fine”, really—fine."), "its fine really fine");
	assert.equal(hashId(normalize("It's fine")), hashId(normalize("its   FINE!")));
	assert.notEqual(hashId("a"), hashId("b"));
});

test("QuoteMatcher finds a long clip by any 8-word run and a short clip only whole", () => {
	const long = "you realize that tomorrow was never a day it was a feeling of possibility";
	const m = new QuoteMatcher([
		{ id: "L", norm: normalize(long) },
		{ id: "S", norm: normalize("Fortune favours the bold") },
	]);
	assert.deepEqual([...m.find("As I wrote: “it was a feeling of possibility” and that never a day it was stays.")], []);
	assert.deepEqual([...m.find("He said tomorrow was never a day, it was a feeling. Wow.")], ["L"]);
	assert.deepEqual([...m.find("Fortune favours the bold, they say.")], ["S"]);
	assert.deepEqual([...m.find("Fortune favours the brave.")], []);
});

test("nearCopies finds a lightly edited copy and a clip inside another", () => {
	const a = clip("a", "The best way to predict the future is to create it yourself today");
	const b = clip("b", "The best way to predict the future is to create it yourself");
	const c = clip("c", "Completely different words about cooking pasta with fresh basil leaves");
	const pairs = nearCopies([a, b, c]);
	assert.equal(pairs.length, 1);
	assert.deepEqual(pairs[0].slice(0, 2).sort(), ["a", "b"]);
});

test("Relater ranks by rare shared words and tags, and explains why", () => {
	const clips = [
		clip("jung", "The shadow is the part of you that you refuse to see", { tags: ["jung"] }),
		clip("time", "Tomorrow never comes, today is the only day that exists"),
		clip("food", "Fresh basil makes the pasta sauce taste better"),
	];
	const r = new Relater(clips.map((c) => ({ id: c.id, words: c.words, tags: c.tags })));
	const ranked = r.rank("I keep putting things off until tomorrow. Today I will start.", []);
	assert.equal(ranked[0].id, "time");
	assert.ok(ranked[0].why.includes("tomorrow"));
	assert.ok(!ranked.some((x) => x.id === "food"));
	const byTag = r.rank("Notes on psychology", ["jung"]);
	assert.equal(byTag[0].id, "jung");
	assert.ok(byTag[0].why.includes("#jung"));
	assert.equal(r.rank("tomorrow today", [], [], new Set(["time"])).length, 0);
});

test("runQuery: search tokens, filters, archived hidden, sort and reverse", () => {
	const a = clip("a", "Discipline beats motivation every single day", { clipped: NOW - 3 * DAY, tags: ["habits"], uses: [{ path: "x.md", how: "quote", since: NOW - DAY }] });
	const b = clip("b", "Motivation is a feeling that comes and goes", { clipped: NOW - 1 * DAY, kind: "book" });
	const c = clip("c", "Archived thought about motivation and work", { clipped: NOW - 2 * DAY });
	const state: Record<string, ClipState> = { c: { arch: 1 }, b: { star: 1 } };
	const all = [a, b, c];
	const ids = (q: Partial<typeof EMPTY_QUERY>) => runQuery(all, state, { ...EMPTY_QUERY, ...q }, NOW).map((h) => h.clip.id);
	assert.deepEqual(ids({}), ["b", "a"]);
	assert.deepEqual(ids({ reverse: true }), ["a", "b"]);
	assert.deepEqual(ids({ saved: "archived" }), ["c"]);
	assert.deepEqual(ids({ text: "is:unused" }), ["b"]);
	assert.deepEqual(ids({ use: "used" }), ["a"]);
	assert.deepEqual(ids({ text: "#habits" }), ["a"]);
	assert.deepEqual(ids({ kinds: ["book"] }), ["b"]);
	assert.deepEqual(ids({ text: "is:starred" }), ["b"]);
	assert.deepEqual(ids({ text: "dicipline" }), ["a"]);
	assert.deepEqual(ids({ sort: "used" }), ["a", "b"]);
	assert.deepEqual(ids({ sort: "length" }), ["b", "a"]);
	assert.deepEqual(ids({ since: "7", sort: "clipped", reverse: true }), ["a", "b"]);
	const s = splitSearch("#jung is:unused color:red type:book shadow self");
	assert.deepEqual(s, { words: "shadow self", tags: ["jung"], is: ["unused"], colors: ["red"], kinds: ["book"] });
});

test("groupHits by tag puts a clip under each tag and untagged last", () => {
	const a = clip("a", "one two three four", { tags: ["x", "y"] });
	const b = clip("b", "five six seven eight", { tags: ["x"] });
	const c = clip("c", "nine ten eleven twelve");
	const hits = runQuery([a, b, c], {}, EMPTY_QUERY, NOW);
	const g = groupHits(hits, "tag", (k) => k);
	assert.deepEqual(g.map((x) => [x.label, x.hits.length]), [["#x", 2], ["#y", 1], ["No tags", 1]]);
});

test("pickDaily: same pick all day, unused first, skips archived and snoozed", () => {
	const clips = Array.from({ length: 30 }, (_, i) => clip("c" + i, "clip number " + i + " with some words", { uses: i < 15 ? [{ path: "u.md", how: "quote", since: NOW }] : [] }));
	const state: Record<string, ClipState> = { c20: { arch: 1 }, c21: { snooze: NOW + DAY } };
	const p1 = pickDaily(clips, state, 5, NOW);
	const p2 = pickDaily(clips, state, 5, NOW + 3600000);
	assert.deepEqual(p1, p2);
	assert.equal(p1.length, 5);
	assert.ok(!p1.includes("c20") && !p1.includes("c21"));
	assert.ok(p1.every((id) => Number(id.slice(1)) >= 15), "unused clips come first");
	const k = keepLater(undefined, NOW);
	assert.equal(k.step, 1);
	assert.equal(k.snooze, NOW + 7 * DAY);
	assert.equal(keepLater({ step: 9 }, NOW).snooze, NOW + 180 * DAY);
});

test("fuzzyMatch: every word must match; typos and letters in order", () => {
	assert.ok(fuzzyMatch("tmrw day", "Tomorrow was never a day"));
	assert.ok(fuzzyMatch("tomorow", "Tomorrow was never a day"));
	assert.equal(fuzzyMatch("tomorrow pasta", "Tomorrow was never a day"), null);
	const m = fuzzyMatch("never", "Tomorrow was never a day");
	assert.deepEqual(m?.ranges, [[13, 18]]);
});
