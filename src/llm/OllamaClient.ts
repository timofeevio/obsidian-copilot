import { requestUrl } from "obsidian";

export interface ChatMsg {
	role: "system" | "user" | "assistant";
	content: string;
}

export type OllamaErrorKind = "not-running" | "model-missing" | "server";

/** A classified, user-friendly error from the Ollama backend. */
export class OllamaError extends Error {
	constructor(
		public kind: OllamaErrorKind,
		message: string,
		public cause?: unknown,
	) {
		super(message);
		this.name = "OllamaError";
	}
}

/** Turn any thrown value into a short message suitable for a Notice. */
export function describeError(e: unknown): string {
	if (e instanceof OllamaError) return e.message;
	if (e instanceof Error) return e.message;
	return String(e);
}

const KEEP_ALIVE = "30m";

/**
 * Minimal client for the Ollama HTTP API.
 *
 * - `chat()` is non-streaming and uses Obsidian's `requestUrl()`, which bypasses CORS.
 * - `chatStream()` streams via native `fetch` + NDJSON; it needs `OLLAMA_ORIGINS` set
 *   (see README) and supports cancellation through an `AbortSignal`.
 *
 * The API is OpenAI-compatible at `/v1/*`, so pointing `baseUrl` at LM Studio / llama.cpp
 * / a cloud endpoint would work with the same shape later.
 */
export class OllamaClient {
	constructor(
		private baseUrl: string,
		private model: string,
		private temperature: number,
		private numPredict: number,
	) {}

	private options() {
		// num_ctx sets the context window. 8192 gives room for longer notes than Ollama's
		// small default; Phase 5 (#6) will make this a user setting.
		return { temperature: this.temperature, num_predict: this.numPredict, num_ctx: 8192 };
	}

	/** Non-streaming chat. Returns the full assistant message. */
	async chat(messages: ChatMsg[]): Promise<string> {
		let res;
		try {
			res = await requestUrl({
				url: `${this.baseUrl}/api/chat`,
				method: "POST",
				contentType: "application/json",
				throw: false,
				body: JSON.stringify({
					model: this.model,
					messages,
					stream: false,
					options: this.options(),
					keep_alive: KEEP_ALIVE,
				}),
			});
		} catch (e) {
			throw this.connectionError(e);
		}
		if (res.status !== 200) throw this.httpError(res.status, res.text);
		return res.json?.message?.content ?? "";
	}

	/** Streaming chat. Yields content chunks as they arrive. Pass a signal to cancel. */
	async *chatStream(messages: ChatMsg[], signal?: AbortSignal): AsyncGenerator<string> {
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					messages,
					stream: true,
					options: this.options(),
					keep_alive: KEEP_ALIVE,
				}),
				signal,
			});
		} catch (e) {
			if (isAbort(e)) return;
			throw this.connectionError(e);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw this.httpError(res.status, text);
		}
		if (!res.body) throw new OllamaError("server", "Ollama returned an empty response body.");

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					let json: any;
					try {
						json = JSON.parse(trimmed);
					} catch {
						continue; // ignore partial/garbage lines
					}
					if (json.error) throw new OllamaError("server", String(json.error));
					if (json.message?.content) yield json.message.content as string;
					if (json.done) return;
				}
			}
		} catch (e) {
			if (isAbort(e)) return;
			throw e;
		} finally {
			reader.cancel().catch(() => {});
		}
	}

	/** List installed model tags. Doubles as a connection test. */
	async listModels(): Promise<string[]> {
		let res;
		try {
			res = await requestUrl({
				url: `${this.baseUrl}/api/tags`,
				method: "GET",
				throw: false,
			});
		} catch (e) {
			throw this.connectionError(e);
		}
		if (res.status !== 200) throw this.httpError(res.status, res.text);
		const models = (res.json?.models ?? []) as Array<{ name?: string }>;
		return models.map((m) => m.name).filter((n): n is string => !!n);
	}

	private connectionError(cause: unknown): OllamaError {
		return new OllamaError(
			"not-running",
			`Couldn't reach Ollama at ${this.baseUrl}. Is the Ollama server running?`,
			cause,
		);
	}

	private httpError(status: number, body: string): OllamaError {
		let msg = body;
		try {
			msg = JSON.parse(body)?.error ?? body;
		} catch {
			/* keep raw body */
		}
		if (status === 404 || /not found|try pulling/i.test(msg)) {
			return new OllamaError(
				"model-missing",
				`Model "${this.model}" isn't available. Pull it first:  ollama pull ${this.model}`,
			);
		}
		return new OllamaError("server", `Ollama error ${status}: ${msg || "unknown"}`);
	}
}

function isAbort(e: unknown): boolean {
	return e instanceof DOMException ? e.name === "AbortError" : (e as Error)?.name === "AbortError";
}
