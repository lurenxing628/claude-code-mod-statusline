#!/usr/bin/env node
// Claude Code statusLine command. Lays out the cells the session-hud mod writes
// to ~/.claude/session-hud/<session id>.json (rows of cells, each cell a list
// of parts) as aligned columns, the model (from stdin) in the first cell, then
// the project and git branch, then the 5-hour and weekly limits (from stdin,
// on a subscription); a session without the mod gets one row built from stdin
// alone.
const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = path.join(os.homedir(), '.claude', 'session-hud')
const STALE_MS = 7 * 24 * 3600 * 1000

// Claude Code draws the whole status line dimmed, so every piece states its
// own intensity (22, normal) before a bright color; labels are bright white.
const paint = code => text => `\x1b[22;${code}m${text}\x1b[0m`
const label = paint('97')
const magenta = paint('1;95')
const green = paint('1;92')
const red = paint('1;91')
const yellow = paint('1;93')
const sky = paint('1;38;5;117')
const softBlue = paint('1;38;5;111')
// The effort level graded from calm to hot.
const EFFORT_COLORS = { low: '92', medium: '96', high: '93', xhigh: '38;5;208', max: '91' }
const SEP = paint('37')('   丨   ')
// The least room between two parts of a cell, unless the data names one for
// the column.
const GAP = 4

// Cells the terminal draws for the text: CJK and the emoji two, the rest one.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦⚡]/
const width = text => [...text.replace(/\x1b\[[0-9;]*m/g, '')].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

// A part marks with a tab where it gives way (between a label and its figure):
// in a column whose parts line up, a part narrower than the widest there takes
// the room at the mark, so it starts and ends with the widest; elsewhere the
// mark is a space.
const FLEX = '\t'
const stretch = (part, room, isEnd) =>
  part.includes(FLEX) ? part.replace(FLEX, ' '.repeat(1 + room)) : isEnd ? part : part + ' '.repeat(room)

// Sizes each column to its widest cell and fits every cell to it, joining the
// columns with 丨 so the separators line up. In a column whose cells all have
// the same number of parts (two or more), the parts line up too, each as wide
// as its widest (stretched at its mark, or padded after); in any other column
// a cell of several parts spreads them across the width (the spare room
// between them, the first gaps taking the remainder) and a single part is
// padded after. Nothing is padded at the end of the last column.
const layout = (rows, gaps = []) => {
  const columns = Math.max(...rows.map(row => row.length))
  const gapOf = c => gaps[c] ?? GAP
  const partWidths = Array.from({ length: columns }, (_, c) => {
    const cells = rows.map(row => row[c]).filter(Boolean)
    const count = cells[0]?.length ?? 0
    if (cells.length < 2 || count < 2 || cells.some(cell => cell.length !== count)) return null
    return Array.from({ length: count }, (_, k) => Math.max(...cells.map(cell => width(cell[k]))))
  })
  const cellWidth = (parts, c) => parts.reduce((n, part) => n + width(part), 0) + gapOf(c) * (parts.length - 1)
  const widths = Array.from({ length: columns }, (_, c) =>
    partWidths[c] ? cellWidth(partWidths[c].map(n => ' '.repeat(n)), c) : Math.max(...rows.map(row => cellWidth(row[c] || [''], c))),
  )
  const fit = (cell, c, isLast) => {
    const gap = ' '.repeat(gapOf(c))
    if (partWidths[c]) {
      return cell.map((part, k) => stretch(part, partWidths[c][k] - width(part), isLast && k === cell.length - 1)).join(gap)
    }
    const parts = cell.map(part => part.replace(FLEX, ' '))
    const spare = widths[c] - cellWidth(parts, c)
    if (parts.length === 1) return isLast ? parts[0] : parts[0] + ' '.repeat(spare)
    const between = parts.length - 1
    return parts.reduce((line, part, i) => {
      if (i === 0) return part
      return line + gap + ' '.repeat(Math.floor(spare / between) + (i <= spare % between ? 1 : 0)) + part
    }, '')
  }
  return rows.map(row => row.map((parts, c) => fit(parts, c, c === row.length - 1)).join(SEP))
}

const formatTokens = n =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n)

