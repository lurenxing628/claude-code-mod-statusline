// `isEstimate`: no response has reported the window yet, so `tokens` is the
// engine's local estimate of what the first request will carry.
export type HudContext = { tokens: number | null; window: number; isEstimate?: boolean }

export type HudEdits = {
  added: number
  removed: number
  files: string[]
}

// The loops working now (`main` or a subagent's id), since when at least one
// has been, and the time banked from the busy spans that ended.
export type HudActive = { loops: string[]; since: number | null; totalMs: number }

// One main-loop request's output and how long it streamed, for the TPS figure.
export type HudSpeedSample = { tokens: number; ms: number }

export type HudTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-hud': {
      compactAt: number | null
      edits: HudEdits
      tokens: HudTokens
      speed: HudSpeedSample[]
      active: HudActive
    }
  }
}
