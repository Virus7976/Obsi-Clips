// "Used 3×" after each used clip, inside the clip notes themselves: in the editor and in reading view.
import { StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, MarkdownView, type MarkdownPostProcessorContext } from "obsidian";
import type ClipsPlugin from "./main";
import type { Clip } from "./model";
import { UsesModal } from "./ui";

/** Sent to every editor when use counts change, so the marks redraw. */
export const refreshBadges = StateEffect.define<null>();

class UsedWidget extends WidgetType {
	constructor(
		private plugin: ClipsPlugin,
		private clip: Clip,
	) {
		super();
	}

	eq(other: UsedWidget) {
		return other.clip.id === this.clip.id && other.clip.uses.length === this.clip.uses.length;
	}

	toDOM() {
		const b = createEl("button", { cls: "oc-badge-inline", text: `Used ${this.clip.uses.length}×`, attr: { type: "button", "aria-label": "Show where this clip is used" } });
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			new UsesModal(this.plugin, this.clip).open();
		});
		return b;
	}

	ignoreEvent() {
		return true;
	}
}

export function badgeExtension(plugin: ClipsPlugin): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(refreshBadges)))) this.decorations = this.build(u.view);
			}
			build(view: EditorView): DecorationSet {
				const out: Range<Decoration>[] = [];
				const doc = view.state.doc;
				// The clip's own block id (" ^clip-abc", added for an embed) is hidden in live preview,
				// except on the line with the cursor, so it can still be seen and edited.
				if (plugin.settings.hideIds && view.state.field(editorLivePreviewField, false)) {
					const busy = new Set(view.state.selection.ranges.flatMap((r) => [doc.lineAt(r.from).number, doc.lineAt(r.to).number]));
					for (const { from, to } of view.visibleRanges) {
						for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
							const line = doc.line(n);
							const m = / \^clip-[a-z0-9]+\s*$/.exec(line.text);
							if (m && !busy.has(n)) out.push(Decoration.replace({}).range(line.from + m.index + 1, line.to));
						}
					}
				}
				const path = view.state.field(editorInfoField, false)?.file?.path;
				const clips = path && plugin.settings.badges ? plugin.store.byPath.get(path) : undefined;
				for (const c of clips ?? []) {
					if (!c.uses.length) continue;
					const p = c.places.find((x) => x.path === path);
					if (!p || p.line + 1 > doc.lines) continue;
					// The end of the clip's first block: the last > line of a quote, else its own line.
					let end = p.line + 1;
					if (/^>/.test(doc.line(end).text)) while (end < doc.lines && /^>/.test(doc.line(end + 1).text)) end++;
					else end = Math.min(p.endLine + 1, doc.lines);
					// Before a block id, so the mark is not hidden with it.
					const last = doc.line(end);
					const id = / \^[\w-]+\s*$/.exec(last.text);
					const pos = id ? last.from + id.index + 1 : last.to;
					out.push(Decoration.widget({ widget: new UsedWidget(plugin, c), side: -1 }).range(pos));
				}
				return Decoration.set(out, true);
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

/** Tells every open editor to redraw its marks. */
export function redrawBadges(plugin: ClipsPlugin) {
	for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		cm?.dispatch({ effects: refreshBadges.of(null) });
		if (view.getMode() === "preview") view.previewMode.rerender(true);
	}
}

/** Reading view: adds the mark to the quote or callout that holds a used clip. */
export function badgePostProcessor(plugin: ClipsPlugin) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		if (!plugin.settings.badges) return;
		const clips = plugin.store.byPath.get(ctx.sourcePath);
		if (!clips?.length) return;
		const info = ctx.getSectionInfo(el);
		if (!info) return;
		const block = el.querySelector("blockquote, .callout, li, p");
		if (!block) return;
		for (const c of clips) {
			if (!c.uses.length) continue;
			const p = c.places.find((x) => x.path === ctx.sourcePath);
			if (!p || p.line < info.lineStart || p.line > info.lineEnd) continue;
			if (el.querySelector(`[data-oc-badge="${c.id}"]`)) continue;
			let target: Element = el.querySelector(".callout-content, blockquote") ?? block;
			// A list holds one clip per item: find the item by counting "- " lines before the clip.
			const items = el.querySelectorAll(":scope > ul > li, :scope > ol > li");
			if (items.length) {
				const lines = info.text.split("\n").slice(info.lineStart, p.line + 1);
				const idx = lines.filter((l) => /^[-*+] |^\d+\. /.test(l)).length - 1;
				target = items[Math.max(0, Math.min(idx, items.length - 1))];
			}
			const b = target.createEl("button", { cls: "oc-badge-inline is-reading", text: `Used ${c.uses.length}×`, attr: { type: "button", "data-oc-badge": c.id } });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				new UsesModal(plugin, c).open();
			});
		}
	};
}
