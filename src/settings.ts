import {
	App,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";
import type LocalCopilotPlugin from "./main";
import { describeError } from "./llm/OllamaClient";

export type ApplyTarget = "menu" | "replace" | "insert" | "copy" | "chat";

export interface LocalCopilotSettings {
	baseUrl: string;
	model: string;
	temperature: number;
	numPredict: number;
	promptsFolder: string;
	defaultApply: ApplyTarget;
	includeActiveNote: boolean;
}

export const DEFAULT_SETTINGS: LocalCopilotSettings = {
	baseUrl: "http://localhost:11434",
	model: "gemma3:12b",
	temperature: 0.7,
	numPredict: -1,
	promptsFolder: "_prompts",
	defaultApply: "menu",
	includeActiveNote: false,
};

export class LocalCopilotSettingTab extends PluginSettingTab {
	private plugin: LocalCopilotPlugin;

	constructor(app: App, plugin: LocalCopilotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ---- Connection ----
		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("Ollama base URL")
			.setDesc(
				"Where the Ollama server is listening. OpenAI-compatible servers (LM Studio, etc.) also work — just change this.",
			)
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.baseUrl)
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (v) => {
						this.plugin.settings.baseUrl = v.trim() || DEFAULT_SETTINGS.baseUrl;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Ping the server and list installed models.")
			.addButton((btn) =>
				btn
					.setButtonText("Test")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("Testing…");
						try {
							const models = await this.plugin.client.listModels();
							new Notice(
								`✅ Connected to Ollama.\n${models.length} model(s): ${
									models.join(", ") || "none installed"
								}`,
								6000,
							);
						} catch (e) {
							new Notice(`❌ ${describeError(e)}`, 8000);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText("Test");
						}
					}),
			);

		// ---- Model & generation ----
		new Setting(containerEl).setName("Model & generation").setHeading();

		let modelText: TextComponent | undefined;
		let modelDrop: DropdownComponent | undefined;
		new Setting(containerEl)
			.setName("Model")
			.setDesc(
				"Pick an installed model, or type any tag (e.g. gemma3:12b). Typing works even if the server is offline.",
			)
			.addDropdown((dd) => {
				modelDrop = dd;
				dd.addOption(this.plugin.settings.model, this.plugin.settings.model);
				dd.setValue(this.plugin.settings.model);
				dd.onChange(async (v) => {
					this.plugin.settings.model = v;
					modelText?.setValue(v);
					await this.plugin.saveSettings();
				});
			})
			.addText((txt) => {
				modelText = txt;
				txt
					.setPlaceholder(DEFAULT_SETTINGS.model)
					.setValue(this.plugin.settings.model)
					.onChange(async (v) => {
						this.plugin.settings.model = v.trim();
						await this.plugin.saveSettings();
					});
			})
			.addExtraButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip("Refresh installed models from Ollama")
					.onClick(() => this.populateModels(modelDrop)),
			);

		// Populate the dropdown from /api/tags (async; leaves the seeded value on failure).
		void this.populateModels(modelDrop);

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Higher = more creative, lower = more deterministic.")
			.addSlider((s) =>
				s
					.setLimits(0, 1.5, 0.05)
					.setValue(this.plugin.settings.temperature)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.temperature = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Max output tokens")
			.setDesc("Cap on generated tokens (num_predict). Use -1 for unlimited.")
			.addText((t) =>
				t
					.setPlaceholder("-1")
					.setValue(String(this.plugin.settings.numPredict))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.numPredict = Number.isFinite(n) ? n : -1;
						await this.plugin.saveSettings();
					}),
			);

		// ---- Behavior ----
		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Default apply action")
			.setDesc(
				"What to do with command output. 'Ask each time' shows a menu (Replace / Insert / Copy). 'Send to chat' streams into the sidebar (Phase 3).",
			)
			.addDropdown((dd) =>
				dd
					.addOptions({
						menu: "Ask each time (menu)",
						replace: "Replace selection",
						insert: "Insert below",
						copy: "Copy to clipboard",
						chat: "Send to chat",
					})
					.setValue(this.plugin.settings.defaultApply)
					.onChange(async (v) => {
						this.plugin.settings.defaultApply = v as ApplyTarget;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Include active note in chat")
			.setDesc(
				"When on, the chat automatically sends the note you're currently viewing as context with each message. You can also toggle this from the chat header.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.includeActiveNote).onChange(async (v) => {
					this.plugin.settings.includeActiveNote = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Custom prompts folder")
			.setDesc("Vault folder scanned for custom prompt commands (Phase 4). Each .md becomes a command.")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.promptsFolder)
					.setValue(this.plugin.settings.promptsFolder)
					.onChange(async (v) => {
						this.plugin.settings.promptsFolder = v.trim() || DEFAULT_SETTINGS.promptsFolder;
						await this.plugin.saveSettings();
					}),
			);
	}

	/** Replace the model dropdown's options with the live list from Ollama. */
	private async populateModels(dd?: DropdownComponent): Promise<void> {
		if (!dd) return;
		let models: string[];
		try {
			models = await this.plugin.client.listModels();
		} catch {
			return; // leave the seeded current value; manual text entry still works
		}
		const current = this.plugin.settings.model;
		dd.selectEl.empty();
		if (current && !models.includes(current)) {
			dd.addOption(current, `${current} (not installed)`);
		}
		for (const m of models) dd.addOption(m, m);
		dd.setValue(current);
	}
}
