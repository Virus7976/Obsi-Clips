// One window to set up AI. It looks for models on this device first, then offers a service with a
// key. A choice is saved only after a test call answers, so a broken setup is never kept.
import { Modal, Notice, Platform, setIcon } from "obsidian";
import type ClipsPlugin from "./main";
import type { AiTarget } from "./ai";
import { findLocalModels, findNetworkModels, findPhoneBridge, PHONE_URL, sizeLabel, type FoundModel, type PhoneBridge } from "./local";
import { ListPicker } from "./ui";
import { PHONE_SECRET, PROVIDERS, SERVICES, type AiProvider } from "./settings";

const SHOW = 6;
/** The last computer address typed, so it is there next time. Not a secret: a home address only. */
const NET_KEY = "clips-network-host";

/** The pending link to an Obsi app, so only the answer to our own request is accepted. */
const LINK_KEY = "clips-link";
const LINK_TTL = 10 * 60 * 1000;

export function startPhoneLink(plugin: ClipsPlugin) {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	const state = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	plugin.app.saveLocalStorage(LINK_KEY, { state, at: Date.now() });
	const url = `obsi-ai://link?name=${encodeURIComponent("Clips")}&state=${state}&return=${encodeURIComponent("obsidian://clips-ai")}`;
	window.open(url);
}

/**
 * The Obsi app's answer, by obsidian://clips-ai. Accepted only when it carries the state we sent
 * in the last ten minutes. The address is never taken from the answer: it is always this phone.
 */
export async function finishPhoneLink(plugin: ClipsPlugin, params: Record<string, string>) {
	const pending = plugin.app.loadLocalStorage(LINK_KEY) as { state?: string; at?: number } | null;
	plugin.app.saveLocalStorage(LINK_KEY, null);
	const token = params.token ?? "";
	if (!pending?.state || params.state !== pending.state || Date.now() - (pending.at ?? 0) > LINK_TTL) {
		new Notice("That link was not asked for here, so it was ignored.");
		return;
	}
	if (params.error) {
		new Notice(params.error === "no-model" ? "That app has no AI model yet. Get one in its Settings, AI." : "The link was not made.");
		return;
	}
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
		new Notice("The link was not made.");
		return;
	}
	const app = (params.app ?? "Obsi app").replace(/[^\w .-]/g, "").slice(0, 30) || "Obsi app";
	const target: AiTarget = { provider: "phone", app, baseUrl: PHONE_URL + "/v1", model: "phone" };
	const problem = await plugin.ai.check(target, token);
	if (problem) {
		new Notice("Linked, but the model did not answer. " + problem, 8000);
		return;
	}
	plugin.app.secretStorage.setSecret(PHONE_SECRET, token);
	plugin.useAi(target);
	new Notice(`AI now runs on this phone, in ${app}.`);
	AiSetupModal.current?.done(`It works. Clips use the model in ${app}. Nothing leaves the phone.`);
}

export class AiSetupModal extends Modal {
	static current: AiSetupModal | null = null;
	private localEl!: HTMLElement;
	private resultEl!: HTMLElement;
	private showAll = false;
	private found: FoundModel[] = [];
	private bridge: PhoneBridge | null = null;
	private busy = false;
	private netEl!: HTMLElement;

	constructor(private plugin: ClipsPlugin) {
		super(plugin.app);
	}

	onOpen() {
		AiSetupModal.current = this;
		this.modalEl.addClass("oc-modal", "oc-ai-modal");
		this.setTitle("Set up AI");
		const { contentEl } = this;
		contentEl.createEl("p", {
			cls: "oc-ai-intro",
			text: "AI finds clips close in meaning and suggests tags. It never writes for you. It sends only short pieces of text, and only when you search or tag.",
		});

		contentEl.createDiv({ cls: "oc-ai-head", text: Platform.isMobileApp ? "On this phone" : "On this computer" });
		contentEl.createDiv({ cls: "oc-ai-sub", text: "Private. Nothing leaves this device." });
		this.localEl = contentEl.createDiv({ cls: "oc-ai-list" });

		contentEl.createDiv({ cls: "oc-ai-head", text: "On your network" });
		contentEl.createDiv({ cls: "oc-ai-sub", text: "A computer in your home that runs Ollama or LM Studio. Nothing leaves your home." });
		this.drawNetwork(contentEl.createDiv({ cls: "oc-ai-service" }));

		contentEl.createDiv({ cls: "oc-ai-head", text: "A service with a key" });
		contentEl.createDiv({ cls: "oc-ai-sub", text: "OpenRouter, Anthropic, OpenAI, Gemini and more. The key stays in Obsidian's key store on this device." });
		this.drawService(contentEl.createDiv({ cls: "oc-ai-service" }));

		this.resultEl = contentEl.createDiv({ cls: "oc-ai-result" });
		void this.look();
	}

	onClose() {
		if (AiSetupModal.current === this) AiSetupModal.current = null;
		this.contentEl.empty();
	}

