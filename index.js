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

// move is called on every turn and returns your next move
// Valid moves are "up", "down", "left", or "right"
// See https://docs.battlesnake.com/api/example-move for available data
function move(gameState) {
  let isMoveSafe = {
    up: true,
    down: true,
    left: true,
    right: true,
  };

  // We've included code to prevent your Battlesnake from moving backwards
  const myHead = gameState.you.body[0];
  const myNeck = gameState.you.body[1];

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
      const isTail = i === snake.body.length - 1 && snake.body.length > 1;
      if (!isTail) blocked.add(`${segment.x},${segment.y}`);
    });
  }
  // gameState.board.snakes already includes us, but add myBody to be safe
  myBody.forEach((segment, i) => {
    const isTail = i === myBody.length - 1 && myBody.length > 1;
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

  // Choose a random move from the safe moves
  let nextMove = candidates[Math.floor(Math.random() * candidates.length)];

  // TODO: Step 4 - Move towards food instead of random, to regain health and survive longer
  const food = gameState.board.food;
  if (food.length > 0) {
    const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    let best = Infinity;
    for (const dir of candidates) {
      const next = nextSquare(dir);
      const d = Math.min(...food.map((f) => dist(next, f)));
      if (d < best) {
        best = d;
        nextMove = dir;
      }
    }
  }

  console.log(`MOVE ${gameState.turn}: ${nextMove}`);
  return { move: nextMove };
}

runServer({
  info: info,
  start: start,
  move: move,
  end: end,
});
