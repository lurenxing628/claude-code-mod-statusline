import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionContextUsage } from 'claude-code'

import type { HudContext, HudEdits, HudSpeedSample, HudTokens } from '../types'
import {
  addSpeedSample,
  countLines,
  countPatch,
  enterLoop,
  HUD_GAPS,
  leaveLoop,
  NO_ACTIVITY,
  recentTps,
  renderCells,
} from './format'

// The statusLine command (~/.claude/session-hud/statusline.js) prints
// the cells in <HUD_DIR>/<session id>.json under the prompt, the model added.
const HUD_DIR = '.claude/session-hud'
const NO_EDITS: HudEdits = { added: 0, removed: 0, files: [] }
const NO_TOKENS: HudTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
const NO_SPEED: HudSpeedSample[] = []
const MAX_FILES = 500
// Shorter streams than this give no meaningful tokens-per-second figure.
const MIN_TPS_MS = 300

const compactAt = atom({ plugin: 'session-hud', key: 'compactAt' } as const, null)
const edits = atom({ plugin: 'session-hud', key: 'edits' } as const, NO_EDITS)
const tokens = atom({ plugin: 'session-hud', key: 'tokens' } as const, NO_TOKENS)
const speed = atom({ plugin: 'session-hud', key: 'speed' } as const, NO_SPEED)
const active = atom({ plugin: 'session-hud', key: 'active' } as const, NO_ACTIVITY)

const toHudContext = (c: SessionContextUsage): HudContext => ({
  tokens: c.tokens ?? null,
  window: c.window,
})

const record = ($: EngineInterface, filePath: string, delta: { added: number; removed: number }) =>
  update($, edits, cur => ({
    added: cur.added + delta.added,
    removed: cur.removed + delta.removed,
    files: cur.files.includes(filePath) ? cur.files : [...cur.files, filePath].slice(-MAX_FILES),
  }))

const addUsage = ($: EngineInterface, usage: ModelUsage) =>
  update($, tokens, cur => ({
    input: cur.input + usage.input_tokens,
    output: cur.output + usage.output_tokens,
    cacheRead: cur.cacheRead + usage.cache_read_input_tokens,
    cacheWrite: cur.cacheWrite + usage.cache_creation_input_tokens,
    requests: cur.requests + 1,
  }))

const refreshCompactAt = async ($: EngineInterface) => {
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    if (breakdown === undefined) return
    const at = breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null
    await update($, compactAt, () => at)
  } catch {
    // Keep the last threshold; the line draws without it.
  }
}

let published = ''
let windowSeen: number | null = null
let compactCheckedAt = 0
let estimate: { at: number; tokens: number | null } = { at: 0, tokens: null }
const ESTIMATE_EVERY_MS = 5000
// A compaction can read the threshold while the engine has none to give (it
// came back off once and stayed so), so it is read again now and then too.
const COMPACT_EVERY_MS = 10_000

// Before the first response there is no reading of the window: the engine's
// local estimate (the one /context draws, no API call) stands in, at most
// every few seconds.
const estimateTokens = async ($: EngineInterface, now: number) => {
  if (now - estimate.at < ESTIMATE_EVERY_MS) return estimate.tokens
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    estimate = { at: now, tokens: breakdown?.totalTokens ?? null }
  } catch {
    estimate = { at: now, tokens: null }
  }
  return estimate.tokens
}

// Renders the cells and writes them for the statusLine command when they
// changed. The context and cost are read from the engine on every pass (what
// the status line itself reads), so they are there as soon as the engine has
// them; the compaction threshold is looked up again when the window changes
// and every few seconds.
const publish = async ($: EngineInterface) => {
  const home = await $.env.get('HOME')
  if (home === undefined) return
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.context.window !== windowSeen || now - compactCheckedAt >= COMPACT_EVERY_MS) {
    windowSeen = usage.context.window
    compactCheckedAt = now
    await refreshCompactAt($)
  }
  let context = toHudContext(usage.context)
  if (context.tokens === null) {
    const tokens = await estimateTokens($, now)
    if (tokens !== null) context = { ...context, tokens, isEstimate: true }
  }
  const cells = renderCells({
    context,
    compactAt: await read($, compactAt),
    cost: usage.cost?.usd ?? null,
    edits: await read($, edits),
    tokens: await read($, tokens),
    tps: recentTps(await read($, speed)),
    active: await read($, active),
    now,
  })
  const path = `${home}/${HUD_DIR}/${await $.session.id()}.json`
  const text = JSON.stringify({ rows: cells, gaps: HUD_GAPS })
  if (`${path}\n${text}` === published) return
  published = `${path}\n${text}`
  await $.fs.write(path, text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    // Right away, so a new session never shows the stdin-only fallback for long.
    $.clock.after(1, () => void publish($))
    $.clock.every(1000, () => void publish($))

    return ran
  })

  on('session.end', async ($, e, next) => {
    const ran = await next(e)
    if (e.reason === 'clear') {
      await update($, edits, () => NO_EDITS)
      await update($, tokens, () => NO_TOKENS)
      await update($, speed, () => NO_SPEED)
      await update($, active, () => NO_ACTIVITY)
    }

    return ran
  })

  // The active clock: the main loop works from turn.start to its
  // turn.complete; a subagent, which raises no turn.start, from its first
  // model request to its turn.complete.
  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    await update($, active, cur => enterLoop(cur, 'main', t))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const t = await $.clock.now()
    await update($, active, cur => leaveLoop(cur, e.agentId ?? 'main', t))

    return next(e)
  })

  // Every model request, subagents' included, adds to the token totals; the
  // TPS figure is over the main loop's last few requests, each timed from its
  // first streamed chunk (the response envelope) to its stop.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const loop = e.agentId
      const t = await $.clock.now()
      await update($, active, cur => enterLoop(cur, loop, t))
    }
    const stream = next(e)
    let firstAt: number | null = null
    let stopAt: number | null = null
    for await (const chunk of stream) {
      if (firstAt === null) firstAt = performance.now()
      if (chunk.kind === 'stop') stopAt = performance.now()
      yield chunk
    }
    const result = await stream.result
    if (result.usage !== null) {
      await addUsage($, result.usage)
      const ms = firstAt !== null && stopAt !== null ? stopAt - firstAt : 0
      if (e.agentId === undefined && ms >= MIN_TPS_MS && result.usage.output_tokens > 0) {
        const sample = { tokens: result.usage.output_tokens, ms }
        await update($, speed, cur => addSpeedSample(cur, sample))
      }
    }

    return result
  })

  // Edits made inside subagents count too: they change the same files.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result.staged !== true) {
      await record($, ran.result.filePath, countPatch(ran.result.structuredPatch))
    }

    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result.staged !== true) {
      const r = ran.result
      const delta =
        r.structuredPatch.length > 0
          ? countPatch(r.structuredPatch)
          : r.type === 'create'
            ? { added: countLines(r.content), removed: 0 }
            : { added: 0, removed: 0 }
      await record($, r.filePath, delta)
    }

    return ran
  })
}
