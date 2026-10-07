"use strict";

const $ = (id) => document.getElementById(id);
const pieceNames = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};
let game = null;
let orientation = "white";
let selected = null;
let dragging = null;
let pending = false;
let requestEpoch = 0;
let boardKey = "";
let movesKey = "";
let explanationKey = "";
let viewing = null; // Index of a past QUEEN move whose explanation is shown.
let promotionMoves = [];
let notationMode = loadPreference("queen.notation", false);
let pieceIcons = loadPreference("queen.pieceIcons", true);
let preview = null; // Hovered line on the board: { position, moved, key }.
let previewBases = []; // FENs a hovered line may start from, best first.

// Storage can be unavailable (e.g. blocked site data); fall back to defaults.
function loadPreference(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "on";
  } catch {
    return fallback;
  }
}
function savePreference(key, on) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {}
}

function pieces(fen) {
  const map = {};
  fen
    .split(" ")[0]
    .split("/")
    .forEach((row, rank) => {
      let file = 0;
      for (const item of row) {
        if (/\d/.test(item)) file += Number(item);
        else map[String.fromCharCode(97 + file++) + (8 - rank)] = item;
      }
    });
  return map;
}

function colorOf(piece) {
  return piece === piece.toUpperCase() ? "white" : "black";
}
function canMove() {
  return (
    game && !pending && game.phase === "playing" && game.turn === game.human
  );
}
function candidates(from, to) {
  return game.legal_moves.filter((move) => move.startsWith(from + (to || "")));
}

function renderBoard() {
  if (!game) return;
  const key = [
    game.fen,
    game.phase,
    game.human,
    game.last_move,
    orientation,
    selected,
    pending,
    preview?.key,
  ].join("|");
  if (key === boardKey) return;
  boardKey = key;
  const position = preview ? preview.position : pieces(game.fen);
  const files = orientation === "white" ? "abcdefgh" : "hgfedcba";
  const ranks =
    orientation === "white"
      ? [8, 7, 6, 5, 4, 3, 2, 1]
      : [1, 2, 3, 4, 5, 6, 7, 8];
  const fragment = document.createDocumentFragment();
  ranks.forEach((rank, row) =>
    [...files].forEach((file, col) => {
      const square = file + rank;
      const piece = position[square];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "square";
      button.dataset.square = square;
      const name = piece
        ? `${colorOf(piece)} ${pieceNames[piece.toLowerCase()]}`
        : "empty";
      button.setAttribute("aria-label", `${square}, ${name}`);
      button.setAttribute("aria-pressed", String(square === selected));
      if ((file.charCodeAt(0) - 97 + rank) % 2 === 1)
        button.classList.add("dark");
      if (piece) button.classList.add("occupied");
      if (square === selected) button.classList.add("selected");
      if (preview?.moved.has(square)) button.classList.add("previewed");
      if (
        !preview &&
        game.last_move &&
        [game.last_move.slice(0, 2), game.last_move.slice(2, 4)].includes(
          square,
        )
      )
        button.classList.add("last-move");
      if (selected && canMove() && candidates(selected, square).length)
        button.classList.add("available");
      if (
        game.in_check &&
        piece &&
        piece.toLowerCase() === "k" &&
        colorOf(piece) === game.turn
      )
        button.classList.add("in-check");
      if (piece) {
        const image = document.createElement("img");
        image.src = `/pieces/${colorOf(piece) === "white" ? "w" : "b"}${piece.toUpperCase()}.svg`;
        image.alt = "";
        image.draggable = false;
        button.append(image);
      }
      if (col === 0) {
        const label = document.createElement("span");
        label.className = "rank";
        label.textContent = rank;
        label.setAttribute("aria-hidden", "true");
        button.append(label);
      }
      if (row === 7) {
        const label = document.createElement("span");
        label.className = "file";
        label.textContent = file;
        label.setAttribute("aria-hidden", "true");
        button.append(label);
      }
      button.addEventListener("click", () => clickSquare(square));
      button.draggable = Boolean(
        canMove() && piece && colorOf(piece) === game.human,
      );
      button.addEventListener("dragstart", (event) => {
        const image = button.querySelector("img");
        if (!image?.complete || !image.naturalWidth) {
          event.preventDefault();
          return;
        }
        const bounds = image.getBoundingClientRect();
        const preview = document.createElement("canvas");
        preview.width = Math.max(1, Math.round(bounds.width));
        preview.height = Math.max(1, Math.round(bounds.height));
        const context = preview.getContext("2d");
        if (!context) {
          event.preventDefault();
          return;
        }
        // Render only the SVG at its displayed size, with a transparent background.
        context.drawImage(image, 0, 0, preview.width, preview.height);
        event.dataTransfer.setDragImage(
          preview,
          preview.width / 2,
          preview.height / 2,
        );
        dragging = square;
        event.dataTransfer.setData("text/plain", square);
        event.dataTransfer.effectAllowed = "move";
      });
      button.addEventListener("dragover", (event) => {
        if (canMove() && dragging && candidates(dragging, square).length)
          event.preventDefault();
      });
      button.addEventListener("drop", (event) => {
        event.preventDefault();
        const from = dragging;
        dragging = null;
        if (from && canMove()) chooseMove(from, square);
      });
      button.addEventListener("dragend", () => {
        dragging = null;
      });
      button.addEventListener("keydown", (event) => {
        const offsets = {
          ArrowLeft: -1,
          ArrowRight: 1,
          ArrowUp: -8,
          ArrowDown: 8,
        };
        if (event.key in offsets) {
          event.preventDefault();
          const target = row * 8 + col + offsets[event.key];
          const squares = $("board").children;
          if (target >= 0 && target < 64) squares[target].focus();
        }
        if (event.key === "Escape") {
          selected = null;
          renderBoard();
        }
      });
      fragment.append(button);
    }),
  );
  $("board").replaceChildren(fragment);
}

