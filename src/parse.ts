// Reads the clips (highlights) out of one note. No Obsidian parts, so it can be tested on its own.
//
// Formats it knows:
// - ObsiTube / ObsiLearn:  > ==🟡text==  then  > [15:35](link)   then an optional note paragraph and #tags
// - ObsiRead:              > ==🟡text== [↗](link)                 then an optional note paragraph and #tags
// - Obsi Bible:            ### Mark 4:3 · BSB · Yellow  > text  > [Open in Obsi Bible](obsibible://…)  then a note
// - Readest:               > [!readest-highlight|yellow] [Page 3](link)  with > [!readest-note] after, or a nested > > [!note]
// - Readest (older):       - text   *page 15*   **Note:** …        under a Highlights heading
// - Any note:              > [!quote] callouts, and ==marked text== inside a paragraph

export type ClipFormat = "obsi" | "obsiread" | "bible" | "readest" | "readest-old" | "quote" | "mark";

export interface ParsedClip {
	text: string;
	color: string;
	where: string;
	link: string;
	note: string;
	tags: string[];
	/** First and last line of the clip in the note, counted from 0. */
	line: number;
	endLine: number;
	/** The block id already on the clip (the part after ^), or "". */
	blockId: string;
	format: ClipFormat;
}

export interface ParseOptions {
	/** Keep ==marked text== found inside normal paragraphs. */
	marks?: boolean;
	/** Fewer words than this is not a clip. */
	minWords?: number;
	/** Keep plain > quotes with no marks. Off by default: in a saved article they are the author's quotes. */
	plainQuotes?: boolean;
}

