import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Agent-driven generation loop.
 *
 * The agent (pi by default) runs the copypage skill's Generate step: read the
 * capture snapshot, write a React repro. Verification is injected by the host
 * (captureRepro → diffSnapshots → writeReport → decide), so the agent only
 * ever sees concrete diff entries — the same loop that was run manually to
 * reach 1:1 locally.
 */

export interface GenerationMetrics {
  ssim: number
  pixelDiffPct: number
  dynamicAreaPct?: number
}

export interface GenerationEntry {
  severity: number
  element: string
  property: string
  expected: string
  actual: string
}

export interface GenerationVerifyResult {
  metrics: GenerationMetrics
  decision: string
  topEntries: GenerationEntry[]
}

export interface AgentTurnOptions {
  /** working directory for the agent process; the repo root that holds `skill/` */
  repoRoot: string
  /** stable per-generation session id: every round reopens the same context */
  sessionId: string
  model?: string
  /** agent executable, default "pi" */
  command?: string
  /** extra args inserted before the generated args (tests use a stub script) */
  commandArgs?: string[]
  /** directory containing SKILL.md, default <repoRoot>/skill */
  skillPath?: string
  timeoutMs?: number
  extraEnv?: Record<string, string>
  onProgress: (message: string) => void
}

export interface AgentTurnResult {
  text: string
  exitCode: number
  durationMs: number
}

export interface GenerationLoopOptions extends Omit<AgentTurnOptions, 'onProgress'> {
  origDir: string
  reproDir: string
  viewports: number[]
  maxRounds?: number
  onProgress: (message: string) => void
  /** host-owned verification; called after every agent round */
  verify: (round: number) => Promise<GenerationVerifyResult>
}

export interface GenerationLoopResult {
  rounds: { round: number; decision: string; metrics: GenerationMetrics }[]
  finalDecision: string
}

const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_MAX_ROUNDS = 8

function summarizeToolArgs(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (toolName === 'bash' && typeof a.command === 'string') return a.command.replace(/\s+/g, ' ').slice(0, 140)
  for (const key of ['path', 'file', 'file_path', 'pattern', 'query']) {
    if (typeof a[key] === 'string') return String(a[key]).slice(0, 140)
  }
  const json = JSON.stringify(a)
  return json.length > 140 ? `${json.slice(0, 137)}…` : json
}

/**
 * One agent invocation in JSON mode (`pi --mode json`). Streams assistant text
 * and tool activity through onProgress; resolves when the process exits.
 */
export async function runAgentTurn(prompt: string, opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const command = opts.command ?? 'pi'
  const args = [
    ...(opts.commandArgs ?? []),
    '--mode',
    'json',
    '--approve',
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.skillPath ? ['--skill', opts.skillPath] : []),
    '--session-id',
    opts.sessionId,
    prompt,
  ]

  const started = Date.now()
  const child = spawn(command, args, {
    cwd: opts.repoRoot,
    env: { ...process.env, ...(opts.extraEnv ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let text = ''
  let stderrTail = ''
  let settled = false
  let timedOut = false
  let flushTimer: NodeJS.Timeout | undefined
  let pending = ''

  const flush = () => {
    const chunk = pending.trim()
    pending = ''
    if (chunk) opts.onProgress(`[agent] ${chunk.slice(-600)}`)
  }

  const timer = setTimeout(() => {
    timedOut = true
    opts.onProgress(`[agent] timeout after ${Math.round((opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS) / 1000)}s — killing`)
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  }, opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS)
  timer.unref()

  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      // non-JSON stdout should not happen in json mode; surface it anyway
      if (trimmed) opts.onProgress(`[agent] ${trimmed.slice(0, 300)}`)
      return
    }
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }
    switch (event.type) {
      case 'session':
        opts.onProgress(`[agent] session ${String(event.id).slice(0, 12)} started`)
        break
      case 'tool_execution_start': {
        flush()
        const toolName = String(event.toolName ?? 'tool')
        opts.onProgress(`[agent] ${toolName}: ${summarizeToolArgs(toolName, event.args)}`)
        break
      }
      case 'message_update': {
        const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
        if (inner?.type === 'text_delta' && inner.delta) {
          text += inner.delta
          pending += inner.delta
          if (pending.length > 2000) flush()
          else if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = undefined
              flush()
            }, 3000)
            flushTimer.unref()
          }
        }
        break
      }
      case 'agent_settled':
        settled = true
        flush()
        break
      default:
        break
    }
  })

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-8000)
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`cannot start agent "${command}": ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (flushTimer) clearTimeout(flushTimer)
      flush()
      resolve(code ?? -1)
    })
  })

  const durationMs = Date.now() - started
  if (timedOut) throw new Error(`agent turn timed out after ${Math.round(durationMs / 1000)}s`)
  if (exitCode !== 0) {
    const detail = stderrTail.trim().split('\n').slice(-6).join('\n') || `exit code ${exitCode}`
    throw new Error(`agent exited with ${exitCode}: ${detail}`)
  }
  if (!settled) {
    opts.onProgress('[agent] process exited without agent_settled (continuing)')
  }
  return { text, exitCode, durationMs }
}

export function buildGeneratePrompt(opts: {
  origDir: string
  reproDir: string
  viewports: number[]
  taskDir: string
}): string {
  return `你是 CopyPage 生成器。按 copypage skill 的 Generate 阶段工作，所有路径均为绝对路径。