function clickSquare(square) {
  if (!canMove()) return;
  if (selected && candidates(selected, square).length) {
    chooseMove(selected, square);
    return;
  }
  const piece = pieces(game.fen)[square];
  selected =
    piece && colorOf(piece) === game.human && selected !== square
      ? square
      : null;
  renderBoard();
}

function chooseMove(from, to) {
  const options = candidates(from, to);
  if (!options.length) return;
  if (options.length > 1) {
    promotionMoves = options;
    $("promotion-dialog").showModal();
    return;
  }
  action("/api/move", { uci: options[0] });
}

function renderMoves() {
  if (viewing !== null && !game.moves[viewing]?.analysis) viewing = null;
  const key = viewing + "|" + JSON.stringify(game.moves);
  if (key === movesKey) return;
  movesKey = key;
  $("move-count").textContent = `${game.moves.length} played`;
  if (!game.moves.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "The story of your game starts here.";
    $("moves").replaceChildren(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < game.moves.length; i += 2) {
    const first = game.moves[i];
    const number = document.createElement("span");
    number.className = "move-number";
    number.textContent = first.number + ".";
    fragment.append(number);
    for (let j = 0; j < 2; j++) {
      const index = i + j;
      const item = game.moves[index];
      const cell = document.createElement(item?.analysis ? "button" : "span");
      cell.className = "move-san";
      cell.textContent = item ? item.san : "—";
      if (index === game.moves.length - 1) cell.classList.add("latest");
      if (item?.analysis) {
        cell.type = "button";
        cell.title = "Show QUEEN’s explanation for this move";
        cell.setAttribute("aria-pressed", String(index === viewing));
        if (index === viewing) cell.classList.add("viewing");
        cell.addEventListener("click", () => {
          viewing = index === viewing ? null : index;
          render();
        });
      }
      fragment.append(cell);
    }
  }
  const scrollTop = $("moves").scrollTop;
  $("moves").replaceChildren(fragment);
  $("moves").scrollTop = viewing === null ? $("moves").scrollHeight : scrollTop;
}

// QUEEN writes moves as prose: "12.white knight f1-g3", "...black pawn e6-e5",
// "white pawn d4 takes black pawn e5". Parse them so they can be rendered as
// notation and previewed on the board.
const pieceLetters = {
  pawn: "P",
  knight: "N",
  bishop: "B",
  rook: "R",
  queen: "Q",
  king: "K",
};
const pieceWord = Object.keys(pieceLetters).join("|");
const movePattern = new RegExp(
  [
    String.raw`(?:(?<number>\d+)\s*(?:\.\.\.|…|\.)\s*`,
    String.raw`|(?<bareDots>\.\.\.|…))?`,
    String.raw`(?<color>white|black) (?<piece>${pieceWord}) `,
    String.raw`(?<from>[a-h][1-8])`,
    String.raw`(?:-|(?<capture> takes (?:white|black) (?:${pieceWord}) ))`,
    String.raw`(?<to>[a-h][1-8])`,
  ].join(""),
  "g",
);

function isCastle({ piece, from, to }) {
  return (
    piece === "king" &&
    from[0] === "e" &&
    Math.abs(to.charCodeAt(0) - from.charCodeAt(0)) === 2
  );
}

// Returns the moves in a paragraph. `ply` is null when the text gives no
// move number.
function parseMoves(paragraph) {
  const moves = [];
  let pendingReply = null; // Ply Black answers after "15.white …".
  for (const match of paragraph.matchAll(movePattern)) {
    // "the white knight g1-f3" reads as prose; leave it as written.
    if (/\bthe\s+$/i.test(paragraph.slice(0, match.index))) continue;
    const { number, bareDots, color, piece, from, to, capture } = match.groups;
    const white = color === "white";
    let ply = null;
    // The color decides the side: QUEEN writes Black's moves as "1.black …"
    // as well as "1...black …".
    if (number) ply = Number(number) * 2 + !white;
    // "15.white pawn a5-a6 … ...black pawn b7-b6" means 15…b6.
    else if (bareDots && !white && pendingReply !== null) ply = pendingReply;
    pendingReply = ply !== null && white ? ply + 1 : null;
    moves.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      ply,
      color,
      piece,
      from,
      to,
      capture: Boolean(capture),
    });
  }
  return moves;
}

