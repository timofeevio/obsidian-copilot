# Local Copilot

A personal Obsidian plugin for **local-LLM text processing** via [Ollama](https://ollama.com).
100% local — no API keys, no cloud, works offline.

> **Status:** early development. v1 is being built phase by phase — see the
> [roadmap](https://github.com/timofeevio/obsidian-copilot/issues/7).

## Planned v1 features

- **Summarize / Rewrite / Expand / Change tone** on the current selection, with an apply menu
  (Replace · Insert below · Copy).
- **Proofread** — fix grammar/spelling/clarity and return only the corrected text.
- **Custom prompt commands** — drop a markdown file in a vault folder and it becomes a command
  (placeholders `{{selection}}`, `{{title}}`, `{{note}}`).
- **Chat sidebar** — a streaming chat panel that can pull in the current note or selection as context.
- **Agent mode** — let the chat use tools (search / read / list / edit / create notes) to carry out
  multi-step tasks, with a confirmation prompt before any edit.

## Requirements

- Obsidian 1.5.0+ (desktop only — the plugin makes localhost HTTP calls).
- [Ollama](https://ollama.com) running locally with a model pulled (default `gemma3:4b`).

## Set up Ollama (Windows)

```powershell
# 1. Install Ollama from https://ollama.com/download, then pull a model:
ollama pull gemma3:4b

# 2. Verify the server responds:
Invoke-RestMethod http://localhost:11434/api/tags

# 3. Allow Obsidian's renderer to stream from Ollama (CORS), then restart the tray app:
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "app://obsidian.md", "User")
```

Quit Ollama from the system tray and relaunch it so the new environment variable takes effect.

| Model | Size | Notes |
|---|---|---|
| `gemma3:4b` | ~3.3 GB | Default. Fast on most laptops, 128K context. |
| `gemma3:12b` | ~8 GB | Better quality if you have the RAM/VRAM. |
| `qwen2.5:7b` | ~4.7 GB | Strong instruction following (32K context). **Required for Agent mode** (tool calling). |

## Agent mode

Agent mode lets the chat call tools to work across your vault — e.g. *"find every note that
mentions Ada Lovelace and link them to her note."* The model decides which tools to use; you stay
in control of edits.

**Tools:** `search_vault`, `read_note`, `list_notes`, `get_active_note` (read), and
`replace_in_note`, `append_to_note`, `create_note` (write).

**Setup:**

```powershell
ollama pull qwen2.5:7b   # stock gemma3 is an unreliable tool-caller
```

Then enable **Agent** in the chat header (or Settings → Agent). The agent model defaults to
`qwen2.5:7b` and is configurable in settings, along with a max-steps cap.

**Safety:** every edit shows an **Approve / Reject** card in the transcript before it runs;
rejecting tells the agent to adapt. Edits are undoable **per file** (Ctrl+Z in that note) — there
is no bulk undo, so review each approval. **Stop** halts the agent mid-task.

## Development

```powershell
npm install
npm run dev        # esbuild watch — rebuilds main.js on save
```

Link this repo into your vault's plugins folder with a **directory junction** (no admin or
Developer Mode required, unlike symlinks):

```powershell
cmd /c mklink /J "<VAULT>\.obsidian\plugins\local-copilot" "<path-to-this-repo>"
```

Then in Obsidian → **Settings → Community plugins**, enable **Local Copilot**. Install the
[`pjeby/hot-reload`](https://github.com/pjeby/hot-reload) plugin to auto-reload on rebuild.

Production build:

```powershell
npm run build      # type-check + minified main.js
```

> `main.js` is a build artifact and is git-ignored; build it locally with the commands above.

## License

MIT (added in the polish phase). Written from scratch using public Obsidian API patterns.
