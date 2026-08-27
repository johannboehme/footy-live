// Glasses UI: page state machine and render pipeline for the 576x288 canvas.
//
// Three layouts share the screen:
//  - 'text3'  header / body / footer — scores, fixtures, my team, game detail
//  - 'ladder' header / four aligned column containers / footer
//  - 'list'   header + native list container — favourite-team picker
//
// Same-layout renders go through textContainerUpgrade (flicker-free); layout
// changes go through rebuildPageContainer. The OS contextual menu (SDK 0.0.14
// menuObject) is attached to the startup page and re-attached on every rebuild,
// since omitting it on a rebuild clears it.
import {
  EvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  StartUpPageCreateResult,
} from '@evenrealities/even_hub_sdk'
import { type Snapshot, type LadderEntry, type Game, liveGames, results, fixtures, CLUBS } from './afl'
import { gameLine, fmtStart, fmtLiveStatus, fmtClockNow, ordinal } from './format'

export type Page = 'scores' | 'fixtures' | 'ladder' | 'myteam' | 'detail' | 'teampick'
type Layout = 'text3' | 'ladder' | 'list'

export const MENU = {
  scores: 1,
  fixtures: 2,
  ladder: 3,
  myteam: 4,
  teampick: 5,
  refresh: 6,
} as const

const GAMES_PER_PAGE = 6
const LADDER_ROWS = 7

interface State {
  page: Page
  snapshot: Snapshot | null
  ladder: LadderEntry[] | null
  favTeam: string
  focus: { scores: number; fixtures: number }
  detail: { gameId: string; origin: 'scores' | 'fixtures' | 'myteam' } | null
  ladderPage: number
  offline: boolean
}

const state: State = {
  page: 'scores',
  snapshot: null,
  ladder: null,
  favTeam: '',
  focus: { scores: 0, fixtures: 0 },
  detail: null,
  ladderPage: 0,
  offline: false,
}

let bridge: EvenAppBridge | null = null
let created = false
let currentLayout: Layout = 'text3'
let lastContents: Record<string, string> = {}

// ---------------------------------------------------------------------------
// Serial call queue — bridge calls must never overlap, and a flaky BLE hop can
// hang for ~30s, so every call gets a hard timeout.
let chain: Promise<unknown> = Promise.resolve()

function enqueue<T>(fn: () => Promise<T>, timeoutMs = 6000): Promise<T | null> {
  const run = chain.then(() =>
    Promise.race([
      fn(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]).catch(err => {
      console.warn('[footy] bridge call failed:', err)
      return null
    }),
  )
  chain = run
  return run
}

// ---------------------------------------------------------------------------
// Layout definitions

function contextMenu(): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemID: MENU.scores, itemName: 'Scores' }),
      new MenuItemProperty({ itemID: MENU.fixtures, itemName: 'Fixtures' }),
      new MenuItemProperty({ itemID: MENU.ladder, itemName: 'Ladder' }),
      new MenuItemProperty({ itemID: MENU.myteam, itemName: 'My Team' }),
      new MenuItemProperty({ itemID: MENU.teampick, itemName: 'Set My Team' }),
      new MenuItemProperty({ itemID: MENU.refresh, itemName: 'Refresh' }),
    ],
  })
}

function text3Containers(c: Record<string, string>): TextContainerProperty[] {
  return [
    new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 34,
      containerID: 1, containerName: 'header',
      content: c['header'] || ' ', isEventCapture: 0,
      borderWidth: 0, paddingLength: 0,
    }),
    new TextContainerProperty({
      xPosition: 0, yPosition: 36, width: 576, height: 214,
      containerID: 2, containerName: 'body',
      content: c['body'] || ' ', isEventCapture: 1,
      borderWidth: 0, paddingLength: 0,
    }),
    new TextContainerProperty({
      xPosition: 0, yPosition: 252, width: 576, height: 36,
      containerID: 3, containerName: 'footer',
      content: c['footer'] || ' ', isEventCapture: 0,
      borderWidth: 0, paddingLength: 0, textColor: 2,
    }),
  ]
}

function ladderContainers(c: Record<string, string>): TextContainerProperty[] {
  const col = (id: number, name: string, x: number, w: number, capture = 0) =>
    new TextContainerProperty({
      xPosition: x, yPosition: 36, width: w, height: 214,
      containerID: id, containerName: name,
      content: c[name] || ' ', isEventCapture: capture,
      borderWidth: 0, paddingLength: 0,
    })
  return [
    new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 34,
      containerID: 1, containerName: 'header',
      content: c['header'] || ' ', isEventCapture: 0,
      borderWidth: 0, paddingLength: 0,
    }),
    col(2, 'lteam', 0, 300, 1),
    col(3, 'lwl', 300, 86),
    col(4, 'lpct', 386, 104),
    col(5, 'lpts', 490, 86),
    new TextContainerProperty({
      xPosition: 0, yPosition: 252, width: 576, height: 36,
      containerID: 6, containerName: 'footer',
      content: c['footer'] || ' ', isEventCapture: 0,
      borderWidth: 0, paddingLength: 0, textColor: 2,
    }),
  ]
}

