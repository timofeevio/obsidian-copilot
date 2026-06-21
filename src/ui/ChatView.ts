import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type LocalCopilotPlugin from "../main";
import { ChatMsg, describeError } from "../llm/OllamaClient";

export const CHAT_VIEW_TYPE = "local-copilot-chat";

const CHAT_SYSTEM =
	"You are Local Copilot, a helpful assistant running entirely on the user's machine. " +
	"Be concise and use Markdown when it helps. When the user shares note content, ground your answers in it.";

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
	private activeNoteEl!: HTMLElement;

	private controller: AbortController | null = null;
	private streaming = false;

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

		// Header: toggle to auto-include whatever note the user is currently viewing.
		const header = root.createDiv({ cls: "lc-header" });
		const toggle = header.createEl("label", { cls: "lc-include" });
		this.includeEl = toggle.createEl("input", { type: "checkbox" });
		this.includeEl.checked = this.plugin.settings.includeActiveNote;
		toggle.createSpan({ text: "Include active note" });
		this.includeEl.addEventListener("change", async () => {
			this.plugin.settings.includeActiveNote = this.includeEl.checked;
			await this.plugin.saveSettings();
			this.updateActiveNoteLabel();
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
		const reply = await this.streamReply([
			{ role: "system", content: system },
			{ role: "user", content },
		]);
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

		// Rebuilt per send so it always reflects the note the user is currently viewing
		// (and its latest content). Not stored in history, so it never goes stale.
		const messages: ChatMsg[] = [{ role: "system", content: CHAT_SYSTEM }];
		const noteCtx = await this.activeNoteContext();
		if (noteCtx) messages.push(noteCtx);
		messages.push(...this.history);

		const reply = await this.streamReply(messages);
		if (reply !== null) this.history.push({ role: "assistant", content: reply });
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
		this.setStreaming(true);
		this.controller = new AbortController();

		const bubble = this.addBubble("assistant");
		const contentEl = bubble.createDiv({ cls: "lc-bubble-content" });
		const typing = this.renderTyping(bubble);
		this.scrollToBottom();
		let acc = "";
		try {
			for await (const chunk of this.plugin.client.chatStream(messages, this.controller.signal)) {
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
			this.setStreaming(false);
			this.controller = null;
		}

		contentEl.empty();
		await MarkdownRenderer.render(this.app, acc || "_(empty response)_", contentEl, "", this);
		this.scrollToBottom();
		return acc;
	}

	private stop(): void {
		this.controller?.abort();
		this.controller = null;
		this.setStreaming(false);
	}

	private clear(): void {
		this.stop();
		this.history = [];
		this.historyEl.empty();
		this.renderPlaceholder();
		this.inputEl?.focus();
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
}
