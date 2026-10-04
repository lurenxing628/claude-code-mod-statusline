import { describe, expect, test } from 'claude-code/testing'

import {
  activeMs,
  addSpeedSample,
  countLines,
  countPatch,
  enterLoop,
  formatTokens,
  formatTokensTenths,
  leaveLoop,
  NO_ACTIVITY,
  recentTps,
  renderCells,
} from '../hooks/format'
import type { HudSnapshot } from '../hooks/format'

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
const plainCells = (snapshot: HudSnapshot) => renderCells(snapshot).map(row => row.map(cell => cell.map(plain)))

const BASE: HudSnapshot = {
  context: { tokens: 182_000, window: 1_000_000 },
  compactAt: 600_000,
  cost: 3.214,
  edits: { added: 320, removed: 45, files: ['/a', '/b'] },
  tokens: { input: 1000, output: 45_000, cacheRead: 90_000, cacheWrite: 9000, requests: 4 },
  tps: 68,
  active: { loops: [], since: null, totalMs: 32 * 60_000 + 5000 },
  now: 83 * 60_000,
}

describe('session-hud format', () => {
  test('counts patch lines and created files', () => {
    expect(countPatch([{ lines: [' a', '-b', '+c', '+d'] }])).toEqual({ added: 2, removed: 1 })
    expect(countLines('one\ntwo\nthree\n')).toBe(3)
    expect(countLines('')).toBe(0)
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(182_000)).toBe('182k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokensTenths(999)).toBe('999')
    expect(formatTokensTenths(1000)).toBe('1.0k')
    expect(formatTokensTenths(182_340)).toBe('182.3k')
    expect(formatTokensTenths(999_960)).toBe('1.0M')
    expect(formatTokensTenths(12_345_678)).toBe('12.3M')
  })

  test('puts the work in the first row and the consumption in the second', () => {
    expect(plainCells(BASE)).toEqual([
      [[''], ['上下文 182k ████░░░░░░░░░┃600k░░░░ 1M'], ['改动\t2 文件', '+320\t−45 行']],
      [['费用', '$3.21'], ['输入 100.0k', '输出 45.0k', 'TPS 68.0'], ['活跃\t32m05s', '缓存\t90.00%']],
    ])
  })

  test('stretches the bar so the window ends where the speed cell below does', () => {
    const width = (text: string) => [...text].reduce((n, ch) => n + (/[一-鿿]/.test(ch) ? 2 : 1), 0)
    const ends = (snapshot: HudSnapshot) => {
      const [top, bottom] = plainCells(snapshot)
      const context = width(top?.[1]?.[0] ?? '')
      expect(context).toBe((bottom?.[1] ?? []).reduce((n, part) => n + width(part), 0) + 4 * 2)
      return context
    }

    expect(ends(BASE)).toBe(37)
    expect(ends({ ...BASE, tokens: { ...BASE.tokens, cacheRead: 615_000_000, output: 120_500 }, tps: 135.8 })).toBe(39)
  })

  test('draws the compaction mark past the fill, near the end, and with no threshold none', () => {
    // A speed cell narrower than the context, so the bar keeps its 20 cells.
    const narrow: HudSnapshot = { ...BASE, tokens: { ...BASE.tokens, output: 450 }, tps: 6 }
    const context = (snapshot: HudSnapshot) => plainCells(snapshot)[0]?.[1]?.[0]

    expect(context({ ...narrow, context: { tokens: 700_000, window: 1_000_000 } })).toBe('上下文 700k ████████████┃600k░░░░ 1M')
    expect(context({ ...narrow, compactAt: 950_000 })).toBe('上下文 182k ████░░░░░░░░░░░950k┃░ 1M')
    expect(context({ ...narrow, compactAt: null })).toBe('上下文 182k ████░░░░░░░░░░░░░░░░ 1M')
    expect(context({ ...narrow, context: { tokens: 25_000, window: 1_000_000, isEstimate: true } })).toBe(
      '上下文 ~25k █░░░░░░░░░░░┃600k░░░░ 1M',
    )
  })

  test('weighs the speed of the last ten requests by their tokens', () => {
    expect(recentTps([])).toBe(null)
    // A long answer at 100/s and a lone tool call at 20/s: 2040 tokens in 20.5s.
    expect(recentTps([{ tokens: 2000, ms: 20_000 }, { tokens: 40, ms: 500 }])?.toFixed(1)).toBe('99.5')

    let samples = [{ tokens: 1, ms: 1000 }]
    for (let i = 0; i < 10; i += 1) samples = addSpeedSample(samples, { tokens: 50, ms: 1000 })
    expect(samples).toHaveLength(10)
    expect(recentTps(samples)).toBe(50)
  })

  test('gives the speed to a tenth', () => {
    expect(plainCells({ ...BASE, tps: 68.46 })[1]?.[1]?.[2]).toBe('TPS 68.5')
  })

  test('keeps every part in the empty states', () => {
    expect(
      plainCells({
        ...BASE,
        context: null,
        cost: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
        tps: null,
        active: NO_ACTIVITY,
      }),
    ).toEqual([
      [[''], ['上下文 等待首次响应'], ['改动\t2 文件', '+320\t−45 行']],
      [['费用', '—'], ['输入 0', '输出 0', 'TPS —'], ['活跃\t0s', '缓存\t—']],
    ])
  })

  test('counts active time once while any loop works', () => {
    let a = enterLoop(NO_ACTIVITY, 'main', 0)
    a = enterLoop(a, 'agent-1', 10_000)
    a = leaveLoop(a, 'main', 30_000)
    expect(activeMs(a, 40_000)).toBe(40_000)

    a = leaveLoop(a, 'agent-1', 50_000)
    expect(a).toEqual({ loops: [], since: null, totalMs: 50_000 })
    expect(activeMs(a, 90_000)).toBe(50_000)

    a = enterLoop(a, 'main', 100_000)
    expect(activeMs(a, 103_000)).toBe(53_000)
    expect(leaveLoop(a, 'unknown', 104_000)).toBe(a)
    expect(plainCells({ ...BASE, active: a, now: 103_000 })[1]?.[2]?.[0]).toBe('活跃\t53s')
  })
})