function teamListContainers(): { text: TextContainerProperty[]; list: ListContainerProperty[] } {
  return {
    text: [
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 34,
        containerID: 1, containerName: 'header',
        content: 'Pick your team — tap to select', isEventCapture: 0,
        borderWidth: 0, paddingLength: 0,
      }),
    ],
    list: [
      new ListContainerProperty({
        xPosition: 0, yPosition: 36, width: 576, height: 252,
        containerID: 10, containerName: 'teampick',
        isEventCapture: 1, borderWidth: 0, paddingLength: 0,
        itemContainer: new ListItemContainerProperty({
          itemCount: CLUBS.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: CLUBS.map(t => t.name),
        }),
      }),
    ],
  }
}

// ---------------------------------------------------------------------------
// Per-page content builders

function scoresList(): Game[] {
  const s = state.snapshot
  return s ? [...liveGames(s), ...results(s)] : []
}

function headerLine(title: string): string {
  const s = state.snapshot
  const round = s ? s.roundLabel : 'AFL'
  const live = s ? liveGames(s).length : 0
  const status = state.offline
    ? 'offline'
    : live > 0
      ? `● LIVE ${live}`
      : s ? fmtClockNow(s.fetchedAt) : ''
  return `AFL ${round} · ${title}${status ? ' · ' + status : ''}`
}

function pagedGameLines(games: Game[], focus: number): string {
  const page = Math.floor(focus / GAMES_PER_PAGE)
  const slice = games.slice(page * GAMES_PER_PAGE, (page + 1) * GAMES_PER_PAGE)
  return slice.map((g, i) => gameLine(g, page * GAMES_PER_PAGE + i === focus)).join('\n')
}

function pageIndicator(games: Game[], focus: number): string {
  const pages = Math.ceil(games.length / GAMES_PER_PAGE)
  if (pages <= 1) return ''
  return ` · ${Math.floor(focus / GAMES_PER_PAGE) + 1}/${pages}`
}

function buildScores(): Record<string, string> {
  const games = scoresList()
  if (!state.snapshot) {
    return { header: 'AFL · Footy Live', body: 'Loading scores…', footer: ' ' }
  }
  if (games.length === 0) {
    return {
      header: headerLine('Scores'),
      body: 'No live games or recent results.\nCheck Fixtures for upcoming games.',
      footer: 'hold: menu',
    }
  }
  const focus = Math.min(state.focus.scores, games.length - 1)
  state.focus.scores = focus
  return {
    header: headerLine('Scores'),
    body: pagedGameLines(games, focus),
    footer: `swipe: choose · tap: open${pageIndicator(games, focus)}`,
  }
}

function buildFixtures(): Record<string, string> {
  const s = state.snapshot
  const games = s ? fixtures(s) : []
  if (!s) return { header: 'AFL · Footy Live', body: 'Loading fixtures…', footer: ' ' }
  if (games.length === 0) {
    return {
      header: headerLine('Fixtures'),
      body: 'No upcoming games in the next\ntwo weeks.',
      footer: 'hold: menu',
    }
  }
  const focus = Math.min(state.focus.fixtures, games.length - 1)
  state.focus.fixtures = focus
  return {
    header: headerLine('Fixtures'),
    body: pagedGameLines(games, focus),
    footer: `swipe: choose · tap: open${pageIndicator(games, focus)}`,
  }
}

function buildLadder(): Record<string, string> {
  const l = state.ladder
  if (!l || l.length === 0) {
    return { header: 'AFL Ladder', lteam: 'Loading ladder…', lwl: ' ', lpct: ' ', lpts: ' ', footer: ' ' }
  }
  const pages = Math.ceil(l.length / LADDER_ROWS)
  state.ladderPage = ((state.ladderPage % pages) + pages) % pages
  const slice = l.slice(state.ladderPage * LADDER_ROWS, (state.ladderPage + 1) * LADDER_ROWS)
  const fav = state.favTeam
  return {
    header: `AFL Ladder · ${slice[0].rank}–${slice[slice.length - 1].rank}`,
    lteam: slice.map(e => `${e.abbrev === fav ? '★' : ''}${e.rank} ${e.name}`).join('\n'),
    lwl: slice.map(e => (e.ties > 0 ? `${e.wins}-${e.losses}-${e.ties}` : `${e.wins}-${e.losses}`)).join('\n'),
    lpct: slice.map(e => `${e.percentage}%`).join('\n'),
    lpts: slice.map(e => `${e.points}`).join('\n'),
    footer: `swipe: more · ${state.ladderPage + 1}/${pages}`,
  }
}

