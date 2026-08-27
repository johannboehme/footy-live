// Data layer: AFL scores, fixtures and ladder via ESPN's public JSON API.
// Unofficial endpoints — shapes verified 2026-08, may change without notice.

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/australian-football/afl/scoreboard'
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports/australian-football/afl/standings'

export type GameState = 'pre' | 'in' | 'post'

export interface TeamScore {
  abbrev: string
  name: string
  score: number
  winner: boolean
  /** Points scored per quarter (not cumulative); empty until the game starts. */
  quarters: number[]
}

export interface Game {
  id: string
  date: Date
  state: GameState
  /** Quarter 1–4 while live, 0 before the bounce. */
  period: number
  /** Display clock while live, e.g. "12:40". */
  clock: string
  venue: string
  home: TeamScore
  away: TeamScore
}

export interface LadderEntry {
  rank: number
  abbrev: string
  name: string
  wins: number
  losses: number
  ties: number
  percentage: string
  points: number
}

export interface Snapshot {
  /** "Finals" or "Round N" */
  roundLabel: string
  games: Game[]
  fetchedAt: Date
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

function parseCompetitor(c: any): TeamScore {
  return {
    abbrev: c?.team?.abbreviation ?? 'TBD',
    name: c?.team?.shortDisplayName ?? c?.team?.displayName ?? 'To be decided',
    score: Number(c?.score ?? 0),
    winner: c?.winner === true,
    quarters: Array.isArray(c?.linescores)
      ? c.linescores.map((l: any) => Math.round(Number(l?.value ?? 0)))
      : [],
  }
}

function parseEvent(e: any): Game | null {
  const comp = e?.competitions?.[0]
  if (!comp) return null
  const home = comp.competitors?.find((c: any) => c.homeAway === 'home')
  const away = comp.competitors?.find((c: any) => c.homeAway === 'away')
  if (!home || !away) return null
  const state = (e?.status?.type?.state ?? 'pre') as GameState
  return {
    id: String(e.id),
    date: new Date(e.date),
    state,
    period: Number(e?.status?.period ?? 0),
    clock: String(e?.status?.displayClock ?? ''),
    venue: comp?.venue?.fullName ?? '',
    home: parseCompetitor(home),
    away: parseCompetitor(away),
  }
}

/**
 * One fetch covering the recent past and near future: live games, the last
 * round's results and the upcoming fixtures all come back together.
 */
export async function fetchSnapshot(): Promise<Snapshot> {
  const now = new Date()
  const from = new Date(now.getTime() - 6 * 864e5)
  const to = new Date(now.getTime() + 13 * 864e5)
  const data = await getJson(`${SCOREBOARD}?dates=${yyyymmdd(from)}-${yyyymmdd(to)}`)

  const games = (data?.events ?? [])
    .map(parseEvent)
    .filter((g: Game | null): g is Game => g !== null)
    .sort((a: Game, b: Game) => a.date.getTime() - b.date.getTime())

  const seasonType = Number(data?.leagues?.[0]?.season?.type?.type ?? 2)
  const week = Number(data?.week?.number ?? 0)
  const roundLabel = seasonType === 3 ? 'Finals' : seasonType === 1 ? 'Pre-season' : week > 0 ? `Round ${week}` : 'AFL'

  return { roundLabel, games, fetchedAt: new Date() }
}

export async function fetchLadder(): Promise<LadderEntry[]> {
  const data = await getJson(STANDINGS)
  const entries = data?.standings?.entries ?? data?.children?.[0]?.standings?.entries ?? []
  const ladder: LadderEntry[] = entries.map((en: any) => {
    const stats: Record<string, any> = {}
    for (const s of en?.stats ?? []) stats[s.name] = s
    return {
      rank: Number(stats['rank']?.value ?? 0),
      abbrev: en?.team?.abbreviation ?? '???',
      name: en?.team?.shortDisplayName ?? en?.team?.displayName ?? 'Unknown',
      wins: Number(stats['wins']?.value ?? 0),
      losses: Number(stats['losses']?.value ?? 0),
      ties: Number(stats['ties']?.value ?? 0),
      percentage: String(stats['percentage']?.displayValue ?? '—').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''),
      points: Number(stats['points']?.value ?? 0),
    }
  })
  return ladder.sort((a, b) => a.rank - b.rank)
}

export function liveGames(s: Snapshot): Game[] {
  return s.games.filter(g => g.state === 'in')
}

export function results(s: Snapshot): Game[] {
  return s.games.filter(g => g.state === 'post').reverse()
}

export function fixtures(s: Snapshot): Game[] {
  return s.games.filter(g => g.state === 'pre')
}

/** The 18 AFL clubs, for the favourite-team picker (ESPN abbreviations). */
export const CLUBS: { abbrev: string; name: string }[] = [
  { abbrev: 'ADEL', name: 'Adelaide Crows' },
  { abbrev: 'BL', name: 'Brisbane Lions' },
  { abbrev: 'CARL', name: 'Carlton' },
  { abbrev: 'COLL', name: 'Collingwood' },
  { abbrev: 'ESS', name: 'Essendon' },
  { abbrev: 'FRE', name: 'Fremantle' },
  { abbrev: 'GEEL', name: 'Geelong Cats' },
  { abbrev: 'SUNS', name: 'Gold Coast SUNS' },
  { abbrev: 'GWS', name: 'GWS GIANTS' },
  { abbrev: 'HAW', name: 'Hawthorn' },
  { abbrev: 'MELB', name: 'Melbourne' },
  { abbrev: 'NMFC', name: 'North Melbourne' },
  { abbrev: 'PORT', name: 'Port Adelaide' },
  { abbrev: 'RICH', name: 'Richmond' },
  { abbrev: 'STK', name: 'St Kilda' },
  { abbrev: 'SYD', name: 'Sydney Swans' },
  { abbrev: 'WCE', name: 'West Coast Eagles' },
  { abbrev: 'WB', name: 'Western Bulldogs' },
]
