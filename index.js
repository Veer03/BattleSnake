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
    color: "#00FF00", // TODO: Choose color
    head: "default", // TODO: Choose head
    tail: "default", // TODO: Choose tail
  };
}

// start is called when your Battlesnake begins a game
function start(gameState) {
  console.log("GAME START");
}

// end is called when your Battlesnake finishes a game
function end(gameState) {
  console.log("GAME OVER\n");
}

const DIRS = ["up", "down", "left", "right"];
const DELTA = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
const key = (p) => `${p.x},${p.y}`;
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const add = (p, dir) => ({ x: p.x + DELTA[dir][0], y: p.y + DELTA[dir][1] });
const inside = (p, w, h) => p.x >= 0 && p.x < w && p.y >= 0 && p.y < h;

function legalMoves(s, w, h) {
  if (!s || !s.alive || !s.body?.length) return [];
  const neck = s.body[1];
  return DIRS.filter((d) => {
    const p = add(s.body[0], d);
    if (!inside(p, w, h) || (neck && key(p) === key(neck))) return false;
    for (let i = 0; i < s.body.length; i++) {
      if (i === s.body.length - 1 && s.body.length > 1 && !s.grow) continue;
      if (key(s.body[i]) === key(p)) return false;
    }
    return true;
  });
}

