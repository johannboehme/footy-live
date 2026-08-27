// Phone-side UI shown inside the Even app's WebView (and in a plain browser
// during development). Mirrors the glasses data and hosts settings.
import { type Snapshot, type LadderEntry, type Game, liveGames, results, fixtures, CLUBS } from './afl'
import { fmtStart, fmtLiveStatus } from './format'

export interface PhoneUiModel {
  snapshot: Snapshot | null
  ladder: LadderEntry[] | null
  offline: boolean
  favTeam: string
  onPickTeam: (abbrev: string) => void
}

let root: HTMLElement | null = null

export function initPhoneUi(): void {
  root = document.querySelector<HTMLElement>('#app')
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

function gameCard(g: Game): string {
  const status =
    g.state === 'in' ? `<span class="live">● ${esc(fmtLiveStatus(g))}</span>`
    : g.state === 'post' ? 'Final'
    : esc(fmtStart(g.date))
  const score = (t: { score: number }, show: boolean) => (show ? String(t.score) : '')
  const showScore = g.state !== 'pre'
  const winner = (won: boolean) => (g.state === 'post' && won ? ' class="won"' : '')
  return `<div class="card game">
    <div class="teams">
      <div${winner(g.home.winner)}><span>${esc(g.home.name)}</span><b>${score(g.home, showScore)}</b></div>
      <div${winner(g.away.winner)}><span>${esc(g.away.name)}</span><b>${score(g.away, showScore)}</b></div>
    </div>
    <div class="meta">${status}${g.venue ? ` · ${esc(g.venue)}` : ''}</div>
  </div>`
}

function section(title: string, games: Game[]): string {
  if (games.length === 0) return ''
  return `<h2>${esc(title)}</h2>${games.map(gameCard).join('')}`
}

export function renderPhoneUi(model: PhoneUiModel): void {
  if (!root) return
  const { snapshot: s, ladder, offline, favTeam } = model

  const picker = `<h2>My team</h2><div class="card">
    <select id="team-picker">
      <option value="">— pick your club —</option>
      ${CLUBS.map(c => `<option value="${c.abbrev}"${c.abbrev === favTeam ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>
    <p class="hint">Shown on the My Team page on your glasses.</p>
  </div>`

  const ladderHtml = ladder?.length
    ? `<h2>Ladder</h2><div class="card"><table>
        <tr><th></th><th>Club</th><th>W-L</th><th>%</th><th>Pts</th></tr>
        ${ladder.map(e => `<tr${e.abbrev === favTeam ? ' class="fav"' : ''}>
          <td>${e.rank}</td><td>${esc(e.name)}</td>
          <td>${e.wins}-${e.losses}${e.ties ? '-' + e.ties : ''}</td>
          <td>${esc(e.percentage)}</td><td>${e.points}</td></tr>`).join('')}
      </table></div>`
    : ''

  const body = s
    ? section('Live', liveGames(s)) + section('Fixtures', fixtures(s)) + section('Results', results(s))
    : '<div class="card"><p>Loading scores…</p></div>'

  root.innerHTML = `
    <header>
      <h1>Footy Live</h1>
      <p class="sub">${s ? esc(`AFL ${s.roundLabel}`) : 'AFL scores on your glasses'}${offline ? ' · <span class="offline">offline</span>' : ''}</p>
    </header>
    ${body}
    ${picker}
    ${ladderHtml}
    <footer>
      <p>Scroll on the glasses to move between games, tap to open one, and use the
      contextual menu to switch between Scores, Fixtures, Ladder and My Team.</p>
      <p>Unofficial fan app. Data via ESPN's public feeds — not affiliated with
      the AFL or ESPN. Scores may lag broadcast by a few seconds.</p>
    </footer>`

  root.querySelector<HTMLSelectElement>('#team-picker')?.addEventListener('change', ev => {
    const abbrev = (ev.target as HTMLSelectElement).value
    if (abbrev) model.onPickTeam(abbrev)
  })
}
