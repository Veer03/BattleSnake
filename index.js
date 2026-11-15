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
  const { width, height } = gameState.board;
  const me = gameState.you;
  const head = me.body[0];
  const tail = me.body[me.body.length - 1];
  const dirs = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const key = (p) => `${p.x},${p.y}`;
  const inBounds = (p) => p.x >= 0 && p.x < width && p.y >= 0 && p.y < height;
  const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  // freeAt: the step number from which a square is empty
  const freeAt = new Map();
  for (const s of gameState.board.snakes) {
    const len = s.body.length;
    s.body.forEach((seg, i) => {
      let f = len - i;
      if (i === len - 1 && s.health === 100) f += 1; // just ate, tail stays
      const k = key(seg);
      freeAt.set(k, Math.max(freeAt.get(k) || 0, f));
    });
  }

  const others = gameState.board.snakes.filter((s) => s.id !== me.id);
  const maxEnemy = others.reduce((m, s) => Math.max(m, s.length), 0);

  const danger = new Set();
  for (const s of others) {
    if (s.length < me.length) continue;
    for (const d of Object.values(dirs)) {
      danger.add(key({ x: s.head.x + d.x, y: s.head.y + d.y }));
    }
  }
  const hazards = new Set((gameState.board.hazards || []).map(key));

  // Time-aware flood fill: returns the set of reachable squares
  const flood = (start) => {
    const seen = new Set([key(start)]);
    let frontier = [start];
    let step = 1;
    while (frontier.length) {
      const nextFrontier = [];
      step++;
      for (const p of frontier) {
        for (const d of Object.values(dirs)) {
          const n = { x: p.x + d.x, y: p.y + d.y };
          const k = key(n);
          if (!inBounds(n) || seen.has(k)) continue;
          if ((freeAt.get(k) || 0) > step) continue;
          seen.add(k);
          nextFrontier.push(n);
        }
      }
      frontier = nextFrontier;
    }
    return seen;
  };

  const food = gameState.board.food;
  const hungry =
    me.health < 50 || (others.length > 0 && me.length <= maxEnemy);
  const foodWeight = me.health < 25 ? 12 : 6;

  let best = null;
  let bestScore = -Infinity;
  for (const [name, d] of Object.entries(dirs)) {
    const next = { x: head.x + d.x, y: head.y + d.y };
    const k = key(next);
    if (!inBounds(next)) continue;
    if ((freeAt.get(k) || 0) > 1) continue;

    const reach = flood(next);
    let score = reach.size;
    if (reach.size < me.length) score -= 1000;
    if (me.length > 3 && !reach.has(key(tail))) score -= 300;
    if (danger.has(k)) score -= 500;
    if (hazards.has(k)) score -= 30;

    if (hungry && food.length > 0) {
      score -= foodWeight * Math.min(...food.map((f) => dist(next, f)));
    } else {
      score -= 0.5 * dist(next, tail); // stay compact, follow the tail
    }

    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }

  console.log(`MOVE ${gameState.turn}: ${best ?? "down (no safe move)"}`);
  return { move: best ?? "down" };
}

runServer({
  info: info,
  start: start,
  move: move,
  end: end,
});
