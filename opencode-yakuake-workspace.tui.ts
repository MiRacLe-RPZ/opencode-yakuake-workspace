import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { $ } from "bun"
import { basename } from "node:path"

// Yakuake workspace for OpenCode TUI:
//   - companion panes (bottom shell + right leaf notes)
//   - tab rename from session/git/project
//   - desktop notifications when Yakuake is hidden
//   - leaf symlink follows api.route.current session switches
//
// TUI-only: server plugins cannot see session navigation.

const MAX_LEN = 40
const PLACEHOLDER_TAB = "New session"
const SKIP_TITLES = new Set([
  "",
  "new session",
  "new session...",
  "untitled",
  "untitled session",
])

const SHRINK_BOTTOM_PX = 99999
const COMPANION_HEIGHT_PX = 120
const NOTES_PANE_WIDTH_PX = 400
const ROUTE_POLL_MS = 500
const SERVICE = "yakuake-workspace"

function shorten(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim()
  t = t.replace(/^(feature|bugfix|hotfix|fix|chore|ops|wip)[/._-]+/i, "")
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN - 1).replace(/\s+\S*$/, "").trimEnd() + "…"
  return t
}

function isMeaningfulTitle(title: string | undefined): boolean {
  if (!title) return false
  return !SKIP_TITLES.has(title.trim().toLowerCase())
}

async function yakuakeAvailable(): Promise<boolean> {
  const r = await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.activeSessionId`
    .quiet()
    .nothrow()
  return r.exitCode === 0 && /^\d+$/.test(String(r.stdout).trim())
}

async function activeYakuakeSessionId(): Promise<string | undefined> {
  const r = await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.activeSessionId`
    .quiet()
    .nothrow()
  const sid = String(r.stdout).trim()
  return /^\d+$/.test(sid) ? sid : undefined
}

async function sendNotification(title: string, message: string, yakuakeTabId: string) {
  const visibleR = await $`qdbus org.kde.yakuake /yakuake/MainWindow_1 Get org.qtproject.Qt.QWidget visible`
    .quiet()
    .nothrow()
  const isVisible = String(visibleR.stdout).trim() === "true"

  const currentR = !isVisible
    ? { stdout: yakuakeTabId }
    : await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.activeSessionId`.quiet().nothrow()

  const currentId = String(currentR.stdout).trim()
  if (!isVisible || currentId !== yakuakeTabId) {
    await $`notify-send -i ai.opencode.desktop "${title}" "${message}"`.quiet().nothrow()
  }
}

async function gitBranch(cwd: string): Promise<string | undefined> {
  const r = await $`git -C ${cwd} rev-parse --abbrev-ref HEAD`.quiet().nothrow()
  if (r.exitCode !== 0) return undefined
  const b = String(r.stdout).trim()
  if (!b || b === "HEAD") return undefined
  return b
}

async function setTabTitle(title: string): Promise<boolean> {
  const short = shorten(title)
  if (!short) return false
  const sid = await activeYakuakeSessionId()
  if (!sid) return false
  const res = await $`qdbus org.kde.yakuake /yakuake/tabs org.kde.yakuake.setTabTitle ${sid} ${short}`
    .quiet()
    .nothrow()
  return res.exitCode === 0
}

async function terminalIdsForSession(yakuakeTabId: string): Promise<string[]> {
  const termsR = await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.terminalIdsForSessionId ${yakuakeTabId}`
    .quiet()
    .nothrow()
  return String(termsR.stdout)
    .trim()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
}

