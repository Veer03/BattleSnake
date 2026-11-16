// Welcome to
// __________         __    __  .__                               __
// \______   \_____ _/  |__/  |_|  |   ____   ______ ____ _____  |  | __ ____
//  |    |  _/\__  \\   __\   __\  | _/ __ \ /  ___//    \\__  \ |  |/ // __ \
//  |    |   \ / __ \|  |  |  | |  |_\  ___/ \___ \|   |  \/ __ \|    <\  ___/
//  |________/(______/__|  |__| |____/\_____>______>___|__(______/__|__\\_____>
//
// This file can be a nice home for your Battlesnake logic and helper functions.
//
// To get you started we've included code to prevent your Battlesnake from moving backwards.
// For more info see docs.battlesnake.com

import runServer from "./server.js";

// info is called when you create your Battlesnake on play.battlesnake.com
// and controls your Battlesnake's appearance
// TIP: If you open your Battlesnake URL in a browser you should see this data
function info() {
  console.log("INFO");

  return {
    apiversion: "1",
    author: "VeerHarsh", // TODO: Your Battlesnake Username
    color: "#0000ff", // TODO: Choose color
    head: "smile", // TODO: Choose head
    tail: "hook", // TODO: Choose tail
  };
}

// start is called when your Battlesnake begins a game
function start(gameState) {
  console.log("GAME START");
  getGameTiming(gameState);
}

// end is called when your Battlesnake finishes a game
function end(gameState) {
  console.log("GAME OVER\n");
  timingByGame.delete(gameState.game?.id || "__unknown_game__");
}

// ---------------------------------------------------------------------------
// SEARCH ENGINE
//
// How it works (same family of ideas the top snakes use):
//   1. Simulate the real game rules turn by turn (movement, growth, food,
//      starvation, wall / body / head-to-head deaths).
//   2. Paranoid minimax with alpha-beta pruning: I pick the move that is best
//      assuming the nearby opponents pick the replies that hurt me most.
//   3. Iterative deepening: search 1 round ahead, then 2, then 3... until the
//      time budget runs out, then use the deepest COMPLETED round.
//   4. At the leaves, score the board with a Voronoi "area control" heuristic:
//      count the squares I can reach before anyone else, plus length, food and
//      anti-trap terms.
// ---------------------------------------------------------------------------

const DIR_INDEX = { up: 0, down: 1, left: 2, right: 3 };

const MAX_DEPTH = 20; // hard cap on rounds searched
const ENUM_OPPONENTS = 2; // how many nearest opponents get every reply tried
const SAFETY_MS = 160; // extra margin on top of the measured overhead
const MIN_BUDGET_MS = 20; // never search for less than this
const MAX_BUDGET_MS = 80; // cap search time to leave more response margin
const EARLY_BUDGET_MS = 30; // cap for the first few turns (open board)
const TIMEOUT = "timeout";

// Time the engine spends waiting on us that is NOT our thinking (network,
// Windows localhost delays, a busy laptop...). Starts pessimistic and is
// corrected every turn from what the engine reports.
const DIR_VEC = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// Board geometry, cached because it never changes during a game.
// nbr[cell] = [up, down, left, right] neighbour cells (-1 = wall).
// A cell is just y * width + x.
let boardCache = null;
const timingByGame = new Map();

function getGameTiming(gameState) {
  const gameId = gameState.game?.id || "__unknown_game__";
  if (!timingByGame.has(gameId)) {
    if (timingByGame.size >= 128) {
      const oldestGame = timingByGame.keys().next().value;
      timingByGame.delete(oldestGame);
    }
    timingByGame.set(gameId, {
      overheadEst: 300,
      lastComputeMs: 0,
      lastMove: null,
      opponentProfiles: new Map(),
    });
  }
  return { gameId, timing: timingByGame.get(gameId) };
}

