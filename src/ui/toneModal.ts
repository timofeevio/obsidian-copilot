import { App, SuggestModal } from "obsidian";

const TONES = [
	"Formal",
	"Casual",
	"Concise",
	"Friendly",
	"Professional",
	"Confident",
	"Persuasive",
	"Academic",
	"Plain / simple",
	"Enthusiastic",
];

/** Pick a tone preset for "Change tone…", or type a custom one. */
export class ToneModal extends SuggestModal<string> {
	constructor(
		app: App,
		private onPick: (tone: string) => void,
	) {
		super(app);
		this.setPlaceholder("Pick a tone — or type your own and press Enter");
	}

	getSuggestions(query: string): string[] {
		const q = query.trim().toLowerCase();
		if (!q) return TONES;
		const matches = TONES.filter((t) => t.toLowerCase().includes(q));
		// Let the user enter an arbitrary tone that isn't in the preset list.
		if (!TONES.some((t) => t.toLowerCase() === q)) return [query.trim(), ...matches];
		return matches;
	}

	renderSuggestion(tone: string, el: HTMLElement): void {
		el.createEl("div", { text: tone });
	}

	onChooseSuggestion(tone: string): void {
		this.onPick(tone);
	}
}
