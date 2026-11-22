import { EMPTY_QUERY, type ClipState, type Query } from "./model";

export type InsertFormat = "quote" | "embed" | "plain";
export type PanelLook = "calm" | "detailed" | "text";
/** Where AI runs: a service with a key, a model app on this device, or the model in an Obsi app on this phone. */
export type AiProvider =
	| "openrouter" | "anthropic" | "openai" | "gemini" | "groq" | "mistral" | "deepseek" | "xai" | "custom"
	| "local" | "network" | "phone";

export interface AiSettings {
	on: boolean;
	provider: AiProvider;
	/** The app that runs a local model, like "Ollama" or "ObsiTube", for Settings to show. */
	app: string;
	baseUrl: string;
	model: string;
	/** The name of the key in Obsidian's key store. The key itself is never in data.json. */
	keyName: string;
	/** Search and "For this note" also find clips close in meaning. */
	meaning: boolean;
	/** Tag ideas: only when you ask, or for new untagged clips by themselves. */
	tags: "tap" | "auto";
}

export interface Settings {
	/** Where clips are: anywhere in the vault, or only in some folders. */
	scope: "vault" | "folders";
	/** Folders that hold clips, when scope is "folders". */
	folders: string[];
	/** ==marked text== inside normal paragraphs counts as a clip. */
	marks: boolean;
	/** Plain > quotes with no marks count as clips. */
	plainQuotes: boolean;
	minWords: number;

	insertFormat: InsertFormat;
	calloutType: string;
	insertNote: boolean;
	insertWhere: boolean;

	/** Pasted clip text counts as a use, not only embeds and links. */
	countQuotes: boolean;
	/** Notes in these folders never count as uses (templates, archives). */
	ignoreFolders: string[];
	/** "Used 3×" after each clip in your clip notes. */
	badges: boolean;

	reviewCount: number;
	reviewNudge: boolean;
	statusBar: boolean;

	panelCount: number;
	/** How many clips the side bar shows at first, and adds with Show more. */
	panelFirst: number;
	/** The side bar's look: calm two-line clips, detailed cards, or the words alone. */
	panelLook: PanelLook;
	/** Open "For this note" in the side bar when Obsidian starts. */
	panelOnStart: boolean;

	query: Query;
	showWhatsNew: boolean;
	ai: AiSettings;
}

export const DEFAULT_SETTINGS: Settings = {
	scope: "vault",
	folders: [],
	marks: true,
	plainQuotes: false,
	minWords: 3,
	insertFormat: "quote",
	calloutType: "quote",
	insertNote: false,
	insertWhere: true,
	countQuotes: true,
	ignoreFolders: [],
	badges: true,
	reviewCount: 5,
	reviewNudge: true,
	statusBar: true,
	panelCount: 25,
	panelFirst: 5,
	panelLook: "calm",
	panelOnStart: false,
	query: EMPTY_QUERY,
	showWhatsNew: true,
	ai: {
		on: false,
		provider: "openrouter",
		app: "",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "google/gemini-2.5-flash-lite",
		keyName: "clips-ai",
		meaning: true,
		tags: "tap",
	},
};

export interface Provider {
	name: string;
	url: string;
	/** A small, fast model that is enough for these short jobs. */
	model: string;
	key: boolean;
	/** Where to get a key. */
	keyPage?: string;
	/** How the key looks, to catch a key pasted into the wrong service. */
	keyHint?: RegExp;
	/** "anthropic" uses Anthropic's own way to ask. All others use the OpenAI way. */
	style?: "anthropic";
}

export const PROVIDERS: Record<AiProvider, Provider> = {
	openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash-lite", key: true, keyPage: "https://openrouter.ai/keys", keyHint: /^sk-or-/ },
	anthropic: { name: "Anthropic", url: "https://api.anthropic.com/v1", model: "claude-haiku-5-5", key: true, keyPage: "https://console.anthropic.com/settings/keys", keyHint: /^sk-ant-/, style: "anthropic" },
	openai: { name: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4.1-mini", key: true, keyPage: "https://platform.openai.com/api-keys", keyHint: /^sk-(?!or-|ant-)/ },
	gemini: { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash-lite", key: true, keyPage: "https://aistudio.google.com/apikey", keyHint: /^AIza/ },
	groq: { name: "Groq", url: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant", key: true, keyPage: "https://console.groq.com/keys", keyHint: /^gsk_/ },
	mistral: { name: "Mistral", url: "https://api.mistral.ai/v1", model: "mistral-small-latest", key: true, keyPage: "https://console.mistral.ai/api-keys" },
	deepseek: { name: "DeepSeek", url: "https://api.deepseek.com/v1", model: "deepseek-chat", key: true, keyPage: "https://platform.deepseek.com/api_keys", keyHint: /^sk-/ },
	xai: { name: "xAI", url: "https://api.x.ai/v1", model: "grok-3-mini", key: true, keyPage: "https://console.x.ai", keyHint: /^xai-/ },
	custom: { name: "Other service", url: "", model: "", key: true },
	local: { name: "On this device", url: "", model: "", key: false },
	network: { name: "On your network", url: "", model: "", key: false },
	phone: { name: "Obsi app on this phone", url: "", model: "phone", key: false },
};

/** The services with a key, for the setup list. */
export const SERVICES: AiProvider[] = ["openrouter", "anthropic", "openai", "gemini", "groq", "mistral", "deepseek", "xai", "custom"];

/** Where the link token for an Obsi app on the phone is kept in Obsidian's key store. */
export const PHONE_SECRET = "clips-phone";

export interface PluginData {
	settings: Settings;
	clips: Record<string, ClipState>;
	daily: { day: string; ids: string[]; done: string[] };
	seenVersion: string;
	welcomed: boolean;
	/** Kept AI results, so nothing is asked twice. */
	memo: { words: Record<string, string[]>; picks: Record<string, string[]>; tags: Record<string, string[]>; tagged: string[] };
}

export const EMPTY_DATA: PluginData = {
	settings: DEFAULT_SETTINGS,
	clips: {},
	daily: { day: "", ids: [], done: [] },
	seenVersion: "",
	welcomed: false,
	memo: { words: {}, picks: {}, tags: {}, tagged: [] },
};

/** Fills in anything missing from saved data, so an older data.json still loads. */
export function mergeData(raw: unknown): PluginData {
	const d = (raw && typeof raw === "object" ? raw : {}) as Partial<PluginData>;
	const s = (d.settings ?? {}) as Partial<Settings>;
	return {
		settings: {
			...DEFAULT_SETTINGS,
			...s,
			// 0.1.0 only had folders: someone who picked folders keeps them.
			scope: s.scope === "vault" || s.scope === "folders" ? s.scope : s.folders?.length ? "folders" : "vault",
			query: { ...EMPTY_QUERY, ...(s.query ?? {}) },
			ai: aiFrom(s.ai),
		},
		clips: d.clips ?? {},
		daily: { ...EMPTY_DATA.daily, ...(d.daily ?? {}) },
		seenVersion: d.seenVersion ?? "",
		welcomed: d.welcomed ?? false,
		memo: { ...EMPTY_DATA.memo, ...(d.memo ?? {}) },
	};
}

/** Saved AI settings, with 0.1.0's "ollama" service read as a model on this device. */
function aiFrom(raw: unknown): AiSettings {
	const a = { ...DEFAULT_SETTINGS.ai, ...((raw ?? {}) as Partial<AiSettings>) };
	if ((a.provider as string) === "ollama") {
		a.provider = "local";
		a.app = a.app || "Ollama";
	}
	if (!(a.provider in PROVIDERS)) a.provider = "openrouter";
	return a;
}
