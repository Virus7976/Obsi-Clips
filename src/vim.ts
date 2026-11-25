// Vim keys for the side bar and the library: move, act on clips and press the buttons without the mouse.
import { Modal, Scope, type App, type ItemView } from "obsidian";
import type ClipsPlugin from "./main";
import { clipMenu, menuOpenOrJustShut } from "./ui";

/** The keys, for the help list. Arrow keys always work; the letters only with Vim keys on. */
export const VIM_KEYS: [string, string][] = [
	["j  k", "Next or last clip"],
	["gg  G", "First or last clip"],
	["Ctrl+d  Ctrl+u", "Down or up 5 clips"],
	["/", "Search"],
	["Enter", "Put the clip in your note"],
	["Shift+Enter", "Put it in as an embed"],
	["y  c", "Copy as a quote"],
	["o", "Open where it came from"],
	["s", "Star or unstar"],
	["u", "Where it is used"],
	["Space  za", "Show all of the clip"],
	["m", "The clip's menu"],
	["n", "Show more"],
	["d", "Search deeper with AI"],
	["Esc", "Back to your note"],
	["?", "This list"],
];

export interface KeyPlace {
	plugin: ClipsPlugin;
	/** Where the cards are. */
	list: HTMLElement;
	search: HTMLInputElement;
	/** Draws every card, for a list that draws a page at a time. */
	all?: () => void;
	/** Searches deeper with AI. False when it cannot now. */
	deeper?: () => boolean;
}

/** Key presses that wait for a second key: "gg" and "za". */
const PENDING_MS = 900;

/**
 * Keys on the list of cards. Arrow keys always work. Letters work when "Vim keys" is on.
 * Returns the handler, so a view can add it with registerDomEvent.
 */
export function listKeys(at: KeyPlace): (e: KeyboardEvent) => void {
	let pending = "";
	let pendingAt = 0;
	return (e: KeyboardEvent) => {
		const t = e.target as HTMLElement;
		const card = t.closest<HTMLElement>(".oc-card");
		if (!card || t !== card || e.altKey || e.isComposing) return;
		// An open menu has the keys: Esc there closes the menu, not the list.
		if (menuOpenOrJustShut()) return;
		const cards = cardsIn(at.list);
		const i = cards.indexOf(card);
		if (i < 0) return;
		const vim = at.plugin.settings.vimKeys;
		const ctrl = e.ctrlKey || e.metaKey;
		const key = e.key;
		const before = Date.now() - pendingAt < PENDING_MS ? pending : "";
		pending = "";

		const go = (n: number) => {
			e.preventDefault();
			e.stopPropagation();
			const to = cards[Math.max(0, Math.min(cards.length - 1, n))];
			to.focus();
			to.scrollIntoView({ block: "nearest" });
		};

		if (key === "ArrowDown" && !ctrl) return go(i + 1);
		if (key === "ArrowUp" && !ctrl) {
			if (i === 0) {
				e.preventDefault();
				at.search.focus();
				return;
			}
			return go(i - 1);
		}
		if (key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			at.plugin.target.backToNote();
			return;
		}
		if (!vim) return;
		// Ctrl+d and Ctrl+u are Obsidian hotkeys too, so the view's scope takes them: see viewScope.
		if (ctrl) return;
		if (key === "j") return go(i + 1);
		if (key === "k") {
			if (i === 0) {
				e.preventDefault();
				at.search.focus();
				return;
			}
			return go(i - 1);
		}
		if (key === "G") {
			at.all?.();
			const every = cardsIn(at.list);
			e.preventDefault();
			every[every.length - 1]?.focus();
			every[every.length - 1]?.scrollIntoView({ block: "nearest" });
			return;
		}
		if (key === "g") {
			e.preventDefault();
			if (before === "g") return go(0);
			pending = "g";
			pendingAt = Date.now();
			return;
		}
		if (key === "z") {
			e.preventDefault();
			pending = "z";
			pendingAt = Date.now();
			return;
		}
		const clip = at.plugin.store.byId.get(card.dataset.id ?? "");
		if ((key === "a" && before === "z") || key === " ") {
			e.preventDefault();
			card.toggleClass("is-open", !card.hasClass("is-open"));
			return;
		}
		if (key === "/") {
			e.preventDefault();
			at.search.focus();
			at.search.select();
			return;
		}
		if (key === "y" && clip) {
			e.preventDefault();
			void at.plugin.copyClip(clip, "quote");
			return;
		}
		if (key === "m" && clip) {
			e.preventDefault();
			const r = card.getBoundingClientRect();
			// When the menu closes with nothing picked, the cursor goes back to the clip.
			// Obsidian puts the cursor in the note when a menu closes, so this must undo that.
			let picked = false;
			const pick = (ev: Event) => {
				if (ev instanceof KeyboardEvent && ev.key !== "Enter" && ev.key !== " ") return;
				if ((ev.target as HTMLElement | null)?.closest?.(".menu") || (ev instanceof KeyboardEvent && activeDocument.querySelector(".menu .menu-item.selected"))) picked = true;
			};
			activeDocument.addEventListener("click", pick, true);
			activeDocument.addEventListener("keydown", pick, true);
			const id = card.dataset.id;
			clipMenu(at.plugin, clip, { x: r.left + 24, y: r.top + 24 }, () => {
				activeDocument.removeEventListener("click", pick, true);
				activeDocument.removeEventListener("keydown", pick, true);
				if (picked) return;
				window.setTimeout(() => {
					const again = card.isConnected ? card : cardsIn(at.list).find((c) => c.dataset.id === id);
					again?.focus();
				}, 0);
			});
			return;
		}
		if (key === "n") {
			const more = at.list.querySelector<HTMLButtonElement>("button.oc-more:not(.oc-deeper)");
			if (more) press(e, at.list, more, i);
			return;
		}
		if (key === "d") {
			const deeper = [...at.list.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Search deeper with AI");
			if (deeper) press(e, at.list, deeper, i);
			return;
		}
		if (key === "?") {
			e.preventDefault();
			new KeysModal(at.plugin.app).open();
		}
	};
}

/**
 * Ctrl+d and Ctrl+u move 5 clips. Obsidian has hotkeys on them, so they go in the view's own scope,
 * which Obsidian asks first while the view is active.
 */
export function viewScope(view: ItemView, at: KeyPlace) {
	const scope = new Scope(view.app.scope);
	const by = (n: number) => () => {
		const a = activeDocument.activeElement as HTMLElement | null;
		if (!at.plugin.settings.vimKeys || !a || !at.list.contains(a) || !a.classList.contains("oc-card")) return true;
		const cards = cardsIn(at.list);
		const to = cards[Math.max(0, Math.min(cards.length - 1, cards.indexOf(a) + n))];
		to?.focus();
		to?.scrollIntoView({ block: "nearest" });
		return false;
	};
	scope.register(["Ctrl"], "d", by(5));
	scope.register(["Ctrl"], "u", by(-5));
	view.scope = scope;
}

/**
 * Keys in the search box. Enter, or Esc with words in the box, moves to the first clip.
 * Esc in an empty box goes back to your note. With Vim keys off, Esc clears the box first, as before.
 */
export function searchKeys(at: KeyPlace, clear: () => void): (e: KeyboardEvent) => void {
	return (e: KeyboardEvent) => {
		if (e.isComposing) return;
		const first = () => cardsIn(at.list)[0];
		// "Enter searches deeper with AI" in Settings: Enter asks AI, and the list moves to what it finds.
		if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && at.plugin.settings.ai.enter && at.deeper?.()) {
			e.preventDefault();
			return;
		}
		if (e.key === "ArrowDown" || (e.key === "Enter" && at.plugin.settings.vimKeys)) {
			const c = first();
			if (!c) return;
			e.preventDefault();
			c.focus();
			return;
		}
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		if (at.search.value) {
			const c = at.plugin.settings.vimKeys ? first() : undefined;
			if (c) c.focus();
			else clear();
			return;
		}
		at.plugin.target.backToNote();
	};
}