const formatMinutes = ms => {
  const minutes = Math.floor((ms || 0) / 60000)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

const fallback = j => {
  const ctx = j.context_window || {}
  const cost = j.cost || {}
  const cells = []
  cells.push([
    ctx.context_window_size > 0 && ctx.total_input_tokens > 0
      ? `${label('上下文 ')}${green(formatTokens(ctx.total_input_tokens))}${label('/')}${softBlue(formatTokens(ctx.context_window_size))}`
      : `${label('上下文 ')}${label('—')}`,
  ])
  if (typeof cost.total_cost_usd === 'number') cells.push([`${label('费用 ')}${yellow(`$${cost.total_cost_usd.toFixed(2)}`)}`])
  cells.push([`${label('API ')}${softBlue(formatMinutes(cost.total_api_duration_ms))}`])
  cells.push([`${label('改动 ')}${green(`+${cost.total_lines_added || 0}`)} ${red(`−${cost.total_lines_removed || 0}`)}${label(' 行')}`])
  return [cells]
}

// The branch checked out at `dir`: the nearest .git above it, followed to the
// real git dir when it is a file (a worktree's); a detached HEAD gives its
// commit, short. Null outside a repository.
const gitBranch = dir => {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const dotGit = path.join(at, '.git')
    let stat = null
    try {
      stat = fs.statSync(dotGit)
    } catch {}
    if (stat !== null) {
      let gitDir = dotGit
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))
        if (pointer === null) return null
        gitDir = path.resolve(at, pointer[1].trim())
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
      const ref = /^ref: refs\/heads\/(.+)$/.exec(head)
      return ref === null ? head.slice(0, 7) : ref[1]
    }
    if (path.dirname(at) === at) return null
  }
}

const whereCells = j => {
  const workspace = j.workspace || {}
  const cwd = workspace.current_dir || j.cwd || process.cwd()
  const project = path.basename(workspace.project_dir || cwd)
  let branch = null
  try {
    branch = gitBranch(cwd)
  } catch {}
  return [
    [`${label('项目 ')}${sky(project)}`],
    [`${label('分支 ')}${branch === null ? label('—') : green(branch)}`],
  ]
}

// How long until `ms` from now: 45m, 2h13m, 3d04h.
const formatCountdown = ms => {
  const minutes = Math.max(0, Math.ceil(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`
}

// A reset time as stdin gives it (epoch seconds, or an ISO string) in ms.
const resetAt = value =>
  typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN

// The 5-hour window over the weekly one, each its use (green/yellow/red, whole
// percents rounded down so 100% means spent) and the countdown to its reset;
// null when stdin carries neither (an API key, or no reading yet).
const limitCells = j => {
  const limits = j.rate_limits || {}
  if (!limits.five_hour && !limits.seven_day) return null
  const cell = (name, window) => {
    if (!window || typeof window.used_percentage !== 'number') return [`${label(name)}${FLEX}${label('—')}`]
    const used = window.used_percentage
    const grade = used < 50 ? green : used < 80 ? yellow : red
    const at = resetAt(window.resets_at)
    const parts = [`${label(name)}${FLEX}${grade(`${Math.floor(used)}%`)}`]
    if (Number.isFinite(at)) parts.push(`${label('↻')}${FLEX}${softBlue(formatCountdown(at - Date.now()))}`)
    return parts
  }
  return [cell('5h', limits.five_hour), cell('周', limits.seven_day)]
}

// Drops the files of sessions untouched for a week, now and then.
const prune = () => {
  if (Math.random() > 0.01) return
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.json') && !name.endsWith('.txt')) continue
    const file = path.join(DIR, name)
    if (Date.now() - fs.statSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file)
  }
}

let raw = ''
process.stdin.on('data', chunk => (raw += chunk))
process.stdin.on('end', () => {
  let j = {}
  try {
    j = JSON.parse(raw)
  } catch {}
  const name = (j.model && (j.model.display_name || j.model.id)) || '?'
  const level = j.effort && j.effort.level
  const effort = level ? ` ${paint(EFFORT_COLORS[level] || '96')(level)}` : ''
  const fast = j.fast_mode ? yellow(' ⚡fast') : ''
  const model = `${magenta(name)}${effort}${fast}`

  let rows = null
  let gaps = []
  const id = String(j.session_id || '').replace(/[^\w-]/g, '')
  if (id !== '') {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'))
      if (Array.isArray(data.rows) && data.rows.length > 0) rows = data.rows
      if (Array.isArray(data.gaps)) gaps = data.gaps
    } catch {}
  }
  if (rows === null) rows = fallback(j)
  const hasSlot = Array.isArray(rows[0][0]) && rows[0][0].join('') === ''
  rows[0] = [[model], ...rows[0].slice(hasSlot ? 1 : 0)]
  for (const [top, bottom] of [whereCells(j), limitCells(j)].filter(Boolean)) {
    if (rows.length > 1) {
      rows[0].push(top)
      rows[1].push(bottom)
    } else {
      rows[0].push(top, bottom)
    }
  }
  process.stdout.write(`${layout(rows, gaps).join('\n')}\n`)

  try {
    prune()
  } catch {}
})
