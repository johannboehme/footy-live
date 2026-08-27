// Text formatting for the 576x288 glasses canvas (single LVGL font, left-aligned).
import type { Game } from './afl'

const TIME_FMT = new Intl.DateTimeFormat('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const DATE_FMT = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
const CLOCK_FMT = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' })

function compactTime(parts: string): string {
  return parts.replace(/\s?(am|pm)/i, m => m.trim().toLowerCase())
}

/** "Fri 7:40pm" for games this week, "Sat 6 Sep 7:40pm" further out. */
export function fmtStart(d: Date): string {
  const days = (d.getTime() - Date.now()) / 864e5
  const time = compactTime(CLOCK_FMT.format(d))
  if (days > 6) return `${DATE_FMT.format(d)} ${time}`
  return compactTime(TIME_FMT.format(d))
}

export function fmtClockNow(d: Date): string {
  return compactTime(CLOCK_FMT.format(d))
}

/** Live game status, e.g. "Q3 12:40" or "HT". */
export function fmtLiveStatus(g: Game): string {
  if (g.period >= 1 && g.period <= 4 && g.clock) return `Q${g.period} ${g.clock}`
  return g.clock || 'Live'
}

/** One-line summary of a game for the scores / fixtures lists. */
export function gameLine(g: Game, focused: boolean): string {
  const cursor = focused ? '▶ ' : '  '
  if (g.state === 'in') {
    return `${cursor}● ${g.home.abbrev} ${g.home.score} v ${g.away.abbrev} ${g.away.score}  ${fmtLiveStatus(g)}`
  }
  if (g.state === 'post') {
    if (g.home.score === g.away.score) {
      return `${cursor}${g.home.abbrev} ${g.home.score} drew ${g.away.abbrev} ${g.away.score}`
    }
    const [w, l] = g.home.winner ? [g.home, g.away] : [g.away, g.home]
    return `${cursor}${w.abbrev} ${w.score} d ${l.abbrev} ${l.score}`
  }
  return `${cursor}${g.home.abbrev} v ${g.away.abbrev}  ${fmtStart(g.date)}`
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}