	private async look() {
		const el = this.localEl;
		el.empty();
		el.createDiv({ cls: "oc-ai-looking", text: "Looking for models…" });
		const [found, bridge] = await Promise.all([findLocalModels(), Platform.isAndroidApp ? findPhoneBridge() : Promise.resolve(null)]);
		this.found = found;
		this.bridge = bridge;
		this.drawLocal();
	}

	private drawLocal() {
		const el = this.localEl;
		el.empty();
		const s = this.plugin.settings.ai;

		if (Platform.isAndroidApp) {
			const b = this.bridge;
			const linked = s.on && s.provider === "phone";
			const row = this.row(
				el,
				"Model in an Obsi app",
				b ? `${b.app} · ${b.ready ? b.model || "ready" : "no model yet"}` : "ObsiTube, ObsiRead, ObsiLearn or Obsi Bible. The app asks you first.",
				linked ? "In use" : "Link",
				() => startPhoneLink(this.plugin),
			);
			if (linked) row.addClass("is-current");
		}

		const list = this.showAll ? this.found : this.found.slice(0, SHOW);
		for (const m of list) {
			const current = s.on && s.provider === "local" && s.baseUrl === m.baseUrl && s.model === m.model;
			const size = sizeLabel(m.bytes);
			const row = this.row(el, m.model, m.app + (size ? " · " + size : ""), current ? "In use" : "Use", () =>
				void this.choose({ provider: "local", app: m.app, baseUrl: m.baseUrl, model: m.model }, ""),
			);
			if (current) row.addClass("is-current");
		}
		if (!this.showAll && this.found.length > SHOW) {
			const more = el.createEl("button", { cls: "oc-link-btn", text: `Show all ${this.found.length} models`, attr: { type: "button" } });
			more.addEventListener("click", () => {
				this.showAll = true;
				this.drawLocal();
			});
		}
		if (!this.found.length && !Platform.isAndroidApp) {
			el.createDiv({
				cls: "oc-ai-empty",
				text: Platform.isMobileApp
					? "No model app found on this device."
					: "No model app found. Ollama and LM Studio are free: install one, get a small model, then look again.",
			});
		}
		const again = el.createEl("button", { cls: "oc-link-btn", attr: { type: "button" } });
		setIcon(again.createSpan(), "refresh-cw");
		again.createSpan({ text: "Look again" });
		again.addEventListener("click", () => void this.look());
	}

	private row(parent: HTMLElement, title: string, desc: string, button: string, onClick: () => void): HTMLElement {
		const row = parent.createDiv({ cls: "oc-ai-row" });
		const text = row.createDiv({ cls: "oc-ai-row-text" });
		text.createDiv({ cls: "oc-ai-row-title", text: title });
		text.createDiv({ cls: "oc-ai-row-desc", text: desc });
		const b = row.createEl("button", { text: button, attr: { type: "button" } });
		if (button === "In use") b.disabled = true;
		else b.addEventListener("click", onClick);
		return row;
	}

