import { App, ButtonComponent, Editor, Modal, Notice } from "obsidian";

/** Replace the original selection (or the whole note, if nothing was selected). */
export function applyReplace(editor: Editor, result: string, hadSelection: boolean): void {
	if (hadSelection) editor.replaceSelection(result);
	else editor.setValue(result);
	new Notice("Local Copilot: replaced.");
}

/** Insert the result just after the selection / cursor. */
export function applyInsertBelow(editor: Editor, result: string): void {
	const end = editor.getCursor("to");
	editor.replaceRange(`\n\n${result}\n`, end);
	new Notice("Local Copilot: inserted below.");
}

export function applyCopy(result: string): void {
	void navigator.clipboard.writeText(result);
	new Notice("Local Copilot: copied to clipboard.");
}

export interface ApplyModalOpts {
	title: string;
	result: string;
	editor: Editor;
	hadSelection: boolean;
}

/**
 * Shows the generated text with Replace / Insert / Copy actions. Used when the
 * "Default apply action" setting is "Ask each time" (the default). Previewing the
 * output before applying is especially useful for proofread/summarize.
 */
export class ApplyModal extends Modal {
	constructor(
		app: App,
		private opts: ApplyModalOpts,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, opts } = this;
		contentEl.addClass("local-copilot-apply-modal");
		contentEl.createEl("h3", { text: opts.title });

		const box = contentEl.createDiv({ cls: "local-copilot-result" });
		box.setText(opts.result);

		const actions = contentEl.createDiv({ cls: "local-copilot-actions" });

		new ButtonComponent(actions)
			.setButtonText(opts.hadSelection ? "Replace selection" : "Replace note")
			.setCta()
			.onClick(() => {
				applyReplace(opts.editor, opts.result, opts.hadSelection);
				this.close();
			});

		new ButtonComponent(actions).setButtonText("Insert below").onClick(() => {
			applyInsertBelow(opts.editor, opts.result);
			this.close();
		});

		new ButtonComponent(actions).setButtonText("Copy").onClick(() => {
			applyCopy(opts.result);
			this.close();
		});

		new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
