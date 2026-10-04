import type { HudActive, HudContext, HudEdits, HudSpeedSample, HudTokens } from '../types'

export type HudSnapshot = {
  context: HudContext | null
  compactAt: number | null
  cost: number | null
  edits: HudEdits
  tokens: HudTokens
  tps: number | null
  active: HudActive
  now: number
}

const BAR_CELLS = 20

// Claude Code draws the whole status line dimmed (`<Text dimColor>` around
// it), so every piece here states its own intensity: 22 (normal) first, then a
// bright color. Labels are bright white, figures bold in their own color
// (green/yellow/red where it grades good to bad), separators and the bar's
// empty cells light gray.
const ansi = (code: string) => (text: string) => (text === '' ? '' : `\x1b[22;${code}m${text}\x1b[0m`)
const label = ansi('97')
const light = ansi('37')
const green = ansi('1;92')
const yellow = ansi('1;93')
const red = ansi('1;91')
const blue = ansi('1;94')
const magenta = ansi('1;95')
const cyan = ansi('1;96')
const orange = ansi('1;38;5;208')
const softBlue = ansi('1;38;5;111')

export const countPatch = (hunks: readonly { lines: readonly string[] }[]) => {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }

  return { added, removed }
}

export const countLines = (text: string) =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

export const formatTokens = (n: number) => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`

  return String(n)
}

// The input and output totals to a tenth of the unit, the zero kept (615.0k,
// 1.2M); a count under a thousand stays whole.
export const formatTokensTenths = (n: number) => {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`

  return String(n)
}

export const formatDuration = (ms: number) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

// Share of all input tokens (uncached + cache write + cache read) the cache served.
export const cacheHitPercent = (t: HudTokens) => {
  const input = t.input + t.cacheWrite + t.cacheRead

  return input === 0 ? null : (t.cacheRead / input) * 100
}

// TPS is over the main loop's last few requests: their output tokens over
// their streaming time together, so a long answer weighs more than a request
// that only called a tool.
const SPEED_SAMPLES = 10

export const addSpeedSample = (samples: readonly HudSpeedSample[], sample: HudSpeedSample) =>
  [...samples, sample].slice(-SPEED_SAMPLES)

export const recentTps = (samples: readonly HudSpeedSample[]) => {
  const tokens = samples.reduce((n, s) => n + s.tokens, 0)
  const ms = samples.reduce((n, s) => n + s.ms, 0)

  return ms === 0 ? null : (tokens / ms) * 1000
}

// Active time is the union of the loops' busy spans: the clock runs while at
// least one loop (the main one, `main`, or a subagent's) is working, once
// however many are.
export const NO_ACTIVITY: HudActive = { loops: [], since: null, totalMs: 0 }

export const enterLoop = (a: HudActive, loop: string, now: number): HudActive =>
  a.loops.includes(loop) ? a : { ...a, loops: [...a.loops, loop], since: a.since ?? now }

export const leaveLoop = (a: HudActive, loop: string, now: number): HudActive => {
  if (!a.loops.includes(loop)) return a
  const loops = a.loops.filter(one => one !== loop)
  if (loops.length > 0 || a.since === null) return { ...a, loops }

  return { loops, since: null, totalMs: a.totalMs + (now - a.since) }
}

export const activeMs = (a: HudActive, now: number) => a.totalMs + (a.since === null ? 0 : now - a.since)