// Learn a small amount about each opponent from its actual moves. This is a
// soft preference signal only; the search still considers dangerous replies.
function updateOpponentProfiles(gameState, timing) {
  const turn = gameState.turn;
  const ownHead = gameState.you.body[0];
  const foods = gameState.board.food || [];

  for (const snake of gameState.board.snakes) {
    if (snake.id === gameState.you.id || !snake.body?.length) continue;
    let profile = timing.opponentProfiles.get(snake.id);
    if (!profile) {
      profile = {
        foodBias: 0.5,
        aggression: 0.5,
        foodSamples: 0,
        aggressionSamples: 0,
      };
      timing.opponentProfiles.set(snake.id, profile);
    }

    const head = snake.body[0];
    if (profile.lastTurn === turn - 1 && profile.lastHead) {
      const oldFoodDistance = profile.lastFood
        .filter((f) => foods.some((now) => now.x === f.x && now.y === f.y))
        .reduce(
          (best, f) => Math.min(best, Math.abs(profile.lastHead.x - f.x) + Math.abs(profile.lastHead.y - f.y)),
          Infinity,
        );
      const newFoodDistance = profile.lastFood
        .filter((f) => foods.some((now) => now.x === f.x && now.y === f.y))
        .reduce(
          (best, f) => Math.min(best, Math.abs(head.x - f.x) + Math.abs(head.y - f.y)),
          Infinity,
        );

      if (oldFoodDistance < Infinity && newFoodDistance !== oldFoodDistance) {
        profile.foodBias =
          profile.foodBias * 0.8 + (newFoodDistance < oldFoodDistance ? 0.2 : 0);
        profile.foodSamples++;
      }

      const oldOpponentDistance =
        Math.abs(profile.lastHead.x - profile.lastOwnHead.x) +
        Math.abs(profile.lastHead.y - profile.lastOwnHead.y);
      const newOpponentDistance =
        Math.abs(head.x - ownHead.x) + Math.abs(head.y - ownHead.y);
      if (newOpponentDistance !== oldOpponentDistance) {
        profile.aggression =
          profile.aggression * 0.8 +
          (newOpponentDistance < oldOpponentDistance ? 0.2 : 0);
        profile.aggressionSamples++;
      }
    }

    profile.lastTurn = turn;
    profile.lastHead = { x: head.x, y: head.y };
    profile.lastOwnHead = { x: ownHead.x, y: ownHead.y };
    profile.lastFood = foods.map((f) => ({ x: f.x, y: f.y }));
  }
}

function getBoard(W, H) {
  if (boardCache && boardCache.W === W && boardCache.H === H) return boardCache;
  const N = W * H;
  const nbr = new Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      nbr[y * W + x] = [
        y + 1 < H ? (y + 1) * W + x : -1,
        y - 1 >= 0 ? (y - 1) * W + x : -1,
        x - 1 >= 0 ? y * W + x - 1 : -1,
        x + 1 < W ? y * W + x + 1 : -1,
      ];
    }
  }
  boardCache = { W, H, N, nbr };
  return boardCache;
}

// Turns the JSON game state into compact arrays the search can copy cheaply.
function buildState(gameState, B) {
  const snakes = gameState.board.snakes.map((s) => ({
    body: s.body.map((p) => p.y * B.W + p.x),
    health: s.health,
    alive: true,
  }));
  let meIdx = gameState.board.snakes.findIndex(
    (s) => s.id === gameState.you.id,
  );
  if (meIdx < 0) {
    snakes.push({
      body: gameState.you.body.map((p) => p.y * B.W + p.x),
      health: gameState.you.health,
      alive: true,
    });
    meIdx = snakes.length - 1;
  }
  const food = new Uint8Array(B.N);
  for (const f of gameState.board.food) food[f.y * B.W + f.x] = 1;
  return { state: { snakes, food }, meIdx };
}

// Moves a snake may legally try: in bounds and not straight back into its neck.
function legalDests(ctx, body) {
  const nb = ctx.nbr[body[0]];
  const neck = body.length > 1 ? body[1] : -1;
  const out = [];
  for (let k = 0; k < 4; k++) {
    const c = nb[k];
    if (c >= 0 && c !== neck) out.push(c);
  }
  if (out.length === 0) out.push(-1); // boxed in: any move kills us
  return out;
}

// Plays ONE full turn: every living snake moves at once.
// dests[i] = the cell snake i moves its head into (-1 = off the board).
// Follows the official order: move, lose 1 health, eat, then eliminations.
function step(ctx, state, dests) {
  const old = state.snakes;
  const n = old.length;
  const food = state.food;
  const snakes = new Array(n);
  let eaten = null;

  for (let i = 0; i < n; i++) {
    const s = old[i];
    if (!s.alive) {
      snakes[i] = s;
      continue;
    }
    const d = dests[i];
    if (d < 0) {
      snakes[i] = { body: s.body, health: 0, alive: false }; // hit a wall
      continue;
    }
    const body = [d].concat(s.body); // new head goes on the front
    let health = ctx.constrictor ? s.health : s.health - 1;
    if (!ctx.constrictor && ctx.hazard[d]) health -= ctx.hazardDmg;
    if (food[d]) {
      if (!ctx.constrictor) health = 100; // eating: back to full health and the tail stays (we grow)
      if (!eaten) eaten = [];
      eaten.push(d);
    } else if (!ctx.constrictor) {
      body.pop(); // not eating: the tail moves forward
    }
    snakes[i] = { body, health, alive: health > 0 };
  }

  // Collisions are decided all at once, using the board after everyone moved.
  const doomed = [];
  for (let i = 0; i < n; i++) {
    const a = snakes[i];
    if (!a.alive) continue;
    const h = a.body[0];
    let dead = false;
    for (let j = 0; j < n && !dead; j++) {
      if (!snakes[j].alive) continue;
      const b = snakes[j].body;
      for (let k = 1; k < b.length; k++) {
        if (b[k] === h) {
          dead = true; // ran into a body (mine or someone else's)
          break;
        }
      }
      // Head-to-head: the shorter snake dies, equal length = both die.
      if (
        !dead &&
        j !== i &&
        snakes[j].alive &&
        b[0] === h &&
        b.length >= a.body.length
      ) {
        dead = true;
      }
    }
    if (dead) doomed.push(i);
  }
  for (const i of doomed) {
    snakes[i] = {
      body: snakes[i].body,
      health: snakes[i].health,
      alive: false,
    };
  }

  let newFood = food;
  if (eaten) {
    newFood = food.slice();
    for (const c of eaten) newFood[c] = 0;
  }
  return { snakes, food: newFood };
}

