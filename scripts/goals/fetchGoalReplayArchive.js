#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const cliProgress = require("cli-progress");

const GAMECENTER_BASE = "https://api-web.nhle.com/v1/gamecenter";
const DEFAULT_START_DATE = "2025-10-07";
const DEFAULT_END_DATE = "2026-04-01";
const DEFAULT_OUTPUT_DIR = path.resolve(
  process.cwd(),
  "data/goal-replay-archive",
);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_SCHEDULE_FILE = path.join(
  PROJECT_ROOT,
  "data",
  "misc",
  "schedule",
  "20252026",
  "regulation.json",
);

function parseArgs(argv) {
  const out = {
    startDate: DEFAULT_START_DATE,
    endDate: DEFAULT_END_DATE,
    outputDir: DEFAULT_OUTPUT_DIR,
    scheduleFile: DEFAULT_SCHEDULE_FILE,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--start-date" && argv[i + 1]) {
      out.startDate = argv[++i];
    } else if (arg === "--end-date" && argv[i + 1]) {
      out.endDate = argv[++i];
    } else if (arg === "--output-dir" && argv[i + 1]) {
      out.outputDir = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--schedule-file" && argv[i + 1]) {
      out.scheduleFile = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  return out;
}

function printHelp() {
  console.log(`Fetch NHL game play-by-play + goal replay payloads for a date range.

Uses local schedule file by default:
  ${DEFAULT_SCHEDULE_FILE}

Usage:
  node scripts/goals/fetchGoalReplayArchive.js [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--output-dir DIR] [--schedule-file FILE]

Defaults:
  --start-date    ${DEFAULT_START_DATE}
  --end-date      ${DEFAULT_END_DATE}
  --output-dir    ${DEFAULT_OUTPUT_DIR}
  --schedule-file ${DEFAULT_SCHEDULE_FILE}
`);
}

function assertDate(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${flag}: ${value}. Expected YYYY-MM-DD.`);
  }
}

function toIsoDate(value) {
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10);
}

function isOnOrBefore(dateA, dateB) {
  return dateA <= dateB;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} ${url}${text ? ` | ${text.slice(0, 180)}` : ""}`,
    );
  }
  return res.json();
}

async function collectGameIdsFromScheduleFile(
  scheduleFile,
  startDate,
  endDate,
) {
  const raw = await fs.readFile(scheduleFile, "utf8");
  const data = JSON.parse(raw);
  const games = Array.isArray(data?.games) ? data.games : [];

  const seen = new Set();
  const ordered = [];
  for (const game of games) {
    const gameDate = String(game?.gameDate || game?.gameDateTime || "").slice(
      0,
      10,
    );
    if (!gameDate) continue;
    if (!isOnOrBefore(startDate, gameDate) || !isOnOrBefore(gameDate, endDate))
      continue;
    const gameId = Number(game?.id);
    if (!gameId || seen.has(gameId)) continue;
    seen.add(gameId);
    ordered.push(gameId);
  }

  return ordered;
}

function getGoalPlays(playByPlay) {
  return (Array.isArray(playByPlay?.plays) ? playByPlay.plays : []).filter(
    (play) => play?.typeDescKey === "goal",
  );
}

function isShootoutGoal(play) {
  return (
    play?.periodDescriptor?.periodType === "SO" ||
    Number(play?.periodDescriptor?.number) === 5
  );
}

async function fetchGoalReplayData(url) {
  if (!url || typeof url !== "string") return null;
  if (!url.startsWith("https://wsr.nhle.com/sprites/")) return null;

  return fetchJson(url, {
    headers: {
      referer: "https://www.nhl.com/",
      "user-agent": "Mozilla/5.0 Chrome/130.0.0.0",
    },
  });
}

