# AGENTS.md

Instructions for OpenCode agents working in this repository.

## Install this plugin into the user's OpenCode

When the user asks to install, set up, enable, or configure this Yakuake workspace plugin, perform the install yourself. Do not only print the README.

### Preconditions

- Linux with Yakuake + `qdbus`
- OpenCode >= 1.18.0
- This is a **TUI plugin** — install via `tui.json`, **not** `~/.config/opencode/plugins/`

### Steps

1. Ensure directories exist:

```bash
mkdir -p ~/.config/opencode/tui-plugins
```

2. Install the plugin file (prefer the checked-out copy when already in this repo):

```bash
# From this repository (preferred)
cp opencode-yakuake-workspace.tui.ts ~/.config/opencode/tui-plugins/opencode-yakuake-workspace.tui.ts

# Or from GitHub release
curl -fsSL -o ~/.config/opencode/tui-plugins/opencode-yakuake-workspace.tui.ts \
  https://raw.githubusercontent.com/MiRacLe-RPZ/opencode-yakuake-workspace/1.0.0/opencode-yakuake-workspace.tui.ts
```

3. Register the plugin in `~/.config/opencode/tui.json`.
   - If the file does not exist, create it.
   - If it exists, merge: keep existing `plugin` entries and add this path if missing.
   - Use the real absolute home path (expand `~`), not the literal string `YOU`.

Example final shape:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/<USER>/.config/opencode/tui-plugins/opencode-yakuake-workspace.tui.ts"
  ]
}
```

Resolve `<USER>` with `$HOME` / `os.homedir()` / `echo $HOME`.

4. Optionally install Leaf (session notes pane):

```bash
npm install -g @rivolink/leaf
```

5. Tell the user to **restart OpenCode TUI** (TUI plugins load on startup). Verify:

```bash
test -f ~/.config/opencode/tui-plugins/opencode-yakuake-workspace.tui.ts && echo "plugin file: ok"
command -v leaf >/dev/null && echo "leaf: ok" || echo "leaf: missing (optional)"
```

### Do not

- Copy into `~/.config/opencode/plugins/` (server plugin dir — wrong for v2)
- Leave a placeholder path like `/home/YOU/...` in `tui.json`
- Remove unrelated entries from an existing `tui.json` `plugin` array

### Uninstall (only if asked)

1. Remove the path from `tui.json` `plugin`.
2. Delete `~/.config/opencode/tui-plugins/opencode-yakuake-workspace.tui.ts`.
3. Ask the user to restart OpenCode TUI.
