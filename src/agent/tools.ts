import { App, TFile, normalizePath } from "obsidian";
import type { ToolDef } from "../llm/OllamaClient";

/**
 * A tool the agent can call. `run` returns a plain-string result that is fed back to
 * the model (errors are returned as strings too, so the model can recover rather than
 * the loop throwing). `isWrite` gates the per-action confirmation in the UI.
 */
export interface Tool {
	def: ToolDef;
	isWrite: boolean;
	run(app: App, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
	/** One-line human summary of a call, for the tool bubble / approval card. */
	summarize(args: Record<string, unknown>): string;
}

// Cap on note content returned to the model, to protect the context window.
const MAX_READ_CHARS = 12000;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_LIST = 200;

// ---- arg coercion helpers (arguments arrive as untyped JSON) ----
function str(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === "string" ? v : "";
}
function num(args: Record<string, unknown>, key: string, fallback: number): number {
	const v = args[key];
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return fallback;
}
function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const v = args[key];
	return typeof v === "boolean" ? v : fallback;
}

function ensureMd(path: string): string {
	return path.endsWith(".md") ? path : `${path}.md`;
}

/** Resolve a vault-relative path to a markdown file, or null. Non-`.md` files (images,
 * PDFs, JSON, …) are rejected so the write tools never process binary/foreign content. */
function resolveNote(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile && f.extension === "md" ? f : null;
}

function truncate(text: string): string {
	return text.length > MAX_READ_CHARS
		? `${text.slice(0, MAX_READ_CHARS)}\n\n…[truncated, ${text.length - MAX_READ_CHARS} more chars]`
		: text;
}

/**
 * Replace literal `find` with `replace`, skipping occurrences already inside an existing
 * `[[wikilink]]` so re-linking is idempotent (no `[[[[…]]]]`). Honors first-vs-all scope.
 */
export function replaceOutsideLinks(
	data: string,
	find: string,
	replace: string,
	all: boolean,
): { content: string; count: number } {
	if (!find) return { content: data, count: 0 };
	const linkSpans: Array<[number, number]> = [];
	for (const m of data.matchAll(/\[\[[^\]]*?\]\]/g)) {
		linkSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
	}
	const inLink = (i: number) => linkSpans.some(([s, e]) => i >= s && i < e);

	let result = "";
	let pos = 0;
	let count = 0;
	let idx = data.indexOf(find);
	while (idx !== -1) {
		if (!inLink(idx) && (all || count === 0)) {
			result += data.slice(pos, idx) + replace;
			count++;
		} else {
			result += data.slice(pos, idx + find.length);
		}
		pos = idx + find.length;
		idx = data.indexOf(find, pos);
	}
	result += data.slice(pos);
	return { content: result, count };
}

