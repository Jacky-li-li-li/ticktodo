<div align="center">
  <img src="./site/icon-rounded.png" width="112" alt="Ticktodo" />
  <h1>Ticktodo</h1>
  <p><strong>Every AI session for a todo, at a glance.</strong></p>
  <p>
    <a href="https://github.com/Jacky-li-li-li/ticktodo/releases/latest"><img src="https://img.shields.io/github/v/release/Jacky-li-li-li/ticktodo?label=release&color=111" alt="Release" /></a>
    <img src="https://img.shields.io/badge/platform-macOS-111" alt="macOS" />
    <a href="https://github.com/Jacky-li-li-li/ticktodo/stargazers"><img src="https://img.shields.io/github/stars/Jacky-li-li-li/ticktodo?style=flat&color=111" alt="Stars" /></a>
  </p>
  <p>
    <a href="#install">Install</a> ·
    <a href="#what-it-does">Features</a> ·
    <a href="#supported-tools">Supported tools</a> ·
    <a href="https://ticktodo.cc/">Website</a> ·
    <a href="./README.zh-CN.md">简体中文</a>
  </p>
</div>

> [!TIP]
> **Built around the todo.** Ticktodo gathers the AI sessions for the same todo across tools.<br />
> Come back without recalling or digging — see where you left off and continue in one click.

Currently supports **15 tools**: **pi**, **Claude Code**, **Claude Desktop**, **WorkBuddy (China)**, **WorkBuddy AI (International)**, **Qoder** / **Qoder CN**, **Codex**, **Cline**, **Grok**, **omp**, **Kimi Code**, **OpenCode**, **ZCode** and **DeepSeek Harness** — see the table below. Desktop adapters (both WorkBuddy builds, Claude Desktop, ZCode, DeepSeek Harness) are read-only: they index sessions from local storage and reopen them via deep link. CLI tools either launch a new session in the terminal with a pre-generated id (pi, Claude Code) or open the tool's new session in the terminal with the prompt on the clipboard, so you just press ⌘V + Enter (Codex, Cline, Grok, omp, Kimi Code, OpenCode, Qoder). Ticktodo never sends or binds automatically — sending and importing remain explicit steps in the tool.

## Why Ticktodo

A todo can span several days and many sessions: research in pi, code changes in another tool, then back again a few days later.

Those sessions live in each tool's own storage, disconnected from one another. To continue, you have to rely on memory and dig through tools one by one.

Ticktodo keeps it simple: **a todo is the index; its sessions are bound together beneath it.**

| Your question | Ticktodo's answer |
|---|---|
| How far along is this todo? | Open it and see all related sessions and the latest progress in one place |
| Where did I leave off? | Each session shows its first / last user message and timestamp |
| How do I continue? | Click the slider on the right of a session to resume it in the terminal |
| Where is the data? | Locally in `~/.ticktodo`; the sessions themselves stay in each tool's storage |

## Is Ticktodo for you?

**Yes, if:**

- You move the same todo forward through multiple AI sessions and come back to it days later.
- You're tired of searching chat titles or relying on memory to find "that session".
- You want the index stored locally and backed up by you, without uploading conversation contents anywhere.

**No, if:**

- You only ever use one session and never look back.
- You need an AI chat client, not a session index.

## Install

### One-line install

```bash
curl -fsSL https://ticktodo.cc/install.sh | sh
```

The script downloads the latest release, verifies `SHA256SUMS.txt`, installs to `/Applications` (or `~/Applications` if not writable), and launches the app.

### Manual download

