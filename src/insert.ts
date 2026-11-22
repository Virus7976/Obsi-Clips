// Putting a clip into a note: the text to insert, block ids, and which note gets it.
import { MarkdownView, Notice, TFile, type App, type Editor, type WorkspaceLeaf } from "obsidian";
import type { Clip, Place } from "./model";
import type { InsertFormat, Settings } from "./settings";

/** The link to the place in the original (the video moment, the page), when there is one. */
export function originalLink(p: Place, c: Clip): string {
	if (p.link) return p.link;
	return c.url;
}

/** "Stop using tomorrow · 15:35" as Markdown, linking the clip note and the moment. */
function sourceLine(app: App, c: Clip, p: Place, fromPath: string, s: Settings): string {
	const f = app.vault.getFileByPath(p.path);
	const link = f ? app.fileManager.generateMarkdownLink(f, fromPath, undefined, c.source) : c.source;
	const bits = [link];
	if (s.insertWhere && p.where) {
		const url = originalLink(p, c);
		bits.push(url && /^[a-z][a-z0-9+.-]*:/i.test(url) ? `[${p.where}](${url.replace(/\)/g, "%29").replace(/ /g, "%20")})` : p.where);
	}
	return bits.join(" · ");
}

/** The Markdown for a clip in the chosen format. Embed needs a block id, so it is made by putIn. */
export function formatClip(app: App, c: Clip, how: Exclude<InsertFormat, "embed">, fromPath: string, s: Settings, p = c.places[0]): string {
	const text = c.text.trim();
	const note = s.insertNote ? p.note.trim() : "";
	if (how === "plain") {
		const out = `${text} (${sourceLine(app, c, p, fromPath, s)})`;
		return note ? out + "\n\n" + note : out;
	}
	const type = (s.calloutType || "quote").trim();
	const lines = [`> [!${type}] ${sourceLine(app, c, p, fromPath, s)}`, ...text.split("\n").map((l) => "> " + l)];
	if (note) lines.push(">", ...note.split("\n").map((l) => "> *" + l.trim() + "*"));
	return lines.join("\n");
}

/** A short random block id that is not already in the note. */
function newBlockId(body: string): string {
	for (;;) {
		const id = "clip-" + Math.random().toString(36).slice(2, 8);
		if (!body.includes("^" + id)) return id;
	}
}

/**
 * Makes sure the clip has a block id in its note, adding one at the end of its first block if needed.
 * Returns null when the note is written over by an app (the id would be lost on the next save).
 */
export async function ensureBlockId(app: App, p: Place): Promise<string | null> {
	if (p.blockId) return p.blockId;
	if (p.writtenOver) return null;
	const f = app.vault.getFileByPath(p.path);
	if (!f) return null;
	let id = "";
	await app.vault.process(f, (body) => {
		const lines = body.split("\n");
		let end = p.line;
		if (/^>/.test(lines[p.line] ?? "")) while (end + 1 < lines.length && /^>/.test(lines[end + 1])) end++;
		else if (p.format === "readest-old") while (end + 1 < lines.length && /^\s{2,}\S/.test(lines[end + 1]) && !/^\s*\*page /i.test(lines[end + 1])) end++;
		const line = lines[end] ?? "";
		const has = /\s\^([A-Za-z0-9-]+)\s*$/.exec(line);
		if (has) {
			id = has[1];
			return body;
		}
		id = newBlockId(body);
		const cr = line.endsWith("\r") ? "\r" : "";
		lines[end] = line.replace(/\r$/, "").replace(/\s+$/, "") + " ^" + id + cr;
		return lines.join("\n");
	});
	p.blockId = id;
	return id;
}

/** The Markdown for any format, adding a block id first for an embed. Falls back to a quote when it cannot. */
export async function textFor(app: App, c: Clip, how: InsertFormat, fromPath: string, s: Settings, p = c.places[0]): Promise<string> {
	if (how !== "embed") return formatClip(app, c, how, fromPath, s, p);
	const id = await ensureBlockId(app, p);
	const f = app.vault.getFileByPath(p.path);
	if (!id || !f) {
		new Notice("This clip's note is written over by its app, so it is put in as a quote instead.");
		return formatClip(app, c, "quote", fromPath, s, p);
	}
	return "!" + app.fileManager.generateMarkdownLink(f, fromPath, "#^" + id);
}

/** Puts text at the cursor on its own lines, with a blank line around it, and moves the cursor after it. */
export function insertAtCursor(editor: Editor, text: string): void {
	// After a selection, never over it: the selection may be what the clip was searched by.
	const cur = editor.getCursor("to");
	const line = editor.getLine(cur.line);
	const before = line.slice(0, cur.ch);
	const after = line.slice(cur.ch);
	let pre = "";
	if (before.trim()) pre = "\n\n";
	else if (cur.line > 0 && editor.getLine(cur.line - 1).trim()) pre = "\n";
	const post = after.trim() ? "\n\n" : "\n";
	const block = pre + text + post;
	editor.replaceRange(block, cur);
	const lines = block.split("\n");
	editor.setCursor({ line: cur.line + lines.length - 1, ch: 0 });
	editor.focus();
}

/** Remembers the last note you typed in, so a clip picked in the library or side bar goes there. */
export class Target {
	private leaf: WorkspaceLeaf | null = null;

	constructor(private app: App) {}

	track(leaf: WorkspaceLeaf | null) {
		if (leaf?.view instanceof MarkdownView) this.leaf = leaf;
	}

	/** The note to put clips in: the active one, else the last one used, if it is still open. */
	view(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;
		const l = this.leaf;
		if (l && l.view instanceof MarkdownView && this.app.workspace.getLeavesOfType("markdown").includes(l)) return l.view;
		return null;
	}

	file(): TFile | null {
		return this.view()?.file ?? null;
	}

	/** Puts a clip into the target note at its cursor, then shows that note. Returns false with a notice if no note. */
	async put(c: Clip, how: InsertFormat, s: Settings, p = c.places[0]): Promise<boolean> {
		const view = this.view();
		if (!view?.file) {
			new Notice("Open a note first, then put the clip in.");
			return false;
		}
		if (view.file.path === p.path) {
			new Notice("This clip is already in this note.");
			return false;
		}
		const text = await textFor(this.app, c, how, view.file.path, s, p);
		if (view.getMode() === "preview") {
			await this.app.vault.process(view.file, (body) => body.replace(/\s*$/, "") + "\n\n" + text + "\n");
		} else insertAtCursor(view.editor, text);
		await this.app.workspace.revealLeaf(view.leaf);
		return true;
	}
}