/** The cards in order, skipping the ones in a folded group. */
export function cardsIn(list: HTMLElement): HTMLElement[] {
	return [...list.querySelectorAll<HTMLElement>(".oc-card")].filter((c) => c.offsetParent !== null || c === activeDocument.activeElement);
}

/** Presses a button, then puts the cursor back on the same clip once the list has drawn again. */
function press(e: KeyboardEvent, list: HTMLElement, b: HTMLButtonElement, i: number) {
	e.preventDefault();
	e.stopPropagation();
	b.click();
	for (const ms of [60, 250, 700]) {
		window.setTimeout(() => {
			if (list.contains(activeDocument.activeElement) && activeDocument.activeElement !== activeDocument.body) return;
			const cards = cardsIn(list);
			cards[Math.min(i, cards.length - 1)]?.focus();
		}, ms);
	}
}

/** Keeps the cursor on the same clip when a list draws again. Call before, then call what it returns after. */
export function holdFocus(list: HTMLElement): () => void {
	const a = activeDocument.activeElement as HTMLElement | null;
	const id = a && list.contains(a) && a.classList.contains("oc-card") ? a.dataset.id : undefined;
	const i = id ? cardsIn(list).indexOf(a as HTMLElement) : -1;
	return () => {
		if (!id) return;
		if (list.contains(activeDocument.activeElement) && activeDocument.activeElement?.classList.contains("oc-card")) return;
		const cards = cardsIn(list);
		const same = cards.find((c) => c.dataset.id === id) ?? cards[Math.min(i, cards.length - 1)];
		same?.focus({ preventScroll: true });
	};
}

export class KeysModal extends Modal {
	constructor(app: App) {
		super(app);
	}
	onOpen() {
		this.setTitle("Keys");
		this.modalEl.addClass("oc-keys-modal");
		const t = this.contentEl.createEl("table", { cls: "oc-keys" });
		for (const [k, what] of VIM_KEYS) {
			const r = t.createEl("tr");
			const kc = r.createEl("td");
			for (const part of k.split("  ")) kc.createEl("kbd", { text: part });
			r.createEl("td", { text: what });
		}
		this.contentEl.createDiv({ cls: "oc-muted", text: "These work when a clip has the cursor. Turn the letters off in Settings > Keys." });
	}
	onClose() {
		this.contentEl.empty();
	}
}
