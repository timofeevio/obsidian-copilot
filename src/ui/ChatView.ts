import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type LocalCopilotPlugin from "../main";
import { ChatMsg, describeError } from "../llm/OllamaClient";
import { runAgent } from "../agent/agentLoop";

export const CHAT_VIEW_TYPE = "local-copilot-chat";

const CHAT_SYSTEM =
	"You are Local Copilot, a helpful assistant running entirely on the user's machine. " +
	"Be concise and use Markdown when it helps. When the user shares note content, ground your answers in it.";

const AGENT_SYSTEM =
	"You are Local Copilot, an agent operating inside the user's Obsidian vault. You have tools to " +
	"search, read, list, and edit notes. Use tools to gather information before answering and to make " +
	"changes the user asks for. Prefer search_vault/read_note to ground your answers. Make minimal, " +
	"precise edits — each edit needs the user's approval. When the task is done, give a short summary.";

// Cap on auto-included active-note content, matching the text-command guard.
const MAX_NOTE_CHARS = 24000;

/**
 * Streaming chat sidebar. Vanilla DOM (no React). Holds an in-memory conversation
 * (`history`, excluding the system prompt) and streams assistant replies via
 * `client.chatStream()`, cancellable through an `AbortController`.
 */
export class ChatView extends ItemView {
	private plugin: LocalCopilotPlugin;
	private history: ChatMsg[] = [];

	private historyEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private includeEl!: HTMLInputElement;
	private agentEl!: HTMLInputElement;
	private activeNoteEl!: HTMLElement;

	private controller: AbortController | null = null;
	private streaming = false;
	private thinkingBubble: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: LocalCopilotPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Local Copilot";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("local-copilot-chat");