async function removeTerminals(ids: string[]) {
  for (const t of ids) {
    await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.removeTerminal ${t}`
      .quiet()
      .nothrow()
  }
}

async function updateSymlink(yakuakeTabId: string, sessionId: string) {
  const symlinkPath = `/tmp/opencode-leaf-${yakuakeTabId}.md`
  const target = `/tmp/opencode-${sessionId}.md`
  const cur = await $`readlink ${symlinkPath}`.quiet().nothrow()
  if (String(cur.stdout).trim() === target) return false
  await $`rm -f ${symlinkPath}`.quiet().nothrow()
  await $`touch ${target}`.quiet().nothrow()
  await $`ln -s ${target} ${symlinkPath}`.quiet().nothrow()
  return true
}

/** Open companion panes when the tab is still unsplit. Right (leaf) needs sessionId. */
async function ensureCompanionSplit(
  dir: string,
  sessionId: string | undefined,
  sessionTitle: string | undefined,
  yakuakeTabId: string,
): Promise<{ bottom?: string; right?: string }> {
  const currentId = await activeYakuakeSessionId()
  if (currentId !== yakuakeTabId) return {}

  const terms = await terminalIdsForSession(yakuakeTabId)
  if (terms.length === 0) return {}

  const topId = terms[0]!
  let bottomId: string | undefined

  if (terms.length === 1) {
    const splitR = await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.splitTerminalTopBottom ${topId}`
      .quiet()
      .nothrow()
    bottomId = String(splitR.stdout).trim()
    if (/^\d+$/.test(bottomId)) {
      await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.tryGrowTerminalBottom ${topId} ${SHRINK_BOTTOM_PX}`
        .quiet()
        .nothrow()
      await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.tryGrowTerminalTop ${bottomId} ${COMPANION_HEIGHT_PX}`
        .quiet()
        .nothrow()
      const cd = `cd -- ${$.escape(dir)}`
      await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.runCommandInTerminal ${bottomId} ${cd}`
        .quiet()
        .nothrow()
    } else {
      bottomId = undefined
    }
  }

  if (!sessionId) return { bottom: bottomId }

  // Already split (e.g. bottom exists) — still try to add right pane if only 1–2 terms
  // and we don't yet have a leaf. If terms already include a right pane from a prior
  // session, caller is responsible for cleanup before calling this.
  const afterBottom = await terminalIdsForSession(yakuakeTabId)
  const splitFrom = afterBottom[0]!
  if (afterBottom.length >= 3) {
    await updateSymlink(yakuakeTabId, sessionId)
    return { bottom: bottomId }
  }

  const sessionFile = `/tmp/opencode-${sessionId}.md`
  const rightSplitR = await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.splitTerminalLeftRight ${splitFrom}`
    .quiet()
    .nothrow()
  const rightId = String(rightSplitR.stdout).trim()
  if (!/^\d+$/.test(rightId)) {
    // Surface split failure for debugging (exit/stderr often empty on qdbus)
    console.error(
      `[yakuake-workspace] right split failed from terminal ${splitFrom}: stdout=${JSON.stringify(String(rightSplitR.stdout))} code=${rightSplitR.exitCode}`,
    )
    return { bottom: bottomId }
  }

  await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.tryGrowTerminalRight ${splitFrom} ${SHRINK_BOTTOM_PX}`
    .quiet()
    .nothrow()
  await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.tryGrowTerminalLeft ${rightId} ${NOTES_PANE_WIDTH_PX}`
    .quiet()
    .nothrow()

  await $`touch ${sessionFile}`.quiet().nothrow()
  const isEmpty = await $`test -s ${sessionFile} && echo no || echo yes`.quiet().nothrow()
  if (String(isEmpty.stdout).trim() === "yes") {
    const header =
      sessionTitle && sessionTitle !== "New session" && sessionTitle !== "New session..."
        ? sessionTitle
        : sessionId
    await $`echo "# ${header}" > ${sessionFile}`.quiet().nothrow()
    await $`echo "" >> ${sessionFile}`.quiet().nothrow()
  }

  const symlinkPath = `/tmp/opencode-leaf-${yakuakeTabId}.md`
  await $`rm -f ${symlinkPath}`.quiet().nothrow()
  await $`touch ${sessionFile}`.quiet().nothrow()
  await $`ln -s ${sessionFile} ${symlinkPath}`.quiet().nothrow()

  const leafCmd = `leaf -w --width=35 ${symlinkPath}`
  await $`qdbus org.kde.yakuake /yakuake/sessions org.kde.yakuake.runCommandInTerminal ${rightId} ${leafCmd}`
    .quiet()
    .nothrow()

  return { bottom: bottomId, right: rightId }
}

function routeSessionId(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sid = route.params?.sessionID
  return typeof sid === "string" ? sid : undefined
}

function projectDir(api: TuiPluginApi): string {
  return api.state.path.directory || api.state.path.worktree || process.cwd()
}

/** Subagent / child sessions have parentID — ignore for Yakuake UI. */
function isChildSession(info: { parentID?: string } | undefined): boolean {
  return Boolean(info?.parentID)
}

const tui: TuiPlugin = async (api) => {
  if (!process.env.KONSOLE_DBUS_SESSION) {
    await api.client.app
      .log({ body: { service: SERVICE, level: "info", message: "disabled: not running inside Yakuake/Konsole" } })
      .catch(() => {})
    return
  }

  if (!(await yakuakeAvailable())) {
    await api.client.app
      .log({ body: { service: SERVICE, level: "info", message: "disabled: Yakuake not available" } })
      .catch(() => {})
    return
  }

  const yakuakeTabId = await activeYakuakeSessionId()
  if (!yakuakeTabId) return

  const log = async (message: string) => {
    await api.client.app
      .log({ body: { service: SERVICE, level: "info", message } })
      .catch(() => {})
  }

  await log("tui plugin active")

  let lastTitle = ""
  let lastSessionId: string | undefined
  let sessionFile: string | undefined
  const sessionsWithTerminals = new Map<string, string[]>()
  let splitBusy = false

  const restoreExisting = async (sessionId: string) => {
    const terms = await terminalIdsForSession(yakuakeTabId)
    if (terms.length > 1) {
      const companions = terms.slice(1)
      sessionsWithTerminals.set(sessionId, companions)
      await log(`restored ${companions.length} existing terminals for session ${sessionId}`)
    }
  }

  const updateSessionHeader = async (title: string) => {
    if (!sessionFile) return
    await $`sed -i '1s/^#.*/# ${title}/' ${sessionFile}`.quiet().nothrow()
  }

  const rename = async (candidate: string | undefined, why: string) => {
    if (!candidate) return
    const short = shorten(candidate)
    if (!short || short === lastTitle) return
    if (await setTabTitle(short)) {
      lastTitle = short
      await log(`tab → "${short}" (${why})`)
      await updateSessionHeader(short)
    }
  }

  const fromProject = async (dir: string) => {
    const branch = await gitBranch(dir)
    return branch || basename(dir)
  }

  const trySplit = async (dir: string, why: string, sessionId?: string, sessionTitle?: string) => {
    if (splitBusy) return
    splitBusy = true
    try {
      const terms = await terminalIdsForSession(yakuakeTabId)

      // Full layout: main + bottom + right — only retarget symlink.
      if (terms.length >= 3) {
        if (sessionId) {
          if (lastSessionId && lastSessionId !== sessionId) {
            sessionsWithTerminals.delete(lastSessionId)
          }
          sessionsWithTerminals.set(sessionId, terms.slice(1))
          await updateSymlink(yakuakeTabId, sessionId)
          sessionFile = `/tmp/opencode-${sessionId}.md`
        }
        await log(`companion split skipped (${why}) - layout complete (${terms.length} terms)`)
        lastSessionId = sessionId
        return
      }

      // Bottom exists but leaf missing (common: plugin-init before session id).
      // Fall through to ensureCompanionSplit which adds the right pane when sessionId is set.
      if (terms.length === 2 && !sessionId) {
        await log(`companion split skipped (${why}) - waiting for session id to create leaf`)
        return
      }

      const panes = await ensureCompanionSplit(dir, sessionId, sessionTitle, yakuakeTabId)
      if (panes.bottom || panes.right) {
        const created: string[] = []
        if (panes.bottom) created.push(panes.bottom)
        if (panes.right) created.push(panes.right)
        // Re-read so tracking includes any previously existing bottom.
        const after = await terminalIdsForSession(yakuakeTabId)
        if (sessionId && after.length > 1) {
          sessionsWithTerminals.set(sessionId, after.slice(1))
        } else if (sessionId && created.length > 0) {
          sessionsWithTerminals.set(sessionId, created)
        }
        if (sessionId) sessionFile = `/tmp/opencode-${sessionId}.md`
        await log(`companion split → bottom=${panes.bottom} right=${panes.right} (${why}) terms=${after.length}`)
      } else {
        await log(`companion split skipped (${why}) terms=${terms.length} session=${sessionId ?? "-"}`)
      }
      lastSessionId = sessionId ?? lastSessionId
    } finally {
      splitBusy = false
    }
  }

  // Initial session from route (preferred) — no OPENCODE_PID parsing needed.
  const initSid = routeSessionId(api)
  if (initSid) {
    await restoreExisting(initSid)
    const info = api.state.session.get(initSid)
    const title = info?.title
    const dir = info?.directory || projectDir(api)
    // Restart into an existing session: prefer real title, else project/branch.
    if (isMeaningfulTitle(title)) await rename(title, "plugin-init/title")
    else await rename(await fromProject(dir), "plugin-init/project")
    await trySplit(dir, "plugin-init", initSid, title)
  } else {
    // /new or home before a session id exists (debug shows n/a).
    await rename(PLACEHOLDER_TAB, "plugin-init/pending-new")
    await trySplit(projectDir(api), "plugin-init")
  }

  // Follow TUI session navigation (covers /sessions and /new — no bus event).
  let routeBusy = false
  const onRouteTick = async () => {
    if (routeBusy) return
    const sid = routeSessionId(api)

    // Pending /new: session is n/a until the first message. Rename tab only —
    // keep leaf on the previous session file (no pending notes file).
    if (!sid) {
      if (lastSessionId !== undefined) {
        await rename(PLACEHOLDER_TAB, "route/pending-new")
        await log(`pending new session — leaf kept on previous file (was ${lastSessionId})`)
        lastSessionId = undefined
      } else if (lastTitle !== PLACEHOLDER_TAB) {
        await rename(PLACEHOLDER_TAB, "route/pending-new")
      }
      return
    }

    // Ignore subagent child sessions if they ever become the route target.
    if (isChildSession(api.state.session.get(sid))) return

    const terms = await terminalIdsForSession(yakuakeTabId)
    const leafMissing = terms.length < 3
    if (sid === lastSessionId && !leafMissing) {
      const changed = await updateSymlink(yakuakeTabId, sid)
      if (changed) await log(`symlink → /tmp/opencode-${sid}.md`)
      return
    }

    routeBusy = true
    try {
      const info = api.state.session.get(sid)
      const dir = info?.directory || projectDir(api)
      const title = info?.title
      if (sid !== lastSessionId) {
        // Real id just appeared (often after first message) or switched session.
        // Placeholder titles → "New session", not project/branch (leaf updates below).
        if (isMeaningfulTitle(title)) await rename(title, "route/session")
        else await rename(PLACEHOLDER_TAB, "route/new-session")
      }
      await trySplit(dir, leafMissing && sid === lastSessionId ? "route.leaf-retry" : "route.change", sid, title)
      const changed = await updateSymlink(yakuakeTabId, sid)
      if (changed) await log(`symlink → /tmp/opencode-${sid}.md`)
    } finally {
      routeBusy = false
    }
  }

  await onRouteTick()
  const timer = setInterval(() => void onRouteTick(), ROUTE_POLL_MS)

  const unsubs = [
    api.event.on("session.created", async (event) => {
      const info = event.properties.info
      if (isChildSession(info)) return
      const dir = info.directory || projectDir(api)
      if (isMeaningfulTitle(info.title)) await rename(info.title, "session.created/title")
      else await rename(PLACEHOLDER_TAB, "session.created/new")
      await trySplit(dir, "session.created", info.id, info.title)
    }),
    api.event.on("session.updated", async (event) => {
      const info = event.properties.info
      if (isChildSession(info)) return
      // Only rename when title becomes meaningful — keep "New session" until then.
      if (isMeaningfulTitle(info.title)) await rename(info.title, "session.updated/title")
      await trySplit(info.directory || projectDir(api), "session.updated", info.id, info.title)
    }),
    api.event.on("vcs.branch.updated", async (event) => {
      const branch = event.properties.branch
      // Don't overwrite the pending "New session" tab with a branch name.
      if (branch && lastTitle !== PLACEHOLDER_TAB) await rename(branch, "vcs.branch.updated")
    }),
    api.event.on("session.error", async (event) => {
      const sessionID = event.properties.sessionID
      if (sessionID && isChildSession(api.state.session.get(sessionID))) return
      const error = event.properties.error
      await sendNotification("OpenCode error", String((error as { message?: string } | undefined)?.message || "Session error"), yakuakeTabId)
    }),
    api.event.on("session.idle", async (event) => {
      if (isChildSession(api.state.session.get(event.properties.sessionID))) return
      await sendNotification("OpenCode waiting", "Session idle — awaiting your input", yakuakeTabId)
    }),
    api.event.on("session.deleted", async (event) => {
      const info = event.properties.info
      if (isChildSession(info)) return
      const deletedSessionId = info?.id ?? event.properties.sessionID
      if (!deletedSessionId) return
      const terms = sessionsWithTerminals.get(deletedSessionId) || []
      await removeTerminals(terms)
      if (terms.length > 0) {
        await log(`cleaned ${terms.length} terminals for deleted session ${deletedSessionId}`)
      }
      sessionsWithTerminals.delete(deletedSessionId)
      if (lastSessionId === deletedSessionId) lastSessionId = undefined
    }),
    api.event.on("permission.asked", async (event) => {
      const permission = event.properties.permission || "unknown"
      const patterns = event.properties.patterns?.join("\n") || ""
      await sendNotification(
        "OpenCode needs your attention",
        `Permission request: ${permission}${patterns ? `\n${patterns}` : ""}`,
        yakuakeTabId,
      )
    }),
    api.event.on("permission.v2.asked", async (event) => {
      const action = event.properties.action || "unknown"
      const resources = event.properties.resources?.join("\n") || ""
      await sendNotification(
        "OpenCode needs your attention",
        `Permission request: ${action}${resources ? `\n${resources}` : ""}`,
        yakuakeTabId,
      )
    }),
  ]

  api.lifecycle.onDispose(async () => {
    clearInterval(timer)
    for (const u of unsubs) u()
    const allTerms: string[] = []
    for (const terms of sessionsWithTerminals.values()) allTerms.push(...terms)
    await removeTerminals(allTerms)
    if (allTerms.length > 0) await log(`cleaned ${allTerms.length} terminals on dispose`)
    sessionsWithTerminals.clear()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "yakuake-workspace",
  tui,
}

export default plugin
