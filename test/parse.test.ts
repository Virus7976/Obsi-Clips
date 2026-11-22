import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClips, isWrittenOver } from "../src/parse";

test("ObsiTube clip: text, colour, time, link, note and tags", () => {
	const body = [
		"---",
		'url: "https://www.youtube.com/watch?v=abc"',
		"---",
		"",
		"> ==🟡You realize that tomorrow was never a day.==",
		"> [15:35](https://www.youtube.com/watch?v=abc&t=935s)",
		"",
		"This hit hard. Tomorrow is a feeling.",
		"Second line of my note. #time #procrastination",
		"",
		"> ==🔴Today is the only day that exists for anyone.==",
		"> [16:02](https://www.youtube.com/watch?v=abc&t=962s)",
	].join("\n");
	const c = parseClips(body);
	assert.equal(c.length, 2);
	assert.equal(c[0].text, "You realize that tomorrow was never a day.");
	assert.equal(c[0].color, "yellow");
	assert.equal(c[0].where, "15:35");
	assert.equal(c[0].link, "https://www.youtube.com/watch?v=abc&t=935s");
	assert.equal(c[0].note, "This hit hard. Tomorrow is a feeling.\nSecond line of my note.");
	assert.deepEqual(c[0].tags, ["time", "procrastination"]);
	assert.equal(c[0].format, "obsi");
	assert.equal(c[0].line, 4);
	assert.equal(c[0].endLine, 8);
	assert.equal(c[1].color, "red");
	assert.equal(c[1].note, "");
});

test("ObsiRead clip with the arrow link and inline tags", () => {
	const body = "> ==🟢Small habits add up to big results over years.== [↗](https://x.com/a#:~:text=Small%20habits) #habits";
	const [c] = parseClips(body);
	assert.equal(c.text, "Small habits add up to big results over years.");
	assert.equal(c.link, "https://x.com/a#:~:text=Small%20habits");
	assert.equal(c.color, "green");
	assert.deepEqual(c.tags, ["habits"]);
	assert.equal(c.format, "obsiread");
});

test("Obsi Bible clip takes its verse and colour from the heading, and the note after", () => {
	const body = [
		"# Mark highlights",
		"",
		"_Made by Obsi Bible. Changes made here are written over; edit in the app._",
		"",
		"## Mark 4",
		"",
		"### Mark 4:11-12 · ESV · Green",
		"> And he said to them, “To you has been given the secret of the kingdom of God.”",
		"> [Open in Obsi Bible](obsibible://ref/MRK.4.11-12)",
		"",
		"This is exactly the problem you have when you explain something.",
		"",
		"### Mark 4:24 · ESV · Green",
		"> And he said to them, “Pay attention to what you hear.”",
		"> [Open in Obsi Bible](obsibible://ref/MRK.4.24)",
		"",
		"Munger said the same. #Charlie #Morgan",
	].join("\n");
	const c = parseClips(body);
	assert.equal(c.length, 2);
	assert.equal(c[0].where, "Mark 4:11-12");
	assert.equal(c[0].color, "green");
	assert.equal(c[0].link, "obsibible://ref/MRK.4.11-12");
	assert.equal(c[0].note, "This is exactly the problem you have when you explain something.");
	assert.equal(c[0].format, "bible");
	assert.equal(c[1].note, "Munger said the same.");
	assert.deepEqual(c[1].tags, ["Charlie", "Morgan"]);
	assert.ok(isWrittenOver(body));
});

test("Readest callouts with a following note callout and a nested note", () => {
	const body = [
		"> [!readest-highlight|yellow] [Page 6](readest://book/1#cfi)",
		"> What bloody man is that? He can report the newest state.",
		"",
		"> [!readest-note]",
		"> He is talking about the soldier.",
		"",
		"> [!quote|blue] Page 9",
		"> Fair is foul, and foul is fair: hover through the fog.",
		"> > [!note]",
		"> > The witches speak in riddles.",
	].join("\n");
	const c = parseClips(body);
	assert.equal(c.length, 2);
	assert.equal(c[0].where, "Page 6");
	assert.equal(c[0].link, "readest://book/1#cfi");
	assert.equal(c[0].note, "He is talking about the soldier.");
	assert.equal(c[0].endLine, 4);
	assert.equal(c[1].color, "blue");
	assert.equal(c[1].where, "Page 9");
	assert.equal(c[1].text, "Fair is foul, and foul is fair: hover through the fog.");
	assert.equal(c[1].note, "The witches speak in riddles.");
});

