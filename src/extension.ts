/**
 * Editor glue. Everything with an `import * as vscode` lives here or in
 * `settings.ts`, which is what keeps the bridge's logic testable in plain node.
 */
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { Bridge } from './bridge/bridge.js'
import { bridgePaths, ensureBridgeDirs } from './bridge/paths.js'
import { asLedgerPort, type LedgerPort } from './bridge/api.js'
import { ControlServer } from './bridge/control-server.js'
import { createCoreCatalogSource } from './bridge/core-catalog.js'
import type { McpTool } from './bridge/mcp.js'
import { readBridgeSettings, readMainRegistry, mainExtensionInstalled, MAIN_EXT_ID } from './bridge/settings.js'
import { drainActiveRequests } from './bridge/ingest.js'

const RESTART_DEBOUNCE_MS = 1500
/** Deactivate must not hold the extension host hostage, unlike a deliberate restart. */
const SHUTDOWN_DRAIN_BUDGET_MS = 5000
/**
 * Bridge settings the harness reads at boot, so changing one means a restart.
 * Everything else (`drainTimeoutSeconds` is read per stop, `ingestIntervalSeconds`
 * just re-arms a timer, `autoStart` gates starting) must never cut a live turn.
 */
const BRIDGE_RESTART_KEYS = ['defaultModelId', 'titleModel', 'titleMaxTokens', 'compactionModel', 'compactionMaxTokens', 'dshVersion'] as const

let output: vscode.LogOutputChannel | undefined

function log(): { info(m: string): void; warn(m: string): void; error(m: string): void } {
  output ??= vscode.window.createOutputChannel('DeepSeek Harness Bridge', { log: true })
  return output
}

/**
 * The ledger port, re-resolved per pass: the main extension may activate after
 * us, or be updated/reloaded, and a port captured once at activation would keep
 * pointing at a stale or absent export forever.
 */
function resolveLedgerPort(): LedgerPort | undefined {
  const ext = vscode.extensions.getExtension(MAIN_EXT_ID)
  if (!ext) return undefined
  try {
    return asLedgerPort(ext.isActive ? ext.exports : undefined)
  } catch (err) {
    log().warn(`could not read the vLLM-Copilot API: ${(err as Error).message}`)
    return undefined
  }
}

/**
 * Show the harness UI per `dsh-bridge.openIn`. `embedded` (default) uses the
 * editor's own browser view: VS Code 1.140 removed the Simple Browser
 * extension (its `simpleBrowser.show` is gone from the command registry,
 * certified on the extension-host rail) and shipped a built-in Browser area,
 * so the probe tries the new door first and keeps the old one for older
 * builds and VSCodium. `external`, or either embedded door missing, ends in
 * the system browser, said out loud. A chromeless webview panel was built
 * and retired the same day (0.0.10/0.0.11): the harness authenticates its
 * browser session with a `SameSite=Strict` HttpOnly cookie, and Chromium
 * never sends Strict cookies from a cross-site frame, so the iframe only
 * ever reached the server's 401 text. The Browser area shows the page
 * top-level, where the cookie works. Do not re-propose the iframe.
 * The token-bearing URL only ever crosses as a command argument.
 */