	private drawNetwork(el: HTMLElement) {
		const s = this.plugin.settings.ai;
		const f = el.createEl("label", { cls: "oc-ai-field" });
		f.createSpan({ cls: "oc-ai-label", text: "Computer" });
		const host = f.createEl("input", { type: "text", attr: { placeholder: "192.168.1.20", inputmode: "url", spellcheck: "false", autocomplete: "off" } });
		host.value = s.provider === "network" ? new URL(s.baseUrl).hostname : ((this.app.loadLocalStorage(NET_KEY) as string | null) ?? "");
		const look = f.createEl("button", { text: "Look", attr: { type: "button" } });
		this.netEl = el.createDiv({ cls: "oc-ai-list" });
		const go = async () => {
			const list = this.netEl;
			list.empty();
			list.createDiv({ cls: "oc-ai-looking", text: "Looking for models…" });
			const found = await findNetworkModels(host.value);
			list.empty();
			if (found === null) {
				list.createDiv({ cls: "oc-ai-empty", text: "Type the address of a computer in your home, like 192.168.1.20." });
				return;
			}
			this.app.saveLocalStorage(NET_KEY, host.value.trim());
			if (!found.length) {
				list.createDiv({
					cls: "oc-ai-empty",
					text: "No models found there. In Ollama, turn on Expose Ollama to the network. In LM Studio, turn on Serve on Local Network.",
				});
				return;
			}
			for (const m of found.slice(0, 12)) {
				const current = s.on && s.provider === "network" && s.baseUrl === m.baseUrl && s.model === m.model;
				const size = sizeLabel(m.bytes);
				const row = this.row(list, m.model, m.app + (size ? " · " + size : ""), current ? "In use" : "Use", () =>
					void this.choose({ provider: "network", app: m.app, baseUrl: m.baseUrl, model: m.model }, ""),
				);
				if (current) row.addClass("is-current");
			}
		};
		look.addEventListener("click", () => void go());
		host.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void go();
		});
	}

	private drawService(el: HTMLElement) {
		const s = this.plugin.settings.ai;
		let provider: AiProvider = SERVICES.includes(s.provider) ? s.provider : "openrouter";

		const field = (label: string) => {
			const f = el.createEl("label", { cls: "oc-ai-field" });
			f.createSpan({ cls: "oc-ai-label", text: label });
			return f;
		};
		const pick = field("Service").createEl("select", { cls: "dropdown" });
		for (const p of SERVICES) pick.createEl("option", { value: p, text: PROVIDERS[p].name });
		pick.value = provider;

		const urlField = field("Address");
		const url = urlField.createEl("input", { type: "text", attr: { placeholder: "https://…/v1", inputmode: "url", spellcheck: "false", autocomplete: "off" } });
		const key = field("Key").createEl("input", { type: "password", attr: { autocomplete: "off", spellcheck: "false" } });
		const modelField = field("Model");
		const model = modelField.createEl("input", { type: "text", attr: { spellcheck: "false", autocomplete: "off" } });
		const choose = modelField.createEl("button", { text: "Pick", attr: { type: "button", "aria-label": "Pick from this service's models" } });
		const getKey = el.createEl("a", { cls: "oc-ai-keylink", text: "Get a key" });
		const hasKey = !!this.plugin.ai.savedKey();
		const keyNow = () => key.value.trim() || (provider === s.provider && hasKey ? this.plugin.ai.savedKey() : "");

		const fill = () => {
			const p = PROVIDERS[provider];
			const same = provider === s.provider;
			url.value = same && s.baseUrl ? s.baseUrl : p.url;
			model.value = same && s.model ? s.model : p.model;
			model.placeholder = p.model || "model name";
			urlField.toggleClass("is-hidden", provider !== "custom");
			getKey.toggleClass("is-hidden", !p.keyPage);
			if (p.keyPage) getKey.href = p.keyPage;
			key.value = "";
			key.placeholder = same && hasKey ? "Saved. Type to replace it." : "Paste your key";
		};
		fill();
		choose.addEventListener("click", () => {
			const k = keyNow();
			if (!k) return this.fail("Paste the key first.");
			const t: AiTarget = { provider, app: PROVIDERS[provider].name, baseUrl: url.value.trim().replace(/\/+$/, ""), model: "" };
			choose.disabled = true;
			void this.plugin.ai.listModels(t, k).then((list) => {
				choose.disabled = false;
				if (!list) return this.fail(this.plugin.ai.lastError || "Could not get the models.");
				if (!list.length) return this.fail("This service lists no models. Type the model name.");
				new ListPicker(this.app, list.map((m) => ({ label: m.id, hint: m.hint, value: m.id })), (id) => (model.value = id), "Small and fast models come first").open();
			});
		});
		pick.addEventListener("change", () => {
			provider = pick.value as AiProvider;
			fill();
		});

		const use = el.createEl("button", { cls: "mod-cta", text: "Use this service", attr: { type: "button" } });
		use.addEventListener("click", () => {
			const k = keyNow();
			if (!k) return this.fail("Paste the key first.");
			const hint = PROVIDERS[provider].keyHint;
			if (hint && key.value.trim() && !hint.test(k)) return this.fail(`That does not look like a key from ${PROVIDERS[provider].name}. Check the service.`);
			if (!model.value.trim()) return this.fail("Type a model name.");
			void this.choose({ provider, app: PROVIDERS[provider].name, baseUrl: url.value.trim().replace(/\/+$/, ""), model: model.value.trim() }, k);
		});
	}

	/** Tests a choice, and saves it only when it answers. */
	private async choose(t: AiTarget, key: string) {
		if (this.busy) return;
		this.busy = true;
		this.resultEl.empty();
		this.resultEl.removeClass("is-bad", "is-good");
		this.resultEl.setText(`Checking ${t.model}…`);
		const problem = await this.plugin.ai.check(t, key);
		this.busy = false;
		if (problem) return this.fail(problem);
		if (PROVIDERS[t.provider].key) this.plugin.app.secretStorage.setSecret(this.plugin.settings.ai.keyName, key);
		this.plugin.useAi(t);
		this.done(t.provider === "local" || t.provider === "network" ? `It works. Clips use ${t.model} in ${t.app}. Nothing leaves ${t.provider === "local" ? "this device" : "your home"}.` : `It works. Clips use ${t.model} on ${t.app}.`);
		this.drawLocal();
	}

	private fail(text: string) {
		this.resultEl.empty();
		this.resultEl.removeClass("is-good");
		this.resultEl.addClass("is-bad");
		this.resultEl.setText(text);
	}

	done(text: string) {
		const el = this.resultEl;
		el.empty();
		el.removeClass("is-bad");
		el.addClass("is-good");
		el.createSpan({ text });
		const b = el.createEl("button", { cls: "mod-cta", text: "Done", attr: { type: "button" } });
		b.addEventListener("click", () => this.close());
	}
}
