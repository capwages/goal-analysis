/**
 * Goal Taxonomy Detector
 *
 * Classifies NHL goals into archetypes using player/puck tracking frames.
 * Archetypes: Rush, Cycle, Net-front, Seam, Broken Coverage, Rebound/Scramble
 */

// Constants from GoalReplay.js
const RAW_W = 2400
const RAW_H = 1020
const FT_PER_RAW = 200 / RAW_W // ~0.0833 ft per raw unit
const DT = 0.1 // 10 fps

// Rink landmarks (raw coords)
const CENTER_X = RAW_W / 2 // 1200
const CENTER_Y = RAW_H / 2 // 510
const GOAL_LINE_LEFT = 168
const GOAL_LINE_RIGHT = 2242
const BLUE_LINE_LEFT = 871
const BLUE_LINE_RIGHT = 1527

// Feature thresholds
const DEFENDER_PROXIMITY_FT = 8
const SHORT_WINDOW = 15 // last 1.5s
const RUSH_WINDOW = 30 // last 3s for rush puck Vx
const CONE_HALF_ANGLE = Math.PI / 6 // 30-degree shooting cone
const FREE_PUCK_FT = 6 // min distance to consider puck "possessed"
const GOALIE_NEAR_NET_FT = 30 // max distance to count as "near net"
const GOALIE_NEAR_NET_FRAC = 0.5 // must be near net this fraction of frames
const GOALIE_MAX_AVG_DIST_FT = 15 // empty-net threshold

// Danger zone: inner OZ near slot
const DANGER_DX = 350 // raw units from goal line
const DANGER_DY = 220 // raw units from goal center Y

// Slot-ish for cycle/slot touches
const SLOT_DX = 250
const SLOT_DY = 120

// ── Helpers ──