async function openHarnessUrl(url: string): Promise<void> {
  const mode = vscode.workspace.getConfiguration('dsh-bridge').get<string>('openIn', 'embedded')
  if (mode === 'embedded') {
    const commands = await vscode.commands.getCommands(true)
    const door = commands.includes('workbench.action.browser.open')
      ? 'workbench.action.browser.open'
      : commands.includes('simpleBrowser.show')
        ? 'simpleBrowser.show'
        : undefined
    if (door) {
      await vscode.commands.executeCommand(door, url)
      return
    }
    void vscode.window.showInformationMessage(
      'This editor build provides no embedded browser view, so the harness opens in the system browser instead.',
    )
  }
  await vscode.env.openExternal(vscode.Uri.parse(url))
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = log()
  const version = String(context.extension.packageJSON.version ?? '0.0.0')
  const paths = bridgePaths(context.globalStorageUri.fsPath)
  ensureBridgeDirs(paths)

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90)
  status.command = 'dshBridge.open'
  context.subscriptions.push(status)

  // The editor control channel: the harness's MCP client dials this loopback
  // server to reach the editor tools. Token per activation, handed to the
  // harness ONLY through the generated overlay row; never logged.
  const controlToken = randomUUID()
  let control: ControlServer | undefined
  let controlStart: Promise<string> | undefined
  function ensureControl(): Promise<string> {
    control ??= new ControlServer({
      token: controlToken,
      activeDir: paths.active,
      mcp: { tools: () => editorTools(), serverInfo: { name: 'vllmc-editor', version } },
      log: logger,
    })
    controlStart ??= control.listen().catch((err: Error) => {
      controlStart = undefined
      throw err
    })
    return controlStart
  }

  let harnessTerminal: vscode.Terminal | undefined
  interface TerminalResult {
    output: string
    exitCode: number | null
    timedOut: boolean
  }
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === harnessTerminal) harnessTerminal = undefined
    }),
  )
  async function runInEditorTerminal(command: string, requestedTimeout: number | undefined, signal: AbortSignal): Promise<TerminalResult> {
    if (!harnessTerminal || !vscode.window.terminals.includes(harnessTerminal)) {
      harnessTerminal = vscode.window.createTerminal({ name: 'DSH Harness' })
    }
    const shell = harnessTerminal.shellIntegration
    if (!shell) throw new Error('the editor terminal has no shell integration yet; retry in a moment')
    const execution = shell.executeCommand(command)
    // show(false): the command and its live output become visible without
    // stealing focus from whatever the user is reading.
    harnessTerminal.show(false)
    const timeoutMs = requestedTimeout ?? 120_000
    const deadline = Date.now() + timeoutMs
    // The exit code only exists on the end event (documented contract); the
    // read stream says nothing about it.
    const ended = new Promise<number | undefined>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          resolve(event.exitCode)
          sub.dispose()
        }
      })
    })
    const iterator = execution.read()[Symbol.asyncIterator]()
    let output = ''
    let timedOut = false
    // The abort promise is built once for the whole command: registering a
    // listener per read iteration would pile up one permanent listener per
    // output chunk on a signal that outlives them all.
    let settleAborted: (value: 'aborted') => void = () => {}
    const aborted = new Promise<'aborted'>((resolve) => {
      settleAborted = resolve
    })
    signal.addEventListener('abort', () => settleAborted('aborted'), { once: true })
    if (signal.aborted) settleAborted('aborted')
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const next: IteratorResult<string> | 'timeout' | 'aborted' = await Promise.race([
        iterator.next(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining)
        }),
        aborted,
      ]).finally(() => {
        // One live timer per command, not one orphan per chunk.
        if (timer) clearTimeout(timer)
      })
      if (next === 'timeout') {
        timedOut = true
        break
      }
      if (next === 'aborted') throw new Error('the harness closed the control channel while the command was still running')
      if (next.done) break
      output += next.value
    }
    let exitCode: number | null = null
    if (!timedOut) {
      // The end event trails the stream by a moment; a lost race means "no
      // exit code", which the tool reports honestly rather than guessing 0.
      const grace = await Promise.race([
        ended,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ])
      exitCode = grace ?? null
    }
    return { output, exitCode, timedOut }
  }

  /** Trims tool output to a size a model context can swallow without revolt. */
  function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n[... clipped, ${text.length - max} more characters]` : text
  }

  /** Resolves a model-supplied path against the first workspace folder. */
  function resolveEditorPath(p: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    return path.isAbsolute(p) || !root ? p : path.resolve(root, p)
  }

  const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
    json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', css: 'css',
    html: 'html', yml: 'yaml', yaml: 'yaml', toml: 'toml', c: 'c', h: 'cpp',
    cc: 'cpp', hpp: 'cpp', java: 'java', cs: 'csharp', sh: 'shellscript', ps1: 'powershell',
  }

  /**
   * The editor tools the harness sees through MCP. Read lazily on every
   * `tools/list` and every call, so the tool bodies always close over live
   * editor state instead of a snapshot taken at activation.
   */
  function editorTools(): McpTool[] {
    return [
      {
        name: 'editor_state',
        description:
          'Report what the user has open in the editor right now: workspace folders, every visible tab, and the active file with its selection text. Call this before editing so work lands where the user is looking.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
          const lines: string[] = []
          const folders = vscode.workspace.workspaceFolders ?? []
          lines.push(`workspace folders: ${folders.length ? folders.map((f) => f.uri.fsPath).join(' | ') : '(none: this window has no open folder)'}`)
          const tabs: string[] = []
          for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
              const input = tab.input as { uri?: { fsPath?: string }; terminal?: { name?: string } } | undefined
              const where = input?.uri?.fsPath ?? (input?.terminal ? `terminal: ${input.terminal.name ?? 'unnamed'}` : tab.label ?? 'unknown tab')
              tabs.push(`${group.isActive && tab.isActive ? '* ' : '  '}${where}`)
            }
          }
          lines.push(tabs.length ? `open tabs (* = active):\n${tabs.join('\n')}` : 'open tabs: (none)')
          const editor = vscode.window.activeTextEditor
          if (editor) {
            const sel = editor.selection
            lines.push(`active: ${editor.document.uri.fsPath} (${editor.document.lineCount} lines, ${editor.document.languageId}, ${editor.document.isDirty ? 'unsaved changes' : 'saved'})`)
            if (!sel.isEmpty) lines.push(`selection L${sel.start.line + 1}-L${sel.end.line + 1}:\n${clip(editor.document.getText(sel), 4000)}`)
            else lines.push(`cursor at L${sel.active.line + 1}`)
          } else {
            lines.push('active: no text editor is focused')
          }
          return { text: lines.join('\n') }
        },
      },
      {
        name: 'editor_diagnostics',
        description:
          'Read the editor problem panel: the errors and warnings VS Code reports for one file or for the whole window. Call this after editing code; it is the same feedback the user sees in real time.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to report on (absolute, or relative to the first workspace folder). Omit to summarize every file with recorded problems.' },
          },
          additionalProperties: false,
        },
        run: async (args) => {
          const severity = ['error', 'warning', 'info', 'hint']
          const format = (d: vscode.Diagnostic) =>
            `  L${d.range.start.line + 1} [${severity[d.severity] ?? 'unknown'}] ${d.message.split('\n')[0]}${d.source ? ` (${d.source})` : ''}`
          const file = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined
          if (file) {
            const target = vscode.Uri.file(resolveEditorPath(file))
            const found = vscode.languages.getDiagnostics(target)
            return { text: found.length ? `${target.fsPath}:\n${found.map(format).join('\n')}` : `${target.fsPath}: no problems recorded.` }
          }
          const entries = vscode.languages.getDiagnostics().filter(([, list]) => list.length > 0)
          if (entries.length === 0) return { text: 'the problem panel is empty: no diagnostics recorded in this window.' }
          const errorsOf = (list: vscode.Diagnostic[]) => list.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length
          const files = entries
            .sort((a, b) => errorsOf(b[1]) - errorsOf(a[1]))
            .slice(0, 40)
            .map(([uri, list]) => `${uri.fsPath}: ${errorsOf(list)} error(s), ${list.length - errorsOf(list)} other\n${list.slice(0, 5).map(format).join('\n')}`)
          return { text: `${entries.length} file(s) carry diagnostics (first 40, error-heavy first):\n${files.join('\n')}` }
        },
      },
      {
        name: 'editor_open_file',
        description: 'Open a file in the editor and focus it, optionally jumping to a 1-based line. Use it after edits so the user sees what changed.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to open (absolute, or relative to the first workspace folder).' },
            line: { type: 'number', description: '1-based line to reveal and place the cursor on.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        run: async (args) => {
          const file = typeof args.path === 'string' ? resolveEditorPath(args.path.trim()) : ''
          if (!file) throw new Error('path is required')
          const doc = await vscode.workspace.openTextDocument(file)
          const shown = await vscode.window.showTextDocument(doc)
          if (typeof args.line === 'number' && Number.isFinite(args.line) && args.line >= 1) {
            const row = Math.min(Math.trunc(args.line) - 1, Math.max(doc.lineCount - 1, 0))
            const target = new vscode.Range(row, 0, row, 0)
            shown.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
            shown.selection = new vscode.Selection(target.start, target.start)
          }
          return { text: `opened ${doc.uri.fsPath} for the user.` }
        },
      },
      {
        name: 'editor_open_diff',
        description:
          'Show a diff editor: the content you provide on the left, the file as it is on disk on the right. Use it before overwriting a file you did not read in full, so the human sees the change instead of discovering it.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File on disk (right side of the diff).' },
            before: { type: 'string', description: 'The content to show on the left, typically the previous version you are replacing.' },
          },
          required: ['path', 'before'],
          additionalProperties: false,
        },
        run: async (args) => {
          if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('path is required')
          if (typeof args.before !== 'string') throw new Error('before (string) is required')
          const file = resolveEditorPath(args.path.trim())
          const language = LANGUAGE_BY_EXTENSION[path.extname(file).replace('.', '')] ?? 'plaintext'
          const left = await vscode.workspace.openTextDocument({ content: args.before, language })
          const right = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
          await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${path.basename(file)}: provided vs on disk`)
          return { text: `diff of ${file} is open for the user to review.` }
        },
      },
      {
        name: 'editor_notify',
        description: 'Put a notification in the editor with optional buttons, and report which button the user clicked (or that it was dismissed). For milestones worth a glance, not for chatter.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The notification text.' },
            buttons: { type: 'array', items: { type: 'string' }, description: 'Up to 3 button labels.' },
          },
          required: ['message'],
          additionalProperties: false,
        },
        run: async (args) => {
          const message = typeof args.message === 'string' ? args.message.trim() : ''
          if (!message) throw new Error('message is required')
          const buttons = Array.isArray(args.buttons) ? args.buttons.filter((b): b is string => typeof b === 'string').slice(0, 3) : []
          const picked = await vscode.window.showInformationMessage(message, ...buttons)
          return { text: picked ? `the user clicked: ${picked}` : 'the notification expired or was dismissed without a choice.' }
        },
      },
      {
        name: 'editor_ask',
        description:
          'Ask the user a question IN THE EDITOR and wait for the answer: a pick list when options are given, otherwise a text box. The user may dismiss it; if so, state your best assumption instead of asking again.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'One clear question.' },
            options: { type: 'array', items: { type: 'string' }, description: 'Choices to offer as a pick list (omit for a free-form answer).' },
            secret: { type: 'boolean', description: 'Obscure the typed answer (for anything credential-shaped).' },
          },
          required: ['question'],
          additionalProperties: false,
        },
        run: async (args) => {
          const question = typeof args.question === 'string' ? args.question.trim() : ''
          if (!question) throw new Error('question is required')
          const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === 'string').slice(0, 10) : []
          const answer = options.length
            ? await vscode.window.showQuickPick(options, { title: 'The harness asks', placeHolder: question, ignoreFocusOut: true })
            : await vscode.window.showInputBox({ title: 'The harness asks', prompt: question, password: args.secret === true, ignoreFocusOut: true })
          if (answer === undefined) {
            return { text: 'the user dismissed the question without answering. State your assumption and proceed; do not fire the same question again.', isError: true }
          }
          return { text: `the user answered: ${answer}` }
        },
      },
      {
        name: 'run_terminal',
        description:
          'Run a shell command in the user VS Code editor terminal and return its combined output and exit code. Prefer this for anything the user should watch or interrupt (builds, tests, git): it runs visibly in the editor. The command runs in the terminal current directory, so cd within the command when it must run elsewhere. Keep timeoutMs generous for builds.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command line to run in the editor terminal.' },
            timeoutMs: { type: 'number', description: 'Give up waiting after this many milliseconds (default 120000).' },
          },
          required: ['command'],
          additionalProperties: false,
        },
        run: async (args, signal) => {
          const command = typeof args.command === 'string' ? args.command.trim() : ''
          if (!command) throw new Error('command must be a non-empty string')
          const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : undefined
          const result = await runInEditorTerminal(command, timeoutMs, signal)
          const note = result.timedOut ? '\n[timed out; the command may still be running in the editor terminal]' : ''
          return { text: `\`\`\`console\n${clip(result.output.replace(/\n+$/, ''), 60_000)}\n\`\`\`\n[exit code: ${result.exitCode ?? 'unknown'}]${note}` }
        },
      },
    ]
  }

  /**
   * The staged core's catalog surface, through the same loader the node rails
   * build, so `bridge:check` exercises the code this window actually runs.
   * The PROFILE's installed copy, not vendor/: pnpm resolved the core's bare
   * dependencies beside it, while the vendor staging has no node_modules and
   * would fail on the core's own imports.
   */
  const catalogSource = createCoreCatalogSource({
    entryFile: () => path.join(paths.profileModules, 'vllm-copilot-core', 'core', 'index.js'),
    log: logger,
  })

  const bridge = new Bridge({
    extensionRoot: context.extensionPath,
    extensionVersion: version,
    paths,
    log: logger,
    dshVersion: () => readBridgeSettings().dshVersion || readBundledPin(),
    registry: () => {
      const registry = readMainRegistry()
      // A configured personality only reaches the harness through the
      // snapshot's `personalityFile`, so resolve each model's file here.
      // Relative or missing paths are skipped: a guess at a personality path
      // is how the wrong persona gets attached to a model.
      const personalityFiles: Record<string, string> = {}
      for (const model of registry.models) {
        const file = model.systemMessageReplacementsFile
        if (typeof file === 'string' && file.trim() && path.isAbsolute(file) && existsSync(file)) {
          personalityFiles[model.id] = file
        }
      }
      return {
        ...registry,
        personalityFiles,
        fixEmptyToolParameters: vscode.workspace.getConfiguration('vllm-copilot').get<boolean>('fixEmptyToolParameters'),
      }
    },
    choices: () => {
      const s = readBridgeSettings()
      return {
        defaultModelId: s.defaultModelId || undefined,
        title: s.title,
        compaction: s.compaction,
        drainTimeoutMs: s.drainTimeoutSeconds * 1000,
      }
    },
    ledgerPort: resolveLedgerPort,
    mainExtension: () => {
      const ext = vscode.extensions.getExtension(MAIN_EXT_ID)
      return ext ? { path: ext.extensionPath, version: String(ext.packageJSON.version ?? 'unknown') } : undefined
    },
    editorWorkspaceFolder: () => {
      const [first, second] = vscode.workspace.workspaceFolders ?? []
      if (!first) return undefined
      if (second) {
        logger.warn(`the window has multiple root folders; the harness workspace is the first one ("${first.name}")`)
      }
      return first.uri.fsPath
    },
    controlEndpoint: () => {
      const url = control?.url
      return url ? { url, token: controlToken } : undefined
    },
    coreCatalog: catalogSource,
    onUnexpectedExit: (info) => {
      render()
      void vscode.window
        .showWarningMessage(
          `The DeepSeek Harness exited on its own (code ${info.code}, signal ${info.signal}). The bridge log has the last output.`,
          'Show Log',
          'Restart Harness',
        )
        .then((choice) => {
          if (choice === 'Show Log') void output?.show()
          if (choice === 'Restart Harness') void guardedStart()
        })
    },
  })

  function readBundledPin(): string {
    // The certified version lives in exactly one file, the same one the node
    // rails read. The setting overrides it; nothing else duplicates it. An
    // unreadable pin aborts the start: quietly booting whatever npm calls
    // "latest" would run an uncertified dsh against overlays certified
    // against a different composition, the exact drift the pin exists to stop.
    try {
      const raw = readFileSync(path.join(context.extensionPath, 'config', 'dsh.json'), 'utf8')
      const pinned = String((JSON.parse(raw) as { pinned?: string }).pinned ?? '')
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pinned)) {
        throw new Error(`config/dsh.json carries no exact pinned version (got ${JSON.stringify(pinned)})`)
      }
      return pinned
    } catch (err) {
      const message = (err as Error).message
      logger.error(`the bundled dsh pin is unreadable: ${message}`)
      throw new Error(`cannot start the harness: the certified dsh pin in config/dsh.json is unreadable (${message}); refusing to fall back to an uncertified "latest"`)
    }
  }

  // Declared before render(): the pill reads this promise to show the
  // starting state, and render() runs at activation, before any start.
  let starting: Promise<string | undefined> | undefined

  function render(): void {
    const active = bridge.activeRequests()
    // The palette reflects reality. Start hides itself while the harness runs,
    // and nothing offers "Open" before there is a URL to open.
    void vscode.commands.executeCommand('setContext', 'dshBridge.running', bridge.supervisor.running)
    void vscode.commands.executeCommand('setContext', 'dshBridge.ownerAvailable', mainExtensionInstalled())
    if (bridge.supervisor.running) {
      status.text = `$(radio-tower) DSH${active ? ` $(zap)${active}` : ''}`
      status.tooltip = new vscode.MarkdownString(
        [
          `**DeepSeek Harness: running**`,
          '',
          `URL: \`${bridge.supervisor.url ? bridge.supervisor.url.replace(/\?.*$/, '?<token redacted>') : 'unknown'}\``,
          `In-flight requests: ${active}`,
          bridge.preparedInfo ? `dsh ${bridge.preparedInfo.dshVersion}, core ${bridge.preparedInfo.coreVersion}` : '',
          bridge.preparedInfo ? `privacy rows disabled: ${bridge.preparedInfo.rowsDisabled}` : '',
          '',
          'Click to open the harness.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      status.backgroundColor = undefined
      // Re-arm the click on every transition INTO running. The command was
      // set to "start" while stopped (below), and a stale one made the
      // running pill execute a no-op Start: the tooltip said "click to
      // open" and the click opened nothing, silently, because starting an
      // already-running harness returns its URL. Every field render claims
      // must be written by every branch that displays it.
      status.command = 'dshBridge.open'
      return
    }
    if (starting) {
      // A cold first run installs the dsh runtime and the profile with pnpm
      // before anything can listen; two-plus minutes of "stopped" reads as
      // death. Say what is happening instead of gaslighting the user.
      status.text = '$(sync~spin) DSH: starting'
      status.tooltip = new vscode.MarkdownString([
        '**DeepSeek Harness: starting**',
        '',
        'The first run after an install downloads and installs the harness once.',
        'That takes a few minutes; later starts take seconds.',
        'Progress: "DeepSeek Bridge" output channel.',
      ].join('\n'))
      status.command = 'dshBridge.start'
      status.backgroundColor = undefined
      return
    }
    if (!mainExtensionInstalled()) {
      status.text = '$(debug-disconnect) DSH: no vLLM-Copilot'
      status.tooltip = 'Install the vLLM-Copilot extension to point the DeepSeek Harness at your own models. Until then the bridge does nothing.'
      status.command = 'workbench.view.extensions'
      return
    }
    status.text = '$(debug-disconnect) DSH: stopped'
    status.tooltip = 'The DeepSeek Harness is not running. Click to start it.'
    status.command = 'dshBridge.start'
  }
  render()
  status.show()

  async function guardedStart(): Promise<string | undefined> {
    if (bridge.supervisor.running && bridge.supervisor.url) return bridge.supervisor.url
    // Best effort: a harness whose control channel failed to start still
    // runs; its agent simply never sees the editor tools (the MCP client
    // cannot dial a dead endpoint and mounts nothing).
    await ensureControl().catch((err: Error) => logger.warn(`editor control channel did not start: ${err.message}`))
    starting ??= bridge
      .start()
      .catch((err: Error) => {
        logger.error(`harness failed to start: ${err.message}`)
        void vscode.window.showErrorMessage(`DeepSeek Harness failed to start: ${err.message}`, 'Show Log').then((choice) => {
          if (choice === 'Show Log') void output?.show()
        })
        return undefined
      })
      .finally(() => {
        starting = undefined
        render()
      })
    // The pill only learns about the flight if we paint it now; the finally
    // above repaints when it lands.
    render()
    return starting
  }

  /**
   * Registry edits must reach the harness, and the harness reads its config at
   * boot, so an edit means a restart. The restart drains first: a user who
   * tweaks a model while a turn is in flight must not watch that turn die.
   *
   * Auto-restart is the spawning window's job alone. Every window hears the
   * same configuration event, and a borrowing window that restarted would
   * tree-kill the harness it does not own, while the concurrent stop and
   * DSH_HOME sweep of two windows can cut down a freshly respawned harness
   * mid-boot. The owner window hears the same event and performs the swap.
   */
  let pendingRestart: NodeJS.Timeout | undefined
  function scheduleRestart(reason: string): void {
    if (!bridge.supervisor.running) return
    if (pendingRestart) clearTimeout(pendingRestart)
    pendingRestart = setTimeout(() => {
      void (async () => {
        if (bridge.supervisor.adopted) {
          logger.info(`not restarting (${reason}): this window borrows the harness; the window that spawned it applies the change`)
          return
        }
        logger.info(`restarting the harness: ${reason}`)
        const settings = readBridgeSettings()
        const preview = await drainActiveRequests(paths.active, 0)
        if (preview.remaining > 0 && settings.drainTimeoutSeconds > 0) {
          void vscode.window.showInformationMessage(
            `Waiting for ${preview.remaining} harness request(s) to finish before applying this change.`,
          )
        }
        await bridge.restart()
        render()
      })()
    }, RESTART_DEBOUNCE_MS)
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('vllm-copilot.servers') ||
        event.affectsConfiguration('vllm-copilot.models') ||
        event.affectsConfiguration('vllm-copilot.fixEmptyToolParameters')
      ) {
        scheduleRestart('the vLLM-Copilot registry changed')
        return
      }
      if (!event.affectsConfiguration('dsh-bridge')) return
      // Only boot-time settings justify draining and restarting a live
      // session. The ingest cadence re-arms here so the setting takes effect
      // without a restart, and switching autoStart on may start a stopped
      // harness; none of these may cut an in-flight turn.
      if (event.affectsConfiguration('dsh-bridge.ingestIntervalSeconds')) armIngestTimer()
      if (event.affectsConfiguration('dsh-bridge.autoStart') && readBridgeSettings().autoStart && !bridge.supervisor.running && !starting) {
        void guardedStart()
      }
      if (BRIDGE_RESTART_KEYS.some((key) => event.affectsConfiguration(`dsh-bridge.${key}`))) {
        scheduleRestart('a bridge setting changed')
      }
    }),
  )

  // Ingestion runs on a timer rather than on a file watch: the outbox is a
  // directory the harness writes into from another process, and polling a
  // directory is portable in a way that reliable inotify events are not.
  let ingestTimer: NodeJS.Timeout | undefined
  let ingesting = false
  async function ingestPass(): Promise<void> {
    if (ingesting) return
    ingesting = true
    try {
      const outcome = await bridge.ingest()
      if (outcome.accepted || outcome.duplicate || outcome.malformed) {
        logger.info(
          `usage ingest: ${outcome.accepted} new, ${outcome.duplicate} duplicate, ${outcome.preReset} before last reset` +
            `${outcome.malformed ? `, ${outcome.malformed} quarantined` : ''}` +
            `${outcome.rejected ? `, ${outcome.rejected} refused` : ''}` +
            `${outcome.deferred ? `, ${outcome.deferred} deferred` : ''}`,
        )
      } else if (outcome.deferred && !ingestTimerWarned) {
        ingestTimerWarned = true
        logger.warn(
          `${outcome.deferred} harness request(s) are waiting for a vLLM-Copilot version that accepts them. ` +
            'Update vLLM-Copilot to see this traffic in your dashboard totals.',
        )
        void vscode.window
          .showWarningMessage(
            'Harness traffic is not reaching your dashboard totals: this vLLM-Copilot version does not accept external usage yet. Update it to fix this.',
            'Show Log',
          )
          .then((choice) => {
            if (choice === 'Show Log') void output?.show()
          })
      }
    } catch (err) {
      logger.warn(`usage ingest pass failed: ${(err as Error).message}`)
    } finally {
      ingesting = false
      render()
    }
  }
  let ingestTimerWarned = false

  function armIngestTimer(): void {
    const seconds = Math.max(2, readBridgeSettings().ingestIntervalSeconds)
    if (ingestTimer) clearInterval(ingestTimer)
    ingestTimer = setInterval(() => void ingestPass(), seconds * 1000)
    ingestTimer.unref?.()
  }
  armIngestTimer()
  void ingestPass()

  // Registered before any early return below: activation can bail out early
  // (no vLLM-Copilot, empty registry) and a timer armed before that would
  // otherwise outlive the extension with nothing left to clear it.
  context.subscriptions.push({
    dispose: () => {
      if (ingestTimer) clearInterval(ingestTimer)
      if (pendingRestart) clearTimeout(pendingRestart)
      control?.close()
    },
  })

  /** What the status bar cannot hold: versions, handoff health, queue depth.
   *  Never a URL with its token and never a server id built from a hostname. */
  async function showReport(): Promise<void> {
    const info = bridge.preparedInfo
    const lines = [
      `Harness: ${bridge.supervisor.running ? 'running' : 'stopped'}`,
      `dsh version: ${info?.dshVersion ?? 'not prepared'}`,
      `vLLM-Copilot core: ${info?.coreVersion ?? 'not staged'}`,
      `snapshot version: ${info?.snapshotVersion ?? 'not written'}`,
      `privacy rows disabled: ${info?.rowsDisabled ?? 'unknown'}`,
      `in-flight requests: ${bridge.activeRequests()}`,
      `pending usage records: ${readdirSync(paths.outbox).filter((n) => n.endsWith('.json')).length}`,
      `editor control channel: ${control?.url ? `listening on ${control.url}` : 'not started'}`,
      `ledger handoff: ${resolveLedgerPort() ? 'available' : 'not offered by this vLLM-Copilot version'}`,
      '',
      'Harness URL tokens and server ids are never shown here.',
    ]
    const choice = await vscode.window.showInformationMessage(lines.join('  \n'), 'Show Log')
    if (choice === 'Show Log') output?.show()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dshBridge.start', async () => {
      await guardedStart()
      render()
    }),
    vscode.commands.registerCommand('dshBridge.stop', async () => {
      const result = await bridge.stop()
      if (!result.drained) {
        void vscode.window.showWarningMessage(`${result.remaining} in-flight harness request(s) were cut by this stop.`)
      }
      render()
    }),
    vscode.commands.registerCommand('dshBridge.restart', async () => {
      await bridge.restart()
      render()
    }),
    vscode.commands.registerCommand('dshBridge.open', async () => {
      const url = bridge.supervisor.url ?? (await guardedStart())
      if (!url) return
      // The URL carries the UI's auth token, so it is opened programmatically
      // and never printed to a log or a notification a user might paste.
      await openHarnessUrl(url)
    }),
    vscode.commands.registerCommand('dshBridge.showLogs', async () => {
      output?.show()
    }),
    vscode.commands.registerCommand('dshBridge.report', () => showReport()),
  )

  // The main extension is expected but not required: with it absent the harness
  // would have no models to offer, so the bridge stays dark and says why once,
  // instead of failing on every start or nagging on every window.
  if (!mainExtensionInstalled()) {
    logger.warn('vLLM-Copilot is not installed; the bridge stays idle and the harness is not launched')
    void vscode.window
      .showWarningMessage(
        'The DeepSeek Harness Bridge needs the vLLM-Copilot extension. Without it, dsh has no models to offer and the bridge does nothing.',
        'Install vLLM-Copilot',
        'Show Log',
      )
      .then(async (choice) => {
        if (choice === 'Install vLLM-Copilot') await vscode.commands.executeCommand('extension.open', MAIN_EXT_ID)
        if (choice === 'Show Log') output?.show()
      })
    return
  }

  // Activate the main extension so its exports (the ledger handoff) are there
  // before the first ingest pass instead of after it.
  try {
    await vscode.extensions.getExtension(MAIN_EXT_ID)?.activate()
  } catch (err) {
    logger.warn(`activating vLLM-Copilot failed: ${(err as Error).message}`)
  }

  const registry = readMainRegistry()
  if (registry.models.length === 0) {
    logger.warn('the vLLM-Copilot registry has no models; the harness is not launched')
    void vscode.window
      .showInformationMessage('Add a server and a model in vLLM-Copilot settings, then start the DeepSeek Harness.', 'Open vLLM-Copilot Settings', 'Start Harness')
      .then((choice) => {
        if (choice === 'Open vLLM-Copilot Settings') void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:system-sciences.vllm-copilot vllm-copilot')
        if (choice === 'Start Harness') void guardedStart()
      })
    return
  }

  if (readBridgeSettings().autoStart) await guardedStart()
  render()

  context.subscriptions.push({
    // Deactivate is best effort: it does not run at all when the host dies,
    // which is what the start-time reap of detached survivors is for.
    dispose: () => {
      // A borrowed harness belongs to a window that is still open: closing
      // this one must leave it, its pid record, and its detached servers
      // running. Only the window that spawned the harness may end it.
      if (bridge.supervisor.adopted) bridge.supervisor.release()
      else void bridge.supervisor.stop({ drainMs: SHUTDOWN_DRAIN_BUDGET_MS })
    },
  })
}

export function deactivate(): void {
  /* the dispose handlers above do the shutdown work */
}
