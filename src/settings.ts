import { EMPTY_QUERY, type ClipState, type Query } from "./model";

export type InsertFormat = "quote" | "embed" | "plain";
export type AiProvider = "openrouter" | "openai" | "groq" | "ollama" | "custom";

export interface AiSettings {
	on: boolean;
	provider: AiProvider;
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
	/** Folders that hold clips. Empty until set up. */
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
	/** Open "For this note" in the side bar when Obsidian starts. */
	panelOnStart: boolean;

	query: Query;
	showWhatsNew: boolean;
	ai: AiSettings;
}

export const DEFAULT_SETTINGS: Settings = {
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
	panelOnStart: false,
	query: EMPTY_QUERY,
	showWhatsNew: true,
	ai: {
		on: false,
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "google/gemini-2.5-flash-lite",
		keyName: "obsi-clips-ai",
		meaning: true,
		tags: "tap",
	},
};

export const PROVIDERS: Record<AiProvider, { name: string; url: string; model: string; key: boolean }> = {
	openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash-lite", key: true },
	openai: { name: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4.1-mini", key: true },
	groq: { name: "Groq", url: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant", key: true },
	ollama: { name: "Ollama (on this computer)", url: "http://localhost:11434/v1", model: "llama3.2", key: false },
	custom: { name: "Other (OpenAI-style)", url: "", model: "", key: true },
};

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
			query: { ...EMPTY_QUERY, ...(s.query ?? {}) },
			ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai ?? {}) },
		},
		clips: d.clips ?? {},
		daily: { ...EMPTY_DATA.daily, ...(d.daily ?? {}) },
		seenVersion: d.seenVersion ?? "",
		welcomed: d.welcomed ?? false,
		memo: { ...EMPTY_DATA.memo, ...(d.memo ?? {}) },
	};
}
