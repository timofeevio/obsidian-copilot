import { Editor, Hotkey, Notice } from "obsidian";
import type LocalCopilotPlugin from "../main";
import { ChatMsg, describeError } from "../llm/OllamaClient";
import { PROMPTS } from "../llm/prompts";
import { ApplyModal, applyCopy, applyInsertBelow, applyReplace } from "../ui/applyMenu";
import { ToneModal } from "../ui/toneModal";

// Soft cap on input length. ~6k tokens, which fits the client's num_ctx (8192) with
// room for the response. Over this we truncate + warn rather than silently drop context.
// Phase 5 (#6) will make context handling configurable.
const MAX_INPUT_CHARS = 24000;

export function registerTextCommands(plugin: LocalCopilotPlugin): void {
	const simple: { id: string; name: string; system: string; title: string; hotkeys?: Hotkey[] }[] = [
		{ id: "summarize-selection", name: "Summarize selection", system: PROMPTS.summarize, title: "Summary" },
		{
			id: "rewrite-concise",
			name: "Rewrite (concise)",
			system: PROMPTS.rewriteConcise,
			title: "Rewrite",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "K" }],
		},
		{ id: "expand-selection", name: "Expand selection", system: PROMPTS.expand, title: "Expanded" },
		{ id: "proofread-selection", name: "Proofread selection", system: PROMPTS.proofread, title: "Proofread" },
	];

	for (const c of simple) {
		plugin.addCommand({
			id: c.id,
			name: c.name,
			hotkeys: c.hotkeys,
			editorCallback: (editor: Editor) => void runTextCommand(plugin, editor, c.system, c.title),
		});
	}

	plugin.addCommand({
		id: "change-tone",
		name: "Change tone…",
		editorCallback: (editor: Editor) => {
			new ToneModal(plugin.app, (tone) => {
				const system = PROMPTS.changeTone.replace("{{tone}}", tone);
				void runTextCommand(plugin, editor, system, `Tone: ${tone}`);
			}).open();
		},
	});
}

/** Run a built-in text command against the selection (or whole note) and apply the result. */
export async function runTextCommand(
	plugin: LocalCopilotPlugin,
	editor: Editor,
	system: string,
	title: string,
): Promise<void> {
	const sel = editor.getSelection();
	const hadSelection = sel.trim().length > 0;
	const raw = hadSelection ? sel : editor.getValue();

	if (!raw.trim()) {
		new Notice("Local Copilot: select some text (or open a note with content) first.");
		return;
	}

	let content = raw;
	let truncated = false;
	if (content.length > MAX_INPUT_CHARS) {
		content = content.slice(0, MAX_INPUT_CHARS);
		truncated = true;
	}

	if (truncated) {
		new Notice("Input was long — only the first part was sent. (Configurable context comes later.)", 6000);
	}

	// "chat" routing streams the command into the sidebar instead of using the apply modal.
	if (plugin.settings.defaultApply === "chat") {
		await plugin.sendCommandToChat(system, content, title);
		return;
	}

	const messages: ChatMsg[] = [
		{ role: "system", content: system },
		{ role: "user", content },
	];

	const notice = new Notice(`Local Copilot: ${title.toLowerCase()}…`, 0);
	try {
		const result = (await plugin.client.chat(messages)).trim();
		notice.hide();
		if (!result) {
			new Notice("Local Copilot: the model returned an empty response.");
			return;
		}
		routeResult(plugin, editor, result, hadSelection, title);
	} catch (e) {
		notice.hide();
		new Notice(`❌ ${describeError(e)}`, 8000);
	}
}

function routeResult(
	plugin: LocalCopilotPlugin,
	editor: Editor,
	result: string,
	hadSelection: boolean,
	title: string,
): void {
	switch (plugin.settings.defaultApply) {
		case "replace":
			applyReplace(editor, result, hadSelection);
			break;
		case "insert":
			applyInsertBelow(editor, result);
			break;
		case "copy":
			applyCopy(result);
			break;
		// "chat" is handled earlier (streamed into the sidebar) and never reaches here.
		case "menu":
		default:
			new ApplyModal(plugin.app, { title, result, editor, hadSelection }).open();
	}
}
