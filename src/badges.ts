// "Used 3×" after each used clip, inside the clip notes themselves: in the editor and in reading view.
import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, MarkdownView, type MarkdownPostProcessorContext } from "obsidian";
import type ObsiClips from "./main";
import type { Clip } from "./model";
import { UsesModal } from "./ui";

/** Sent to every editor when use counts change, so the marks redraw. */
export const refreshBadges = StateEffect.define<null>();

class UsedWidget extends WidgetType {
	constructor(
		private plugin: ObsiClips,
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

export function badgeExtension(plugin: ObsiClips): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshBadges)))) this.decorations = this.build(u.view);
			}
			build(view: EditorView): DecorationSet {
				const b = new RangeSetBuilder<Decoration>();
				if (!plugin.settings.badges) return b.finish();
				const path = view.state.field(editorInfoField, false)?.file?.path;
				const clips = path ? plugin.store.byPath.get(path) : undefined;
				if (!path || !clips?.length) return b.finish();
				const doc = view.state.doc;
				const marks: { pos: number; clip: Clip }[] = [];
				for (const c of clips) {
					if (!c.uses.length) continue;
					const p = c.places.find((x) => x.path === path);
					if (!p || p.line + 1 > doc.lines) continue;
					// The end of the clip's first block: the last > line of a quote, else its own line.
					let end = p.line + 1;
					if (/^>/.test(doc.line(end).text)) while (end < doc.lines && /^>/.test(doc.line(end + 1).text)) end++;
					else end = Math.min(p.endLine + 1, doc.lines);
					marks.push({ pos: doc.line(end).to, clip: c });
				}
				marks.sort((a, b) => a.pos - b.pos);
				for (const m of marks) b.add(m.pos, m.pos, Decoration.widget({ widget: new UsedWidget(plugin, m.clip), side: 1 }));
				return b.finish();
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

/** Tells every open editor to redraw its marks. */
export function redrawBadges(plugin: ObsiClips) {
	for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		cm?.dispatch({ effects: refreshBadges.of(null) });
		if (view.getMode() === "preview") view.previewMode.rerender(true);
	}
}

/** Reading view: adds the mark to the quote or callout that holds a used clip. */
export function badgePostProcessor(plugin: ObsiClips) {
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