function moveNumber(ply, white) {
  return Math.floor(ply / 2) + (white ? "." : "…");
}

function pieceIcon(color, piece) {
  const image = document.createElement("img");
  image.className = "notation-piece";
  image.src = `/pieces/${color[0]}${pieceLetters[piece]}.svg`;
  image.alt = `${color} ${piece}`;
  return image;
}

function moveBadge(move, showNumber) {
  const { color, piece, from, to, capture, ply } = move;
  const badge = document.createElement("span");
  badge.className = `notation ${color}`;
  badge.title = move.text.trim();
  if (showNumber && ply !== null) {
    const number = document.createElement("span");
    number.className = "notation-number";
    number.textContent = moveNumber(ply, color === "white");
    badge.append(number);
  }
  const castle = isCastle(move);
  // Letters follow algebraic notation: pawns and castling have none.
  if (pieceIcons) badge.append(pieceIcon(color, piece));
  else if (piece !== "pawn" && !castle) badge.append(pieceLetters[piece]);
  let target = to;
  if (castle) target = to[0] === "g" ? "O-O" : "O-O-O";
  else if (capture && pieceIcons) target = "×" + to;
  else if (capture) target = (piece === "pawn" ? from[0] : "") + "x" + to;
  const square = document.createElement("span");
  square.className = "notation-square";
  square.textContent = target;
  badge.append(square);
  return badge;
}

// Chains moves that continue one another (12. then 12… then 13.) into lines
// of at least three moves. Unnumbered moves join only when they directly follow
// the previous move; stray asides such as "…e5" are skipped.
function variations(moves, paragraph) {
  const lines = [];
  let line = [];
  const flush = () => {
    if (line.length >= 3) lines.push(line);
    line = [];
  };
  for (const move of moves) {
    const last = line.at(-1);
    if (!last) {
      line.push({ move, ply: move.ply });
    } else if (move.ply !== null) {
      if (move.ply !== last.ply + 1) flush();
      line.push({ move, ply: move.ply });
    } else if (
      move.color !== last.move.color &&
      !paragraph.slice(last.move.end, move.start).trim()
    ) {
      line.push({ move, ply: last.ply === null ? null : last.ply + 1 });
    } else if (last.ply === null) {
      flush();
      line.push({ move, ply: null });
    }
  }
  flush();
  return lines;
}

