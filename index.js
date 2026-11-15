// Welcome to
// __________         __    __  .__                               __
// \______   \_____ _/  |__/  |_|  |   ____   ______ ____ _____  |  | __ ____
//  |    |  _/\__  \   __\   __\  | _/ __ \ /  ___//    \__  \ |  |/ // __ \
//  |    |   \ / __ \|  |  |  | |  |_\  ___/ \___ \|   |  \/ __ \|    <\  ___/
//  |________/(______/__|  |__| |____/\_____>______>___|__(______/__|__\_____>
//
// Single-file Battlesnake: server hooks at the bottom, look-ahead search in the middle.
// For more info see docs.battlesnake.com

import { performance } from "node:perf_hooks";
import runServer from "./server.js";

// ---------------------------------------------------------------------------
// Battlesnake hooks
// ---------------------------------------------------------------------------

function info() {
  console.log("INFO");

  return {
    apiversion: "1",
    author: "VeerHarsh",
    color: "#00FF00",
    head: "tiger-king",
    tail: "tiger-tail",
  };
}

function start(gameState) {
  console.log("GAME START");
}

function end(gameState) {
  forgetGame(gameState);
  console.log("GAME OVER\n");
}

function move(gameState) {
  return { move: chooseMove(gameState) };
}

// ---------------------------------------------------------------------------
// Move selection: look ahead before every move.
//
// For each of our moves we simulate the next turns for every snake (walls, bodies, tails,
// food, hazards, head-to-head) and assume nearby rivals answer with whatever is worst for
// us. The search deepens one turn at a time (iterative deepening + alpha-beta) and stops
// when the time budget runs out, so the reply always goes out well inside the 500 ms limit.
// ---------------------------------------------------------------------------

const DIR_NAMES = ["up", "down", "left", "right"];
const DX = [0, 0, -1, 1];
const DY = [1, -1, 0, 0];

// Outcome scores. One "ply" is a full turn in which every snake moves.
const PLY = 1e6;
const WIN = 1e9;              // WIN - ply * PLY: winning sooner is better
const DRAW = -3e8;            // everyone left dies on the same turn
const LOSS = -1e9;            // LOSS + ply * PLY: dying later is better than dying sooner
const WON = WIN - 200 * PLY;  // values >= WON are forced wins
const LOST = LOSS + 200 * PLY; // values <= LOST are forced losses

// Time limits. Battlesnake allows 500 ms per move including network time, so the search
// itself only gets part of it. MOVE_BUDGET_MS can lower or raise the ceiling.
// The HTTP request also needs time for Node, Express, and network overhead.
// Keep the search short enough to leave a large margin under the 500 ms limit.
const MAX_BUDGET_MS = Math.min(Number(process.env.MOVE_BUDGET_MS) || 55, 55);
const MIN_BUDGET_MS = 5;
const SAFETY_MS = 100;
const MAX_DEPTH = 64;

// Rivals whose every reply is explored: the two nearest, plus anyone whose head is this close.
const TREE_RIVALS = 2;
const TREE_RADIUS = 3;

const TIMEOUT = Symbol("timeout");
const DEAD = Object.freeze({ body: [], health: 0, alive: false });

// Per game: how long our last search took, so we can measure the network overhead
// from the latency Battlesnake reports back on the next turn.
const games = new Map();

function forgetGame(gameState) {
  games.delete(memoKey(gameState));
}