function dist(a, b) {
	return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

function distFt(a, b) {
	return dist(a, b) * FT_PER_RAW
}

/** Shortest absolute angle difference, handles -π/π wrap */
function angleDiff(a, b) {
	let d = a - b
	while (d > Math.PI) d -= 2 * Math.PI
	while (d < -Math.PI) d += 2 * Math.PI
	return Math.abs(d)
}

function getPuck(frame) {
	const onIce = frame?.onIce
	if (!onIce) return null
	for (const e of Object.values(onIce)) {
		if (e.id === 1) return e
	}
	return null
}

function getPlayers(frame) {
	const onIce = frame?.onIce
	if (!onIce) return []
	return Object.values(onIce).filter((e) => e.id !== 1)
}

function mean(arr) {
	if (!arr.length) return 0
	return arr.reduce((s, v) => s + v, 0) / arr.length
}

function variance(arr) {
	if (arr.length < 2) return 0
	const m = mean(arr)
	return mean(arr.map((v) => (v - m) ** 2))
}

function nearestPlayer(frame, target, team) {
	let best = null
	let bestD = Infinity
	for (const p of getPlayers(frame)) {
		if (team && p.teamAbbrev !== team) continue
		const d = distFt(p, target)
		if (d < bestD) {
			bestD = d
			best = p
		}
	}
	return { player: best, dist: bestD }
}

function inDanger(puck, goalX, goalY) {
	return Math.abs(puck.x - goalX) < DANGER_DX && Math.abs(puck.y - goalY) < DANGER_DY
}

function inferAttackingRightByClosestNet(frames) {
	let minLeft = Infinity
	let minRight = Infinity
	const leftGoal = { x: GOAL_LINE_LEFT, y: CENTER_Y }
	const rightGoal = { x: GOAL_LINE_RIGHT, y: CENTER_Y }

	for (const f of frames) {
		const puck = getPuck(f)
		if (!puck) continue
		minLeft = Math.min(minLeft, dist(puck, leftGoal))
		minRight = Math.min(minRight, dist(puck, rightGoal))
	}

	// If no puck points were found, retain the existing default orientation.
	if (!isFinite(minLeft) || !isFinite(minRight)) {
		return { attackingRight: true, minLeft, minRight, hasSignal: false }
	}

	return {
		attackingRight: minRight < minLeft,
		minLeft,
		minRight,
		hasSignal: true,
	}
}

function inferAttackingRightFromGoalEvent(goalEventHint) {
	if (!goalEventHint) return null

	const xCoord = Number(goalEventHint.xCoord)
	if (isFinite(xCoord) && Math.abs(xCoord) >= 15) {
		return xCoord > 0
	}

	const homeDefendingSide = String(goalEventHint.homeTeamDefendingSide || '').toLowerCase()
	const scoringTeam = goalEventHint.teamAbbrev
	const homeTricode = goalEventHint.homeTricode
	const awayTricode = goalEventHint.awayTricode

	if ((homeDefendingSide === 'left' || homeDefendingSide === 'right') && scoringTeam && homeTricode && awayTricode) {
		const homeDefendsRight = homeDefendingSide === 'right'
		if (scoringTeam === homeTricode) return !homeDefendsRight
		if (scoringTeam === awayTricode) return homeDefendsRight
	}

	return null
}

function goalEventTargetYDeltaRaw(goalEventHint) {
	if (!goalEventHint) return null
	const yCoord = Number(goalEventHint.yCoord)
	if (!isFinite(yCoord)) return null
	const RAW_PER_FT_Y = RAW_H / 85 // NHL y-axis is approximately -42.5ft..+42.5ft
	return Math.abs(yCoord) * RAW_PER_FT_Y
}

function puckSpeedFtPerSec(prev, curr) {
	if (!prev || !curr) return null
	const dx = (curr.x - prev.x) * FT_PER_RAW
	const dy = (curr.y - prev.y) * FT_PER_RAW
	return Math.sqrt(dx * dx + dy * dy) / DT
}

function trimPostGoalFrames(frames, goalEventHint = null) {
	if (!frames || frames.length < 30) {
		return { frames, trimmedFrames: 0, trimReason: null, goalFrameIdx: null }
	}

	const attackingRightHint = inferAttackingRightFromGoalEvent(goalEventHint)
	const closestNetInference = inferAttackingRightByClosestNet(frames)
	// Treat goal event hint as authoritative for scoring side when available.
	const attackingRight = attackingRightHint ?? closestNetInference.attackingRight
	const goalX = attackingRight ? GOAL_LINE_RIGHT : GOAL_LINE_LEFT
	const goal = { x: goalX, y: CENTER_Y }
	const pucks = frames.map(getPuck)

	const GOAL_LINE_Y_HALF_SPAN = 36 // 3 ft; NHL net is 6 ft wide (±3 ft from center)
	const MIN_ENTRY_GAP = 8
	const RECENT_SPIKE_WINDOW = 12
	const SHOT_SPIKE_SPEED_FT_PER_S = 35
	const POST_GOAL_BUFFER = 12
	const TAIL_WINDOW = 10
	const TAIL_MEAN_SPEED_FT_PER_S = 2.5
	const TAIL_NEAR_GOAL_FT = 20
	const TAIL_SEARCH_AFTER_GOAL = 30
	let goalFrameIdx = null
	const goalCandidates = []

	const isBehindGoalLine = (puck) =>
		attackingRight ? puck.x >= goalX : puck.x <= goalX
	const inGoalLineBand = (y) => Math.abs(y - CENTER_Y) <= GOAL_LINE_Y_HALF_SPAN

	function crossedGoalLineBetweenPosts(prev, curr) {
		if (!prev || !curr) return false
		const dx = curr.x - prev.x
		if (!dx) return false

		const movingTowardGoal = attackingRight ? dx > 0 : dx < 0
		if (!movingTowardGoal) return false

		const t = (goalX - prev.x) / dx
		if (t < 0 || t > 1) return false

		const yAtCross = prev.y + t * (curr.y - prev.y)
		return inGoalLineBand(yAtCross)
	}

	// Preferred trim: first credible goal-line entry moment after a shot-like speed spike.
	for (let i = 1; i < frames.length; i++) {
		const puck = pucks[i]
		const prevPuck = pucks[i - 1]
		if (!puck) continue

		// Strong geometric check: puck interpolated crossing between posts
		const crossedBetweenPosts = crossedGoalLineBetweenPosts(prevPuck, puck)
		let enteredGoalLineWindow = crossedBetweenPosts
		if (!enteredGoalLineWindow) {
			const currInside = isBehindGoalLine(puck) && inGoalLineBand(puck.y)
			const prevAlreadyBehind = prevPuck && isBehindGoalLine(prevPuck)
			enteredGoalLineWindow = currInside && !prevAlreadyBehind
		}
		// Lookahead: puck crossed goal line X but Y interpolation missed the band
		// (common at 10fps with fast shots). Check next few frames for Y in band.
			if (!enteredGoalLineWindow && prevPuck && !isBehindGoalLine(prevPuck) && isBehindGoalLine(puck)) {
				for (let k = 0; k <= 4 && i + k < frames.length; k++) {
					const p = pucks[i + k]
					if (p && isBehindGoalLine(p) && inGoalLineBand(p.y)) {
						enteredGoalLineWindow = true
					break
				}
			}
		}
		if (!enteredGoalLineWindow) continue
		if (goalCandidates.length && i - goalCandidates[goalCandidates.length - 1] < MIN_ENTRY_GAP) {
			continue
		}

		// Speed spike required for weaker entry signals; strong geometric crossing
		// (interpolated Y between posts) doesn't need a spike — deflections/tips are slow.
		let hasRecentSpike = crossedBetweenPosts
		if (!hasRecentSpike) {
			for (let j = Math.max(1, i - RECENT_SPIKE_WINDOW); j <= i; j++) {
				const speed = puckSpeedFtPerSec(pucks[j - 1], pucks[j])
				if (speed != null && speed >= SHOT_SPIKE_SPEED_FT_PER_S) {
					hasRecentSpike = true
					break
				}
			}
		}
		if (!hasRecentSpike) continue
		goalCandidates.push(i)
	}

	let settleStartIdx = null
	const settledCandidates = []
	for (const candidateIdx of goalCandidates) {
		const windowStartMin = candidateIdx + 2
		const windowStartMax = Math.min(frames.length - TAIL_WINDOW, candidateIdx + TAIL_SEARCH_AFTER_GOAL)
		let candidateSettleStart = null

		for (let start = windowStartMin; start <= windowStartMax; start++) {
			const speeds = []
			let nearGoalCount = 0
			for (let j = start; j < start + TAIL_WINDOW; j++) {
				const puck = pucks[j]
				if (puck && distFt(puck, goal) <= TAIL_NEAR_GOAL_FT) nearGoalCount++
				const speed = puckSpeedFtPerSec(pucks[j - 1], puck)
				if (speed != null) speeds.push(speed)
			}
			if (speeds.length < TAIL_WINDOW - 2) continue
			if (mean(speeds) >= TAIL_MEAN_SPEED_FT_PER_S) continue
			if (nearGoalCount < Math.ceil(TAIL_WINDOW * 0.6)) continue
			candidateSettleStart = start
			break
		}

		if (candidateSettleStart != null) {
			settledCandidates.push({ candidateIdx, candidateSettleStart })
		}
	}

	if (settledCandidates.length) {
		// Pick the first frame of the latest consecutive settled run.
		let runStart = settledCandidates.length - 1
		while (
			runStart > 0 &&
			settledCandidates[runStart].candidateIdx === settledCandidates[runStart - 1].candidateIdx + 1
		) {
			runStart--
		}

		let runEnd = runStart
		while (
			runEnd + 1 < settledCandidates.length &&
			settledCandidates[runEnd + 1].candidateIdx === settledCandidates[runEnd].candidateIdx + 1
		) {
			runEnd++
		}

		// Default to the first frame in the latest settled run.
		let best = settledCandidates[runStart]

		// If event y-coordinate is available, pick the frame whose puck y best matches the
		// expected vertical offset of the official goal location.
		const targetYDeltaRaw = goalEventTargetYDeltaRaw(goalEventHint)
		if (isFinite(targetYDeltaRaw)) {
			let bestYErr = Infinity
			for (let i = runStart; i <= runEnd; i++) {
				const c = settledCandidates[i]
				const puck = pucks[c.candidateIdx]
				if (!puck) continue
				const yDelta = Math.abs(puck.y - CENTER_Y)
				const yErr = Math.abs(yDelta - targetYDeltaRaw)
				if (yErr < bestYErr) {
					bestYErr = yErr
					best = c
				}
			}
		}

		goalFrameIdx = best.candidateIdx
		settleStartIdx = best.candidateSettleStart
	}

	if (goalFrameIdx == null && goalCandidates.length) {
		// Fallback: choose the first frame in the latest consecutive candidate run.
		// This captures initial net entry instead of a later "linger near goal line" frame.
		let runStart = goalCandidates.length - 1
		while (runStart > 0 && goalCandidates[runStart] === goalCandidates[runStart - 1] + 1) {
			runStart--
		}
		goalFrameIdx = goalCandidates[runStart]
	}

	if (goalFrameIdx != null) {
		const trimAnchor = settleStartIdx ?? goalFrameIdx
		const trimEnd = Math.min(frames.length, trimAnchor + POST_GOAL_BUFFER)
		if (trimEnd < frames.length) {
			return {
				frames: frames.slice(0, trimEnd),
				trimmedFrames: frames.length - trimEnd,
				trimReason: 'net-entry',
				goalFrameIdx,
			}
		}
	}

	// Fallback trim: after last shot-like spike, remove long low-motion near-net tail.
	let lastSpikeIdx = null
	for (let i = 1; i < frames.length; i++) {
		const speed = puckSpeedFtPerSec(pucks[i - 1], pucks[i])
		if (speed != null && speed >= SHOT_SPIKE_SPEED_FT_PER_S) lastSpikeIdx = i
	}

	if (lastSpikeIdx == null) {
		return { frames, trimmedFrames: 0, trimReason: null, goalFrameIdx }
	}

	for (let i = lastSpikeIdx + 1; i + TAIL_WINDOW < frames.length; i++) {
		const speeds = []
		let nearGoalCount = 0

		for (let j = i; j < i + TAIL_WINDOW; j++) {
			const puck = pucks[j]
			if (puck && distFt(puck, goal) <= TAIL_NEAR_GOAL_FT) nearGoalCount++
			const speed = puckSpeedFtPerSec(pucks[j - 1], puck)
			if (speed != null) speeds.push(speed)
		}

		if (speeds.length < TAIL_WINDOW - 2) continue
		if (mean(speeds) >= TAIL_MEAN_SPEED_FT_PER_S) continue
		if (nearGoalCount < Math.ceil(TAIL_WINDOW * 0.6)) continue

		const trimEnd = Math.min(frames.length, i + POST_GOAL_BUFFER)
		if (trimEnd < frames.length) {
			return {
				frames: frames.slice(0, trimEnd),
				trimmedFrames: frames.length - trimEnd,
				trimReason: 'low-motion-tail',
				goalFrameIdx,
			}
		}
	}

	return { frames, trimmedFrames: 0, trimReason: null, goalFrameIdx }
}

// ── Main classifier ──

export function classifyGoal(frames, options = {}) {
	if (!frames || frames.length < 5) {
		return { error: 'Not enough frames' }
	}
	const originalFrameCount = frames.length
	const trimmed = trimPostGoalFrames(frames, options?.goalEventHint || null)
	if (trimmed.frames.length >= 5) {
		frames = trimmed.frames
	}

	// 1) Setup & Orientation
	const lastN = frames.slice(-10)
	const avgPuckX = mean(lastN.map((f) => getPuck(f)?.x ?? CENTER_X))
	const attackingRight = avgPuckX > CENTER_X
	const sign = attackingRight ? 1 : -1

	const goalX = attackingRight ? GOAL_LINE_RIGHT : GOAL_LINE_LEFT
	const goalY = CENTER_Y
	const goal = { x: goalX, y: goalY }
	const ozLine = attackingRight ? BLUE_LINE_RIGHT : BLUE_LINE_LEFT

	// Identify teams
	const firstPlayers = getPlayers(frames[0])
	const teams = [...new Set(firstPlayers.map((p) => p.teamAbbrev).filter(Boolean))]

	// ── Goalie detection (hardened) ──
	// Candidate must be within GOALIE_NEAR_NET_FT for ≥ GOALIE_NEAR_NET_FRAC of frames.
	// Among candidates, pick lowest position variance (stationary near net); tie-break by avg dist.
	const playerStats = new Map()
	for (const f of frames) {
		for (const p of getPlayers(f)) {
			const dRaw = dist(p, goal)
			const dFt = dRaw * FT_PER_RAW
			const entry = playerStats.get(p.id) || {
				totalDistRaw: 0,
				count: 0,
				nearCount: 0,
				team: p.teamAbbrev,
				xVals: [],
				yVals: [],
			}
			entry.totalDistRaw += dRaw
			entry.count++
			if (dFt <= GOALIE_NEAR_NET_FT) entry.nearCount++
			entry.xVals.push(p.x)
			entry.yVals.push(p.y)
			playerStats.set(p.id, entry)
		}
	}

	const goalEventHint = options?.goalEventHint || null
	const goalEventShotType = goalEventHint?.shotType ?? null

	// ── Goalie detection: prefer hint, fall back to heuristic ──
	let goalieId = null
	let goalieAvgDistRaw = Infinity
	let bestGoalieVar = Infinity

	// Try to resolve goalie from hint's goalieInNetId (NHL player ID → tracking ID)
	if (goalEventHint?.goalieInNetId) {
		for (const f of frames) {
			for (const p of getPlayers(f)) {
				if (p.playerId === goalEventHint.goalieInNetId) {
					goalieId = p.id
					const stats = playerStats.get(p.id)
					if (stats) goalieAvgDistRaw = stats.totalDistRaw / stats.count
					break
				}
			}
			if (goalieId != null) break
		}
	}

	// Heuristic fallback
	if (goalieId == null) {
		for (const [id, s] of playerStats) {
			const nearFrac = s.nearCount / s.count
			if (nearFrac < GOALIE_NEAR_NET_FRAC) continue

			const posVar = variance(s.xVals) + variance(s.yVals)
			const avgDistRaw = s.totalDistRaw / s.count

			if (posVar < bestGoalieVar || (posVar === bestGoalieVar && avgDistRaw < goalieAvgDistRaw)) {
				goalieId = id
				goalieAvgDistRaw = avgDistRaw
				bestGoalieVar = posVar
			}
		}

		// Fallback: closest overall
		if (goalieId == null) {
			for (const [id, s] of playerStats) {
				const avgDistRaw = s.totalDistRaw / s.count
				if (avgDistRaw < goalieAvgDistRaw) {
					goalieAvgDistRaw = avgDistRaw
					goalieId = id
				}
			}
		}
	}

	const goalieStats = playerStats.get(goalieId)

	// ── Attacking team: prefer hint teamAbbrev, fall back to goalie-derived ──
	let attackingTeam, defendingTeam
	if (goalEventHint?.teamAbbrev && teams.includes(goalEventHint.teamAbbrev)) {
		attackingTeam = goalEventHint.teamAbbrev
		defendingTeam = teams.find((t) => t !== attackingTeam) || teams[0]
	} else if (teams.length === 2 && goalieStats) {
		defendingTeam = goalieStats.team
		attackingTeam = teams.find((t) => t !== defendingTeam) || teams[0]
	} else {
		attackingTeam = teams[0] || 'UNK'
		defendingTeam = teams[1] || 'UNK'
	}

	// ── Empty-net detection: deterministic from hint, else heuristic ──
	const goalieAvgDistFt = goalieAvgDistRaw * FT_PER_RAW
	let emptyNet
	if (goalEventHint && 'goalieInNetId' in goalEventHint) {
		emptyNet = !goalEventHint.goalieInNetId
	} else {
		emptyNet = goalieAvgDistFt > GOALIE_MAX_AVG_DIST_FT
	}

		if (emptyNet) {
			return {
				classification: { primary: 'Empty Net', secondary: null, confidence: 1 },
				scores: {},
				features: { goalieAvgDistFt: round2(goalieAvgDistFt), goalFrameIdx: trimmed.goalFrameIdx },
			meta: {
				attackingTeam,
				defendingTeam,
				attackingDirection: attackingRight ? 'right' : 'left',
				shotType: goalEventShotType,
				totalFrames: originalFrameCount,
				analyzedFrames: frames.length,
				trimmedFrames: trimmed.trimmedFrames,
				trimReason: trimmed.trimReason,
				goalFrameIdx: trimmed.goalFrameIdx,
				emptyNet: true,
			},
		}
	}

	// ── Puck velocities (full clip) ──
	const puckSpeeds = []
	const puckVx = []
	const puckVy = []

	for (let i = 1; i < frames.length; i++) {
		const prev = getPuck(frames[i - 1])
		const curr = getPuck(frames[i])
		if (!prev || !curr) continue

		const dx = (curr.x - prev.x) * FT_PER_RAW
		const dy = (curr.y - prev.y) * FT_PER_RAW
		const speed = Math.sqrt(dx * dx + dy * dy) / DT

		puckSpeeds.push(speed)
		puckVx.push(dx / DT)
		puckVy.push(dy / DT)
	}

	const puckSpeedMean = mean(puckSpeeds)
	const puckSpeedMax = puckSpeeds.length ? Math.max(...puckSpeeds) : 0

	// ── Release frame detection ──
	// Peak puck speed in last 2s as "release" (shot moment); fallback last frame.
	const RELEASE_SEARCH = 20 // last 2s
	let releaseIdx = frames.length - 1
	let releasePeakSpeed = 0

	for (let i = Math.max(1, frames.length - RELEASE_SEARCH); i < frames.length; i++) {
		const prev = getPuck(frames[i - 1])
		const curr = getPuck(frames[i])
		if (!prev || !curr) continue

		const dx = (curr.x - prev.x) * FT_PER_RAW
		const dy = (curr.y - prev.y) * FT_PER_RAW
		const speed = Math.sqrt(dx * dx + dy * dy) / DT

		if (speed > releasePeakSpeed) {
			releasePeakSpeed = speed
			releaseIdx = i
		}
	}

	const releaseFrame = frames[releaseIdx]
	const releasePuck = getPuck(releaseFrame)

	// Windows (end-based; release used where it matters)
	const wShort = frames.slice(-SHORT_WINDOW)

	// 2) Feature Extraction

	// Rush puck Vx toward goal (3s window ending at release, not clip end)
	const rushVxEnd = Math.min(releaseIdx, puckVx.length)
	const rushVxStart = Math.max(0, rushVxEnd - RUSH_WINDOW)
	const rushVxSlice = puckVx.slice(rushVxStart, rushVxEnd)
	const puckVxTowardGoal = sign * mean(rushVxSlice)

	// Attacking & defending centroid velocity (toward goal direction)
	const attackCentroidXVals = []
	const defCentroidXVals = []

	for (let i = 1; i < frames.length; i++) {
		const prevPlayers = getPlayers(frames[i - 1])
		const currPlayers = getPlayers(frames[i])

		const prevAtk = prevPlayers.filter((p) => p.teamAbbrev === attackingTeam && p.id !== goalieId)
		const currAtk = currPlayers.filter((p) => p.teamAbbrev === attackingTeam && p.id !== goalieId)
		if (prevAtk.length && currAtk.length) {
			const dx = (mean(currAtk.map((p) => p.x)) - mean(prevAtk.map((p) => p.x))) * FT_PER_RAW
			attackCentroidXVals.push(dx / DT)
		}

		const prevDef = prevPlayers.filter((p) => p.teamAbbrev === defendingTeam && p.id !== goalieId)
		const currDef = currPlayers.filter((p) => p.teamAbbrev === defendingTeam && p.id !== goalieId)
		if (prevDef.length && currDef.length) {
			const dx = (mean(currDef.map((p) => p.x)) - mean(prevDef.map((p) => p.x))) * FT_PER_RAW
			defCentroidXVals.push(dx / DT)
		}
	}

	const attackingCentroidVx = sign * mean(attackCentroidXVals)
	const defendingCentroidVx = sign * mean(defCentroidXVals)
	const rushDifferentialVx = attackingCentroidVx - defendingCentroidVx

	// OZ time fraction (puck-based)
	let ozFrameCount = 0
	for (const f of frames) {
		const puck = getPuck(f)
		if (!puck) continue
		const inOZ = attackingRight ? puck.x > ozLine : puck.x < ozLine
		if (inOZ) ozFrameCount++
	}
	const ozFraction = frames.length ? ozFrameCount / frames.length : 0

	// Slot touches (puck enters slot-ish)
	let slotTouches = 0
	let prevInSlot = false
	for (const f of frames) {
		const puck = getPuck(f)
		if (!puck) continue
		const inSlot = Math.abs(puck.x - goalX) < SLOT_DX && Math.abs(puck.y - goalY) < SLOT_DY
		if (inSlot && !prevInSlot) slotTouches++
		prevInSlot = inSlot
	}

	// Corridor bodies at release (angle-wrap safe)
	let corridorBodies = 0
	if (releasePuck) {
		const angleToGoal = Math.atan2(goalY - releasePuck.y, goalX - releasePuck.x)
		for (const p of getPlayers(releaseFrame)) {
			if (p.id === goalieId) continue
			const angleToPlayer = Math.atan2(p.y - releasePuck.y, p.x - releasePuck.x)
			const dToGoal = dist(releasePuck, goal)
			const dToPlayer = dist(releasePuck, p)
			if (angleDiff(angleToPlayer, angleToGoal) < CONE_HALF_ANGLE && dToPlayer < dToGoal) {
				corridorBodies++
			}
		}
	}

	// Net-front: attacker crease proximity gated by puck in danger zone, last ~1s
	const CREASE_WINDOW = 10
	const creaseFrames = frames.slice(-CREASE_WINDOW)
	let minAttackerCreaseDist = Infinity
	let creaseGateFrames = 0

	for (const f of creaseFrames) {
		const puck = getPuck(f)
		if (!puck) continue
		if (!inDanger(puck, goalX, goalY)) continue
		creaseGateFrames++

		for (const p of getPlayers(f)) {
			if (p.teamAbbrev !== attackingTeam) continue
			const d = distFt(p, goal)
			if (d < minAttackerCreaseDist) minAttackerCreaseDist = d
		}
	}

	// Seam: lateral puck movement (y-range) in danger zone in W_short
	const shortPucks = wShort.map(getPuck).filter(Boolean)
	const dangerPucks = shortPucks.filter((p) => inDanger(p, goalX, goalY))
	const dangerFrac = shortPucks.length ? dangerPucks.length / shortPucks.length : 0

	const seamYRange = dangerPucks.length >= 2
		? (Math.max(...dangerPucks.map((p) => p.y)) - Math.min(...dangerPucks.map((p) => p.y))) * FT_PER_RAW
		: 0

	// Lateral puck speed (Vy) in W_short
	const shortVySlice = puckVy.slice(-SHORT_WINDOW)
	const puckVyAbsMean = mean(shortVySlice.map((v) => Math.abs(v)))

	// Broken Coverage: nearest defender to shooter proxy (not puck)
	let shooter = null
	if (goalEventHint?.scoringPlayerId && releasePuck) {
		for (const p of getPlayers(releaseFrame)) {
			if (p.playerId === goalEventHint.scoringPlayerId) {
				shooter = p
				break
			}
		}
	}
	if (!shooter) {
		shooter = releasePuck ? nearestPlayer(releaseFrame, releasePuck, attackingTeam).player : null
	}

	const nearestDefIds = []
	const nearestDefDists = []
	let unmarkedFrames = 0

	for (const f of wShort) {
		const target = shooter || getPuck(f)
		if (!target) continue

		const defenders = getPlayers(f).filter(
			(p) => p.teamAbbrev === defendingTeam && p.id !== goalieId,
		)

		let minD = Infinity
		let minId = null
		for (const d of defenders) {
			const dd = distFt(d, target)
			if (dd < minD) {
				minD = dd
				minId = d.id
			}
		}

		nearestDefIds.push(minId)
		nearestDefDists.push(minD)
		if (minD > DEFENDER_PROXIMITY_FT) unmarkedFrames++
	}

	let defIdSwaps = 0
	for (let i = 1; i < nearestDefIds.length; i++) {
		if (nearestDefIds[i] !== nearestDefIds[i - 1] && nearestDefIds[i] != null) defIdSwaps++
	}

	const gapAtRelease = nearestDefDists.length ? nearestDefDists[nearestDefDists.length - 1] : 0

	// Rebound/Scramble: density + spikes + possession changes (free-puck gated) + low-slot presence
	const localDensities = []
	const DENSITY_RADIUS_FT = 12
	let lowSlotFrames = 0

	for (const f of wShort) {
		const puck = getPuck(f)
		if (!puck) continue

		let count = 0
		for (const p of getPlayers(f)) {
			if (distFt(p, puck) < DENSITY_RADIUS_FT) count++
		}
		localDensities.push(count)

		if (Math.abs(puck.x - goalX) < 200 && Math.abs(puck.y - goalY) < 150) lowSlotFrames++
	}

	const localDensityMean = mean(localDensities)
	const lowSlotFrac = wShort.length ? lowSlotFrames / wShort.length : 0

	const shortSpeeds = puckSpeeds.slice(-SHORT_WINDOW)
	const speedSpikes = shortSpeeds.filter((s) => s > puckSpeedMean * 2).length

	let possessionChanges = 0
	let prevNearestTeam = null

	for (const f of wShort) {
		const puck = getPuck(f)
		if (!puck) continue

		const { player: nearest, dist: nearestDist } = nearestPlayer(f, puck)
		if (!nearest || nearestDist > FREE_PUCK_FT) continue

		const team = nearest.teamAbbrev
		if (prevNearestTeam && team !== prevNearestTeam) possessionChanges++
		prevNearestTeam = team
	}

	// 3) Recipe Scores

	const scores = {}

	// Rush: puck Vx toward goal near release + attacker outruns defender centroid
	scores.rush =
		1.5 * normalize(puckVxTowardGoal, 10, 8) +
		normalize(rushDifferentialVx, 4, 3)

	// Cycle: sustained OZ + repeated slot access + low puck speed - chaos
	scores.cycle =
		1.2 * normalize(ozFraction, 0.85, 0.10) +
		normalize(slotTouches, 2, 1) +
		normalize(-puckSpeedMean, -18, 8) -
		0.7 * normalize(possessionChanges, 3, 2)

	// Net-front: traffic + crease presence (only if puck actually got to inner OZ late)
	scores.netFront =
		normalize(corridorBodies, 3, 1.5) +
		normalize(-minAttackerCreaseDist, -8, 4)

	// Seam: big lateral puck move near net + lateral speed (danger-gated)
	scores.seam =
		1.5 * normalize(seamYRange, 12, 5) +
		normalize(puckVyAbsMean, 10, 5) +
		0.6 * normalize(dangerFrac, 0.5, 0.25)

	// Broken coverage: defender assignment churn + shooter gap
	scores.brokenCoverage =
		1.5 * normalize(defIdSwaps, 2, 1) +
		normalize(gapAtRelease, 15, 6) +
		0.6 * normalize(unmarkedFrames / Math.max(1, wShort.length), 0.35, 0.2)

	// Rebound/Scramble: bodies + shot-like spikes + changes, but only if puck lived low-slot
	scores.rebound =
		normalize(localDensityMean, 4, 1.5) +
		normalize(speedSpikes, 2, 1) +
		normalize(possessionChanges, 2, 1) +
		0.8 * normalize(lowSlotFrac, 0.4, 0.2)

	// 4) Classification
	const labels = Object.keys(scores)
	const sorted = labels.slice().sort((a, b) => scores[b] - scores[a])
	const topScore = scores[sorted[0]]
	const secondScore = scores[sorted[1]]

	const MINIMUM_THRESHOLD = 0.5
	const FALLBACK_THRESHOLD = -0.75
	const STRONG_SIGNAL_FALLBACK_THRESHOLD = -1.1

	const hasGoalSignal = trimmed.goalFrameIdx != null || releasePeakSpeed >= 35 || puckSpeedMax >= 50
	const strongGoalSignal = trimmed.goalFrameIdx != null && puckSpeedMax >= 50
	const fallbackFloor = strongGoalSignal ? STRONG_SIGNAL_FALLBACK_THRESHOLD : FALLBACK_THRESHOLD
	const useFallback = topScore < MINIMUM_THRESHOLD && topScore >= fallbackFloor && hasGoalSignal

	const primary =
		topScore >= MINIMUM_THRESHOLD || useFallback ? formatLabel(sorted[0]) : null
	const secondary =
		secondScore >= MINIMUM_THRESHOLD && topScore - secondScore < 1.0
			? formatLabel(sorted[1])
			: null

	const confidence =
		primary != null
			? useFallback
				? Math.round(Math.min(0.65, Math.max(0.4, 0.45 + (topScore - secondScore) * 0.1)) * 100) /
					100
				: Math.round(Math.min(1, 0.5 + (topScore - secondScore) * 0.15) * 100) / 100
			: 0

	const features = {
		puckSpeedMean: round2(puckSpeedMean),
		puckSpeedMax: round2(puckSpeedMax),
		puckVxTowardGoal: round2(puckVxTowardGoal),
		attackingCentroidVx: round2(attackingCentroidVx),
		defendingCentroidVx: round2(defendingCentroidVx),
		rushDifferentialVx: round2(rushDifferentialVx),
		ozFraction: round2(ozFraction),
		slotTouches,
		corridorBodies,
		minAttackerCreaseDistFt: round2(minAttackerCreaseDist),
		creaseGateFrames,
		seamYRangeFt: round2(seamYRange),
		dangerFrac: round2(dangerFrac),
		puckVyAbsMean: round2(puckVyAbsMean),
		defIdSwaps,
		gapAtReleaseFt: round2(gapAtRelease),
		unmarkedFrames,
		localDensityMean: round2(localDensityMean),
		speedSpikes,
		possessionChanges,
			lowSlotFrac: round2(lowSlotFrac),
			goalFrameIdx: trimmed.goalFrameIdx,
			releaseIdx,
			releasePeakSpeed: round2(releasePeakSpeed),
			shooterId: shooter?.id ?? null,
		}

	return {
		classification: { primary, secondary, confidence },
		scores: Object.fromEntries(labels.map((k) => [k, round2(scores[k])])),
		features,
		meta: {
			attackingTeam,
			defendingTeam,
			attackingDirection: attackingRight ? 'right' : 'left',
			shotType: goalEventShotType,
			totalFrames: originalFrameCount,
			analyzedFrames: frames.length,
			trimmedFrames: trimmed.trimmedFrames,
			trimReason: trimmed.trimReason,
			goalFrameIdx: trimmed.goalFrameIdx,
			emptyNet: false,
		},
	}
}

// ── Utilities ──

function normalize(value, center, spread) {
	return (value - center) / spread
}

function formatLabel(key) {
	const map = {
		rush: 'Rush',
		cycle: 'Cycle',
		netFront: 'Net-front',
		seam: 'Seam',
		brokenCoverage: 'Broken Coverage',
		rebound: 'Rebound/Scramble',
	}
	return map[key] || key
}

function round2(n) {
	if (!isFinite(n)) return null
	return Math.round(n * 100) / 100
}