export const TOOLS: Tool[] = [
	{
		isWrite: false,
		summarize: (a) => `search_vault("${str(a, "query")}")`,
		def: {
			type: "function",
			function: {
				name: "search_vault",
				description:
					"Search all markdown notes for text (case-insensitive substring) and return matching note paths with a snippet. Use this to find notes that mention something.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Text to search for." },
						limit: {
							type: "number",
							description: `Max matching notes to return (default ${DEFAULT_SEARCH_LIMIT}).`,
						},
					},
					required: ["query"],
				},
			},
		},
		async run(app, args, signal) {
			const query = str(args, "query").trim();
			if (!query) return "Error: 'query' is required.";
			const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, num(args, "limit", DEFAULT_SEARCH_LIMIT)));
			const q = query.toLowerCase();
			const hits: string[] = [];
			for (const file of app.vault.getMarkdownFiles()) {
				if (signal?.aborted) break;
				const content = await app.vault.cachedRead(file);
				const i = content.toLowerCase().indexOf(q);
				if (i === -1) continue;
				const snippet = content
					.slice(Math.max(0, i - 40), i + query.length + 60)
					.replace(/\s+/g, " ")
					.trim();
				hits.push(`- ${file.path}: …${snippet}…`);
				if (hits.length >= limit) break;
			}
			if (hits.length === 0) return `No notes mention "${query}".`;
			return `Found ${hits.length} note(s) mentioning "${query}":\n${hits.join("\n")}`;
		},
	},
	{
		isWrite: false,
		summarize: (a) => `read_note("${str(a, "path")}")`,
		def: {
			type: "function",
			function: {
				name: "read_note",
				description: "Read the full text of a note by its vault-relative path.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Vault-relative path, e.g. People/Ada.md" } },
					required: ["path"],
				},
			},
		},
		async run(app, args) {
			const path = str(args, "path").trim();
			const file = resolveNote(app, path);
			if (!file) return `Error: no note found at "${path}".`;
			return truncate(await app.vault.cachedRead(file));
		},
	},
	{
		isWrite: false,
		summarize: (a) => (str(a, "folder") ? `list_notes("${str(a, "folder")}")` : "list_notes()"),
		def: {
			type: "function",
			function: {
				name: "list_notes",
				description: "List markdown note paths in the vault, optionally restricted to a folder prefix.",
				parameters: {
					type: "object",
					properties: {
						folder: { type: "string", description: "Optional folder prefix to filter by, e.g. People" },
					},
				},
			},
		},
		async run(app, args) {
			const folder = normalizePath(str(args, "folder").trim()).replace(/^\/+|\/+$/g, "");
			let files = app.vault.getMarkdownFiles();
			if (folder && folder !== ".") files = files.filter((f) => f.path.startsWith(`${folder}/`));
			if (files.length === 0) return folder ? `No notes under "${folder}".` : "No notes in the vault.";
			const paths = files.slice(0, MAX_LIST).map((f) => `- ${f.path}`);
			const more = files.length > MAX_LIST ? `\n…and ${files.length - MAX_LIST} more` : "";
			return `${files.length} note(s):\n${paths.join("\n")}${more}`;
		},
	},
	{
		isWrite: false,
		summarize: () => "get_active_note()",
		def: {
			type: "function",
			function: {
				name: "get_active_note",
				description: "Get the path and content of the note the user is currently viewing.",
				parameters: { type: "object", properties: {} },
			},
		},
		async run(app) {
			const file = app.workspace.getActiveFile();
			if (!file) return "There is no active note.";
			return `Path: ${file.path}\n\n${truncate(await app.vault.cachedRead(file))}`;
		},
	},
	{
		isWrite: true,
		summarize: (a) =>
			`replace_in_note("${str(a, "path")}": "${str(a, "find")}" → "${str(a, "replace")}")`,
		def: {
			type: "function",
			function: {
				name: "replace_in_note",
				description:
					"Replace literal text in a note. Occurrences already inside an existing [[wikilink]] are skipped, so this is safe for converting a mention into a link (e.g. find 'Ada Lovelace', replace '[[Ada Lovelace]]').",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Vault-relative path of the note to edit." },
						find: { type: "string", description: "Exact text to find." },
						replace: { type: "string", description: "Text to replace it with." },
						all: {
							type: "boolean",
							description: "Replace all occurrences (default true) or just the first (false).",
						},
					},
					required: ["path", "find", "replace"],
				},
			},
		},
		async run(app, args) {
			const path = str(args, "path").trim();
			const find = str(args, "find");
			const replace = str(args, "replace");
			const all = bool(args, "all", true);
			if (!find) return "Error: 'find' is required.";
			const file = resolveNote(app, path);
			if (!file) return `Error: no note found at "${path}".`;
			let count = 0;
			await app.vault.process(file, (data) => {
				const r = replaceOutsideLinks(data, find, replace, all);
				count = r.count;
				return r.content;
			});
			return count > 0
				? `Replaced ${count} occurrence(s) in ${path}.`
				: `No replaceable occurrences of "${find}" in ${path} (already linked or not present).`;
		},
	},
	{
		isWrite: true,
		summarize: (a) => `append_to_note("${str(a, "path")}")`,
		def: {
			type: "function",
			function: {
				name: "append_to_note",
				description: "Append text to the end of an existing note.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Vault-relative path of the note." },
						content: { type: "string", description: "Text to append." },
					},
					required: ["path", "content"],
				},
			},
		},
		async run(app, args) {
			const path = str(args, "path").trim();
			const content = str(args, "content");
			const file = resolveNote(app, path);
			if (!file) return `Error: no note found at "${path}".`;
			await app.vault.process(file, (data) => `${data}\n\n${content}`);
			return `Appended to ${path}.`;
		},
	},
	{
		isWrite: true,
		summarize: (a) => `create_note("${ensureMd(str(a, "path"))}")`,
		def: {
			type: "function",
			function: {
				name: "create_note",
				description: "Create a new note at a vault-relative path (parent folders are created as needed).",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Vault-relative path for the new note." },
						content: { type: "string", description: "Initial note content." },
					},
					required: ["path"],
				},
			},
		},
		async run(app, args) {
			const path = normalizePath(ensureMd(str(args, "path").trim()));
			if (!path || path.startsWith("..") || path.includes("/../")) return "Error: invalid path.";
			if (app.vault.getAbstractFileByPath(path)) return `Error: a file already exists at "${path}".`;
			const slash = path.lastIndexOf("/");
			if (slash > 0) {
				const folder = path.slice(0, slash);
				if (!app.vault.getAbstractFileByPath(folder)) {
					await app.vault.createFolder(folder).catch(() => {});
				}
			}
			await app.vault.create(path, str(args, "content"));
			return `Created ${path}.`;
		},
	},
];

export function toolSchemas(): ToolDef[] {
	return TOOLS.map((t) => t.def);
}

export function getTool(name: string): Tool | undefined {
	return TOOLS.find((t) => t.def.function.name === name);
}
