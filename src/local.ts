// Finds AI models that run on this device: model apps on a computer (Ollama, LM Studio and others),
// and on a phone the model kept by an Obsi app. It only asks addresses on this device (127.0.0.1),
// so nothing about you leaves it while it looks.
import { requestUrl } from "obsidian";
import { addressProblem, isLoopback } from "./safety";

/** The Obsi apps on a phone lend their model on this address. The same in every Obsi app. */
export const PHONE_PORT = 47391;
export const PHONE_URL = `http://127.0.0.1:${PHONE_PORT}`;

export interface FoundModel {
	/** The app that runs it, like "Ollama". */
	app: string;
	/** OpenAI-style address, ending in /v1. */
	baseUrl: string;
	model: string;
	/** Size on disk in bytes, when the app says. */
	bytes?: number;
}

export interface PhoneBridge {
	/** The Obsi app that lends its model, like "ObsiTube". */
	app: string;
	/** A model is on the phone and can answer. */
	ready: boolean;
	model: string;
}

interface Server {
	app: string;
	port: number;
	/** How to list its models. */
	list: "ollama" | "openai";
}

const SERVERS: Server[] = [
	{ app: "Ollama", port: 11434, list: "ollama" },
	{ app: "LM Studio", port: 1234, list: "openai" },
	{ app: "Jan", port: 1337, list: "openai" },
	{ app: "GPT4All", port: 4891, list: "openai" },
	{ app: "llama.cpp", port: 8080, list: "openai" },
];

/** Models that only turn text into numbers cannot answer, so they are never offered. */
const NOT_CHAT = /embed|rerank|bge-|e5-|minilm|clip|whisper|tts/i;

async function getJson(url: string, ms: number, headers: Record<string, string> = {}): Promise<unknown> {
	let timer = 0;
	const timeout = new Promise<null>((r) => (timer = window.setTimeout(() => r(null), ms)));
	try {
		const res = await Promise.race([requestUrl({ url, method: "GET", headers, throw: false }), timeout]);
		if (!res || res.status >= 400) return null;
		return res.json as unknown;
	} catch {
		return null;
	} finally {
		window.clearTimeout(timer);
	}
}

async function probe(s: Server, host = "127.0.0.1"): Promise<FoundModel[]> {
	const base = `http://${host}:${s.port}`;
	if (s.list === "ollama") {
		const j = (await getJson(base + "/api/tags", 1500)) as { models?: { name?: string; size?: number }[] } | null;
		return (j?.models ?? [])
			.filter((m): m is { name: string; size?: number } => typeof m.name === "string" && !NOT_CHAT.test(m.name))
			.map((m) => ({ app: s.app, baseUrl: base + "/v1", model: m.name, bytes: m.size }));
	}
	const j = (await getJson(base + "/v1/models", 1500)) as { data?: { id?: string }[] } | null;
	return (j?.data ?? [])
		.filter((m): m is { id: string } => typeof m.id === "string" && !NOT_CHAT.test(m.id))
		.map((m) => ({ app: s.app, baseUrl: base + "/v1", model: m.id }));
}

/** Every chat model the model apps on this device offer, smallest first (small is fast and enough). */
export async function findLocalModels(): Promise<FoundModel[]> {
	const lists = await Promise.all(SERVERS.map((s) => probe(s)));
	const seen = new Set<string>();
	const out: FoundModel[] = [];
	for (const m of lists.flat()) {
		const key = m.baseUrl + "|" + m.model;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(m);
	}
	return out.sort((a, b) => (a.bytes ?? 9e12) - (b.bytes ?? 9e12) || a.model.localeCompare(b.model));
}

/**
 * The models on another computer in your home, like a desktop running Ollama or LM Studio.
 * Only a home-network address is asked. Returns null when the address is not one.
 */
export async function findNetworkModels(typed: string): Promise<FoundModel[] | null> {
	const host = typed.trim().replace(/^[a-z]+:\/\//i, "").replace(/[/:].*$/, "");
	if (!host || addressProblem(`http://${host}`, false) !== null || isLoopback(`http://${host}`)) return null;
	const lists = await Promise.all(SERVERS.filter((s) => s.app !== "llama.cpp").map((s) => probe(s, host)));
	return lists.flat().sort((a, b) => (a.bytes ?? 9e12) - (b.bytes ?? 9e12) || a.model.localeCompare(b.model));
}

/** The Obsi app that lends its model on this phone, or null when none is lending right now. */
export async function findPhoneBridge(): Promise<PhoneBridge | null> {
	const j = (await getJson(PHONE_URL + "/obsi", 1500)) as { app?: unknown; ready?: unknown; model?: unknown } | null;
	if (!j || typeof j.app !== "string") return null;
	return { app: j.app.slice(0, 40), ready: j.ready === true, model: typeof j.model === "string" ? j.model.slice(0, 60) : "" };
}

/** "2.0 GB" */
export function sizeLabel(bytes?: number): string {
	if (!bytes) return "";
	return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export { addressProblem, isLoopback };