function annotate(paragraph) {
  const moves = parseMoves(paragraph);
  const lines = variations(moves, paragraph);
  // Hovering a move previews its line up to that move.
  const lineUpTo = new Map();
  for (const line of lines) {
    line.forEach(({ move }, index) =>
      lineUpTo.set(move, line.slice(0, index + 1).map((entry) => entry.move)),
    );
  }
  // Only numbered moves are marked up inline.
  const nodes = [];
  let last = 0;
  for (const move of moves) {
    if (move.ply === null) continue;
    const badge = moveBadge(move, true);
    previewOnHover(badge, lineUpTo.get(move) ?? [move]);
    nodes.push(paragraph.slice(last, move.start), badge);
    last = move.end;
  }
  nodes.push(paragraph.slice(last));
  return { nodes, lines };
}

// Plays moves onto a FEN's piece map. Returns null if a move doesn't fit,
// e.g. the line starts from a different position or skips a side's move.
function playLine(fen, moves) {
  const position = pieces(fen);
  const moved = new Set();
  let turn = fen.split(" ")[1] === "b" ? "black" : "white";
  for (const move of moves) {
    const { color, piece, from, to } = move;
    const moving = position[from];
    if (
      color !== turn ||
      !moving ||
      colorOf(moving) !== color ||
      moving.toUpperCase() !== pieceLetters[piece] ||
      (position[to] && colorOf(position[to]) === color)
    )
      return null;
    if (piece === "pawn" && from[0] !== to[0] && !position[to])
      delete position[to[0] + from[1]]; // En passant.
    if (isCastle(move)) {
      const rank = from[1];
      const [rookFrom, rookTo] = to[0] === "g" ? ["h", "f"] : ["a", "d"];
      position[rookTo + rank] = position[rookFrom + rank];
      delete position[rookFrom + rank];
      moved.delete(rookFrom + rank);
      moved.add(rookTo + rank);
    }
    delete position[from];
    moved.delete(from);
    const promotes = piece === "pawn" && (to[1] === "8" || to[1] === "1");
    position[to] = promotes ? (color === "white" ? "Q" : "q") : moving;
    moved.add(to);
    turn = turn === "white" ? "black" : "white";
  }
  return { position, moved };
}

function showLine(moves) {
  for (const fen of previewBases) {
    const played = fen && playLine(fen, moves);
    if (played) {
      preview = { ...played, key: moves.map((m) => m.from + m.to).join(" ") };
      renderBoard();
      return;
    }
  }
}

function clearLine() {
  if (!preview) return;
  preview = null;
  renderBoard();
}

function previewOnHover(element, moves) {
  element.addEventListener("mouseenter", () => showLine(moves));
  element.addEventListener("mouseleave", clearLine);
}

function lineBlock(line) {
  const block = document.createElement("div");
  block.className = "variation";
  const label = document.createElement("span");
  label.className = "variation-label";
  label.textContent = "Line from QUEEN’s reasoning";
  block.append(label);
  // The last hovered move stays on the board until the cursor leaves the box.
  block.addEventListener("mouseleave", clearLine);
  const moves = line.map(({ move }) => move);
  line.forEach(({ move, ply }, index) => {
    const white = move.color === "white";
    // Spaces matter for letter mode's text flow; flex layout ignores them.
    if (index > 0) block.append(" ");
    if (ply !== null && (white || index === 0)) {
      const number = document.createElement("span");
      number.className = "variation-number";
      number.textContent = moveNumber(ply, white);
      block.append(number);
    }
    const badge = moveBadge(move, false);
    const upTo = moves.slice(0, index + 1);
    badge.addEventListener("mouseenter", () => showLine(upTo));
    block.append(badge);
  });
  return block;
}

