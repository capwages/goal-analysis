#!/usr/bin/env node

const fs = require('fs/promises')
const path = require('path')
const cliProgress = require('cli-progress')

const SCRIPT_DIR = __dirname
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_INPUT_DIR = path.join(PROJECT_ROOT, 'data', 'goal-replay-archive')
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'goal-classification-by-team')
const DEFAULT_TAXONOMY_PATH = path.join(PROJECT_ROOT, 'src', 'util', 'goalTaxonomy.js')
const NHL_TRICODES = new Set([
	'ANA', 'BOS', 'BUF', 'CAR', 'CBJ', 'CGY', 'CHI', 'COL',
	'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NJD',
	'NSH', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
	'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WPG', 'WSH',
])

function parseArgs(argv) {
	const args = {
		inputDir: DEFAULT_INPUT_DIR,
		outputDir: DEFAULT_OUTPUT_DIR,
		taxonomyPath: DEFAULT_TAXONOMY_PATH,
		maxGames: null,
	}

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--input-dir' && argv[i + 1]) {
			args.inputDir = path.resolve(process.cwd(), argv[++i])
		} else if (arg === '--output-dir' && argv[i + 1]) {
			args.outputDir = path.resolve(process.cwd(), argv[++i])
		} else if (arg === '--taxonomy-path' && argv[i + 1]) {
			args.taxonomyPath = path.resolve(process.cwd(), argv[++i])
		} else if (arg === '--max-games' && argv[i + 1]) {
			args.maxGames = Number(argv[++i])
		} else if (arg === '--help') {
			printHelp()
			process.exit(0)
		}
	}

	return args
}

function printHelp() {
	console.log(`Build per-team goal classification files from archived goal replay data.

Usage:
  node scripts/goals/buildGoalClassificationsByTeam.js [--input-dir DIR] [--output-dir DIR] [--taxonomy-path FILE] [--max-games N]

Defaults:
  --input-dir     ${DEFAULT_INPUT_DIR}
  --output-dir    ${DEFAULT_OUTPUT_DIR}
  --taxonomy-path ${DEFAULT_TAXONOMY_PATH}
`)
}

async function loadClassifier(taxonomyPath) {
	const source = await fs.readFile(taxonomyPath, 'utf8')
	const blob = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
	const mod = await import(blob)
	if (!mod || typeof mod.classifyGoal !== 'function') {
		throw new Error(`Could not load classifyGoal from ${taxonomyPath}`)
	}
	return mod.classifyGoal
}

async function readJson(filePath) {
	const raw = await fs.readFile(filePath, 'utf8')
	return JSON.parse(raw)
}

async function fileExists(filePath) {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

function isNhlTricode(code) {
	return NHL_TRICODES.has(String(code || '').toUpperCase())
}

function getTeamAbbrevMap(pbp) {
	const map = new Map()
	const awayId = pbp?.awayTeam?.id
	const homeId = pbp?.homeTeam?.id
	const awayAbbrev = pbp?.awayTeam?.abbrev || pbp?.awayTeam?.triCode || null
	const homeAbbrev = pbp?.homeTeam?.abbrev || pbp?.homeTeam?.triCode || null
	if (awayId && awayAbbrev) map.set(Number(awayId), String(awayAbbrev).toUpperCase())
	if (homeId && homeAbbrev) map.set(Number(homeId), String(homeAbbrev).toUpperCase())
	return map
}

function getPlayerTeamAbbrevMap(pbp, teamById) {
	const map = new Map()
	for (const player of Array.isArray(pbp?.rosterSpots) ? pbp.rosterSpots : []) {
		const playerId = Number(player?.playerId)
		if (!playerId) continue
		const teamId = Number(player?.teamId)
		const abbrev = teamById.get(teamId)
		if (abbrev) map.set(playerId, abbrev)
	}
	return map
}

function getGoalPlays(pbp) {
	return (Array.isArray(pbp?.plays) ? pbp.plays : []).filter((play) => play?.typeDescKey === 'goal')
}

function isShootoutGoal(play) {
	return play?.periodDescriptor?.periodType === 'SO' || Number(play?.periodDescriptor?.number) === 5
}

function getTeamAbbrevForGoal(play, details, teamById, playerTeamById) {
	return String(
		details?.eventOwnerTeamAbbrev ||
		details?.scoringTeamAbbrev ||
		teamById.get(Number(details?.eventOwnerTeamId)) ||
		playerTeamById.get(Number(details?.scoringPlayerId)) ||
		'UNK',
	).toUpperCase()
}

function getGoalHint(play, details, teamAbbrev, homeTricode, awayTricode) {
	return {
		xCoord: details?.xCoord ?? details?.xCoordinate ?? null,
		yCoord: details?.yCoord ?? details?.yCoordinate ?? null,
		teamAbbrev,
		homeTricode,
		awayTricode,
		homeTeamDefendingSide: play?.homeTeamDefendingSide || null,
		scoringPlayerId: details?.scoringPlayerId || null,
		goalieInNetId: details?.goalieInNetId ?? null,
	}
}

function upsertGoalRecord(store, teamAbbrev, playerId, goalRecord) {
	if (!store.has(teamAbbrev)) {
		store.set(teamAbbrev, new Map())
	}
	const players = store.get(teamAbbrev)
	if (!players.has(playerId)) {
		players.set(playerId, { id: playerId, goals: [] })
	}
	const player = players.get(playerId)
	const existingIdx = player.goals.findIndex(
		(g) => Number(g.gameId) === Number(goalRecord.gameId) && Number(g.goalIndex) === Number(goalRecord.goalIndex),
	)
	if (existingIdx >= 0) {
		player.goals[existingIdx] = goalRecord
	} else {
		player.goals.push(goalRecord)
	}
}

function finalizeTeamPayload(playerMap) {
	const players = Array.from(playerMap.values())
	players.sort((a, b) => Number(a.id) - Number(b.id))
	for (const player of players) {
		player.goals.sort((a, b) => {
			if (Number(a.gameId) !== Number(b.gameId)) return Number(a.gameId) - Number(b.gameId)
			return Number(a.goalIndex) - Number(b.goalIndex)
		})
	}
	return { players }
}

async function clearOutputDir(outputDir) {
	await fs.mkdir(outputDir, { recursive: true })
	const entries = await fs.readdir(outputDir, { withFileTypes: true })
	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith('.json')) {
			await fs.unlink(path.join(outputDir, entry.name))
		}
	}
}