function teamGames(abbrev: string): { live: Game | null; next: Game | null; last: Game | null } {
  const s = state.snapshot
  if (!s) return { live: null, next: null, last: null }
  const mine = s.games.filter(g => g.home.abbrev === abbrev || g.away.abbrev === abbrev)
  return {
    live: mine.find(g => g.state === 'in') ?? null,
    next: mine.find(g => g.state === 'pre') ?? null,
    last: [...mine].reverse().find(g => g.state === 'post') ?? null,
  }
}

function buildMyTeam(): Record<string, string> {
  const fav = state.favTeam
  if (!fav) {
    return {
      header: 'My Team',
      body: 'No team set yet.\nOpen the menu and choose\n"Set My Team".',
      footer: 'hold: menu',
    }
  }
  const club = CLUBS.find(c => c.abbrev === fav)
  const { live, next, last } = teamGames(fav)
  const lines: string[] = []
  if (live) {
    const opp = live.home.abbrev === fav ? live.away : live.home
    const me = live.home.abbrev === fav ? live.home : live.away
    lines.push(`● LIVE  ${me.abbrev} ${me.score} v ${opp.abbrev} ${opp.score}  ${fmtLiveStatus(live)}`)
  }
  if (next) {
    const home = next.home.abbrev === fav
    const opp = home ? next.away : next.home
    lines.push(`Next: ${home ? 'v' : '@'} ${opp.abbrev} · ${fmtStart(next.date)}`)
    if (next.venue) lines.push(`      ${next.venue}`)
  }
  if (last) lines.push(`Last: ${gameLine(last, false).trim()}`)
  const entry = state.ladder?.find(e => e.abbrev === fav)
  if (entry) {
    lines.push(`Ladder: ${ordinal(entry.rank)} · ${entry.wins}-${entry.losses} · ${entry.percentage}%`)
  }
  if (lines.length === 0) lines.push('No games in the current window.')
  return {
    header: headerLine(club?.name ?? fav),
    body: lines.join('\n'),
    footer: live || next || last ? 'tap: open game' : 'hold: menu',
  }
}

function findDetailGame(): Game | null {
  const s = state.snapshot
  if (!s || !state.detail) return null
  return s.games.find(g => g.id === state.detail!.gameId) ?? null
}

function buildDetail(): Record<string, string> {
  const g = findDetailGame()
  if (!g) return { header: 'Game', body: 'Game not found.', footer: 'tap: back' }
  const q = (t: { quarters: number[] }) =>
    t.quarters.length ? `Q  ${t.quarters.join('  ')}` : ''
  if (g.state === 'pre') {
    return {
      header: `${g.home.abbrev} v ${g.away.abbrev}`,
      body: [
        g.home.name,
        `v`,
        g.away.name,
        '',
        `${fmtStart(g.date)}${g.venue ? ' · ' + g.venue : ''}`,
      ].join('\n'),
      footer: 'tap: back · swipe: other games',
    }
  }
  const status = g.state === 'in' ? `● ${fmtLiveStatus(g)}` : 'Final'
  const body = [
    `${g.home.name}  ${g.home.score}`,
    q(g.home),
    `${g.away.name}  ${g.away.score}`,
    q(g.away),
    `${status}${g.venue ? ' · ' + g.venue : ''}`,
  ].filter(Boolean).join('\n')
  return {
    header: `${g.home.abbrev} v ${g.away.abbrev}`,
    body,
    footer: 'tap: back · swipe: other games',
  }
}

// ---------------------------------------------------------------------------
// Render pipeline

function layoutFor(page: Page): Layout {
  if (page === 'ladder') return 'ladder'
  if (page === 'teampick') return 'list'
  return 'text3'
}

function buildContents(page: Page): Record<string, string> {
  switch (page) {
    case 'scores': return buildScores()
    case 'fixtures': return buildFixtures()
    case 'ladder': return buildLadder()
    case 'myteam': return buildMyTeam()
    case 'detail': return buildDetail()
    case 'teampick': return {}
  }
}

export async function initGlasses(b: EvenAppBridge): Promise<boolean> {
  bridge = b
  const contents = buildContents(state.page)
  const containers = text3Containers(contents)
  const result = await enqueue(() =>
    b.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: containers.length,
      textObject: containers,
      menuObject: contextMenu(),
    } as any)),
  )
  created = result === StartUpPageCreateResult.success
  currentLayout = 'text3'
  lastContents = contents
  if (!created) console.error('[footy] createStartUpPageContainer failed:', result)
  return created
}