function renderExplanation() {
  const viewed = viewing === null ? null : game.moves[viewing]?.analysis;
  const analysis = viewed || game.analysis;
  const thinking = !viewed && game.phase === "thinking";
  const text = thinking ? game.thinking_text : analysis?.text || "";
  // While thinking, the explanation is about the current position.
  previewBases = thinking ? [game.fen] : [analysis?.fen, game.fen];
  const key = [viewing, game.phase, text, notationMode, pieceIcons].join("|");
  if (key !== explanationKey) {
    const [lastViewing, lastPhase] = explanationKey.split("|");
    const wasThinking = lastPhase === "thinking";
    const viewChanged = lastViewing !== String(viewing);
    explanationKey = key;
    clearLine(); // The hovered element is about to be replaced.
    if (text) {
      const prose = text
        .replace(/^ANALYSIS:\s*/, "")
        .split(
          /\n(?:BEST_MOVE|CRITICAL_LINE|PRINCIPAL_VARIATION|PROMISING_MOVES|EVALUATION):/,
        )[0];
      const fragment = document.createDocumentFragment();
      prose.split(/\n\s*\n/).forEach((paragraph) => {
        const p = document.createElement("p");
        if (!notationMode) {
          p.textContent = paragraph;
          fragment.append(p);
          return;
        }
        const { nodes, lines } = annotate(paragraph);
        p.append(...nodes);
        fragment.append(p, ...lines.map(lineBlock));
      });
      $("explanation").classList.toggle("letters", !pieceIcons);
      $("explanation").replaceChildren(fragment);
      if (thinking) $("explanation").scrollTop = $("explanation").scrollHeight;
      else if (wasThinking || viewChanged) $("explanation").scrollTop = 0;
    } else if (thinking) {
      const p = document.createElement("p");
      p.className = "thinking-placeholder";
      p.textContent = game.engine_loading
        ? "QUEEN is warming up. Its first reply is on the way…"
        : "QUEEN is considering its reply…";
      $("explanation").replaceChildren(p);
    } else {
      $("explanation").replaceChildren(emptyExplanation());
    }
  }
  $("analysis-summary").hidden = thinking || !analysis?.best_move_san;
  $("show-latest").hidden = !viewed;
  if (analysis?.best_move_san) {
    const a = analysis;
    $("analysis-move").textContent =
      `QUEEN played ${a.move_number}${a.color === "black" ? "…" : "."} ${a.best_move_san}`;
    $("analysis-timing").textContent = `${a.generation_seconds.toFixed(1)}s`;
  }
  $("retry-box").hidden = game.phase !== "error";
  $("ai-error").textContent = game.error || "";
}

function emptyExplanation() {
  const box = document.createElement("div");
  box.className = "empty-explanation";
  const icon = document.createElement("div");
  icon.className = "empty-piece";
  icon.textContent = "♞";
  icon.setAttribute("aria-hidden", "true");
  const title = document.createElement("h3");
  title.textContent = "Strong moves. Clear intentions.";
  const prose = document.createElement("p");
  prose.textContent =
    "Make your first move. QUEEN will play its reply and explain the ideas behind it, right here.";
  const note = document.createElement("span");
  note.className = "small-note";
  note.textContent = "A real game, running entirely on your Mac.";
  box.append(icon, title, prose, note);
  return box;
}

function render() {
  if (!game) return;
  $("connection").textContent = game.engine_loading
    ? "Warming up"
    : game.error && !game.analysis
      ? "Local demo"
      : "Local · Ready";
  $("connection-dot").classList.toggle("loading", game.engine_loading);
  const topColor = orientation === "white" ? "black" : "white";
  const bottomColor = orientation;
  for (const [where, color] of [
    ["top", topColor],
    ["bottom", bottomColor],
  ]) {
    const avatar = $(where + "-avatar");
    avatar.textContent = color === game.human ? "Y" : "♛";
    avatar.className = `avatar ${color === game.human ? "human-avatar" : "queen-avatar"}`;
    $(where + "-player").textContent = color === game.human ? "You" : "QUEEN";
    $(where + "-color").textContent =
      (color === "white" ? "White" : "Black") + " pieces";
    $(where + "-turn").textContent =
      game.phase !== "finished" && game.turn === color
        ? color === game.human
          ? "Your turn"
          : "Thinking"
        : "";
  }
  let status = "Your turn";
  if (game.phase === "thinking")
    status = game.engine_loading ? "QUEEN is warming up" : "QUEEN is thinking";
  if (game.phase === "error") status = "QUEEN needs another try";
  if (game.phase === "finished") {
    const o = game.outcome;
    status = o.winner
      ? `${o.winner === game.human ? "You win" : "QUEEN wins"} · ${o.reason}`
      : `Draw · ${o.reason}`;
  } else if (game.in_check && canMove()) status = "Your turn · check";
  $("status").textContent = status;
  $("status-dot").classList.toggle("loading", game.phase === "thinking");
  $("elapsed").textContent =
    game.phase === "thinking" ? `${Math.floor(game.thinking_seconds)}s` : "";
  $("hint").textContent = canMove()
    ? "Click a piece, then a highlighted square. Or drag to move."
    : game.phase === "finished"
      ? "Start a new game, or take back your last turn."
      : "Your next move will be available after QUEEN replies.";
  $("undo").disabled = pending || !game.can_take_back;
  $("resign").disabled = pending || game.phase === "finished";
  $("claim-draw").hidden = !game.can_claim_draw;
  $("claim-draw").disabled = pending;
  $("new-game").disabled = pending;
  $("retry").disabled = pending;
  renderBoard();
  renderMoves();
  renderExplanation();
}

