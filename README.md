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
    <a href="./README.zh-CN.md">简体中文</a>
  </p>
</div>

> [!TIP]
> **Built around the todo.** Ticktodo gathers the AI sessions for the same todo across tools.<br />
> Come back without recalling or digging — see where you left off and continue in one click.

Currently supports **pi**; more tools such as WorkBuddy are on the way.

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

**Requirements**: macOS. Session aggregation and **Continue** require `pi >= 1.3.0` (use `TICK_PI_PATH` to point to the executable).

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

- **Resume an existing session**: open pi's TUI in the terminal with the session's own cwd; context continues exactly where it left off.
- **Start a new session**: pick a project and write the first message; by default it is copied to the clipboard for review, or you can send it directly in settings.
- If a directory no longer exists, you get a clear warning and fall back to your home directory — never a silent run in the wrong place.

### Import past sessions

Past sessions on this Mac are listed by project. Pick one to **create a todo** or **open it directly** — no manual cleanup needed.

### Chat inside the panel

The built-in chat can reuse pi's credentials or use any OpenAI-compatible endpoint (custom provider). The model can also call `create_todo` / `list_todos`, so you can capture follow-ups while you chat.

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
| **pi** | ✅ Supported | ✅ | Terminal TUI | Requires `pi >= 1.3.0` |
| WorkBuddy (China) | Planned | — | Deep link | PRD and read-only testing done; adapter not released |
| WorkBuddy AI (International) | Planned | — | Deep link | Separate adapter with the same storage core |
| Claude Code / Cursor | Later | — | — | Claude Code uses local JSONL; Cursor format TBD |

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
  <sub>Made for macOS · Your data stays on your computer · <a href="https://ticktodo.cc">ticktodo.cc</a></sub>
</div>