async function rebuild(layout: Layout, contents: Record<string, string>): Promise<void> {
  if (!bridge) return
  const payload: any = { menuObject: contextMenu() }
  if (layout === 'list') {
    const { text, list } = teamListContainers()
    payload.containerTotalNum = text.length + list.length
    payload.textObject = text
    payload.listObject = list
  } else {
    const containers = layout === 'ladder' ? ladderContainers(contents) : text3Containers(contents)
    payload.containerTotalNum = containers.length
    payload.textObject = containers
  }
  await enqueue(() => bridge!.rebuildPageContainer(new RebuildPageContainer(payload)))
  currentLayout = layout
  lastContents = contents
}

const CONTAINER_IDS: Record<string, number> = {
  header: 1, body: 2, footer: 3,
}
const LADDER_IDS: Record<string, number> = {
  header: 1, lteam: 2, lwl: 3, lpct: 4, lpts: 5, footer: 6,
}

async function upgrade(contents: Record<string, string>): Promise<void> {
  if (!bridge) return
  const ids = currentLayout === 'ladder' ? LADDER_IDS : CONTAINER_IDS
  for (const [name, content] of Object.entries(contents)) {
    if (lastContents[name] === content) continue
    await enqueue(() =>
      bridge!.textContainerUpgrade(new TextContainerUpgrade({
        containerID: ids[name],
        containerName: name,
        contentOffset: 0,
        contentLength: 0,
        content: content || ' ',
      })),
    )
  }
  lastContents = contents
}

/** Render the current page: in-place upgrade when the layout is unchanged, full rebuild otherwise. */
export async function render(force = false): Promise<void> {
  if (!bridge || !created) return
  const layout = layoutFor(state.page)
  const contents = buildContents(state.page)
  if (!force && layout === currentLayout && layout !== 'list') {
    await upgrade(contents)
  } else {
    await rebuild(layout, contents)
  }
}

// ---------------------------------------------------------------------------
// Input handling — called from main.ts event routing

export function setData(snapshot: Snapshot | null, ladder: LadderEntry[] | null, offline: boolean): void {
  if (snapshot) state.snapshot = snapshot
  if (ladder) state.ladder = ladder
  state.offline = offline
}

export function setFavTeam(abbrev: string): void {
  state.favTeam = abbrev
}

export function getFavTeam(): string {
  return state.favTeam
}

export function getPage(): Page {
  return state.page
}

export function goto(page: Page): void {
  state.page = page
  if (page === 'ladder') state.ladderPage = 0
}

export function onScroll(dir: 1 | -1): boolean {
  switch (state.page) {
    case 'scores':
    case 'fixtures': {
      const games = state.page === 'scores' ? scoresList() : (state.snapshot ? fixtures(state.snapshot) : [])
      if (games.length === 0) return false
      const key = state.page
      state.focus[key] = (state.focus[key] + dir + games.length) % games.length
      return true
    }
    case 'ladder':
      state.ladderPage += dir
      return true
    case 'detail': {
      if (!state.detail || !state.snapshot) return false
      const origin = state.detail.origin
      const list = origin === 'fixtures' ? fixtures(state.snapshot) : scoresList()
      if (list.length === 0) return false
      const idx = list.findIndex(g => g.id === state.detail!.gameId)
      const next = list[((idx < 0 ? 0 : idx) + dir + list.length) % list.length]
      state.detail.gameId = next.id
      return true
    }
    default:
      return false
  }
}

export function onClick(): boolean {
  switch (state.page) {
    case 'scores':
    case 'fixtures': {
      const games = state.page === 'scores' ? scoresList() : (state.snapshot ? fixtures(state.snapshot) : [])
      const focus = state.focus[state.page]
      const g = games[focus]
      if (!g) return false
      state.detail = { gameId: g.id, origin: state.page }
      state.page = 'detail'
      return true
    }
    case 'detail': {
      const origin = state.detail?.origin ?? 'scores'
      state.page = origin === 'myteam' ? 'myteam' : origin
      state.detail = null
      return true
    }
    case 'myteam': {
      const { live, next, last } = teamGames(state.favTeam)
      const g = live ?? next ?? last
      if (!g) return false
      state.detail = { gameId: g.id, origin: 'myteam' }
      state.page = 'detail'
      return true
    }
    default:
      return false
  }
}

/** Returns the picked club abbreviation, or null if the index is invalid. */
export function onTeamPicked(index: number): string | null {
  const club = CLUBS[index]
  if (!club) return null
  state.favTeam = club.abbrev
  state.page = 'myteam'
  return club.abbrev
}

export function hasLiveGames(): boolean {
  return state.snapshot ? liveGames(state.snapshot).length > 0 : false
}