function chooseModelMove(s, state, w, h, me) {
  const moves = legalMoves(s, w, h);
  if (!moves.length) return null;
  let best = moves[0], bestScore = -Infinity;
  for (const d of moves) {
    const p = add(s.body[0], d);
    let score = -0.05 * (Math.min(p.x, w - 1 - p.x) + Math.min(p.y, h - 1 - p.y));
    const foodDist = Math.min(Infinity, ...state.food.map((f) => manhattan(p, f)));
    score -= foodDist * 0.55;
    if (s.length > me.length) score += 0.6 / (manhattan(p, me.body[0]) + 1);
    if (state.hazards.has(key(p))) score -= 2.5;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function stepState(state, moves, w, h, hazardDamage) {
  const next = { ...state, snakes: state.snakes.map((s) => ({ ...s, body: s.body.map((p) => ({ ...p })), alive: s.alive })) };
  const growing = new Map();
  for (let i = 0; i < next.snakes.length; i++) {
    const s = next.snakes[i], dir = moves[i];
    if (!s.alive || !dir) continue;
    const head = add(s.body[0], dir), ate = next.food.some((f) => key(f) === key(head));
    growing.set(s.id, ate);
    s.body.unshift(head);
    if (ate) { s.health = 100; next.food = next.food.filter((f) => key(f) !== key(head)); }
    else { s.body.pop(); s.health -= 1; }
    if (next.hazards.has(key(head))) s.health -= hazardDamage;
    if (!inside(head, w, h) || s.health <= 0) s.alive = false;
  }
  const occupied = new Map();
  for (const s of next.snakes) if (s.alive) for (let j = 1; j < s.body.length; j++) {
    const k = key(s.body[j]); if (!occupied.has(k)) occupied.set(k, []); occupied.get(k).push(s);
  }
  for (const s of next.snakes) if (s.alive && occupied.has(key(s.body[0]))) s.alive = false;
  for (let i = 0; i < next.snakes.length; i++) for (let j = i + 1; j < next.snakes.length; j++) {
    const a = next.snakes[i], b = next.snakes[j];
    if (!a.alive || !b.alive || key(a.body[0]) !== key(b.body[0])) continue;
    if (a.body.length === b.body.length) { a.alive = false; b.alive = false; }
    else if (a.body.length > b.body.length) b.alive = false;
    else a.alive = false;
  }
  return next;
}

function flood(head, snakes, selfId, w, h) {
  const blocked = new Set();
  for (const s of snakes) if (s.alive) s.body.slice(0, -1).forEach((p) => blocked.add(key(p)));
  const seen = new Set([key(head)]), q = [head];
  for (let i = 0; i < q.length; i++) for (const d of DIRS) {
    const p = add(q[i], d), k = key(p);
    if (inside(p, w, h) && !blocked.has(k) && !seen.has(k)) { seen.add(k); q.push(p); }
  }
  return seen.size;
}

function pathDistance(start, targets, snakes, w, h) {
  if (!targets.length) return Infinity;
  const targetSet = new Set(targets.map(key));
  if (targetSet.has(key(start))) return 0;
  const blocked = new Set();
  for (const s of snakes) if (s.alive) s.body.forEach((p, i) => {
    if (i !== s.body.length - 1) blocked.add(key(p));
  });
  blocked.delete(key(start));
  const seen = new Set([key(start)]), q = [{ p: start, d: 0 }];
  for (let i = 0; i < q.length; i++) for (const dir of DIRS) {
    const p = add(q[i].p, dir), k = key(p);
    if (!inside(p, w, h) || blocked.has(k) || seen.has(k)) continue;
    if (targetSet.has(k)) return q[i].d + 1;
    seen.add(k);
    q.push({ p, d: q[i].d + 1 });
  }
  return Infinity;
}

function territory(state, w, h) {
  const dist = new Map(), owners = new Map(), q = [];
  for (const s of state.snakes) if (s.alive) {
    const k = key(s.body[0]); if (!dist.has(k)) { dist.set(k, 0); owners.set(k, s.id); q.push(s.body[0]); }
  }
  for (let i = 0; i < q.length; i++) {
    const p = q[i], k = key(p), nd = dist.get(k) + 1;
    for (const d of DIRS) { const n = add(p, d), nk = key(n);
      if (!inside(n, w, h) || dist.has(nk)) continue;
      dist.set(nk, nd); owners.set(nk, owners.get(k)); q.push(n);
    }
  }
  const counts = Object.create(null);
  for (const id of owners.values()) counts[id] = (counts[id] || 0) + 1;
  return counts;
}

function evaluate(state, myId, w, h, solo, mode) {
  const me = state.snakes.find((s) => s.id === myId);
  if (!me?.alive) return -100000;
  const alive = state.snakes.filter((s) => s.alive), others = alive.filter((s) => s.id !== myId);
  const area = flood(me.body[0], alive, myId, w, h);
  const territoryCounts = territory(state, w, h), board = w * h;
  const largest = Math.max(...alive.map((s) => s.body.length));
  const longest = me.body.length >= largest;
  const foodDist = pathDistance(me.body[0], state.food, alive, w, h);
  const tailDist = me.body.length > 1
    ? pathDistance(me.body[0], [me.body[me.body.length - 1]], alive, w, h)
    : Infinity;
  let score = Math.min(area, me.body.length * 3) * (solo ? 2.4 : 1.2);
  score += (territoryCounts[myId] || 0) * (solo ? 0.08 : others.length === 1 ? 0.7 : 0.35);
  score += me.health * 0.16 + me.body.length * (solo ? 1.4 : 2.2);
  if (area < me.body.length) score -= (me.body.length - area) * (mode === "survival" ? 20 : 14);
  if (Number.isFinite(foodDist) && (!longest || me.health < 40)) {
    score -= foodDist * (me.health < 40 ? 2.4 : 0.8);
    if (foodDist >= me.health) score -= 1000;
  }
  if (Number.isFinite(tailDist)) score += Math.max(0, me.body.length - tailDist) * 0.25;
  if (others.length) for (const enemy of others) {
    const d = manhattan(me.body[0], enemy.body[0]);
    if (me.body.length > enemy.body.length) score += Math.max(0, 5 - d) * (mode === "aggressive" ? 2.2 : 0.8);
    else score -= Math.max(0, 3 - d) * 2;
  }
  if (solo) score += Math.min(area, board) * 0.12;
  return score;
}

function move(gameState) {
  const started = Date.now();
  let chosen = "up", bestScore = -Infinity, depthReached = 0;
  try {
    const w = gameState.board.width, h = gameState.board.height, you = gameState.you;
    const snakes = (gameState.board.snakes || []).map((s) => ({
      id: s.id, body: (s.body || []).map((p) => ({ x: p.x, y: p.y })),
      health: s.health ?? 100, alive: true, grow: false,
    }));
    if (!snakes.some((s) => s.id === you.id)) snakes.push({ id: you.id, body: you.body.map((p) => ({ ...p })), health: you.health, alive: true });
    const init = { snakes, food: (gameState.board.food || []).map((p) => ({ ...p })), hazards: new Set((gameState.board.hazards || []).map(key)) };
    const myIndex = snakes.findIndex((s) => s.id === you.id), me = snakes[myIndex];
    const opponents = snakes.filter((s) => s.id !== you.id), solo = opponents.length === 0;
    const allMoves = legalMoves(me, w, h);
    if (!allMoves.length) {
      const fallback = DIRS.find((d) => inside(add(me.body[0], d), w, h)) || "up";
      console.log(`TURN ${gameState.turn} move=${fallback} score=-999 depth=0 ms=${Date.now()-started}`);
      return { move: fallback };
    }
    const immediate = allMoves.map((d) => {
      const candidate = stepState(init, snakes.map((s, i) => i === myIndex ? d : chooseModelMove(s, init, w, h, me)), w, h, gameState.game?.ruleset?.settings?.hazardDamage || 14);
      return { d, state: candidate, score: evaluate(candidate, you.id, w, h, solo, gameState.mode) };
    }).sort((a, b) => b.score - a.score);
    chosen = immediate[0].d; bestScore = immediate[0].score;
    const deadline = started + 350, hazardDamage = gameState.game?.ruleset?.settings?.hazardDamage || 14;
    const maxDepth = 4;
    for (let depth = 1; depth <= maxDepth && Date.now() < deadline; depth++) {
      let depthBest = chosen, depthScore = -Infinity;
      for (const root of immediate) {
        if (Date.now() >= deadline) break;
        let state = root.state, value = root.score;
        for (let ply = 1; ply < depth; ply++) {
          if (Date.now() >= deadline) break;
          const actor = state.snakes.find((s) => s.id === you.id);
          if (!actor?.alive) { value = -100000; break; }
          const ownMoves = legalMoves(actor, w, h);
          if (!ownMoves.length) { value = -100000; break; }
          let nextBest = -Infinity;
          for (const d of ownMoves) {
            const modelMoves = state.snakes.map((s) => s.id === you.id ? d : chooseModelMove(s, state, w, h, actor));
            const child = stepState(state, modelMoves, w, h, hazardDamage);
            nextBest = Math.max(nextBest, evaluate(child, you.id, w, h, solo, gameState.mode));
          }
          value = nextBest;
        }
        if (value > depthScore) { depthScore = value; depthBest = root.d; }
      }
      if (depthScore > -Infinity) { chosen = depthBest; bestScore = depthScore; depthReached = depth; }
    }
    console.log(`TURN ${gameState.turn} move=${chosen} score=${bestScore.toFixed(2)} depth=${depthReached} ms=${Date.now()-started}`);
    return { move: chosen };
  } catch (err) {
    const safe = DIRS.find((d) => {
      const p = add(gameState.you.body[0], d);
      return inside(p, gameState.board.width, gameState.board.height) && !gameState.you.body.slice(0, -1).some((b) => key(b) === key(p));
    }) || chosen;
    console.log(`TURN ${gameState.turn} move=${safe} score=-999 depth=${depthReached} ms=${Date.now()-started}`);
    return { move: safe };
  }
}

runServer({
  info: info,
  start: start,
  move: move,
  end: end,
});
