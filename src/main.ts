// Footy Live — AFL live scores for Even Realities G2.
// Entry point: bridge init, event routing, data polling, persistence, phone UI.
import { waitForEvenAppBridge, EvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { fetchSnapshot, fetchLadder, type Snapshot, type LadderEntry } from './afl'
import * as ui from './glasses'
import { MENU } from './glasses'
import { initPhoneUi, renderPhoneUi } from './phone'

const FAV_KEY = 'footy.favTeam'
const LIVE_POLL_MS = 30_000
const IDLE_POLL_MS = 5 * 60_000
const LADDER_TTL_MS = 15 * 60_000

let bridge: EvenAppBridge | null = null
let snapshot: Snapshot | null = null
let ladder: LadderEntry[] | null = null
let ladderFetchedAt = 0
let offline = false
let foregrounded = true
let pollTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeEvents: (() => void) | null = null

async function saveFavTeam(abbrev: string): Promise<void> {
  ui.setFavTeam(abbrev)
  try {
    if (bridge) await bridge.setLocalStorage(FAV_KEY, abbrev)
    else localStorage.setItem(FAV_KEY, abbrev)
  } catch (err) {
    console.warn('[footy] could not persist favourite team:', err)
  }
}

async function loadFavTeam(): Promise<string> {
  try {
    if (bridge) return (await bridge.getLocalStorage(FAV_KEY)) || ''
    return localStorage.getItem(FAV_KEY) || ''
  } catch {
    return ''
  }
}

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  if (!foregrounded) return
  const delay = ui.hasLiveGames() ? LIVE_POLL_MS : IDLE_POLL_MS
  pollTimer = setTimeout(() => void refreshData(), delay)
}

async function refreshData(opts: { withLadder?: boolean } = {}): Promise<void> {
  const wantLadder = opts.withLadder || Date.now() - ladderFetchedAt > LADDER_TTL_MS
  try {
    const [snap, lad] = await Promise.all([
      fetchSnapshot(),
      wantLadder ? fetchLadder() : Promise.resolve(null),
    ])
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('mocklive')) {
      const g = snap.games.find(x => x.state === 'pre')
      if (g) {
        g.state = 'in'
        g.period = 3
        g.clock = '12:40'
        g.home.score = 68
        g.home.quarters = [21, 26, 21]
        g.away.score = 59
        g.away.quarters = [18, 22, 19]
      }
    }
    snapshot = snap
    if (lad) {
      ladder = lad
      ladderFetchedAt = Date.now()
    }
    offline = false
  } catch (err) {
    console.warn('[footy] data refresh failed:', err)
    offline = true
  }
  ui.setData(snapshot, ladder, offline)
  await ui.render()
  renderPhoneUi({ snapshot, ladder, offline, favTeam: ui.getFavTeam(), onPickTeam: pickTeamFromPhone })
  schedulePoll()
}

async function pickTeamFromPhone(abbrev: string): Promise<void> {
  await saveFavTeam(abbrev)
  if (ui.getPage() === 'myteam' || ui.getPage() === 'ladder') await ui.render()
  renderPhoneUi({ snapshot, ladder, offline, favTeam: abbrev, onPickTeam: pickTeamFromPhone })
}

async function handleMenu(itemId: number): Promise<void> {
  switch (itemId) {
    case MENU.scores: ui.goto('scores'); break
    case MENU.fixtures: ui.goto('fixtures'); break
    case MENU.ladder: ui.goto('ladder'); break
    case MENU.myteam: ui.goto('myteam'); break
    case MENU.teampick: ui.goto('teampick'); break
    case MENU.refresh:
      await refreshData({ withLadder: true })
      return
    default:
      return
  }
  await ui.render()
  if (itemId === MENU.ladder && Date.now() - ladderFetchedAt > LADDER_TTL_MS) {
    void refreshData({ withLadder: true })
  }
}

function cleanup(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  unsubscribeEvents?.()
  unsubscribeEvents = null
}

function wireEvents(b: EvenAppBridge): void {
  unsubscribeEvents = b.onEvenHubEvent(event => {
    void (async () => {
      const menuClick = (event as any).menuItemClickEvent
      // Any interaction proves the app is in the foreground. The OS contextual
      // menu fires FOREGROUND_EXIT without a matching ENTER, so without this
      // the poll timer would die the first time the menu is opened.
      if (menuClick || event.listEvent || event.textEvent) {
        foregrounded = true
        if (!pollTimer) schedulePoll()
      }
      if (menuClick) {
        await handleMenu(menuClick.itemID ?? 0)
        return
      }
      if (event.listEvent) {
        const idx = event.listEvent.currentSelectItemIndex ?? 0
        const picked = ui.onTeamPicked(idx)
        if (picked) {
          await saveFavTeam(picked)
          await ui.render()
        }
        return
      }
      if (event.textEvent) {
        const type = event.textEvent.eventType ?? 0
        const dir = type === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : type === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : 0
        if (dir && ui.onScroll(dir as 1 | -1)) await ui.render()
        return
      }
      if (event.sysEvent) {
        const type = event.sysEvent.eventType ?? 0
        if (type === OsEventTypeList.CLICK_EVENT || type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
          foregrounded = true
          if (!pollTimer) schedulePoll()
        }
        if (type === OsEventTypeList.CLICK_EVENT) {
          if (ui.onClick()) await ui.render()
        } else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
          // System exit dialog; cleanup happens on SYSTEM_EXIT if confirmed.
          await b.shutDownPageContainer(1)
        } else if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
          foregrounded = true
          await ui.render(true)
          await refreshData()
        } else if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
          foregrounded = false
          if (pollTimer) clearTimeout(pollTimer)
          pollTimer = null
        } else if (type === OsEventTypeList.ABNORMAL_EXIT_EVENT || type === OsEventTypeList.SYSTEM_EXIT_EVENT) {
          cleanup()
        }
      }
    })()
  })
}

async function start(): Promise<void> {
  initPhoneUi()
  renderPhoneUi({ snapshot: null, ladder: null, offline: false, favTeam: '', onPickTeam: pickTeamFromPhone })

  // In a plain browser (no Even app host) the bridge never appears — run the
  // phone UI standalone so the app is still previewable and debuggable.
  bridge = await Promise.race([
    waitForEvenAppBridge(),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 2500)),
  ])

  ui.setFavTeam(await loadFavTeam())

  if (bridge) {
    wireEvents(bridge)
    const ok = await ui.initGlasses(bridge)
    if (!ok) console.error('[footy] glasses page creation failed')
  }

  await refreshData({ withLadder: true })
}

void start()