// Picks the reply for opponents we don't search properly: the move into the
// most open space. Cheap, and much better than assuming they stand still.
function pickOpen(ctx, list, stamp) {
  let best = list[0];
  let bestFree = -1;
  for (const c of list) {
    if (c < 0) continue;
    let free = 0;
    for (const m of ctx.nbr[c]) {
      if (m >= 0 && ctx.occ[m] !== stamp) free++;
    }
    if (free > bestFree) {
      bestFree = free;
      best = c;
    }
  }
  return best;
}

// Scores a board from MY point of view. Higher = better for me.
function evaluate(ctx, state) {
  const { nbr, freeAt, owner, dist, seen } = ctx;
  const snakes = state.snakes;
  const n = snakes.length;
  const food = state.food;
  const me = snakes[ctx.meIdx];
  const myLen = me.body.length;

  // freeAt[cell] = how many turns until a body square is empty again.
  // The tail leaves after 1 turn, the square before it after 2, and so on.
  freeAt.fill(0);
  let maxOppLen = 0;
  for (let i = 0; i < n; i++) {
    const s = snakes[i];
    if (!s.alive) continue;
    const L = s.body.length;
    for (let k = 0; k < L; k++) {
      const t = ctx.constrictor ? 32767 : L - k;
      const c = s.body[k];
      if (t > freeAt[c]) freeAt[c] = t;
    }
    if (i !== ctx.meIdx && L > maxOppLen) maxOppLen = L;
  }

  let cur = ctx.qa;
  let nxt = ctx.qb;
  let curN = 0;
  let nxtN = 0;
  let tmp;

  // --- A) Space I can reach on my own + distance to the nearest food ---
  const stamp = ++ctx.seenStamp;
  const head = me.body[0];
  const myDist = ctx.myDist;
  myDist.fill(32767);
  myDist[head] = 0;
  seen[head] = stamp;
  cur[curN++] = head;
  let area = 0;
  let nearestFood = 99;
  let d = 0;
  while (curN > 0) {
    d++;
    nxtN = 0;
    for (let q = 0; q < curN; q++) {
      const nb = nbr[cur[q]];
      for (let k = 0; k < 4; k++) {
        const m = nb[k];
        if (m < 0 || seen[m] === stamp || freeAt[m] > d) continue;
        seen[m] = stamp;
        myDist[m] = d;
        area++;
        if (nearestFood === 99 && food[m]) nearestFood = d;
        nxt[nxtN++] = m;
      }
    }
    tmp = cur;
    cur = nxt;
    nxt = tmp;
    curN = nxtN;
  }

  // --- B) Voronoi: who gets to each square first? ---
  // All snakes spread out one step at a time. A square goes to whoever
  // arrives first. On a tie the LONGER snake wins it (it wins the head-to-head);
  // an equal tie makes the square neutral.
  owner.fill(-1);
  const cnt = ctx.cnt;
  cnt.fill(0);
  curN = 0;
  for (let i = 0; i < n; i++) {
    if (!snakes[i].alive) continue;
    const h = snakes[i].body[0];
    owner[h] = i;
    dist[h] = 0;
    cnt[i]++;
    cur[curN++] = h;
  }
  d = 0;
  while (curN > 0) {
    d++;
    nxtN = 0;
    for (let q = 0; q < curN; q++) {
      const c = cur[q];
      const o = owner[c];
      const nb = nbr[c];
      for (let k = 0; k < 4; k++) {
        const m = nb[k];
        if (m < 0 || freeAt[m] > d) continue;
        const om = owner[m];
        if (om === -1) {
          owner[m] = o;
          dist[m] = d;
          nxt[nxtN++] = m;
        } else if (dist[m] === d && om !== o && om !== -2) {
          const lo = snakes[o].body.length;
          const lm = snakes[om].body.length;
          if (lo > lm) owner[m] = o;
          else if (lo === lm) owner[m] = -2;
        }
      }
    }
    let w = 0;
    for (let q = 0; q < nxtN; q++) {
      const m = nxt[q];
      const om = owner[m];
      if (om >= 0) {
        cnt[om]++;
        nxt[w++] = m;
      }
    }
    tmp = cur;
    cur = nxt;
    nxt = tmp;
    curN = w;
  }

  let oppSum = 0;
  let oppN = 0;
  for (let i = 0; i < n; i++) {
    if (i === ctx.meIdx || !snakes[i].alive) continue;
    oppSum += cnt[i];
    oppN++;
  }

  const opponentDist = ctx.oppDist;
  opponentDist.fill(32767);
  let oppCur = ctx.qa;
  let oppNext = ctx.qb;
  let oppCurN = 0;
  for (let i = 0; i < n; i++) {
    if (i === ctx.meIdx || !snakes[i].alive) continue;
    const h = snakes[i].body[0];
    if (opponentDist[h] === 32767) {
      opponentDist[h] = 0;
      oppCur[oppCurN++] = h;
    }
  }
  let opponentLayer = 0;
  while (oppCurN > 0) {
    opponentLayer++;
    let oppNextN = 0;
    for (let q = 0; q < oppCurN; q++) {
      const nb = nbr[oppCur[q]];
      for (let k = 0; k < 4; k++) {
        const m = nb[k];
        if (m < 0 || opponentDist[m] !== 32767 || freeAt[m] > opponentLayer)
          continue;
        opponentDist[m] = opponentLayer;
        oppNext[oppNextN++] = m;
      }
    }
    const swap = oppCur;
    oppCur = oppNext;
    oppNext = swap;
    oppCurN = oppNextN;
  }

  const hp = me.health;
  const hungerValue = Math.max(0, 60 - hp) * 0.3;
  // Grow more eagerly while small or when we need length to contest a larger
  // opponent. Once we already have the length advantage, value open space and
  // safe health-restoring food more than adding extra body to a crowded board.
  const lengthDeficit = Math.min(6, Math.max(0, maxOppLen - myLen));
  const earlyGrowthValue =
    myLen < 8 ? 42 : myLen > maxOppLen ? 8 : 14;
  const growthValue = earlyGrowthValue + lengthDeficit * 4;
  const roomFactor = area < myLen * 1.5 ? 0.55 : 1;
  const postGrowthRoomFactor = area < (myLen + 1) * 1.25 ? 0.65 : 1;
  let bestFoodReward = 0;
  for (let c = 0; c < food.length; c++) {
    if (!food[c] || myDist[c] === 32767) continue;
    const myEta = myDist[c];
    let raceFactor = 1;
    let foodHunterBias = 0;
    if (oppN > 0 && opponentDist[c] <= myEta) {
      if (opponentDist[c] === myEta) {
        raceFactor = myLen > maxOppLen ? 0.8 : hp < 50 ? 0.65 : 0.35;
      } else {
        raceFactor = hp < 50 ? 0.25 : 0.1;
      }
      for (let i = 0; i < n; i++) {
        if (i === ctx.meIdx || !snakes[i].alive) continue;
        const profile = ctx.opponentProfiles.get(ctx.opponentIds[i]);
        const confidence = profile
          ? Math.min(1, profile.foodSamples / 8)
          : 0;
        if (profile) {
          foodHunterBias = Math.max(
            foodHunterBias,
            profile.foodBias * confidence,
          );
        }
      }
      // A food-focused opponent is more likely to take a close race. Keep this
      // adjustment small because the minimax simulation already checks replies.
      raceFactor *= 1 - 0.2 * foodHunterBias;
    }
    const travelCost = myEta * (hp < 50 ? 0.7 + (50 - hp) / 10 : 0.4);
    const reward =
      ((growthValue * roomFactor * postGrowthRoomFactor + hungerValue) /
        (1 + myEta * 0.18)) *
        raceFactor -
      travelCost;
    if (reward > bestFoodReward) bestFoodReward = reward;
  }

  // --- C) Combine everything into one number ---
  let score = 2 * (cnt[ctx.meIdx] - (oppN > 0 ? oppSum / oppN : 0)); // area control
  score += 6 * myLen; // growing is good
  if (oppN > 0) score += 4 * (myLen - maxOppLen); // being longer wins head-to-heads

  if (myLen > maxOppLen && area >= myLen * 1.5) {
    for (let i = 0; i < n; i++) {
      if (i === ctx.meIdx || !snakes[i].alive) continue;
      const opponent = snakes[i];
      const shortfall = opponent.body.length - cnt[i];
      if (shortfall > 0) score += Math.min(80, 20 + shortfall * 8);

      // When we have the size lead and plenty of room, reward safe pressure
      // that leaves a smaller opponent with fewer exits. This is a positional
      // bonus, not a command to chase into a head-to-head.
      let opponentExits = 0;
      for (const dest of legalDests(ctx, opponent.body)) {
        if (dest >= 0 && freeAt[dest] <= 1) opponentExits++;
      }
      if (opponentExits <= 2) score += (3 - opponentExits) * 18;
    }
  }

  // Trap check: less room than my own body length = I'm walling myself in.
  if (area < myLen) score -= (myLen - area) * 25 + 200;
  else if (area < myLen * 1.5) score -= (myLen * 1.5 - area) * 6;

  // Food: a gentle pull always, a strong pull when hungry.
  if (nearestFood === 99) {
    if (hp < 50) score -= (50 - hp) * 2; // hungry and no food reachable
  } else {
    if (nearestFood > hp) score -= 1000; // will starve before reaching food
    score += bestFoodReward;
    if (bestFoodReward === 0)
      score -= nearestFood * (hp < 50 ? 1 + (50 - hp) / 10 : 0.8);
  }

  let nextMoves = 0;
  let headToHeadThreats = 0;
  let headToHeadRisk = 0;
  let bestFutureExits = 0;
  let bestUncontestedFutureExits = 0;
  const myNextLength = myLen + (ctx.constrictor ? 1 : 0);
  for (const dest of legalDests(ctx, me.body)) {
    if (dest < 0 || freeAt[dest] > 1) continue;
    nextMoves++;
    const myLengthAfterMove =
      myNextLength + (!ctx.constrictor && food[dest] ? 1 : 0);
    let threatened = false;
    for (let i = 0; i < n && !threatened; i++) {
      if (i === ctx.meIdx || !snakes[i].alive) continue;
      const opponent = snakes[i];
      const opponentHeadMoves = nbr[opponent.body[0]];
      const opponentNeck = opponent.body.length > 1 ? opponent.body[1] : -1;
      if (!opponentHeadMoves.includes(dest) || dest === opponentNeck) continue;
      const opponentLengthAfterMove =
        opponent.body.length + (ctx.constrictor || food[dest] ? 1 : 0);
      if (opponentLengthAfterMove >= myLengthAfterMove) {
        threatened = true;
        const profile = ctx.opponentProfiles.get(ctx.opponentIds[i]);
        const confidence = profile
          ? Math.min(1, profile.aggressionSamples / 8)
          : 0;
        headToHeadRisk +=
          40 + (profile ? profile.aggression * confidence * 30 : 0);
      }
    }
    if (threatened) headToHeadThreats++;

    // Look one additional move beyond this destination. Estimate exits using
    // how soon current body squares clear; count squares within two steps of an
    // equal-or-longer opponent as contested, not safe escape routes.
    let futureExits = 0;
    let uncontestedFutureExits = 0;
    const releaseHorizon = food[dest] ? 3 : 2;
    for (const future of nbr[dest]) {
      if (future < 0 || future === head || freeAt[future] > releaseHorizon)
        continue;
      futureExits++;
      if (
        maxOppLen < myLengthAfterMove ||
        opponentDist[future] > 2
      ) {
        uncontestedFutureExits++;
      }
    }
    if (
      uncontestedFutureExits > bestUncontestedFutureExits ||
      (uncontestedFutureExits === bestUncontestedFutureExits &&
        futureExits > bestFutureExits)
    ) {
      bestFutureExits = futureExits;
      bestUncontestedFutureExits = uncontestedFutureExits;
    }
  }
  if (nextMoves === 0) {
    score -= 50000;
  } else {
    // A single exit is already a warning; a single exit under head pressure
    // is usually a trap several turns in the making.
    if (nextMoves === 1) score -= 180;
    else if (nextMoves === 2) score -= 40;
    const unthreatenedExits = nextMoves - headToHeadThreats;
    if (nextMoves > 1 && unthreatenedExits === 1) score -= 60;
    score -= headToHeadRisk;
    if (headToHeadThreats === nextMoves) score -= 25000;

    // Prefer moves that leave room to turn again, especially when a longer
    // opponent can contest the only continuation.
    if (bestFutureExits === 0) score -= 220;
    else if (bestFutureExits === 1) score -= 110;
    else if (bestFutureExits === 2) score -= 35;
    if (bestFutureExits > 0 && bestUncontestedFutureExits === 0)
      score -= 100;
  }
  return score;
}

