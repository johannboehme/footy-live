# Footy Live

Live AFL scores, fixtures and the ladder on your Even Realities G2 smart glasses.

An [Even Hub](https://hub.evenrealities.com) app. Glanceable footy: live scores
update in place every 30 seconds while a game is on, and the OS contextual menu
(long-press) switches between pages without touching the display layout.

| Scores (live) | Game detail |
|---|---|
| ![Scores](docs/scores-live.png) | ![Game detail](docs/game-detail.png) |

| Fixtures | Ladder |
|---|---|
| ![Fixtures](docs/fixtures.png) | ![Ladder](docs/ladder.png) |

| Contextual menu | Team picker | My Team |
|---|---|---|
| ![Menu](docs/context-menu.png) | ![Picker](docs/team-picker.png) | ![My Team](docs/my-team.png) |

## Pages

- **Scores** — live games first (`● WB 68 v COLL 59  Q3 12:40`), then the last
  round's results (`HAW 107 d WCE 45`, winner first, the way footy results read).
- **Fixtures** — upcoming games for the next two weeks, in your local time.
- **Ladder** — all 18 clubs with W-L, percentage and premiership points, in
  pixel-aligned columns; your club is starred.
- **My Team** — your club's live or next game, last result and ladder position.
- **Game detail** — tap any game: full team names, quarter-by-quarter scores,
  status and venue. Swipe to flip through the other games.

## Controls

| Gesture | Action |
|---|---|
| Swipe up / down | Move between games, flip ladder pages |
| Tap | Open the focused game / go back from detail |
| Long-press | OS contextual menu: Scores · Fixtures · Ladder · My Team · Set My Team · Refresh |
| Double tap | Exit (system dialog) |

## Tech notes

- Vite + TypeScript, no framework; `@evenrealities/even_hub_sdk` 0.0.14.
- Uses the SDK 0.0.14 **contextual menu** (`menuObject` + `menuItemClickEvent`)
  for navigation and **text brightness** (`textColor`) for dimmed footers.
- Live updates go through `textContainerUpgrade` (flicker-free, in place);
  layout changes go through `rebuildPageContainer`. All bridge calls are
  serialized through a queue with a hard timeout.
- Polls every 30 s while a game is live, every 5 min otherwise, and pauses in
  the background.
- Phone-side WebView shows the same data plus a favourite-team picker, styled
  to the Even app design tokens.

## Development

```bash
npm install
npm run dev                                   # http://localhost:5173
npx evenhub-simulator http://localhost:5173   # desktop G2 simulator
```

Append `?mocklive` to the dev URL to fake a live game (dev builds only).

Package for Even Hub:

```bash
npm run build
npx evenhub pack app.json dist -o footy-live.ehpk
```

## Data

Scores come from ESPN's public JSON feeds. This is an unofficial fan project —
not affiliated with, or endorsed by, the AFL or ESPN. Scores may lag broadcast
by a few seconds, and the feed can change without notice.
