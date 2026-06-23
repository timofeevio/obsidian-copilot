import { App } from "obsidian";
import { ChatMsg, OllamaClient, describeError } from "../llm/OllamaClient";
import { Tool, getTool, toolSchemas } from "./tools";

export interface RunAgentOpts {
	app: App;
	client: OllamaClient;
	model: string;
	maxIterations: number;
	/** [system, …context, user] — extended in place with assistant/tool turns as the loop runs. */
	messages: ChatMsg[];
	signal: AbortSignal;
	/** Toggled around each model call so the UI can show a "thinking" indicator. */
	onThinking: (active: boolean) => void;
	/** Render assistant text produced on a turn. */
	onAssistantText: (text: string) => void;
	/** A tool is about to run. */
	onToolCall: (name: string, summary: string) => void;
	/** A tool produced a result. */
	onToolResult: (name: string, result: string) => void;
	/** Ask the user to approve a write tool. Resolve true to run it, false to reject. */
	confirmWrite: (tool: Tool, args: Record<string, unknown>, summary: string) => Promise<boolean>;
}

export type StoppedReason = "done" | "max-iterations" | "aborted";

export interface RunAgentResult {
	finalText: string;
	stoppedReason: StoppedReason;
}

/**
 * Drive the tool-calling loop: ask the model, run any requested tools (write tools gated
 * by `confirmWrite`), feed results back, and repeat until the model answers with no tool
 * calls, the iteration cap is hit, or the signal aborts.
 */
export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
	const { app, client, model, maxIterations, messages, signal } = opts;
	const tools = toolSchemas();
	let finalText = "";

	for (let i = 0; i < maxIterations; i++) {
		if (signal.aborted) return { finalText, stoppedReason: "aborted" };

		opts.onThinking(true);
		let content: string;
		let toolCalls;
		try {
			({ content, toolCalls } = await client.chatWithTools(messages, tools, { model, signal }));
		} finally {
			opts.onThinking(false);
		}
		if (signal.aborted) return { finalText, stoppedReason: "aborted" };

		messages.push({
			role: "assistant",
			content,
			tool_calls: toolCalls.length ? toolCalls : undefined,
		});
		if (content.trim()) {
			finalText = content;
			opts.onAssistantText(content);
		}

		if (toolCalls.length === 0) return { finalText, stoppedReason: "done" };

		for (const call of toolCalls) {
			if (signal.aborted) return { finalText, stoppedReason: "aborted" };
			const name = call.function?.name ?? "";
			const args = (call.function?.arguments ?? {}) as Record<string, unknown>;
			const tool = getTool(name);
			const summary = tool ? tool.summarize(args) : `${name}(${JSON.stringify(args)})`;
			opts.onToolCall(name, summary);

			let result: string;
			if (!tool) {
				result = `Error: unknown tool "${name}".`;
			} else if (tool.isWrite) {
				const approved = await opts.confirmWrite(tool, args, summary);
				if (signal.aborted) return { finalText, stoppedReason: "aborted" };
				result = approved
					? await safeRun(app, tool, args, signal)
					: "The user rejected this action. Do not retry it; continue without it or ask how to proceed.";
			} else {
				result = await safeRun(app, tool, args, signal);
			}

			opts.onToolResult(name, result);
			messages.push({ role: "tool", tool_name: name, content: result });
		}
	}

	return { finalText, stoppedReason: "max-iterations" };
}

async function safeRun(
	app: App,
	tool: Tool,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<string> {
	try {
		return await tool.run(app, args, signal);
	} catch (e) {
		return `Error running ${tool.def.function.name}: ${describeError(e)}`;
	}
}