function acceptState(next) {
  if (game && next.game_id === game.game_id && next.version < game.version)
    return;
  if (!game || next.game_id !== game.game_id) {
    orientation = next.human;
    selected = null;
    viewing = null;
    boardKey = "";
    movesKey = "";
    explanationKey = "";
  }
  game = next;
  render();
}

async function action(path, body = {}) {
  if (pending || !game) return;
  const epoch = ++requestEpoch;
  pending = true;
  selected = null;
  viewing = null;
  $("notice").hidden = true;
  render();
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game_id: game.game_id,
        version: game.version,
        ...body,
      }),
    });
    const next = await response.json();
    if (!response.ok)
      throw new Error(next.error || "That action couldn't be completed.");
    if (epoch === requestEpoch) acceptState(next);
  } catch (error) {
    $("notice").textContent = error.message;
    $("notice").hidden = false;
  } finally {
    pending = false;
    render();
  }
}

async function poll() {
  const epoch = requestEpoch;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Connection lost");
    const next = await response.json();
    if (epoch === requestEpoch && !pending) acceptState(next);
  } catch {
    $("connection").textContent = "Reconnecting…";
    $("connection-dot").classList.add("loading");
  }
  setTimeout(
    poll,
    game?.phase === "thinking" || game?.engine_loading ? 250 : 1200,
  );
}

$("notation-toggle").checked = notationMode;
$("icons-toggle").checked = pieceIcons;
$("icons-toggle-label").hidden = !notationMode;
$("notation-toggle").addEventListener("change", (event) => {
  notationMode = event.target.checked;
  savePreference("queen.notation", notationMode);
  $("icons-toggle-label").hidden = !notationMode;
  renderExplanation();
});
$("icons-toggle").addEventListener("change", (event) => {
  pieceIcons = event.target.checked;
  savePreference("queen.pieceIcons", pieceIcons);
  renderExplanation();
});
$("flip").addEventListener("click", () => {
  orientation = orientation === "white" ? "black" : "white";
  render();
});
$("show-latest").addEventListener("click", () => {
  viewing = null;
  render();
});
$("undo").addEventListener("click", () => action("/api/undo"));
$("resign").addEventListener("click", () => action("/api/resign"));
$("claim-draw").addEventListener("click", () => action("/api/draw"));
$("retry").addEventListener("click", () => action("/api/retry"));
$("new-game").addEventListener("click", () => {
  $("color").value = game?.human || "white";
  $("new-game-dialog").showModal();
});
$("cancel-new").addEventListener("click", () => $("new-game-dialog").close());
$("new-game-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("new-game-dialog").close();
  action("/api/new", { color: $("color").value });
});
$("cancel-promotion").addEventListener("click", () =>
  $("promotion-dialog").close(),
);
document.querySelectorAll("[data-promotion]").forEach((button) =>
  button.addEventListener("click", () => {
    const move = promotionMoves.find((uci) =>
      uci.endsWith(button.dataset.promotion),
    );
    $("promotion-dialog").close();
    if (move) action("/api/move", { uci: move });
  }),
);
poll();
