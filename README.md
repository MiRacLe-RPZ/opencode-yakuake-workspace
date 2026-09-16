# opencode-yakuake-workspace

A plugin for [OpenCode](https://opencode.ai) that integrates with **Yakuake** (KDE drop-down terminal) to provide a dedicated workspace with companion terminals and session-aware management.

![Yakuake Workspace](https://img.shields.io/badge/Yakuake-Workspace-blue)

## What it does

This plugin enhances your OpenCode experience in Yakuake by:

- **Auto-creating companion terminals** on session start
  - Bottom pane (~120px): Shell with project directory
  - Right pane (~400px): Leaf text editor for session notes
- **Session-aware terminal management**
  - Terminals are tied to specific OpenCode sessions
  - Automatic cleanup when switching sessions
  - No duplicate terminals on repeated events
- **Desktop notifications** when Yakuake is hidden
  - Permission requests
  - Session errors
  - Idle state (awaiting user input)
- **Automatic tab renaming** based on session context
  - Session title, git branch, or project name

## Installation

> This is a **TUI plugin** (`tui.json`), not a server plugin (`plugins/`). Do not place it under `~/.config/opencode/plugins/`.

### From GitHub Release (recommended)

1. Download the TUI plugin:

```bash
mkdir -p ~/.config/opencode/tui-plugins
curl -o ~/.config/opencode/tui-plugins/opencode-yakuake-workspace.tui.ts \
  https://raw.githubusercontent.com/MiRacLe-RPZ/opencode-yakuake-workspace/1.0.0/opencode-yakuake-workspace.tui.ts
```

2. Register it in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/YOU/.config/opencode/tui-plugins/opencode-yakuake-workspace.tui.ts"
  ]
}
```

3. (Optional) Install Leaf editor for session notes pane:

```bash
npm install -g @rivolink/leaf
```

4. Restart OpenCode TUI

### From local file

1. Copy the TUI plugin:

```bash
mkdir -p ~/.config/opencode/tui-plugins
cp opencode-yakuake-workspace.tui.ts ~/.config/opencode/tui-plugins/
```

2. Register it in `~/.config/opencode/tui.json` (same as above), then restart OpenCode TUI.

## Requirements

- **OpenCode** >= 1.18.0 (TUI plugin API)
- **Yakuake** (KDE drop-down terminal) — plugin works **only inside Yakuake**
- **Qt D-Bus** utilities (`qdbus` command)
- **Leaf** text editor (`@rivolink/leaf`) — for session notes pane
- **Linux** with KDE Plasma environment

**Note:** This plugin automatically disables if OpenCode is run outside Yakuake/Konsole terminal. It does not run under `opencode serve` / headless.

## Features

### Companion Terminals

When you start OpenCode in Yakuake with a session (e.g., `opencode -s <sessionId>`):

```
┌──────────────────────────────────────────────────────────┐
│                                                      │editable│
│          OpenCode TUI (main terminal)                │ notes  │ 
│                                                      │ (leaf) │
├─────────────────────────────────────────────────┤        │
│        Companion shell (120px height)                │ 400px  │ 
└─────────────────────────────────────────────────┘────────┘
```

### Session Notes

The right pane opens [Leaf](https://github.com/rivolink/leaf) editor with a session-specific notes file:

- File path: `/tmp/opencode-{sessionId}.md`
- Content persists across OpenCode restarts
- Header auto-updates when tab is renamed
- Use for meeting notes, task lists, debugging thoughts

### Smart Terminal Cleanup

- **Session switch**: Old companion terminals are removed, new ones created
- **Session delete**: All companion terminals cleaned up
- **No duplicates**: Companion terminals created only once per session

### Desktop Notifications

Notifications appear when Yakuake is **hidden** (dropdown closed) and OpenCode needs attention:

- **Permission requests**: Bash commands requiring approval
- **Session errors**: Critical errors during execution
- **Idle state**: OpenCode waiting for your input

### Tab Renaming

Yakuake tab title is automatically updated based on:

1. OpenCode session title (if meaningful)
2. Git branch name (e.g., `feature/my-branch`)
3. Project directory name (fallback)

## Configuration

No configuration needed - the plugin works out of the box.

### Optional: Customizing pane sizes

Edit the constants in the plugin source:

```typescript
const COMPANION_HEIGHT_PX = 120    // Bottom pane height
const NOTES_PANE_WIDTH_PX = 400    // Right pane width
const SHRINK_BOTTOM_PX = 99999     // Internal: shrink to minimum
```

## How it works

### Plugin Hooks

- **`plugin init`**: Detects OpenCode session from command line (`-s <sessionId>`), creates companion terminals
- **`session.created`**: Skips if terminals already exist for this session
- **`session.updated`**: Syncs tab title, skips terminal creation
- **`session.deleted`**: Cleans up companion terminals
- **`permission.ask`**: Sends desktop notification if Yakuake hidden
- **`session.error`**: Sends desktop notification if Yakuake hidden
- **`session.idle`**: Sends desktop notification if Yakuake hidden

### Session Detection

The plugin reads the OpenCode session ID from:

1. Parent process command line via `/proc/{PID}/cmdline`
2. Environment variable `OPENCODE_PID`

This works because OpenCode spawns the plugin in a worker process that doesn't inherit CLI arguments directly.

### Terminal Management

- **Bottom pane**: Created via `splitTerminalTopBottom`, resized with `tryGrowTerminalTop`
- **Right pane**: Created via `splitTerminalLeftRight`, resized with `tryGrowTerminalLeft`
- **Cleanup**: Uses `removeTerminal` for old terminals before creating new ones

## Troubleshooting

### Terminals not created

1. Check Yakuake is running: `pgrep yakuake`
2. Check D-Bus access: `qdbus org.kde.yakuake /yakuake/sessions`
3. Check OpenCode was started with `-s <sessionId>`

### Leaf editor not opening

1. Install Leaf: `npm install -g @rivolink/leaf`
2. Check Leaf works: `leaf --version`
3. Plugin will still create bottom pane without Leaf

### Notifications not showing

1. Check Yakuake visibility: `qdbus org.kde.yakuake /yakuake/MainWindow_1 Get org.qtproject.Qt.QWidget visible`
2. Notifications only show when Yakuake is hidden
3. Check `notify-send` works: `notify-send "Test" "Message"`

### Tab not renaming

1. Check session has a meaningful title (not "New session")
2. Git branch detection requires a git repository
3. Tab title updates on `session.created` and `session.updated`

## Development

### Running locally

```bash
# Copy to OpenCode plugins directory
cp opencode-yakuake-workspace.ts ~/.config/opencode/plugins/

# Restart OpenCode
```

### Testing

```bash
# Test plugin loads
bun -e "import('./opencode-yakuake-workspace.ts').then(m => console.log('OK'))"

# Test D-Bus commands
qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.activeSessionId
qdbus org.kde.yakuake /yakuake/MainWindow_1 Get org.qtproject.Qt.QWidget visible
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Credits

- Built with [@opencode-ai/plugin](https://opencode.ai/docs/plugins)
- Uses [Leaf](https://github.com/rivolink/leaf) (`@rivolink/leaf`) for session notes
