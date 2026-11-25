import { Notice, PluginSettingTab, type App, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type ClipsPlugin from "./main";
import { FolderPicker } from "./ui";
import { PROVIDERS } from "./settings";
import { plural } from "./text";
import { GET_MB, KEEP_MB } from "./meaning";
import { KeysModal } from "./vim";

type Obj = Record<string, unknown>;

export class ClipsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ClipsPlugin,
	) {
		super(app, plugin);
	}

	// Keys like "ai.model" reach inside the settings.
	getControlValue(key: string): unknown {
		return key.split(".").reduce<unknown>((o, k) => (o as Obj | undefined)?.[k], this.plugin.settings);
	}

	async setControlValue(key: string, value: unknown) {
		const parts = key.split(".");
		let o = this.plugin.settings as unknown as Obj;
		for (const p of parts.slice(0, -1)) o = o[p] as Obj;
		o[parts[parts.length - 1]] = value;
		await this.plugin.saveNow();
		this.plugin.settingChanged(key);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const toggle = (name: string, desc: string, key: string): SettingDefinition => ({ name, desc, control: { type: "toggle", key } });
		const slider = (name: string, desc: string, key: string, min: number, max: number, step = 1): SettingDefinition => ({ name, desc, control: { type: "slider", key, min, max, step } });
		const dropdown = (name: string, desc: string, key: string, options: Record<string, string>): SettingDefinition => ({ name, desc, control: { type: "dropdown", key, options } });
		const store = this.plugin.store;
		const ai = this.plugin.ai;
		const meaning = this.plugin.meaning;

		return [
			{
				type: "group",
				items: [
					{ name: "Open the library", desc: "Every clip, with search, sort and filters.", action: () => this.plugin.openLibrary() },
					{ name: "Review clips", desc: "A few clips you have not used yet. When today's are done, a few more.", action: () => this.plugin.openReview(true) },
					{ name: "Tidy clips", desc: "Clips saved twice, near copies, clips with no tags, broken links.", action: () => this.plugin.openTidy() },
					{ name: "What's new", desc: "What changed in each version.", action: () => void this.plugin.openWhatsNew() },
				],
			},
			{
				type: "group",
				items: [
					{
						type: "page",
						name: "Where clips are",
						desc: "Your whole vault, or only some folders.",
						displayValue: () => (s.scope === "vault" ? "Whole vault" : s.folders.length ? s.folders.join(", ") : "Not set"),
						status: () => (store.needsFolders ? "warning" : null),
						items: [
							{
								type: "group",
								items: [
									{
										name: "Read clips from",
										desc: "Whole vault: every note with highlights counts. Only these folders: only notes in the folders below.",
										control: { type: "dropdown", key: "scope", options: { vault: "Whole vault", folders: "Only these folders" } },
									},
								],
							},
							{
								type: "list",
								visible: () => s.scope === "folders",
								heading: "Folders",
								emptyState: "No folders yet. Add one, or find them for you.",
								items: s.folders.map((f) => ({ name: f, desc: store.ready ? plural(store.allSources().filter((x) => x.path === f || x.path.startsWith(f + "/")).reduce((n, x) => n + x.count, 0), "clip") : "" })),
								onDelete: (i) => {
									const next = s.folders.filter((_, j) => j !== i);
									void this.plugin.setFolders(next).then(() => this.update());
								},
								addItem: {
									name: "Add folder",
									action: () =>
										new FolderPicker(this.app, (f) => {
											if (s.folders.includes(f.path)) return;
											void this.plugin.setFolders([...s.folders, f.path]).then(() => this.update());
										}).open(),
								},
							},
							{
								type: "group",
								items: [
									{ name: "Find my clip folders", desc: "Look through the vault and pick from the folders that hold clips.", action: () => this.plugin.openSetup(), visible: () => s.scope === "folders" },
									toggle("Marked text counts", "==Marked text== inside a normal paragraph counts as a clip.", "marks"),
									toggle("Plain quotes count", "A > quote with no marks counts as a clip. Off: in a saved article these are the author's quotes.", "plainQuotes"),
									slider("Shortest clip", "Clips with fewer words are left out.", "minWords", 1, 10),
								],
							},
						],
					},
					{
						type: "page",
						name: "Putting clips in",
						desc: "How a clip looks when you put it in a note.",
						displayValue: () => ({ quote: "Quote", embed: "Embed", plain: "Plain text" })[s.insertFormat],
						items: [
							{
								type: "group",
								items: [
									{
										name: "Put in as",
										desc: "Quote: a callout with a link back. Embed: shows the clip from its note and stays in step with it. Plain text: the words and a link.",
										control: { type: "dropdown", key: "insertFormat", options: { quote: "Quote", embed: "Embed", plain: "Plain text" } },
									},
									{ name: "Callout type", desc: "The callout a quote uses, like quote or cite.", control: { type: "text", key: "calloutType", placeholder: "quote" } },
									toggle("Add the time or page", "A quote links the moment in the video or the page in the book.", "insertWhere"),
									toggle("Add my note", "Your note on the clip goes under the quote.", "insertNote"),
									toggle("Hide clip ids in the editor", "An embed adds a short id like ^clip-abc to the clip's line. Hidden unless the cursor is on that line.", "hideIds"),
								],
							},
						],
					},
					{
						type: "page",
						name: "Counting uses",
						desc: "What counts as using a clip.",
						items: [
							{
								type: "group",
								items: [
									toggle("Pasted text counts", "A note that holds the clip's words counts as a use, not only embeds and links. 8 words in a row is enough for a long clip. A clip's own note never counts.", "countQuotes"),
									toggle("Show uses in clip notes", "\"Used 3×\" after each used clip in your clip notes.", "badges"),
									{ name: "Count uses again", desc: "Read every note again now.", action: () => void store.rebuild().then(() => new Notice("Uses counted")) },
								],
							},
							{
								type: "list",
								heading: "Never count notes in",
								emptyState: "Every note counts.",
								items: s.ignoreFolders.map((f) => ({ name: f })),
								onDelete: (i) => {
									s.ignoreFolders = s.ignoreFolders.filter((_, j) => j !== i);
									void this.plugin.saveNow().then(() => {
										void store.rebuild();
										this.update();
									});
								},
								addItem: {
									name: "Add folder",
									action: () =>
										new FolderPicker(this.app, (f) => {
											if (s.ignoreFolders.includes(f.path)) return;
											s.ignoreFolders.push(f.path);
											void this.plugin.saveNow().then(() => {
												void store.rebuild();
												this.update();
											});
										}).open(),
								},
							},
						],
					},
					{
						type: "page",
						name: "Review",
						desc: "A few forgotten clips each day.",
						displayValue: () => plural(s.reviewCount, "clip") + " a day",
						items: [
							{
								type: "group",
								items: [
									slider("Clips a day", "How many clips review shows each day.", "reviewCount", 1, 20),
									toggle("Remind me", "When Obsidian opens, a short note says how many clips are waiting.", "reviewNudge"),
									toggle("Show in the status bar", "\"5 to review\" at the bottom of the window. Computers only.", "statusBar"),
								],
							},
						],
					},
					{
						type: "page",
						name: "Library",
						desc: "How clips look in the library.",
						displayValue: () => ({ full: "Full", compact: "Compact", text: "Text only" })[s.libraryLook],
						items: [
							{
								type: "group",
								items: [
									dropdown("Card look", "Full: the whole clip, your note, tags and details. Compact: shorter cards. Text only: just the words.", "libraryLook", { full: "Full", compact: "Compact", text: "Text only" }),
								],
							},
						],
					},
					{
						type: "page",
						name: "Side bar",
						desc: "Clips for the note you are writing.",
						displayValue: () => ({ calm: "Calm", detailed: "Detailed", text: "Text only" })[s.panelLook],
						items: [
							{
								type: "group",
								heading: "Look",
								items: [
									dropdown("Card look", "Calm: two lines and the source. Detailed: more text, uses and why it fits. Text only: just the words.", "panelLook", { calm: "Calm", detailed: "Detailed", text: "Text only" }),
									dropdown("Clips used in this note", "The clips you already put in this note, at the top. Folded: one line you can open.", "panelUsed", { folded: "Folded", open: "Open", hidden: "Hidden" }),
								],
							},
							{
								type: "group",
								heading: "How many",
								items: [
									slider("Clips at first", "How many clips show before Show more.", "panelFirst", 3, 20, 1),
									dropdown("Show more shows", "All the rest: every clip that fits, up to the most below. A few more: the same number again.", "panelMore", { all: "All the rest", step: "A few more" }),
									slider("Most clips listed", "The most clips the side bar lists for one note.", "panelCount", 5, 60, 5),
								],
							},
							{
								type: "group",
								heading: "When",
								items: [
									dropdown("Find clips again", "When I pause: a few seconds after you stop typing. As I type: often while you write. On another note: only when you open a different note.", "panelUpdate", { pause: "When I pause", live: "As I type", switch: "On another note" }),
									toggle("Clips for drawings", "Show clips for Excalidraw drawings too.", "panelDrawings"),
									toggle("Open when Obsidian starts", "Show the side bar on start.", "panelOnStart"),
								],
							},
						],
					},
				],
			},
			{
				type: "group",
				items: [
					{
						type: "page",
						name: "Keys",
						desc: "Move and act on clips without the mouse.",
						displayValue: () => (s.vimKeys ? "Vim keys" : "Arrow keys"),
						items: [
							{
								type: "group",
								items: [
									toggle("Vim keys", "j and k move between clips. gg and G go to the first and last. y copies, m opens the menu, n shows more, d searches deeper with AI, Esc goes back to your note. Arrow keys always work.", "vimKeys"),
									{ name: "Show all keys", desc: "The list of keys. Press ? on a clip to see it too.", action: () => new KeysModal(this.app).open() },
								],
							},
						],
					},
				],
			},
			{
				type: "group",
				items: [
					{
						type: "page",
						name: "Meaning search",
						desc: "Finds clips close in meaning, on this device. No AI app, no key, no cost.",
						displayValue: () => meaningLabel(this.plugin),
						status: () => (s.index.on && meaning.state === "failed" ? "warning" : null),
						items: [
							{
								type: "group",
								items: [
									{
										name: "Get the meaning model",
										desc:
											meaning.state === "failed" && meaning.error
												? "Last problem: " + meaning.error
												: `Downloads a small model once (${GET_MB} MB) from Hugging Face and keeps ${KEEP_MB} MB in the plugin folder. Then a search for "fear" also finds a clip about courage.`,
										action: () => void this.plugin.getMeaning(),
										visible: () => !meaning.present && meaning.state !== "getting",
									},
									{
										name: "Getting the meaning model…",
										desc: `${GET_MB} MB. This takes a few seconds on a fast connection.`,
										visible: () => meaning.state === "getting",
									},
									{ ...toggle("Use meaning search", "Off: search finds the same words only. The model stays on this device.", "index.on"), visible: () => meaning.present },
								],
							},
							{
								type: "group",
								heading: "Where",
								visible: () => meaning.present && s.index.on,
								items: [
									toggle("In search", "Under the matches, clips close in meaning. In the side bar and the library.", "index.search"),
									toggle("In the side bar", "For this note also lists clips close in meaning, not only clips with the same words.", "index.sidebar"),
									dropdown("How close", "Close: fewer clips, very near in meaning. Loose: more clips, some only a bit near.", "index.near", { close: "Close", some: "Some", loose: "Loose" }),
								],
							},
							{
								type: "group",
								heading: "Other devices",
								visible: () => meaning.present || s.index.on,
								items: [
									toggle("Get it on other devices", `A phone or computer that syncs these settings gets the model by itself (${GET_MB} MB, once). Each device finds meanings for new clips by itself, in a moment.`, "index.auto"),
									{
										name: "Remove from this device",
										desc: `Turns meaning search off and deletes the model (${KEEP_MB} MB) from this device.`,
										action: () => void this.plugin.removeMeaning(),
										visible: () => meaning.present,
									},
								],
							},
						],
					},
					{
						type: "page",
						name: "AI",
						desc: "Optional. Finds clips close in meaning and suggests tags. Off by default.",
						displayValue: () => (ai.usable() ? aiLabel(this.plugin) : s.ai.on ? "Not ready" : "Off"),
						status: () => (s.ai.on && !ai.usable() ? "warning" : null),
						items: [
							{
								type: "group",
								items: [
									{
										name: s.ai.baseUrl ? "Change the AI" : "Set up AI",
										desc: ai.lastError && s.ai.on ? "Last problem: " + ai.lastError : s.ai.baseUrl ? "Now: " + aiLabel(this.plugin) + "." : "Pick a model on this device, or a service with a key.",
										action: () => this.plugin.openAiSetup(),
									},
									{
										...toggle("Use AI", "It never writes text for you. It only helps find your own clips and suggests tags.", "ai.on"),
										visible: () => !!s.ai.baseUrl,
									},
									{ ...toggle("Find by meaning", "Search and the side bar also find clips close in meaning, not only the same words.", "ai.meaning"), visible: () => s.ai.on },
									{ ...toggle("Enter searches deeper", "Enter in a search box asks AI to look deeper, and the list moves to what it finds. To use a key of your own, set one for Search deeper with AI in Hotkeys.", "ai.enter"), visible: () => s.ai.on },
									{ ...toggle("Sort the side bar", "AI puts the clips that fit your note best at the top. Once per note.", "ai.order"), visible: () => s.ai.on && s.ai.meaning },
									{
										name: "Tag ideas",
										desc: "When I tap: ideas show in Edit tags. By themselves: new clips with no tags get tags in the background.",
										control: { type: "dropdown", key: "ai.tags", options: { tap: "When I tap", auto: "By themselves" } },
										visible: () => s.ai.on,
									},
									{
										name: "Remove AI from this device",
										desc: "Turns AI off and deletes its key and phone link from Obsidian's key store.",
										action: () => this.plugin.forgetAi(),
										visible: () => s.ai.on || !!ai.savedKey(),
									},
								],
							},
						],
					},
					toggle("Show what's new after an update", "Open the list of changes once after each update.", "showWhatsNew"),
				],
			},
		];
	}
}

/** "On", "Getting…", "Off" for the Meaning search row. */
function meaningLabel(plugin: ClipsPlugin): string {
	const m = plugin.meaning;
	if (m.state === "getting") return "Getting…";
	if (m.state === "loading") return "Starting…";
	if (m.ready || m.state === "idle") return "On";
	if (plugin.settings.index.on && m.state === "failed") return "Not ready";
	if (plugin.settings.index.on && !m.present) return "Not on this device";
	return "Off";
}

/** "llama3.2:3b in Ollama", "ObsiTube on this phone", "gpt-4.1-mini on OpenAI". */
export function aiLabel(plugin: ClipsPlugin): string {
	const a = plugin.settings.ai;
	if (a.provider === "phone") return `${a.app || "Obsi app"} on this phone`;
	if (a.provider === "local") return `${a.model} in ${a.app || "a model app"}`;
	return `${a.model} on ${a.app || PROVIDERS[a.provider].name}`;
}