function chooseMove(gameState) {
  const t0 = performance.now();
  const ctx = buildContext(gameState);
  const root = buildState(gameState, ctx.W);
  const n = root.snakes.length;
  const budget = timeBudget(gameState);
  ctx.deadline = t0 + budget;
  ctx.counts = new Int32Array(n);
  ctx.rootRivals = n - 1;
  ctx.solo = n === 1;

  // Decide which rivals get the full worst-case treatment; the rest follow a cheap policy.
  const myHead = root.snakes[0].body[0];
  const byDistance = [];
  for (let i = 1; i < n; i++) byDistance.push(i);
  byDistance.sort((a, b) => cellDist(ctx, myHead, root.snakes[a].body[0]) - cellDist(ctx, myHead, root.snakes[b].body[0]));
  ctx.inTree = new Uint8Array(n);
  let treeCount = 0;
  for (const i of byDistance) {
    if (treeCount < TREE_RIVALS || cellDist(ctx, myHead, root.snakes[i].body[0]) <= TREE_RADIUS) {
      ctx.inTree[i] = 1;
      treeCount++;
    }
  }

  const stamp = markBlocked(ctx, root);
  const moves = legalMoves(ctx, root, 0, stamp);
  let best;
  let details;

  if (moves.length === 0) {
    // Every square is a wall or a body that will still be there: nothing survives.
    best = 0;
    for (let d = 0; d < 4; d++) if (ctx.nbr[myHead * 4 + d] >= 0) { best = d; break; }
    details = "no safe move";
  } else if (moves.length === 1) {
    best = moves[0];
    details = "only one safe move";
  } else {
    const plan = rivalPlan(ctx, root, stamp);
    const result = iterativeDeepening(ctx, root, plan, quickOrder(ctx, root, moves));
    best = result.move;
    details = `depth ${result.depth}, score ${formatScore(result.score)}, ${ctx.nodes} nodes`;
  }

  const elapsed = performance.now() - t0;
  remember(gameState, elapsed, budget);
  console.log(`MOVE ${gameState.turn}: ${DIR_NAMES[best]} (${details}, ${elapsed.toFixed(0)}/${budget.toFixed(0)} ms)`);
  return DIR_NAMES[best];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function iterativeDeepening(ctx, root, plan, order) {
  let best = order[0];
  let bestScore = -Infinity;
  let depthDone = 0;
  const lastScore = new Map();

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    ctx.horizon = false;
    const results = [];
    let alpha = -Infinity;
    try {
      for (const m of order) {
        const v = minNode(ctx, root, m, plan, depth, 0, alpha, Infinity);
        results.push({ m, v });
        if (v > alpha) alpha = v;
      }
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      best = salvagePartial(results, order, lastScore, best);
      break;
    }

    // Stable sort: equal scores keep the order from the previous (shallower) search.
    results.sort((a, b) => b.v - a.v);
    order = results.map((r) => r.m);
    for (const r of results) lastScore.set(r.m, r.v);
    best = order[0];
    bestScore = results[0].v;
    depthDone = depth;

    if (!ctx.horizon) break;                               // every line already ends in a result
    if (bestScore >= WON || bestScore <= LOST) break;      // forced win, or every move loses
    if (results.length > 1 && results[1].v <= LOST) break; // only one move avoids a forced loss
  }
  return { move: best, depth: depthDone, score: bestScore };
}

// Time ran out partway through a deeper search. Use what that search proved.
function salvagePartial(results, order, lastScore, fallback) {
  if (!results.length) return fallback;
  let top = results[0];
  for (const r of results) if (r.v > top.v) top = r;
  if (top.v > LOST) return top.m;
  // The moves searched so far all lose at this depth; prefer one not yet shown to lose.
  const lost = new Set(results.filter((r) => r.v <= LOST).map((r) => r.m));
  const alt = order.find((m) => !lost.has(m) && !(lastScore.get(m) <= LOST));
  return alt ?? fallback;
}

