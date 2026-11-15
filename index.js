// Welcome to
// __________         __    __  .__                               __
// \______   \_____ _/  |__/  |_|  |   ____   ______ ____ _____  |  | __ ____
//  |    |  _/\__  \   __\   __\  | _/ __ \ /  ___//    \__  \ |  |/ // __ \
//  |    |   \ / __ \|  |  |  | |  |_\  ___/ \___ \|   |  \/ __ \|    <\  ___/
//  |________/(______/__|  |__| |____/\_____>______>___|__(______/__|__\_____>
//
// The move logic (look-ahead search) lives in logic.js.
// For more info see docs.battlesnake.com

import runServer from "./server.js";
import { chooseMove, forgetGame } from "./logic.js";

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
  forgetGame(gameState);
  console.log("GAME OVER\n");
}

// move is called on every turn and returns your next move.
// chooseMove simulates the next several turns for every snake before answering,
// and always replies within its time budget.
function move(gameState) {
  return { move: chooseMove(gameState) };
}

runServer({
  info: info,
  start: start,
  move: move,
  end: end,
});
