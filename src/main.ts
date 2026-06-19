import { Notice, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	LocalCopilotSettings,
	LocalCopilotSettingTab,
} from "./settings";
import { ChatMsg, OllamaClient, describeError } from "./llm/OllamaClient";
import { registerTextCommands } from "./commands/textCommands";

export default class LocalCopilotPlugin extends Plugin {
	settings!: LocalCopilotSettings;
	client!: OllamaClient;

	async onload(): Promise<void> {
		console.log("Local Copilot: loading");

		await this.loadSettings();
		this.client = this.buildClient();

		this.addRibbonIcon("message-square", "Local Copilot", () => {
			new Notice(
				'Local Copilot is loaded. Select text and run a command (e.g. "Proofread selection"), or open Settings.',
			);
		});

		this.addSettingTab(new LocalCopilotSettingTab(this.app, this));

		// Phase 2: selection-based text commands (summarize / rewrite / expand / tone / proofread).
		registerTextCommands(this);

		// Temporary debug command (removed when the chat view lands in Phase 3).
		this.addCommand({
			id: "debug-test-generation",
			name: "Debug: test generation (non-streaming + streaming)",
			callback: () => this.debugTestGeneration(),
		});
	}

	onunload(): void {
		console.log("Local Copilot: unloading");
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

	private async debugTestGeneration(): Promise<void> {
		const messages: ChatMsg[] = [
			{ role: "system", content: "You are a terse assistant. Answer in as few words as possible." },
			{ role: "user", content: "Reply with exactly one word: pong" },
		];
		try {
			new Notice(`Testing ${this.settings.model} — non-streaming…`);
			const text = await this.client.chat(messages);
			console.log("[Local Copilot] chat() =>", text);
			new Notice(`Non-streaming OK: ${text.trim().slice(0, 80)}`);

			new Notice("Testing streaming…");
			let acc = "";
			const ac = new AbortController();
			for await (const chunk of this.client.chatStream(messages, ac.signal)) {
				acc += chunk;
			}
			console.log("[Local Copilot] chatStream() =>", acc);
			new Notice(`Streaming OK: ${acc.trim().slice(0, 80)}`);
		} catch (e) {
			console.error("[Local Copilot] debug generation failed", e);
			new Notice(`❌ ${describeError(e)}`, 8000);
		}
	}
}