- [GitHub Releases](https://github.com/Jacky-li-li-li/ticktodo/releases/latest):
  `Tick-<version>-arm64.dmg` (Apple Silicon) or `Tick-<version>-x64.dmg` (Intel).
- Install a local build:

```bash
bash scripts/install.sh path/to/Tick.app
```

**Requirements**: macOS. Aggregating and continuing `pi` sessions requires an installed `pi` (use `TICK_PI_PATH` to point to the executable); on first launch Ticktodo installs its `tick-extension` into `~/.pi/agent/extensions/tick/` so pi can prefill new sessions and expose `create_todo`/`list_todos`. Aggregating WorkBuddy sessions requires the corresponding desktop app (**WorkBuddy** or **WorkBuddy AI**) — they are apps, not CLIs; new-session prefill is available whenever the app is installed (no version gating).

After installation, Ticktodo lives in the menu bar and does not appear in the Dock.

## Quick start

1. Click the menu bar icon to open the panel (or press `⌘⌥T`).
2. Type what you need to do and press Enter to create a todo.
3. Open the todo and choose **New session**, or bind an existing one via **Import past sessions**.
4. Later, click the slider on the right of a session (or **Continue**) to go back to it.

| Shortcut | Action |
|---|---|
| `⌘⌥T` | Show / hide the panel |
| `⌘⌥N` | New todo |
| `⌘W` | Hide the panel |
| `⌘Q` | Quit Ticktodo |

## What it does

### One todo, one thread

Title + notes, editable in place with a double click. Check to archive; undo for 3 seconds. Archiving is not deleting — restore anytime.

### Sessions gathered automatically

Sessions are discovered from each tool's storage: tool, project, first user message, last message, and time. Sessions under a todo are grouped by project; if a session file is gone, it is marked "not on this Mac" instead of failing.

### Continue in one click

- **Resume an existing session**: open pi's TUI in the terminal with the session's own cwd; context continues exactly where it left off. For sessions from the WorkBuddy desktop apps, **Continue** deep-links into that session in the app instead.
- **Start a new session**: pick a project and write the first message; by default it is **prefilled into the tool's input box** for you to review and press Enter. Tick **Send directly** next to the primary button to send it immediately for this launch, or change the default in settings.
- If a directory no longer exists, you get a clear warning and fall back to your home directory — never a silent run in the wrong place.

### Import past sessions

Past sessions on this Mac are listed by project. Pick one to **create a todo** or **open it directly** — no manual cleanup needed.

### Chat inside the panel

The built-in chat can reuse pi's credentials or use any OpenAI-compatible endpoint (custom provider). The model can also call `create_todo` / `list_todos`, so you can capture follow-ups while you chat.

### Use MCP from external agents

Once Ticktodo is installed, open **⋯ → Settings → Agent connection (MCP)** and copy the ready-made config for pi, Claude Code, or a generic JSON client. After configuring it once, external agents can create todos, list todos, and link the current conversation to a todo — **Ticktodo does not need to be running**. The MCP server writes directly to your own `~/.ticktodo`.

- Certified and tested: `pi`, WorkBuddy (both editions) for session linking; Claude Code is protocol-compatible.
- All matching happens locally; conversation bodies are never uploaded. You can switch to read-only or disable automatic linking in the same panel.
- Without an installed build, the panel falls back to the repository entry `packages/mcp-server/dist/tick-mcp.mjs`.

### Automatic project discovery

Ticktodo reads the first-line header of each tool's session file to get the real cwd, canonicalizes the path, then rolls it up to the git root. Different subdirectories of the same repository do not explode into multiple projects.

### Always there, never in the way

Lives in the menu bar. The panel is pinned by default, or can auto-hide when it loses focus. Window position and size are remembered.

### Optional usage and export

- Usage is off by default; when enabled, each session shows tokens / cost (shown with `≥` when a provider does not report cost).
- Export "open / all" as JSON + Markdown. The export contains only the index and `filePath`, never conversation contents.

## Supported tools

| Tool | Status | Discovery | Continue | Notes |
|---|---|---|---|---|
| **pi** | ✅ Supported | ✅ | Terminal TUI | Requires an installed `pi` |
| WorkBuddy (China) | ✅ Supported | ✅ | Deep link | Read-only index of the app's local database / session files; requires the WorkBuddy desktop app. Can open a prefilled new-task page; sending/binding still happen in the app |
| WorkBuddy AI (International) | ✅ Supported | ✅ | Deep link | Separate adapter (own identity, same read-only storage core); requires the WorkBuddy AI desktop app. Can open a prefilled new-task page; sending/binding still happen in the app |
| **Claude Code** | ✅ Supported | ✅ | Terminal TUI | Requires the `claude` CLI. New sessions prefill the native `--prefill=` input box (no extension needed); resume uses `--resume <transcript path>`. Reads `~/.claude/projects` (honors `CLAUDE_CONFIG_DIR`) |
| **Qoder** / **Qoder CN** | ✅ Supported | ✅ | Terminal TUI | Two separate adapters (`qoder` / `qoder-cn`). Qoder keeps sessions in Claude Code's own format, so it reuses the same read-only kernel and only has its own identity (`$QODER_CONFIG_DIR` / `$QODERCN_CONFIG_DIR`). Resume uses `qodercli[cn] --resume <id>`; **new session** opens it in the terminal with the prompt on the clipboard (⌘V + Enter; no draft flag exists, and the prompt argument would send immediately) |
| **Codex** | ✅ Supported | ✅ | Terminal TUI | One session may live in several `rollout-*.jsonl` files (same thread id) — all are kept in `SessionSummary.files`. Usage comes from `token_count` totals (input is cache-inclusive, so cache is subtracted). **New session**: opens Codex in the terminal and puts the prompt on the clipboard (Codex has no draft flag; its prompt argument would send immediately) — ⌘V then Enter; nothing is sent automatically |
| **Cline** | ✅ Supported | ✅ | Terminal TUI | Manifest + `messages.json` (rewritten whole). Usage from each assistant message's AI-SDK `metrics`. **New session**: opens Cline in the terminal with the prompt on the clipboard (⌘V + Enter; not sent automatically) |
| **Grok** | ✅ Supported | ✅ | Terminal TUI | One folder per session (`summary.json` + `updates.jsonl`, second-precision timestamps). Subagent sessions are hidden. **New session**: opens Grok in the terminal with the prompt on the clipboard (⌘V + Enter) |
| **omp** | ✅ Supported | ✅ | Terminal TUI | pi's layout, but the first line is a fixed-width `title` record (the session header comes second), and the physical `title` record is the current title (`title_change` is audit history). When the project is your home directory, Tick passes `--allow-home` (otherwise omp moves the session to `/tmp`). **New session**: opens omp in the terminal with the prompt on the clipboard (⌘V + Enter) |
| **Kimi Code** | ✅ Supported | ✅ | Terminal TUI | cwd lives only in `session_index.jsonl` (`state.json` has none); the main transcript is `agents/main/wire.jsonl`, subagents' wires count into the same session. **New session**: opens Kimi Code in the terminal with the prompt on the clipboard (⌘V + Enter) |
| **OpenCode** | ✅ Supported | ✅ | Terminal TUI | Sessions are rows in `opencode.db` (`session` row carries tokens/cost/model), so `filePath` points at the database. Subagent sessions are hidden. Desktop and CLI share the same data and there is no per-client ownership field, so one adapter exposes both entry points (`capabilities.clients`): the desktop entry activates the app, the CLI entry resumes precisely. **New session**: opens OpenCode in the terminal with the prompt on the clipboard (⌘V + Enter) |
| **ZCode** | ✅ Supported | ✅ | — | Same tables as OpenCode, but its `session` rows have no token columns (usage comes from `model_usage`) and it is a desktop app: **no resume**, read-only |
| **DeepSeek Harness** | ✅ Supported | ✅ | — | Sessions are **multi-frame zstd** files (one local file = 23,331 frames), so Tick walks the zstd block headers itself; titles and token totals come from dsh's own projection cache, and listing only decompresses the first few frames (for the header / first message), never the whole transcript. **No way back into a session**: `dsh://` only handles `dsh://open` |
| **Claude Desktop** | ✅ Supported | ✅ | Deep link | Separate adapter. Reads both Desktop's own sessions (`<userData>/claude-code-sessions/…/local_<id>/.claude/projects`, opened via `claude://code/continue`) and the CLI sessions Desktop adopted (same `~/.claude/projects` store, opened via `claude://resume`). Opens `claude://code/new` prefilled. Requires the Claude desktop app and a prior sign-in |
| Cursor | Later | — | — | Storage format TBD |

Adding a tool = implement `AiToolAdapter` in `packages/ai/<tool>` and register it in `main.ts`. No changes to core or UI.

## Data and privacy

Ticktodo is local-first:

- Data lives in `~/.ticktodo` (override with `TICK_HOME`). No account, no cloud.
- When reading tool sessions, only the required metadata is read; session files are never copied and conversation contents are never written to Ticktodo's own database.
- Exported files contain only the index and paths, never conversation contents.
- Panel chat storage is separate from CLI sessions; neither reads the other.

| Directory | Contents | Sync |
|---|---|---|
| `data/` | `todos.json`, `settings.json` | ✅ Safe to sync; losing it means losing your todos |
| `sessions/panel-chat/` | Panel conversation contents | ⚠️ Not recommended |
| `cache/` | Project cache, window position, terminal scripts | ❌ Regenerable; safe to delete |
| `exports/` | Manual JSON / Markdown exports | — |

**Credential policy**: no API keys are stored under `~/.ticktodo`. Keys for a custom provider are encrypted with safeStorage (backed by the system keychain) and stored in the app's userData directory, so they are not carried along when the data directory is synced. The panel treats pi's credentials as read-only — it never writes `auth.json` or takes its lock.

---

<div align="center">
  <sub>Local-first · Your data stays organized on your computer · <a href="https://ticktodo.cc">ticktodo.cc</a></sub>
</div>
