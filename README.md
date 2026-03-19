# goal-analysis

NHL goal classification pipeline. Fetches play-by-play and goal replay tracking data from the NHL API, then classifies each goal by play type (Rush, Cycle, Net-front, Seam, Broken Coverage, Rebound/Scramble).

## Setup

```bash
npm install
npm run setup
```

`npm run setup` downloads the goal replay archive (~161 MB compressed, ~2.5 GB extracted) from the GitHub release. Requires the [GitHub CLI](https://cli.github.com/).

## Pipeline

### 1. Fetch goal replay archive

```bash
npm run fetch
```

Fetches play-by-play data and goal replay tracking payloads from the NHL Game Center API for every game in the schedule file. Each game gets a directory under `data/goal-replay-archive/{gameId}/` containing:

- `pbp.json` — full play-by-play
- `goal-{n}.json` — puck/player tracking frames for each goal

Games that have already been fetched are skipped on re-runs. Games that previously errored are retried.

Options (pass after `--`):

| Flag | Default | Description |
|---|---|---|
| `--start-date` | `2025-10-07` | Start of date range (YYYY-MM-DD) |
| `--end-date` | `2026-04-01` | End of date range (YYYY-MM-DD) |
| `--output-dir` | `data/goal-replay-archive` | Where to write game directories |
| `--schedule-file` | `data/misc/schedule/20252026/regulation.json` | Local schedule file |

### 2. Classify goals by team

```bash
npm run classify
```

Reads the goal replay archive, classifies each goal using the taxonomy in `src/util/goalTaxonomy.js`, and writes per-team output files to `data/goal-classification-by-team/{TRICODE}.json`.

Each team file contains players and their goals:

```json
{
  "players": [
    {
      "id": 8475166,
      "goals": [
        {
          "gameId": 2025020049,
          "goalIndex": 5,
          "date": "2025-10-14",
          "opponentTricode": "NSH",
          "shotType": "wrist",
          "goalClassification": "Rebound/Scramble"
        }
      ]
    }
  ]
}
```

Options (pass after `--`):

| Flag | Default | Description |
|---|---|---|
| `--input-dir` | `data/goal-replay-archive` | Archive directory |
| `--output-dir` | `data/goal-classification-by-team` | Where to write team files |
| `--taxonomy-path` | `src/util/goalTaxonomy.js` | Goal classification module |
| `--max-games` | all | Limit number of games to process |

## Data

| Directory | Tracked | Description |
|---|---|---|
| `data/goal-replay-archive/` | No (gitignored) | Raw PBP + tracking frames per game. Downloaded via `npm run setup` or fetched via `npm run fetch`. |
| `data/goal-classification-by-team/` | Yes | Per-team goal classifications. |
| `data/misc/schedule/` | Yes | NHL schedule used by the fetch script. |

## Goal classifications

| Category | Description |
|---|---|
| Rush | Odd-man rush or transition attack |
| Cycle | Extended offensive zone possession |
| Net-front | Tip, deflection, or screen from the crease area |
| Seam | Cross-ice or seam pass leading to a one-timer |
| Broken Coverage | Defensive breakdown leaving a player open |
| Rebound/Scramble | Second-chance goal off a rebound or scramble |