// Cells the terminal draws for the text, as the statusLine command measures
// it: CJK two, the rest one.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦⚡]/
const displayWidth = (text: string) =>
  [...text.replace(/\x1b\[[0-9;]*m/g, '')].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

// `上下文 207k ████░░░░░░░┃567k░░░░░ 1M`: used on the left in the fill's
// color, the window at the bar's end, and the auto-compaction threshold as a
// mark with its figure written into the bar beside it (before it when no room
// is left after).
const contextPart = (ctx: HudContext | null, threshold: number | null, cells = BAR_CELLS) => {
  if (ctx === null || ctx.tokens === null) return `${label('上下文 ')}${label('等待首次响应')}`
  const used = ctx.tokens
  // The fill's color: how close `used` is to the threshold (or the window).
  const pressure = used / (threshold ?? (ctx.window || 1))
  const fill = pressure < 0.6 ? green : pressure < 0.85 ? yellow : red
  const filled = ctx.window > 0 ? Math.min(cells, Math.round((used / ctx.window) * cells)) : 0
  // Cells from..to of the bar: filled ones colored by pressure, the rest light gray.
  const run = (from: number, to: number) =>
    fill('█'.repeat(Math.max(0, Math.min(to, filled) - from))) +
    light('░'.repeat(Math.max(0, to - Math.max(from, filled))))
  let bar = run(0, cells)
  if (threshold !== null && ctx.window > 0) {
    const mark = Math.min(cells, Math.max(0, Math.round((threshold / ctx.window) * cells)))
    const figure = formatTokens(threshold)
    if (mark + figure.length <= cells) {
      bar = `${run(0, mark)}${orange(`┃${figure}`)}${run(mark + figure.length, cells)}`
    } else {
      const start = Math.max(0, mark - figure.length)
      bar = `${run(0, start)}${orange(`${figure}┃`)}${run(mark, cells)}`
    }
  }

  return `${label('上下文 ')}${fill(`${ctx.isEstimate === true ? '~' : ''}${formatTokens(used)}`)} ${bar} ${softBlue(formatTokens(ctx.window))}`
}

// Two rows of cells, each cell a list of parts, ANSI-colored: the session's
// work (model, context, changes), then what it has consumed (cost, tokens and
// speed, active time and cache). The statusLine command writes the model
// into the empty first cell, sizes each column to its widest cell, spreads a
// narrower cell's parts across the width (the spare room goes between them, not
// after them) and joins the columns with 丨.
export type HudCells = string[][][]

// Where a part gives way when its column lines parts up and it is narrower
// than the widest there: the statusLine command puts the room at this mark
// (a space when there is none), so the figure after it ends with the widest.
export const FLEX = '\t'

// The least room between the parts of a cell, per column: the cost's label
// and figure need only a space (the figure ends under the model's effort), the
// last column's parts stand further apart.
export const HUD_GAPS = [1, 4, 6] as const

export const renderCells = (s: HudSnapshot): HudCells => {
  const hit = cacheHitPercent(s.tokens)
  const hitText = hit === null ? label('—') : (hit >= 80 ? green : hit >= 50 ? yellow : red)(`${hit.toFixed(2)}%`)
  const input = s.tokens.input + s.tokens.cacheWrite + s.tokens.cacheRead
  const isActive = s.active.since !== null
  const speed = [
    `${label('输入 ')}${blue(formatTokensTenths(input))}`,
    `${label('输出 ')}${magenta(formatTokensTenths(s.tokens.output))}`,
    `${label('TPS ')}${s.tps === null ? label('—') : cyan(s.tps.toFixed(1))}`,
  ]
  // The bar grows by however much the speed cell below is wider, so the
  // window's figure ends where the TPS does; a wider bar spreads that cell.
  const speedWidth = speed.reduce((n, part) => n + displayWidth(part), 0) + HUD_GAPS[1] * (speed.length - 1)
  const short = speedWidth - displayWidth(contextPart(s.context, s.compactAt))
  const context = contextPart(s.context, s.compactAt, BAR_CELLS + Math.max(0, short))

  return [
    [
      [''],
      [context],
      [
        `${label('改动')}${FLEX}${blue(String(s.edits.files.length))}${label(' 文件')}`,
        `${green(`+${s.edits.added}`)}${FLEX}${red(`−${s.edits.removed}`)}${label(' 行')}`,
      ],
    ],
    [
      [label('费用'), s.cost === null ? label('—') : yellow(`$${s.cost.toFixed(2)}`)],
      speed,
      [
        `${label('活跃')}${FLEX}${(isActive ? cyan : softBlue)(formatDuration(activeMs(s.active, s.now)))}`,
        `${label('缓存')}${FLEX}${hitText}`,
      ],
    ],
  ]
}