// Our turn to choose: take the best of our moves.
function maxNode(ctx, st, depth, ply, alpha, beta) {
  if ((++ctx.nodes & 7) === 0 && performance.now() > ctx.deadline) throw TIMEOUT;
  const over = terminal(ctx, st, ply);
  if (over !== null) return over;
  if (depth === 0) {
    ctx.horizon = true;
    return evaluate(ctx, st);
  }
  const stamp = markBlocked(ctx, st);
  const mine = legalMoves(ctx, st, 0, stamp);
  if (!mine.length) return LOSS + (ply + 1) * PLY;
  const plan = rivalPlan(ctx, st, stamp);
  let best = -Infinity;
  for (const m of mine) {
    const v = minNode(ctx, st, m, plan, depth, ply, alpha, beta);
    if (v > best) {
      best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
  }
  return best;
}

// Rivals answer our move: try every combination of their replies and keep the worst for us.
function minNode(ctx, st, myMove, plan, depth, ply, alpha, beta) {
  const { idx, lists } = plan;
  const k = idx.length;
  const moves = plan.fixed.slice();
  moves[0] = myMove;
  const myNext = ctx.nbr[st.snakes[0].body[0] * 4 + myMove];
  const ordered = new Array(k);
  for (let t = 0; t < k; t++) ordered[t] = closestFirst(ctx, st.snakes[idx[t]].body[0], lists[t], myNext);
  const ctr = new Array(k).fill(0);

  let best = Infinity;
  for (;;) {
    for (let t = 0; t < k; t++) moves[idx[t]] = ordered[t][ctr[t]];
    const v = maxNode(ctx, step(ctx, st, moves), depth - 1, ply + 1, alpha, beta);
    if (v < best) {
      best = v;
      if (v < beta) beta = v;
      if (alpha >= beta) break;
    }
    let t = 0;
    while (t < k && ++ctr[t] === ordered[t].length) ctr[t++] = 0;
    if (t === k) break;
  }
  return best;
}

function terminal(ctx, st, ply) {
  const s = st.snakes;
  let rivals = 0;
  for (let i = 1; i < s.length; i++) if (s[i].alive) rivals++;
  if (!s[0].alive) return !ctx.solo && rivals === 0 ? DRAW + ply * PLY : LOSS + ply * PLY;
  if (!ctx.solo && rivals === 0) return WIN - ply * PLY;
  return null;
}

// Moves for every rival: full reply lists for nearby rivals, one cheap guess for far ones.
function rivalPlan(ctx, st, stamp) {
  const n = st.snakes.length;
  const fixed = new Array(n).fill(0);
  const idx = [];
  const lists = [];
  for (let i = 1; i < n; i++) {
    if (!st.snakes[i].alive) continue;
    if (ctx.inTree[i]) {
      const l = legalMoves(ctx, st, i, stamp);
      idx.push(i);
      lists.push(l.length ? l : [0]); // trapped rival: any move, it dies
    } else {
      fixed[i] = greedyMove(ctx, st, i, stamp);
    }
  }
  return { idx, lists, fixed };
}

// Try the rival replies that land closest to our head first: they are the dangerous ones
// and finding them early lets alpha-beta skip the rest.
function closestFirst(ctx, from, list, target) {
  if (list.length < 2) return list;
  const out = list.slice();
  const d = out.map((m) => cellDist(ctx, ctx.nbr[from * 4 + m], target));
  for (let i = 1; i < out.length; i++) {
    for (let j = i; j > 0 && d[j] < d[j - 1]; j--) {
      [out[j], out[j - 1]] = [out[j - 1], out[j]];
      [d[j], d[j - 1]] = [d[j - 1], d[j]];
    }
  }
  return out;
}

// Starting order for the first search: avoid squares a same-size or bigger head can reach.
function quickOrder(ctx, st, moves) {
  const me = st.snakes[0];
  const scored = moves.map((m) => {
    const c = ctx.nbr[me.body[0] * 4 + m];
    let risk = 0;
    for (let i = 1; i < st.snakes.length; i++) {
      const s = st.snakes[i];
      if (s.alive && s.body.length >= me.body.length && cellDist(ctx, c, s.body[0]) === 1) risk++;
    }
    return { m, risk };
  });
  scored.sort((a, b) => a.risk - b.risk);
  return scored.map((s) => s.m);
}

function greedyMove(ctx, st, i, stamp) {
  const s = st.snakes[i];
  const moves = legalMoves(ctx, st, i, stamp);
  if (!moves.length) return 0;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const c = ctx.nbr[s.body[0] * 4 + m];
    let score = 0;
    let open = 0;
    for (let k = 0; k < 4; k++) {
      const nb = ctx.nbr[c * 4 + k];
      if (nb >= 0 && ctx.blk[nb] !== stamp) open++;
    }
    score += open * 3;

    let foodDist = Infinity;
    for (const food of st.food) foodDist = Math.min(foodDist, cellDist(ctx, c, food));
    if (foodDist < Infinity) score -= foodDist * (s.health < 55 ? 2.5 : 0.35);

    const me = st.snakes[0];
    if (i !== 0 && me.alive) {
      const d = cellDist(ctx, c, me.body[0]);
      if (s.body.length > me.body.length) score += Math.max(0, 5 - d) * 1.5;
      else if (s.body.length < me.body.length) score += Math.min(d, 6) * 0.8;
      if (s.body.length <= me.body.length && d === 1) score -= 24;
    }

    const onFood = st.food.includes(c);
    if (ctx.hazard[c] && !onFood) {
      score -= ctx.hazard[c] * (s.health < 45 ? ctx.hazardDamage * 1.5 : 4);
    }
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rules simulation
// ---------------------------------------------------------------------------

// Mark every square that will still be occupied after the next move. A tail moves away
// unless the snake just ate (its tail is doubled up), so tails are left unmarked.
function markBlocked(ctx, st) {
  const stamp = ++ctx.stamp;
  const blk = ctx.blk;
  for (const s of st.snakes) {
    if (!s.alive) continue;
    const last = ctx.constrictor ? s.body.length : s.body.length - 1;
    for (let j = 0; j < last; j++) blk[s.body[j]] = stamp;
  }
  return stamp;
}

// Moves that do not hit a wall, our own neck/body or another snake's body.
function legalMoves(ctx, st, i, stamp) {
  const head = st.snakes[i].body[0];
  const out = [];
  for (let d = 0; d < 4; d++) {
    const nb = ctx.nbr[head * 4 + d];
    if (nb >= 0 && ctx.blk[nb] !== stamp) out.push(d);
  }
  return out;
}

// Advance one turn following the official order: move, lose health, hazard damage, eat,
// then remove snakes that starved, left the board, hit a body or lost a head-to-head.
function step(ctx, st, moves) {
  const { nbr, hazard, hazardDamage, constrictor } = ctx;
  const prev = st.snakes;
  const n = prev.length;
  const next = new Array(n);
  let food = st.food;
  let eaten = null;

  for (let i = 0; i < n; i++) {
    const s = prev[i];
    if (!s.alive) { next[i] = s; continue; }
    const head = nbr[s.body[0] * 4 + moves[i]];
    if (head < 0) { next[i] = DEAD; continue; }
    const len = s.body.length;
    const body = new Array(len);
    body[0] = head;
    for (let j = 1; j < len; j++) body[j] = s.body[j - 1];
    const onFood = food.includes(head);
    let health = s.health - 1;
    if (hazard[head] && !onFood) health -= hazardDamage * hazard[head];
    if (onFood || constrictor) {
      health = 100;
      body.push(body[len - 1]);
      if (onFood) (eaten ??= []).push(head);
    }
    next[i] = { body, health, alive: health > 0 };
  }
  if (eaten) food = food.filter((f) => !eaten.includes(f));

  const stamp = ++ctx.stamp;
  const occ = ctx.occ;
  for (let i = 0; i < n; i++) {
    const s = next[i];
    if (!s.alive) continue;
    for (let j = 1; j < s.body.length; j++) occ[s.body[j]] = stamp;
  }
  let dying = null;
  for (let i = 0; i < n; i++) {
    const s = next[i];
    if (!s.alive) continue;
    const h = s.body[0];
    let dies = occ[h] === stamp;
    for (let k = 0; !dies && k < n; k++) {
      const o = next[k];
      if (k !== i && o.alive && o.body[0] === h && s.body.length <= o.body.length) dies = true;
    }
    if (dies) (dying ??= []).push(i);
  }
  if (dying) for (const i of dying) next[i].alive = false;

  return { snakes: next, food };
}

// ---------------------------------------------------------------------------
// Position evaluation (used when the search stops looking further ahead)
// ---------------------------------------------------------------------------

function evaluate(ctx, st) {
  const { nbr, freeAt, freeStamp, seen, dist, owner, bestLen, reachMask, foodMark, counts } = ctx;
  const snakes = st.snakes;
  const n = snakes.length;
  const me = snakes[0];
  const stamp = ++ctx.stamp;

  // Segment j of a snake of length L clears after L - j turns.
  for (let i = 0; i < n; i++) {
    const s = snakes[i];
    if (!s.alive) continue;
    const b = s.body;
    const L = b.length;
    for (let j = 0; j < L; j++) {
      const c = b[j];
      const t = ctx.constrictor ? 1 << 30 : L - j;
      if (freeStamp[c] !== stamp || freeAt[c] < t) { freeStamp[c] = stamp; freeAt[c] = t; }
    }
  }
  for (const f of st.food) foodMark[f] = stamp;

  // Spread out from every head at once: a square belongs to whoever gets there first
  // (longer snake wins a tie, equal lengths leave it neutral).
  counts.fill(0);
  let q = ctx.q1;
  let nxt = ctx.q2;
  let nq = 0;
  for (let i = 0; i < n; i++) {
    const s = snakes[i];
    if (!s.alive) continue;
    const h = s.body[0];
    if (seen[h] === stamp) {
      reachMask[h] |= (1 << i);
    } else {
      seen[h] = stamp; dist[h] = 0; owner[h] = i; bestLen[h] = s.body.length;
      reachMask[h] = (1 << i);
      q[nq++] = h;
    }
  }
  let foodDist = Infinity;
  for (let d = 1; nq > 0; d++) {
    let nn = 0;
    for (let a = 0; a < nq; a++) {
      const c = q[a];
      const mask = reachMask[c];
      for (let k = 0; k < 4; k++) {
        const nb = nbr[c * 4 + k];
        if (nb < 0) continue;
        if (seen[nb] === stamp) {
          if (dist[nb] === d) reachMask[nb] |= mask;
          continue;
        }
        if (freeStamp[nb] === stamp && freeAt[nb] > d) continue;
        seen[nb] = stamp; dist[nb] = d; owner[nb] = -1; bestLen[nb] = 0; reachMask[nb] = mask;
        nxt[nn++] = nb;
      }
    }
    for (let a = 0; a < nn; a++) {
      const c = nxt[a], mask = reachMask[c];
      let longest = -1, winner = -1, tied = false;
      for (let i = 0; i < n; i++) {
        if (!(mask & (1 << i)) || !snakes[i].alive) continue;
        const length = snakes[i].body.length;
        if (length > longest) { longest = length; winner = i; tied = false; }
        else if (length === longest) tied = true;
      }
      owner[c] = tied ? -1 : winner;
      bestLen[c] = longest;
      if (owner[c] >= 0) counts[owner[c]]++;
      if (owner[c] === 0 && foodDist === Infinity && foodMark[c] === stamp) foodDist = d;
    }
    const tmp = q; q = nxt; nxt = tmp; nq = nn;
  }

  const myLen = me.body.length;
  const territory = counts[0];
  // Fewer squares than our length usually means a trap. Double-check with our own flood fill,
  // ignoring who reaches each square first.
  const space = territory >= myLen ? territory : soloReach(ctx, me.body[0], stamp, myLen);

  let rivals = 0;
  let maxRival = 0;
  for (let i = 1; i < n; i++) {
    if (snakes[i].alive) { rivals++; maxRival = Math.max(maxRival, snakes[i].body.length); }
  }

  let score = territory * 10;
  if (space < myLen) score -= 2500 + (myLen - space) * 300;
  else if (territory < myLen) score -= (myLen - territory) * 15;

  if (!ctx.solo) {
    score += (ctx.rootRivals - rivals) * 1500;
    if (rivals) score += Math.max(-6, Math.min(6, myLen - maxRival)) * 70;
  }

  // Start routing toward food before health is critical: detours and opponents can
  // make the nearest food unreachable between turns.
  const hungry = me.health < 55 || (rivals > 0 && myLen <= maxRival + 1);
  if (foodDist !== Infinity) {
    if (foodDist >= me.health) score -= 4000;
    score -= foodDist * (me.health < 20 ? 55 : hungry ? 18 : 2);
  } else if (me.health < 25) {
    score -= (25 - me.health) * 60;
  }
  score += me.health;

  // Heads two squares apart can meet next turn: risky against an equal or bigger snake.
  const myHead = me.body[0];
  for (let i = 1; i < n; i++) {
    const s = snakes[i];
    if (s.alive && cellDist(ctx, myHead, s.body[0]) === 2) score += s.body.length >= myLen ? -300 : 40;
  }
  return score;
}

// How many squares we can reach (stopping once we know there is enough room).
function soloReach(ctx, head, freeTag, cap) {
  const { nbr, seen, dist, freeAt, freeStamp, q1 } = ctx;
  const tag = ++ctx.stamp;
  seen[head] = tag;
  dist[head] = 0;
  let qh = 0;
  let qt = 0;
  let count = 0;
  q1[qt++] = head;
  while (qh < qt) {
    const c = q1[qh++];
    const d = dist[c] + 1;
    for (let k = 0; k < 4; k++) {
      const nb = nbr[c * 4 + k];
      if (nb < 0 || seen[nb] === tag) continue;
      if (freeStamp[nb] === freeTag && freeAt[nb] > d) continue;
      seen[nb] = tag;
      dist[nb] = d;
      q1[qt++] = nb;
      if (++count >= cap) return count;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function buildContext(gs) {
  const W = gs.board.width;
  const H = gs.board.height;
  const N = W * H;
  const ruleset = gs.game?.ruleset ?? {};
  const name = String(ruleset.name ?? "standard");
  const wrapped = name.includes("wrapped");
  const constrictor = name.includes("constrictor");
  const hazardDamage = Number(ruleset.settings?.hazardDamagePerTurn ?? 14);

  const nbr = new Int32Array(N * 4);
  const cx = new Int32Array(N);
  const cy = new Int32Array(N);
  for (let c = 0; c < N; c++) {
    const x = c % W;
    const y = (c - x) / W;
    cx[c] = x;
    cy[c] = y;
    for (let d = 0; d < 4; d++) {
      let nx = x + DX[d];
      let ny = y + DY[d];
      if (wrapped) { nx = (nx + W) % W; ny = (ny + H) % H; }
      nbr[c * 4 + d] = nx < 0 || nx >= W || ny < 0 || ny >= H ? -1 : ny * W + nx;
    }
  }
  const hazard = new Uint8Array(N);
  for (const h of gs.board.hazards ?? []) {
    if (h.x >= 0 && h.x < W && h.y >= 0 && h.y < H) hazard[h.y * W + h.x]++;
  }

  return {
    W, H, N, wrapped, constrictor, hazardDamage, nbr, cx, cy, hazard,
    stamp: 0,
    blk: new Int32Array(N),
    occ: new Int32Array(N),
    seen: new Int32Array(N),
    freeStamp: new Int32Array(N),
    freeAt: new Int32Array(N),
    foodMark: new Int32Array(N),
    dist: new Int32Array(N),
    owner: new Int8Array(N),
    bestLen: new Int32Array(N),
    reachMask: new Uint32Array(N),
    q1: new Int32Array(N),
    q2: new Int32Array(N),
    nodes: 0,
    deadline: Infinity,
    horizon: false,
  };
}

// Our snake is always index 0.
function buildState(gs, W) {
  const toCell = (p) => p.y * W + p.x;
  const me = gs.you;
  const list = [me, ...gs.board.snakes.filter((s) => s.id !== me.id)];
  return {
    snakes: list.map((s) => ({ body: s.body.map(toCell), health: s.health, alive: true })),
    food: (gs.board.food ?? []).map(toCell),
  };
}

function cellDist(ctx, a, b) {
  let dx = Math.abs(ctx.cx[a] - ctx.cx[b]);
  let dy = Math.abs(ctx.cy[a] - ctx.cy[b]);
  if (ctx.wrapped) { dx = Math.min(dx, ctx.W - dx); dy = Math.min(dy, ctx.H - dy); }
  return dx + dy;
}

function timeBudget(gs) {
  const timeout = Number(gs.game?.timeout) || 500;
  let budget = Math.min(MAX_BUDGET_MS, timeout * 0.6);
  const memo = games.get(memoKey(gs));
  const latency = Number(gs.you?.latency);
  if (memo && Number.isFinite(latency)) {
    if (latency === 0) {
      // Battlesnake reports 0 when the previous reply timed out: halve the budget.
      budget = Math.min(budget, memo.budget * 0.5);
    } else {
      // latency = search time + network/server overhead; leave room for that overhead.
      const overhead = Math.max(0, latency - memo.compute);
      budget = Math.min(budget, timeout - overhead - SAFETY_MS);
    }
  }
  return Math.max(MIN_BUDGET_MS, budget);
}

function remember(gs, compute, budget) {
  const k = memoKey(gs);
  games.delete(k);
  games.set(k, { compute, budget });
  if (games.size > 200) games.delete(games.keys().next().value); // drop games that never sent /end
}

function memoKey(gs) {
  return `${gs.game?.id}:${gs.you?.id}`;
}

function formatScore(v) {
  if (v >= WON) return `win in ${Math.round((WIN - v) / PLY)}`;
  if (v <= LOST) return `loss in ${Math.round((v - LOSS) / PLY)}`;
  if (v <= DRAW + 200 * PLY) return `draw in ${Math.round((v - DRAW) / PLY)}`;
  return v.toFixed(0);
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

runServer({
  info: info,
  start: start,
  move: move,
  end: end,
});