function sortGameDirs(gameDirs) {
	return gameDirs.sort((a, b) => Number(a) - Number(b))
}

function getGamedayGoalPath(homeTricode, awayTricode, gameId, goalIndex) {
	const away = String(awayTricode || 'UNK').toUpperCase()
	const home = String(homeTricode || 'UNK').toUpperCase()
	return `/gameday/${away}-${home}?gameId=${Number(gameId)}&goal=${Number(goalIndex)}`
}

async function run() {
	const args = parseArgs(process.argv)
	const classifyGoal = await loadClassifier(args.taxonomyPath)

	const archiveEntries = await fs.readdir(args.inputDir, { withFileTypes: true })
	let gameDirs = archiveEntries
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.filter((name) => /^\d+$/.test(name))
	gameDirs = sortGameDirs(gameDirs)

	if (Number.isFinite(args.maxGames) && args.maxGames > 0) {
		gameDirs = gameDirs.slice(0, args.maxGames)
	}

	if (gameDirs.length === 0) {
		console.log('No game folders found in archive.')
		return
	}

	const teamStore = new Map()
	let goalCount = 0
	let classifiedCount = 0
	let skippedGoals = 0
	let errors = 0
	const unknownClassificationGoals = []
	const unknownGoalFrameIdxGoals = []
	const unknownClassificationGoalLinks = []
	const unknownGoalFrameIdxLinks = []

	const bar = new cliProgress.SingleBar(
		{
			format:
				'Team goal classifications |{bar}| {percentage}% | {value}/{total} games | goals={goals} classified={classified} skipped={skipped} errors={errors}',
			barCompleteChar: '\u2588',
			barIncompleteChar: '\u2591',
			hideCursor: true,
		},
		cliProgress.Presets.shades_classic,
	)
	bar.start(gameDirs.length, 0, { goals: 0, classified: 0, skipped: 0, errors: 0 })

	for (let gi = 0; gi < gameDirs.length; gi++) {
		const gameId = gameDirs[gi]
		const gameDir = path.join(args.inputDir, gameId)
		const pbpPath = path.join(gameDir, 'pbp.json')

		try {
			if (!(await fileExists(pbpPath))) {
				errors++
				bar.update(gi + 1, {
					goals: goalCount,
					classified: classifiedCount,
					skipped: skippedGoals,
					errors,
				})
				continue
			}

			const pbp = await readJson(pbpPath)
			const goals = getGoalPlays(pbp)
			const teamById = getTeamAbbrevMap(pbp)
			const playerTeamById = getPlayerTeamAbbrevMap(pbp, teamById)
			const homeTricode = String(pbp?.homeTeam?.abbrev || pbp?.homeTeam?.triCode || '').toUpperCase() || null
			const awayTricode = String(pbp?.awayTeam?.abbrev || pbp?.awayTeam?.triCode || '').toUpperCase() || null
			const gameDate = pbp?.gameDate || String(pbp?.startTimeUTC || '').slice(0, 10) || null

			for (let i = 0; i < goals.length; i++) {
				const goalIndex = i + 1
				goalCount++
				const play = goals[i]
				const details = play?.details || {}
				const scorerId = Number(details?.scoringPlayerId)

				if (!scorerId) {
					skippedGoals++
					continue
				}

				const teamAbbrev = getTeamAbbrevForGoal(play, details, teamById, playerTeamById)
				if (!isNhlTricode(teamAbbrev)) {
					skippedGoals++
					continue
				}
				if (isShootoutGoal(play)) {
					skippedGoals++
					continue
				}

				const goalFilePath = path.join(gameDir, `goal-${goalIndex}.json`)
				let goalClassification = null
				let goalFrameIdx = null

				if (await fileExists(goalFilePath)) {
					try {
						const replayFrames = await readJson(goalFilePath)
						if (Array.isArray(replayFrames) && replayFrames.length > 0) {
							const hint = getGoalHint(play, details, teamAbbrev, homeTricode, awayTricode)
							const out = classifyGoal(replayFrames, { goalEventHint: hint })
							goalClassification = out?.classification?.primary ?? null
							goalFrameIdx = out?.meta?.goalFrameIdx ?? out?.meta?.goamFrameIx ?? null
							if (goalClassification) classifiedCount++
						} else {
							skippedGoals++
						}
					} catch {
						errors++
					}
				} else {
					skippedGoals++
				}

				const goalRecord = {
					gameId: Number(gameId),
					goalIndex,
					date: gameDate,
					opponentTricode:
						teamAbbrev === homeTricode ? awayTricode : teamAbbrev === awayTricode ? homeTricode : null,
					shotType: details?.shotType ?? null,
					goalClassification,
				}
				upsertGoalRecord(teamStore, teamAbbrev, scorerId, goalRecord)
				const gamedayPath = getGamedayGoalPath(homeTricode, awayTricode, gameId, goalIndex)

				if (goalClassification == null) {
					unknownClassificationGoalLinks.push(gamedayPath)
					unknownClassificationGoals.push({
						gameId: Number(gameId),
						goalIndex,
						date: gameDate,
						gamedayPath,
						teamAbbrev,
						scorerId,
						opponentTricode: goalRecord.opponentTricode,
						shotType: goalRecord.shotType,
					})
				}

				if (goalFrameIdx == null) {
					unknownGoalFrameIdxLinks.push(gamedayPath)
					unknownGoalFrameIdxGoals.push({
						gameId: Number(gameId),
						goalIndex,
						date: gameDate,
						gamedayPath,
						teamAbbrev,
						scorerId,
						opponentTricode: goalRecord.opponentTricode,
						shotType: goalRecord.shotType,
						goalClassification,
					})
				}
			}
		} catch {
			errors++
		}

		bar.update(gi + 1, {
			goals: goalCount,
			classified: classifiedCount,
			skipped: skippedGoals,
			errors,
		})
	}

	bar.stop()

	await clearOutputDir(args.outputDir)
	const teamCodes = Array.from(teamStore.keys()).sort()
	for (const tricode of teamCodes) {
		const payload = finalizeTeamPayload(teamStore.get(tricode))
		const outPath = path.join(args.outputDir, `${tricode}.json`)
		await fs.writeFile(outPath, JSON.stringify(payload, null, 2))
	}

	await fs.writeFile(
		path.join(args.outputDir, 'unknown-goal-classification.json'),
		JSON.stringify(unknownClassificationGoals, null, 2),
	)
	await fs.writeFile(
		path.join(args.outputDir, 'unknown-goal-classification-links.txt'),
		`${unknownClassificationGoalLinks.join('\n')}${unknownClassificationGoalLinks.length ? '\n' : ''}`,
	)
	await fs.writeFile(
		path.join(args.outputDir, 'unknown-goal-frame-idx.json'),
		JSON.stringify(unknownGoalFrameIdxGoals, null, 2),
	)
	await fs.writeFile(
		path.join(args.outputDir, 'unknown-goal-frame-idx-links.txt'),
		`${unknownGoalFrameIdxLinks.join('\n')}${unknownGoalFrameIdxLinks.length ? '\n' : ''}`,
	)

	console.log('Done.')
	console.log(`Input archive: ${args.inputDir}`)
	console.log(`Output dir: ${args.outputDir}`)
	console.log(`Teams written: ${teamCodes.length}`)
	console.log(`Goals scanned: ${goalCount}`)
	console.log(`Goals classified: ${classifiedCount}`)
	console.log(`Goals skipped (missing scorer/replay/non-NHL team/shootout): ${skippedGoals}`)
	console.log(`Goals with unknown classification (classification.primary=null): ${unknownClassificationGoals.length}`)
	console.log(
		`Goals with unknown goalFrameIdx (meta.goalFrameIdx/meta.goamFrameIx=null): ${unknownGoalFrameIdxGoals.length}`,
	)
	console.log(`Errors: ${errors}`)
}

run().catch((err) => {
	console.error(err)
	process.exit(1)
})