const COLORS: Record<string, string> = {
	"🟡": "yellow",
	"🔴": "red",
	"🟢": "green",
	"🔵": "blue",
	"🟣": "purple",
	"🟠": "orange",
	"🟤": "brown",
	"⚫": "black",
	"⚪": "white",
};
const COLOR_NAMES = new Set(["yellow", "red", "green", "blue", "purple", "orange", "pink", "brown", "gray", "grey", "violet"]);
const EMOJI_RE = /(🟡|🔴|🟢|🔵|🟣|🟠|🟤|⚫|⚪|⭐)️?/u;
const TIME_LINE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\(([^)\s]+)\)((?:\s+#[\p{L}\p{N}_/-]+)*)\s*$/u;
const BIBLE_LINE = /^\[Open in Obsi Bible\]\(([^)\s]+)\)((?:\s+#[\p{L}\p{N}_/-]+)*)\s*$/iu;
const ARROW_LINK = /\s*\[↗\]\(([^)\s]+)\)/;
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const TRAILING_TAGS = /((?:\s+#[\p{L}\p{N}_/-]+)+)\s*$/u;

function cleanText(s: string): string {
	return s
		.replace(/==/g, "")
		.replace(/\[↗\]\([^)]*\)/g, "")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
		.replace(/\\([*_[\]])/g, "$1")
		.replace(new RegExp(EMOJI_RE.source, "gu"), "")
		.replace(/\s+/g, " ")
		.replace(/^[.,;:\s]+/, "")
		.trim();
}

function colorOf(s: string): string {
	const m = EMOJI_RE.exec(s);
	return m ? (COLORS[m[1]] ?? "") : "";
}

/** Splits trailing #tags off a line. */
function takeTags(s: string): { rest: string; tags: string[] } {
	const m = TRAILING_TAGS.exec(s);
	if (!m) return { rest: s, tags: [] };
	const tags = m[1]
		.trim()
		.split(/\s+/)
		.map((t) => t.slice(1))
		.filter((t) => !/^\d+$/.test(t));
	return { rest: s.slice(0, m.index), tags };
}

function takeBlockId(s: string): { rest: string; id: string } {
	const m = BLOCK_ID.exec(s);
	return m ? { rest: s.slice(0, m.index), id: m[1] } : { rest: s, id: "" };
}

export function parseClips(body: string, opts: ParseOptions = {}): ParsedClip[] {
	const minWords = opts.minWords ?? 3;
	const marks = opts.marks ?? true;
	const plainQuotes = opts.plainQuotes ?? false;
	const lines = body.split(/\r?\n/);
	const out: ParsedClip[] = [];
	let i = 0;
	if (lines[0]?.trim() === "---") {
		i = 1;
		while (i < lines.length && lines[i].trim() !== "---") i++;
		i++;
	}

	const push = (c: ParsedClip): boolean => {
		c.text = cleanText(c.text);
		c.note = c.note.replace(/\s+\n/g, "\n").trim();
		const looksLikeTable = /^\|/.test(c.text) || (c.text.match(/ \| /g) ?? []).length > 1;
		if (c.text.split(/\s+/).filter(Boolean).length < minWords || looksLikeTable) return false;
		out.push(c);
		return true;
	};

	let inHighlights = false;
	let bible: { where: string; color: string } | null = null;
	let inFence = false;

	while (i < lines.length) {
		const line = lines[i];

		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			i++;
			continue;
		}
		if (inFence) {
			i++;
			continue;
		}

		const head = /^(#{1,6})\s+(.*)$/.exec(line);
		if (head) {
			inHighlights = /highlight/i.test(head[2]);
			// Obsi Bible: "### Mark 4:3 · BSB · Yellow"
			const parts = head[2].split(" · ");
			bible = parts.length >= 2 && /\d+:\d+/.test(parts[0]) ? { where: parts[0].trim(), color: COLOR_NAMES.has(parts[parts.length - 1].trim().toLowerCase()) ? parts[parts.length - 1].trim().toLowerCase() : "" } : null;
			i++;
			continue;
		}

		if (/^>/.test(line)) {
			const start = i;
			const block: string[] = [];
			while (i < lines.length && /^>/.test(lines[i])) {
				block.push(lines[i].replace(/^>\s?/, ""));
				i++;
			}
			let end = i - 1;
			const firstIdx = block.findIndex((l) => l.trim() !== "");
			const first = firstIdx >= 0 ? block[firstIdx].trim() : "";

			// A Readest note belongs to the highlight just before it.
			if (/^\[!readest-note\]/i.test(first)) {
				const last = out[out.length - 1];
				const note = block.slice(firstIdx + 1).join("\n").trim();
				if (last && note) {
					last.note = (last.note ? last.note + "\n" : "") + note;
					last.endLine = end;
				}
				continue;
			}

			const callout = /^\[!([\w-]+)(?:\|([\w-]+))?\][+-]?\s*(.*)$/.exec(first);
			let format: ClipFormat = "quote";
			let where = "";
			let link = "";
			let color = "";
			let textLines = block;
			if (callout) {
				const type = callout[1].toLowerCase();
				if (type !== "readest-highlight" && type !== "quote") continue; // some other callout, not a clip
				format = type === "quote" ? "quote" : "readest";
				color = (callout[2] ?? "").toLowerCase();
				const wl = /^\[([^\]]+)\]\(([^)]+)\)/.exec(callout[3]);
				if (wl) {
					where = wl[1];
					link = wl[2];
				} else if (callout[3]) where = cleanText(callout[3]);
				textLines = block.slice(firstIdx + 1);
			}

			const kept: string[] = [];
			const lineTags: string[] = [];
			const noteLines: string[] = [];
			let inNote = false;
			let blockId = "";
			for (const raw of textLines) {
				if (/^>?\s?\[!(?:note|readest-note)\]/i.test(raw)) {
					inNote = true;
					continue;
				}
				if (inNote) {
					noteLines.push(raw.replace(/^>\s?/, ""));
					continue;
				}
				// A block id can sit at the end of any line of the quote, often the time line.
				const own = takeBlockId(raw);
				if (own.id) blockId = own.id;
				const l = own.rest.trim();
				const ts = TIME_LINE.exec(l);
				if (ts) {
					where = ts[1];
					link = ts[2];
					format = "obsi";
					if (ts[3]) lineTags.push(...takeTags(ts[3]).tags);
					continue;
				}
				const bl = BIBLE_LINE.exec(l);
				if (bl) {
					link = bl[1];
					format = "bible";
					if (bl[2]) lineTags.push(...takeTags(bl[2]).tags);
					continue;
				}
				kept.push(own.rest);
			}
			let text = kept.join("\n");
			// A plain quote with no marks, no colour and no link back is the author's quote, not a highlight.
			if (format === "quote" && !callout && !plainQuotes && !/==|🟡|🔴|🟢|🔵|🟣|🟠/u.test(text) && !ARROW_LINK.test(text) && !blockId) continue;
			const arrow = ARROW_LINK.exec(text);
			if (arrow) {
				link = arrow[1];
				format = "obsiread";
				text = text.replace(ARROW_LINK, "");
			}
			if (!color) color = colorOf(text);
			if (bible && format === "bible") {
				where = bible.where;
				color = color || bible.color;
			}
			const tb = takeBlockId(text);
			text = tb.rest;
			blockId = tb.id || blockId;
			const tt = takeTags(text);
			text = tt.rest;
			const tags = [...lineTags, ...tt.tags];

			// Obsi apps write the person's note as the paragraph(s) after the quote, then the tags.
			let note = noteLines.join("\n");
			if (format === "obsi" || format === "obsiread" || format === "bible") {
				let j = i;
				while (j < lines.length && lines[j].trim() === "") j++;
				const para: string[] = [];
				let k = j;
				if (j > i && j - i <= 2) {
					while (k < lines.length) {
						const l = lines[k];
						if (/^(>|#{1,6}\s|- \[\d|---\s*$|\s*```)/.test(l)) break;
						if (l.trim() === "") {
							// A blank line ends the note unless more note text follows before the next clip.
							let n = k;
							while (n < lines.length && lines[n].trim() === "") n++;
							if (n >= lines.length || /^(>|#{1,6}\s|- \[\d)/.test(lines[n])) break;
						}
						para.push(l);
						k++;
					}
				}
				if (para.length) {
					let joined = para.join("\n").trim();
					const nb = takeBlockId(joined);
					joined = nb.rest;
					blockId = blockId || nb.id;
					const nt = takeTags(joined);
					note = (note ? note + "\n" : "") + nt.rest.trim();
					tags.push(...nt.tags);
					end = k - 1;
					while (end > start && lines[end].trim() === "") end--;
					i = k;
				}
			}
			if (!blockId && i < lines.length) {
				const own = /^\^([A-Za-z0-9-]+)\s*$/.exec(lines[i]);
				if (own) {
					blockId = own[1];
					end = i;
					i++;
				}
			}
			push({ text, color, where, link, note, tags: [...new Set(tags)], line: start, endLine: end, blockId, format });
			continue;
		}

		// Older Readest export: "- quote" then "  *page 15*" then "  **Note:** …"
		if (inHighlights && /^- /.test(line) && !/^- \[\d{1,2}:\d{2}/.test(line)) {
			const start = i;
			const textLines = [line.slice(2)];
			let where = "";
			let note = "";
			let inNote = false;
			i++;
			while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
				const l = lines[i].trim();
				const pg = /^\*page (\S+)\*$/i.exec(l);
				const nt = /^\*\*Note:\*\*\s*(.*)$/.exec(l);
				if (pg) where = "Page " + pg[1];
				else if (nt) {
					note = nt[1];
					inNote = true;
				} else if (inNote) note += "\n" + l;
				else textLines.push(l);
				i++;
			}
			const tb = takeBlockId(textLines.join("\n"));
			push({ text: tb.rest, color: "", where, link: "", note, tags: [], line: start, endLine: i - 1, blockId: tb.id, format: "readest-old" });
			continue;
		}

		if (marks) {
			const found = line.match(/==[^=\n]+==/g);
			if (found) {
				const tb = takeBlockId(line);
				for (const m of found) push({ text: m, color: colorOf(m), where: "", link: "", note: "", tags: [], line: i, endLine: i, blockId: tb.id, format: "mark" });
			}
		}
		i++;
	}
	return out;
}

/** True when an app writes this note over, so a block id added by hand would be lost. */
export function isWrittenOver(body: string): boolean {
	return /changes made here are written over/i.test(body.slice(0, 1500));
}