// MY turn to choose. Returns the best score I can force from this board.
function maxNode(ctx, state, depth, alpha, beta, ply) {
  if (ctx.canTimeout && (++ctx.nodes & 15) === 0 && Date.now() > ctx.deadline) {
    throw TIMEOUT;
  }
  const snakes = state.snakes;
  const me = snakes[ctx.meIdx];
  let oppAlive = 0;
  for (let i = 0; i < snakes.length; i++) {
    if (i !== ctx.meIdx && snakes[i].alive) oppAlive++;
  }

  // Dying later is better than dying sooner; winning sooner is better.
  if (!me.alive) {
    return ctx.hasOpps && oppAlive === 0 ? -30000 + ply : -100000 + ply; // 2nd = draw
  }
  if (ctx.hasOpps && oppAlive === 0) return 100000 - ply;
  if (depth <= 0) return evaluate(ctx, state);

  let best = -Infinity;
  for (const dest of legalDests(ctx, me.body)) {
    const v = minNode(ctx, state, dest, depth, alpha, beta, ply);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// OPPONENTS' turn, after I've committed to myDest. They pick the replies that
// are worst for me. The nearest ones get every sensible reply tried; the rest
// just move into open space.
function minNode(ctx, state, myDest, depth, alpha, beta, ply) {
  const snakes = state.snakes;
  const n = snakes.length;
  const W = ctx.W;

  // Mark every body square that will still be blocked next turn (all but the tail).
  const occ = ctx.occ;
  const stamp = ++ctx.stamp;
  for (let i = 0; i < n; i++) {
    if (!snakes[i].alive) continue;
    const b = snakes[i].body;
    const bodyLimit = ctx.constrictor ? b.length : b.length - 1;
    for (let k = 0; k < bodyLimit; k++) occ[b[k]] = stamp;
  }

  const dests = new Array(n).fill(-1);
  dests[ctx.meIdx] = myDest;

  const myHead = snakes[ctx.meIdx].body[0];
  const mx = myHead % W;
  const my = (myHead - mx) / W;

  const opps = [];
  for (let i = 0; i < n; i++) {
    if (i === ctx.meIdx || !snakes[i].alive) continue;
    const body = snakes[i].body;
    const all = legalDests(ctx, body);
    const safe = all.filter((c) => c >= 0 && occ[c] !== stamp); // skip suicidal replies
    const hx = body[0] % W;
    const hy = (body[0] - hx) / W;
    opps.push({
      i,
      list: safe.length > 0 ? safe : all,
      dist: Math.abs(hx - mx) + Math.abs(hy - my),
    });
  }
  opps.sort((a, b) => a.dist - b.dist);

  const meLength = snakes[ctx.meIdx].body.length;
  const myNextLength =
    meLength + (ctx.constrictor || state.food[myDest] ? 1 : 0);
  for (const opp of opps) {
    const body = snakes[opp.i].body;
    const nextLength = body.length + (ctx.constrictor ? 1 : 0);
    opp.list.sort((a, b) => {
      const threat = (dest) => {
        if (dest < 0) return -Infinity;
        const theirLength =
          nextLength + (!ctx.constrictor && state.food[dest] ? 1 : 0);
        if (dest === myDest) {
          return theirLength >= myNextLength ? 10000 : -10000;
        }
        const distance =
          Math.abs((dest % W) - (myDest % W)) +
          Math.abs(Math.floor(dest / W) - Math.floor(myDest / W));
        return (theirLength >= myNextLength ? 100 : 10) / (distance + 1);
      };
      return threat(b) - threat(a);
    });
  }

  const enumerated = [];
  for (let j = 0; j < opps.length; j++) {
    if (j < ENUM_OPPONENTS) enumerated.push(opps[j]);
    else dests[opps[j].i] = pickOpen(ctx, opps[j].list, stamp);
  }

  // Every combination of replies from the enumerated opponents.
  let combos = [[]];
  for (const e of enumerated) {
    const grown = [];
    for (const c of combos) for (const m of e.list) grown.push(c.concat(m));
    combos = grown;
  }

  let value = Infinity;
  for (const combo of combos) {
    for (let k = 0; k < enumerated.length; k++)
      dests[enumerated[k].i] = combo[k];
    const child = step(ctx, state, dests);
    const v = maxNode(ctx, child, depth - 1, alpha, beta, ply + 1);
    if (v < value) value = v;
    if (value < beta) beta = value;
    if (beta <= alpha) break;
  }
  return value;
}

// Picks the best of the candidate moves by searching as deep as time allows.
function lookahead(gameState, candidates, startTime, timing) {
  const B = getBoard(gameState.board.width, gameState.board.height);
  const { state, meIdx } = buildState(gameState, B);
  const opponentIds = gameState.board.snakes.map((snake) => snake.id);
  if (opponentIds.length < state.snakes.length)
    opponentIds.push(gameState.you.id);

  // Time budget = timeout - (measured overhead) - safety margin.
  // The engine tells us last turn's total latency; minus our own thinking time
  // that leaves the overhead we can't control.
  const timeout = gameState.game?.timeout ?? 500;
  const latency = parseInt(gameState.you.latency, 10);
  if (latency > 0 && timing.lastComputeMs > 0) {
    const observed = Math.max(0, latency - timing.lastComputeMs);
    timing.overheadEst =
      observed > timing.overheadEst
        ? observed
        : 0.7 * timing.overheadEst + 0.3 * observed;
  }
  // The first few turns are an open board where deep search adds almost nothing,
  // so think less there and spend the saved time as safety margin.
  const cap = gameState.turn < 5 ? EARLY_BUDGET_MS : MAX_BUDGET_MS;
  const availableBudget = Math.floor(timeout - timing.overheadEst - SAFETY_MS);
  const budget =
    availableBudget < MIN_BUDGET_MS ? 0 : Math.min(cap, availableBudget);
  if (budget === 0) {
    console.log(
      `LOOKAHEAD skipped: only ${Math.max(0, availableBudget)}ms available after latency reserve`,
    );
    return null;
  }

  const hazard = new Uint8Array(B.N);
  for (const h of gameState.board.hazards || []) hazard[h.y * B.W + h.x] = 1;
  const constrictor =
    gameState.game?.ruleset?.name?.toLowerCase() === "constrictor";

  const ctx = {
    W: B.W,
    N: B.N,
    nbr: B.nbr,
    meIdx,
    hasOpps: state.snakes.length > 1,
    opponentIds,
    opponentProfiles: timing.opponentProfiles,
    hazard,
    hazardDmg: gameState.game?.ruleset?.settings?.hazardDamagePerTurn ?? 14,
    constrictor,
    deadline: startTime + budget,
    canTimeout: false,
    nodes: 0,
    // scratch buffers reused by every evaluation (avoids garbage collection)
    stamp: 0,
    seenStamp: 0,
    occ: new Int32Array(B.N),
    seen: new Int32Array(B.N),
    freeAt: new Int16Array(B.N),
    owner: new Int8Array(B.N),
    dist: new Int16Array(B.N),
    myDist: new Int16Array(B.N),
    oppDist: new Int16Array(B.N),
    qa: new Int16Array(B.N),
    qb: new Int16Array(B.N),
    cnt: new Int16Array(state.snakes.length + 1),
  };

  const myHead = state.snakes[meIdx].body[0];
  let order = candidates.map((dir) => ({
    dir,
    dest: B.nbr[myHead][DIR_INDEX[dir]],
  }));
  if (order.length === 1) return order[0].dir; // only one option, no need to think

  let bestDir = null;
  let bestScore = 0;
  let depthDone = 0;

  try {
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      ctx.canTimeout = depth > 1; // depth 1 is tiny, always let it finish
      let alpha = -Infinity;
      let roundBest = null;
      const scored = [];

      for (const r of order) {
        const v = minNode(ctx, state, r.dest, depth, alpha, Infinity, 0);
        scored.push({ r, v });
        if (v > alpha) {
          alpha = v;
          roundBest = r;
        }
      }

      // This whole round finished, so its answer is trustworthy.
      bestDir = roundBest.dir;
      bestScore = alpha;
      depthDone = depth;

      // Search the best-looking moves first next round (more pruning).
      scored.sort((a, b) => b.v - a.v);
      order = scored.map((s) => s.r);

      if (alpha >= 90000) break; // found a forced win, stop thinking
    }
  } catch (e) {
    if (e !== TIMEOUT) throw e;
  }

  console.log(
    `LOOKAHEAD depth ${depthDone}, ${Date.now() - startTime}ms of ${budget}ms, score ${Math.round(bestScore)}, nodes ${ctx.nodes}, engine latency ${gameState.you.latency}, overhead ~${Math.round(timing.overheadEst)}ms`,
  );
  return bestDir;
}

// move is called on every turn and returns your next move
// Valid moves are "up", "down", "left", or "right"
// See https://docs.battlesnake.com/api/example-move for available data
function move(gameState) {
  const startTime = Date.now();
  const { timing } = getGameTiming(gameState);
  updateOpponentProfiles(gameState, timing);
  const constrictor =
    gameState.game?.ruleset?.name?.toLowerCase() === "constrictor";

  let isMoveSafe = {
    up: true,
    down: true,
    left: true,
    right: true,
  };

  // We've included code to prevent your Battlesnake from moving backwards
  const myHead = gameState.you.body[0];
  const myNeck = gameState.you.body[1];

  // Did the engine actually play the move we sent last turn? If not, our
  // answer arrived too late (the engine then repeats the old direction),
  // so assume more overhead and think for less time.
  if (timing.lastMove && gameState.turn === timing.lastMove.turn + 1) {
    const v = DIR_VEC[timing.lastMove.dir];
    if (
      myHead.x !== timing.lastMove.x + v.x ||
      myHead.y !== timing.lastMove.y + v.y
    ) {
      timing.overheadEst = Math.min(400, timing.overheadEst + 100);
      console.log(
        `LATE: turn ${timing.lastMove.turn} answer was not played. Assuming ${timing.overheadEst}ms overhead.`,
      );
    }
  }

  if (myNeck.x < myHead.x) {
    // Neck is left of head, don't move left
    isMoveSafe.left = false;
  } else if (myNeck.x > myHead.x) {
    // Neck is right of head, don't move right
    isMoveSafe.right = false;
  } else if (myNeck.y < myHead.y) {
    // Neck is below head, don't move down
    isMoveSafe.down = false;
  } else if (myNeck.y > myHead.y) {
    // Neck is above head, don't move up
    isMoveSafe.up = false;
  }

  // Where each move takes the head (y increases upward)
  const directions = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const nextSquare = (dir) => ({
    x: myHead.x + directions[dir].x,
    y: myHead.y + directions[dir].y,
  });

  // TODO: Step 1 - Prevent your Battlesnake from moving out of bounds
  const boardWidth = gameState.board.width;
  const boardHeight = gameState.board.height;

  for (const dir of Object.keys(directions)) {
    const next = nextSquare(dir);
    if (
      next.x < 0 ||
      next.x >= boardWidth ||
      next.y < 0 ||
      next.y >= boardHeight
    ) {
      isMoveSafe[dir] = false;
    }
  }

  // TODO: Step 2 - Prevent your Battlesnake from colliding with itself
  const myBody = gameState.you.body;

  // TODO: Step 3 - Prevent your Battlesnake from colliding with other Battlesnakes
  const opponents = gameState.board.snakes;

  // Build a set of every occupied square (our body + all other snakes).
  // The tail is skipped because it moves away this turn. If a snake just ate,
  // its tail is stacked on the segment before it, so that square is still blocked.
  const blocked = new Set();
  for (const snake of opponents) {
    snake.body.forEach((segment, i) => {
      const isTail =
        !constrictor && i === snake.body.length - 1 && snake.body.length > 1;
      if (!isTail) blocked.add(`${segment.x},${segment.y}`);
    });
  }
  // gameState.board.snakes already includes us, but add myBody to be safe
  myBody.forEach((segment, i) => {
    const isTail = !constrictor && i === myBody.length - 1 && myBody.length > 1;
    if (!isTail) blocked.add(`${segment.x},${segment.y}`);
  });

  for (const dir of Object.keys(directions)) {
    const next = nextSquare(dir);
    if (blocked.has(`${next.x},${next.y}`)) {
      isMoveSafe[dir] = false;
    }
  }

  // Head-to-head danger: squares next to the head of any snake that is
  // as long as or longer than us (we'd lose or tie, and a tie kills both)
  const dangerous = new Set();
  for (const snake of opponents) {
    if (snake.id === gameState.you.id) continue;
    if (snake.length >= gameState.you.length) {
      const h = snake.head;
      for (const d of Object.values(directions)) {
        dangerous.add(`${h.x + d.x},${h.y + d.y}`);
      }
    }
  }

  // Are there any safe moves left?
  const safeMoves = Object.keys(isMoveSafe).filter((key) => isMoveSafe[key]);
  if (safeMoves.length == 0) {
    console.log(`MOVE ${gameState.turn}: No safe moves detected! Moving down`);
    return { move: "down" };
  }

  // Prefer safe moves that avoid head-to-head danger; if none, accept the risk
  const saferMoves = safeMoves.filter((dir) => {
    const next = nextSquare(dir);
    return !dangerous.has(`${next.x},${next.y}`);
  });
  const candidates = saferMoves.length > 0 ? saferMoves : safeMoves;

  // Fallback pick in case the search can't answer (random safe move)
  let nextMove = candidates[Math.floor(Math.random() * candidates.length)];

  // TODO: Step 4 - Move towards food instead of random, to regain health and survive longer
  // Food is handled inside the search (see evaluate), including hunger.
  // We hand the search ALL safe moves so it can still pick a risky head-to-head
  // square if every alternative is worse.
  try {
    const searched = lookahead(gameState, safeMoves, startTime, timing);
    if (searched) nextMove = searched;
  } catch (e) {
    console.log("SEARCH ERROR, using fallback move:", e);
  }

  timing.lastMove = {
    turn: gameState.turn,
    dir: nextMove,
    x: myHead.x,
    y: myHead.y,
  };
  timing.lastComputeMs = Date.now() - startTime;
  console.log(`MOVE ${gameState.turn}: ${nextMove}`);
  return { move: nextMove };
}

runServer({
  info: info,
  start: start,
  move: move,
  end: end,
});