test("Older Readest list under a Highlights heading", () => {
	const body = [
		"## Highlights",
		"",
		"- What bloody man is that? He can report,",
		"  As seemeth by his plight, of the revolt",
		"  *page 6*",
		"  **Note:** He is talking about the guy",
		"  who showed up bloody",
		"",
		"- Short one here.",
		"  *page 7*",
	].join("\n");
	const c = parseClips(body);
	assert.equal(c.length, 2);
	assert.equal(c[0].text, "What bloody man is that? He can report, As seemeth by his plight, of the revolt");
	assert.equal(c[0].where, "Page 6");
	assert.equal(c[0].note, "He is talking about the guy\nwho showed up bloody");
	assert.equal(c[0].format, "readest-old");
});

test("Marks inside paragraphs, other callouts skipped, code skipped, short ones dropped", () => {
	const body = [
		"Some text with ==a marked piece of text here== and ==two words== too.",
		"",
		"> [!tip]",
		"> Not a clip at all, just a tip.",
		"",
		"```",
		"==inside code is not a clip==",
		"```",
		"> A plain quote that someone wrote down. ^abc123",
	].join("\n");
	const c = parseClips(body);
	assert.deepEqual(
		c.map((x) => x.text),
		["a marked piece of text here", "A plain quote that someone wrote down."],
	);
	assert.equal(c[1].blockId, "abc123");
	assert.equal(parseClips(body, { marks: false }).length, 1);
});

test("A block id on its own line after the quote is kept", () => {
	const body = "> ==🟡Discipline is choosing what you want most over what you want now.==\n> [1:00](https://y.com?t=60)\n^disc-1\n";
	const [c] = parseClips(body);
	assert.equal(c.blockId, "disc-1");
	assert.equal(c.endLine, 2);
});

test("A note-only entry (no highlighted words) is not a clip, and the next quote is not its note", () => {
	const body = "- [2:00](https://y.com?t=120) just a thought\n\n> ==🟡The real clip text is here and long.==\n> [3:00](https://y.com?t=180)";
	const c = parseClips(body);
	assert.equal(c.length, 1);
	assert.equal(c[0].where, "3:00");
});

test("Tags after the time link are kept; marked quotes with no time are clips; article quotes are not", () => {
	const body = [
		"> ==🟡In the mind of the observer, strength and the capacity to fight are nearly the same thing.==",
		"> [1:43](https://www.youtube.com/watch?v=t&t=103s) #gym #strong",
		"",
		"> ==🟡In 2009 they published a study on strength and anger in men.==",
		"",
		"> In the early days of the cosmic cycle mankind lived on an immaterial plane.",
	].join("\n");
	const c = parseClips(body);
	assert.equal(c.length, 2);
	assert.deepEqual(c[0].tags, ["gym", "strong"]);
	assert.equal(c[0].where, "1:43");
	assert.equal(c[1].text, "In 2009 they published a study on strength and anger in men.");
	assert.equal(parseClips(body, { plainQuotes: true }).length, 3);
});

test("A block id on the time line keeps the clip the same and is found", () => {
	const plain = "> ==🟡You realize that tomorrow was never a day.==\n> [15:35](https://y.com?t=935)";
	const withId = "> ==🟡You realize that tomorrow was never a day.==\n> [15:35](https://y.com?t=935) ^clip-ab12cd";
	const [a] = parseClips(plain);
	const [b] = parseClips(withId);
	assert.equal(b.text, a.text);
	assert.equal(b.where, "15:35");
	assert.equal(b.blockId, "clip-ab12cd");
});
