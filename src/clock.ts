import { PALETTE, type Color } from './game'

export interface ClockSettings {
  enabled: boolean
  initialMs: number
  incrementMs: number
}

export const defaultClockSettings = (): ClockSettings => ({ enabled: false, initialMs: 120_000, incrementMs: 10_000 })

export function normalizeClockSettings(s: ClockSettings): ClockSettings {
  return {
    enabled: Boolean(s.enabled),
    initialMs: Math.max(1000, Math.min(10_800_000, Math.round(Number(s.initialMs) || 120_000))),
    incrementMs: Math.max(0, Math.min(120_000, Math.round(Number(s.incrementMs) || 0))),
  }
}

export interface ClockState {
  remaining: Record<Color, number>
  runningSince: number | null
  turn: number
  revision: number
}

/** at 是房主采样时刻；客人以它校准显示，不自行判超时。 */
export interface ClockSync extends ClockState { at: number }

export function freshClock(settings: ClockSettings, revision = 0): ClockState {
  return {
    remaining: Object.fromEntries(PALETTE.map(p => [p.id, settings.initialMs])) as Record<Color, number>,
    runningSince: null, turn: 0, revision,
  }
}

export function timeLeft(clock: ClockState, color: Color, current: Color, now: number): number {
  const elapsed = color === current && clock.runningSince !== null ? Math.max(0, now - clock.runningSince) : 0
  return Math.max(0, clock.remaining[color] - elapsed)
}

export function formatTime(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