		// Header: toggles to include the active note as context and to enable agent (tools) mode.
		const header = root.createDiv({ cls: "lc-header" });
		const toggles = header.createDiv({ cls: "lc-toggles" });
		this.includeEl = this.makeToggle(toggles, "Include note", this.plugin.settings.includeActiveNote, async (v) => {
			this.plugin.settings.includeActiveNote = v;
			await this.plugin.saveSettings();
			this.updateActiveNoteLabel();
		});
		this.agentEl = this.makeToggle(toggles, "Agent", this.plugin.settings.agentMode, async (v) => {
			this.plugin.settings.agentMode = v;
			await this.plugin.saveSettings();
		});
		this.activeNoteEl = header.createDiv({ cls: "lc-active-note" });
		this.updateActiveNoteLabel();
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateActiveNoteLabel()));

		this.historyEl = root.createDiv({ cls: "lc-history" });
		this.renderPlaceholder();

		const inputRow = root.createDiv({ cls: "lc-input-row" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "lc-input",
			attr: { rows: "3", placeholder: "Ask anything… (Enter to send, Shift+Enter for newline)" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.handleSend();
			}
		});

		const actions = root.createDiv({ cls: "lc-actions" });
		this.sendBtn = this.makeButton(actions, "send", "Send", () => void this.handleSend(), true);
		this.stopBtn = this.makeButton(actions, "square", "Stop", () => this.stop());
		this.makeButton(actions, "trash-2", "Clear", () => this.clear());
		this.stopBtn.disabled = true;
	}

	async onClose(): Promise<void> {
		this.stop();
	}

	// ---- public API used by main.ts (commands + Phase 2 routing) ----

	/** Append a context message (selection / note) without triggering a reply. */
	addContext(label: string, content: string): void {
		if (!content.trim()) {
			new Notice("Local Copilot: nothing to add.");
			return;
		}
		this.history.push({ role: "user", content: `${label}:\n\n${content}` });
		const bubble = this.addBubble("user");
		bubble.createDiv({ cls: "lc-context-label", text: label });
		bubble.createDiv({ cls: "lc-bubble-content", text: content });
		this.scrollToBottom();
		this.inputEl?.focus();
	}

	/** Run a one-shot text command (Phase 2 `defaultApply: chat`) and stream the reply here. */
	async runCommand(system: string, content: string, label: string): Promise<void> {
		const bubble = this.addBubble("user");
		bubble.createDiv({ cls: "lc-context-label", text: label });
		bubble.createDiv({ cls: "lc-bubble-content", text: content });
		this.scrollToBottom();

		this.history.push({ role: "user", content });
		// Use the command's system prompt, but include the same active-note context and
		// history the user can see, so the reply is consistent with the conversation.
		const reply = await this.streamReply(await this.buildMessages(system));
		if (reply !== null) this.history.push({ role: "assistant", content: reply });
	}

	focusInput(): void {
		this.inputEl?.focus();
	}

	// ---- internals ----

	private async handleSend(): Promise<void> {
		if (this.streaming) return;
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";

		const bubble = this.addBubble("user");
		bubble.createDiv({ cls: "lc-bubble-content", text });
		this.scrollToBottom();

		this.history.push({ role: "user", content: text });

		if (this.plugin.settings.agentMode) {
			await this.runAgentTurn();
			return;
		}

		const reply = await this.streamReply(await this.buildMessages(CHAT_SYSTEM));
		if (reply !== null) this.history.push({ role: "assistant", content: reply });
	}

	/** Run one agent turn: the tool-calling loop, rendering tool calls/results + approvals. */
	private async runAgentTurn(): Promise<void> {
		const controller = new AbortController();
		this.controller = controller;
		this.setStreaming(true);
		const messages = await this.buildMessages(AGENT_SYSTEM, { includeToolTurns: true });
		// runAgent appends its assistant/tool turns to `messages` in place; everything past
		// this point is the new turn. We persist those to `history` so a follow-up message
		// (e.g. after hitting the step cap) continues with the full tool-calling context.
		const turnStart = messages.length;
		try {
			const result = await runAgent({
				app: this.app,
				client: this.plugin.client,
				model: this.plugin.settings.agentModel,
				maxIterations: this.plugin.settings.agentMaxIterations,
				messages,
				signal: controller.signal,
				onThinking: (active) => this.setThinking(active),
				onAssistantText: (text) => this.renderAgentText(text),
				onToolCall: (_name, summary) => this.renderToolCall(summary),
				onToolResult: (_name, res) => this.renderToolResult(res),
				confirmWrite: (_tool, _args, summary) => this.confirmWrite(summary),
			});
			this.history.push(...messages.slice(turnStart));
			if (result.stoppedReason === "max-iterations") {
				this.renderSystemLine(
					`Stopped after ${this.plugin.settings.agentMaxIterations} steps. Send another message to continue.`,
				);
			}
		} catch (e) {
			this.renderSystemLine(`⚠️ ${describeError(e)}`, true);
		} finally {
			this.setThinking(false);
			if (this.controller === controller) {
				this.setStreaming(false);
				this.controller = null;
			}
		}
	}

	/**
	 * Build the request messages: the given system prompt, the optional active-note
	 * context, then the conversation history. Rebuilt per send so the active note always
	 * reflects what the user is currently viewing (and its latest content). Shared by
	 * normal sends and routed text commands so both see the same context as the visible
	 * conversation.
	 */
	private async buildMessages(
		systemPrompt: string,
		opts: { includeToolTurns?: boolean } = {},
	): Promise<ChatMsg[]> {
		const messages: ChatMsg[] = [{ role: "system", content: systemPrompt }];
		const noteCtx = await this.activeNoteContext();
		if (noteCtx) messages.push(noteCtx);
		messages.push(...(opts.includeToolTurns ? this.history : this.plainHistory()));
		return messages;
	}

	/**
	 * History with agent-mode tool artifacts stripped: `tool` result turns are dropped and
	 * `tool_calls` removed from assistant turns (keeping any text they carried). Used for the
	 * plain streaming chat, which sends no `tools` and whose model may not handle those roles.
	 */
	private plainHistory(): ChatMsg[] {
		const out: ChatMsg[] = [];
		for (const m of this.history) {
			if (m.role === "tool") continue;
			if (m.role === "assistant" && m.tool_calls) {
				if (m.content.trim()) out.push({ role: "assistant", content: m.content });
				continue;
			}
			out.push(m);
		}
		return out;
	}

	/** Build a context message from the currently active note, if the toggle is on. */
	private async activeNoteContext(): Promise<ChatMsg | null> {
		if (!this.plugin.settings.includeActiveNote) return null;
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		let content = await this.app.vault.cachedRead(file);
		if (content.length > MAX_NOTE_CHARS) content = content.slice(0, MAX_NOTE_CHARS);
		return {
			role: "system",
			content: `The user is currently viewing the note "${file.basename}". Use it as context when relevant:\n\n${content}`,
		};
	}

	private updateActiveNoteLabel(): void {
		if (!this.activeNoteEl) return;
		const file = this.app.workspace.getActiveFile();
		if (!this.plugin.settings.includeActiveNote) {
			this.activeNoteEl.setText("");
			return;
		}
		this.activeNoteEl.setText(file ? `Context: ${file.basename}` : "Context: no active note");
	}

	/** Stream an assistant reply into a new bubble. Returns the text, or null on error. */
	private async streamReply(messages: ChatMsg[]): Promise<string | null> {
		// Own the streaming state via a local controller. The finally block only resets
		// shared state when this stream is still the current one, so a Stop-then-Send race
		// can't let an older stream clobber a newer one's controller / streaming flag.
		const controller = new AbortController();
		this.controller = controller;
		this.setStreaming(true);

		const bubble = this.addBubble("assistant");
		const contentEl = bubble.createDiv({ cls: "lc-bubble-content" });
		const typing = this.renderTyping(bubble);
		this.scrollToBottom();
		let acc = "";
		try {
			for await (const chunk of this.plugin.client.chatStream(messages, controller.signal)) {
				if (!acc) typing.remove();
				acc += chunk;
				contentEl.setText(acc);
				this.scrollToBottom();
			}
		} catch (e) {
			typing.remove();
			bubble.addClass("lc-error");
			contentEl.setText(`⚠️ ${describeError(e)}`);
			return null;
		} finally {
			typing.remove();
			if (this.controller === controller) {
				this.setStreaming(false);
				this.controller = null;
			}
		}

		contentEl.empty();
		await MarkdownRenderer.render(this.app, acc || "_(empty response)_", contentEl, "", this);
		this.scrollToBottom();
		return acc;
	}

	private stop(): void {
		// Only abort; streamReply's finally owns resetting streaming/controller state.
		this.controller?.abort();
	}

	private clear(): void {
		this.stop();
		this.history = [];
		this.thinkingBubble = null;
		this.historyEl.empty();
		this.renderPlaceholder();
		this.inputEl?.focus();
	}

	// ---- agent-mode rendering ----

	/** Show/hide a single "thinking" indicator bubble around each model call. */
	private setThinking(active: boolean): void {
		if (active && !this.thinkingBubble) {
			this.thinkingBubble = this.addBubble("assistant");
			this.renderTyping(this.thinkingBubble);
			this.scrollToBottom();
		} else if (!active && this.thinkingBubble) {
			this.thinkingBubble.remove();
			this.thinkingBubble = null;
		}
	}

	private renderAgentText(text: string): void {
		const bubble = this.addBubble("assistant");
		const contentEl = bubble.createDiv({ cls: "lc-bubble-content" });
		void MarkdownRenderer.render(this.app, text, contentEl, "", this);
		this.scrollToBottom();
	}

	private renderToolCall(summary: string): void {
		const el = this.historyEl.createDiv({ cls: "lc-tool-call" });
		setIcon(el.createSpan({ cls: "lc-tool-icon" }), "wrench");
		el.createSpan({ cls: "lc-tool-name", text: summary });
		this.scrollToBottom();
	}

	private renderToolResult(result: string): void {
		const el = this.historyEl.createDiv({ cls: "lc-tool-result" });
		el.setText(result);
		this.scrollToBottom();
	}

	private renderSystemLine(text: string, isError = false): void {
		this.historyEl.createDiv({ cls: isError ? "lc-system-line lc-error" : "lc-system-line", text });
		this.scrollToBottom();
	}

	/** Render an inline Approve/Reject card and resolve with the user's choice. */
	private confirmWrite(summary: string): Promise<boolean> {
		return new Promise((resolve) => {
			const card = this.historyEl.createDiv({ cls: "lc-approval" });
			card.createDiv({ cls: "lc-approval-title", text: "Approve this edit?" });
			card.createDiv({ cls: "lc-approval-summary", text: summary });
			const actions = card.createDiv({ cls: "lc-approval-actions" });

			const signal = this.controller?.signal;
			let settled = false;
			const decide = (ok: boolean) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				approve.disabled = true;
				reject.disabled = true;
				card.createSpan({
					cls: ok ? "lc-approval-status lc-approved" : "lc-approval-status lc-rejected",
					text: ok ? "Approved" : "Rejected",
				});
				resolve(ok);
			};
			const onAbort = () => decide(false);

			const approve = actions.createEl("button", { cls: "lc-btn mod-cta", text: "Approve" });
			approve.addEventListener("click", () => decide(true));
			const reject = actions.createEl("button", { cls: "lc-btn", text: "Reject" });
			reject.addEventListener("click", () => decide(false));
			signal?.addEventListener("abort", onAbort, { once: true });

			this.scrollToBottom();
		});
	}

	private setStreaming(on: boolean): void {
		this.streaming = on;
		if (this.sendBtn) this.sendBtn.disabled = on;
		if (this.stopBtn) this.stopBtn.disabled = !on;
	}

	private addBubble(role: "user" | "assistant"): HTMLElement {
		this.historyEl.querySelector(".lc-placeholder")?.remove();
		return this.historyEl.createDiv({ cls: `lc-bubble lc-${role}` });
	}

	/** Animated "…" indicator shown until the first token arrives. */
	private renderTyping(parent: HTMLElement): HTMLElement {
		const el = parent.createDiv({ cls: "lc-typing" });
		el.createSpan();
		el.createSpan();
		el.createSpan();
		return el;
	}

	private renderPlaceholder(): void {
		this.historyEl.createDiv({
			cls: "lc-placeholder",
			text: "Start a conversation, or use “Add selection / current note to chat”.",
		});
	}

	private scrollToBottom(): void {
		this.historyEl.scrollTop = this.historyEl.scrollHeight;
	}

	private makeButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
		cta = false,
	): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "lc-btn" });
		if (cta) btn.addClass("mod-cta");
		setIcon(btn.createSpan({ cls: "lc-btn-icon" }), icon);
		btn.createSpan({ text: label });
		btn.addEventListener("click", onClick);
		return btn;
	}

	private makeToggle(
		parent: HTMLElement,
		label: string,
		value: boolean,
		onChange: (checked: boolean) => void,
	): HTMLInputElement {
		const lbl = parent.createEl("label", { cls: "lc-toggle" });
		const input = lbl.createEl("input", { type: "checkbox" });
		input.checked = value;
		lbl.createSpan({ text: label });
		input.addEventListener("change", () => onChange(input.checked));
		return input;
	}
}
