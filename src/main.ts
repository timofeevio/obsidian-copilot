import { Editor, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	LocalCopilotSettings,
	LocalCopilotSettingTab,
} from "./settings";
import { OllamaClient } from "./llm/OllamaClient";
import { registerTextCommands } from "./commands/textCommands";
import { ChatView, CHAT_VIEW_TYPE } from "./ui/ChatView";

export default class LocalCopilotPlugin extends Plugin {
	settings!: LocalCopilotSettings;
	client!: OllamaClient;

	async onload(): Promise<void> {
		console.log("Local Copilot: loading");

		await this.loadSettings();
		this.client = this.buildClient();

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

		this.addRibbonIcon("message-square", "Local Copilot chat", () => void this.activateView());

		this.addSettingTab(new LocalCopilotSettingTab(this.app, this));

		// Phase 2: selection-based text commands (summarize / rewrite / expand / tone / proofread).
		registerTextCommands(this);

		// Phase 3: chat sidebar + context injection.
		this.addCommand({
			id: "open-chat",
			name: "Open Local Copilot chat",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "add-selection-to-chat",
			name: "Add selection to chat",
			editorCallback: (editor: Editor) => {
				const sel = editor.getSelection();
				if (!sel.trim()) {
					new Notice("Local Copilot: select some text first.");
					return;
				}
				void this.activateView().then((view) => view.addContext("Selection", sel));
			},
		});

		this.addCommand({
			id: "add-note-to-chat",
			name: "Add current note to chat",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice("Local Copilot: open a note first.");
					return;
				}
				void (async () => {
					const content = await this.app.vault.cachedRead(file);
					const view = await this.activateView();
					view.addContext(`Note: ${file.basename}`, content);
				})();
			},
		});
	}

	onunload(): void {
		console.log("Local Copilot: unloading");
	}

	/** Reveal the chat view (creating it in the right sidebar if needed) and return it. */
	async activateView(): Promise<ChatView> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
		const view = leaf?.view as ChatView;
		view?.focusInput();
		return view;
	}

	/** Route a text-command result into the chat (Phase 2 `defaultApply: chat`). */
	async sendCommandToChat(system: string, content: string, label: string): Promise<void> {
		const view = await this.activateView();
		await view.runCommand(system, content, label);
	}

	private buildClient(): OllamaClient {
		return new OllamaClient(
			this.settings.baseUrl,
			this.settings.model,
			this.settings.temperature,
			this.settings.numPredict,
		);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Rebuild the client so base URL / model / params take effect immediately.
		this.client = this.buildClient();
	}
}