输入快照：${opts.origDir}
  - screenshots/<width>.png 原始截图（含 dynamic.json 标记的实时区域）
  - dom/<width>.json 元素树 + computed styles，可用 npx tsx packages/core/src/query.ts <snapshotDir> --viewport <w> --region <id> 按需取数
  - meta.json / adaptive.json / interactions.json / states/ / assets/
目标工程：${opts.reproDir}（请在此创建 Vite + React 工程，视口 ${opts.viewports.join(' / ')}）

要求（与 skill 硬规则一致）：
1. 先骨架轮（区域布局），再组件填充轮；几何值用精确像素/arbitrary value，颜色用精确 hex/rgba，禁止档位取整
2. 优先使用 orig/assets 原文件；缺失资产用 screenshots 对应区域裁切
3. 交互态（states/）落地为 hover/focus/active；interactions.json 的交互实现真实行为
4. 实时数据区域（dynamic.json）只需结构与静态样式正确，文案用快照值即可
5. 完成后确保工程可以 npm run build 产出 dist/（不要提交需联网安装的依赖；本仓库根目录已有 node_modules，可使用相对引用或内联样式）

只做生成，不要运行 diff；验证由服务端执行。完成后用一句话总结你创建了哪些文件。`
}

export function buildFixPrompt(opts: {
  round: number
  reproDir: string
  entries: GenerationEntry[]
  metrics: GenerationMetrics
}): string {
  const list = opts.entries
    .map(
      (e, i) =>
        `${i + 1}. [severity ${e.severity}] ${e.property} @ ${e.element}\n   原站: ${e.expected}\n   还原: ${e.actual}`,
    )
    .join('\n')
  return `第 ${opts.round} 轮修复。当前指标：SSIM ${opts.metrics.ssim}，像素差异 ${opts.metrics.pixelDiffPct}%${
    opts.metrics.dynamicAreaPct !== undefined ? `，动态区域 ${opts.metrics.dynamicAreaPct}%` : ''
  }。

请只修复以下差异（按 severity 降序），不要重构无关部分：
${list}

工程目录：${opts.reproDir}
修改后保持可构建。只做修改，不要运行 diff；验证由服务端执行。`
}

/**
 * Drive the loop: agent turn → host verification → next prompt with the top
 * diff entries. Stops on pass / stagnant-stop / cap-stop or round limit.
 */
export async function runGenerationLoop(opts: GenerationLoopOptions): Promise<GenerationLoopResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS
  const rounds: GenerationLoopResult['rounds'] = []
  let last: GenerationVerifyResult | undefined

  for (let round = 1; round <= maxRounds; round++) {
    const prompt =
      round === 1
        ? buildGeneratePrompt({
            origDir: opts.origDir,
            reproDir: opts.reproDir,
            viewports: opts.viewports,
            taskDir: opts.repoRoot,
          })
        : buildFixPrompt({
            round,
            reproDir: opts.reproDir,
            entries: last?.topEntries ?? [],
            metrics: last?.metrics ?? { ssim: 0, pixelDiffPct: 100 },
          })

    opts.onProgress(`[generate] round ${round}/${maxRounds}: agent working`)
    const turn = await runAgentTurn(prompt, {
      ...opts,
      extraEnv: {
        ...(opts.extraEnv ?? {}),
        COPYPAGE_ROUND: String(round),
        COPYPAGE_ORIG_DIR: opts.origDir,
        COPYPAGE_REPRO_DIR: opts.reproDir,
      },
    })
    opts.onProgress(`[generate] round ${round}: agent finished in ${Math.round(turn.durationMs / 1000)}s`)

    const result = await opts.verify(round)
    rounds.push({ round, decision: result.decision, metrics: result.metrics })
    opts.onProgress(
      `[generate] round ${round}: ssim ${result.metrics.ssim} · pixelDiff ${result.metrics.pixelDiffPct}% → ${result.decision}`,
    )
    last = result

    if (result.decision === 'pass' || result.decision === 'stagnant-stop' || result.decision === 'cap-stop') {
      return { rounds, finalDecision: result.decision }
    }
  }

  return { rounds, finalDecision: 'cap-stop' }
}