async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function run() {
  const { startDate, endDate, outputDir, scheduleFile } = parseArgs(
    process.argv,
  );
  assertDate(startDate, "--start-date");
  assertDate(endDate, "--end-date");

  const normalizedStart = toIsoDate(startDate);
  const normalizedEnd = toIsoDate(endDate);
  if (normalizedStart > normalizedEnd) {
    throw new Error(
      `--start-date (${normalizedStart}) must be <= --end-date (${normalizedEnd})`,
    );
  }

  await fs.mkdir(outputDir, { recursive: true });

  console.log(
    `Loading scheduled game IDs from ${scheduleFile} for ${normalizedStart} to ${normalizedEnd}...`,
  );
  const gameIds = await collectGameIdsFromScheduleFile(
    scheduleFile,
    normalizedStart,
    normalizedEnd,
  );

  const gameIdsToProcess = [];
  let skippedExisting = 0;
  for (const gameId of gameIds) {
    const gameDir = path.join(outputDir, String(gameId));
    if (await directoryExists(gameDir)) {
      const errorFile = path.join(gameDir, "error.json");
      try {
        await fs.access(errorFile);
        // Directory exists but has an error — retry it
        await fs.rm(gameDir, { recursive: true });
        gameIdsToProcess.push(gameId);
      } catch {
        // No error file — already succeeded
        skippedExisting++;
      }
      continue;
    }
    gameIdsToProcess.push(gameId);
  }

  console.log(`Found ${gameIds.length} games from schedule file.`);
  console.log(`Skipping ${skippedExisting} existing game directories.`);
  console.log(`Processing ${gameIdsToProcess.length} new games.`);

  const progressBar = new cliProgress.SingleBar(
    {
      format:
        "Goal replay archive |{bar}| {percentage}% | {value}/{total} games | game={gameId} goals={goalDone}/{goalTotal} errors={errors}",
      barCompleteChar: "\u2588",
      barIncompleteChar: "\u2591",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );

  let completedGames = 0;
  let totalGoals = 0;
  let savedGoals = 0;
  let skippedShootoutGoals = 0;
  let errors = 0;
  const errorDetails = [];

  progressBar.start(Math.max(1, gameIdsToProcess.length), 0, {
    gameId: "-",
    goalDone: 0,
    goalTotal: 0,
    errors,
  });

  for (const gameId of gameIdsToProcess) {
    const gameDir = path.join(outputDir, String(gameId));
    await fs.mkdir(gameDir, { recursive: true });

    let goalDone = 0;
    let goalTotal = 0;

    try {
      const pbpUrl = `${GAMECENTER_BASE}/${gameId}/play-by-play`;
      const pbpData = await fetchJson(pbpUrl);
      await fs.writeFile(
        path.join(gameDir, "pbp.json"),
        JSON.stringify(pbpData, null, 2),
      );

      const goals = getGoalPlays(pbpData);
      goalTotal = goals.length;
      totalGoals += goalTotal;

      for (let i = 0; i < goals.length; i++) {
        const goal = goals[i];
        if (isShootoutGoal(goal)) {
          skippedShootoutGoals++;
          goalDone = i + 1;
          progressBar.update(completedGames, {
            gameId,
            goalDone,
            goalTotal,
            errors,
          });
          continue;
        }

        const replayUrl = goal?.pptReplayUrl;
        const targetPath = path.join(gameDir, `goal-${i + 1}.json`);
        const payload = await fetchGoalReplayData(replayUrl);

        if (payload) {
          await fs.writeFile(targetPath, JSON.stringify(payload, null, 2));
          savedGoals++;
        } else {
          await fs.writeFile(
            targetPath,
            JSON.stringify(
              {
                error: "Missing or invalid pptReplayUrl",
                pptReplayUrl: replayUrl ?? null,
                eventId: goal?.eventId ?? null,
              },
              null,
              2,
            ),
          );
        }

        goalDone = i + 1;
        progressBar.update(completedGames, {
          gameId,
          goalDone,
          goalTotal,
          errors,
        });
      }
    } catch (err) {
      errors++;
      const msg = String(err?.message || err);
      errorDetails.push({ gameId, error: msg });
      await fs.writeFile(
        path.join(gameDir, "error.json"),
        JSON.stringify({ error: msg }, null, 2),
      );
    }

    completedGames++;
    progressBar.update(completedGames, {
      gameId,
      goalDone,
      goalTotal,
      errors,
    });
  }

  progressBar.stop();

  console.log("Done.");
  console.log(`Output: ${outputDir}`);
  console.log(`Games found in range: ${gameIds.length}`);
  console.log(`Games skipped (already processed): ${skippedExisting}`);
  console.log(`Games processed this run: ${completedGames}`);
  console.log(`Goal events: ${totalGoals}`);
  console.log(`Goal replay payloads saved: ${savedGoals}`);
  console.log(
    `Shootout goals skipped (no replay fetch, no file write): ${skippedShootoutGoals}`,
  );
  console.log(`Errors: ${errors}`);
  if (errorDetails.length > 0) {
    console.log("\nError details:");
    for (const { gameId, error } of errorDetails) {
      console.log(`  Game ${gameId}: ${error}`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
