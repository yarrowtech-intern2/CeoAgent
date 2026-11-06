"use strict";

// /game — a small arcade against the CEO, played in the main panel.
// Type "/game" into any message box (home composer, new chat, chat reply) and
// the app switches to the Game Room instead of starting an agent run.
//
// Everything runs in the browser: the CEO's moves come from local code
// (minimax / pattern guessing) and its banter is canned, so playing costs no
// API tokens. The CEO is the app's own 3D bot — the game mounts the shared
// GeometricBot into the arena and drives its mood, shape and gaze.
//
// render() rebuilds the whole #app on every poll, so the game keeps one
// persistent "stage" element and just re-attaches it (VIEW_ATTACHERS), which
// keeps a game in progress — and the bot's canvas — intact.

(() => {
  const STORE_KEY = "ceoGameScores";
  const MUTE_KEY = "ceoGameMuted";
  const LEVELS = [
    { id: "intern", label: "Intern" },
    { id: "manager", label: "Manager" },
    { id: "ceo", label: "CEO" },
  ];
  const GAMES = [
    { id: "ttt", title: "Tic-Tac-Toe", blurb: "Three in a row. Quick and ruthless." },
    { id: "c4", title: "Connect Four", blurb: "Drop discs, plan ahead, connect four." },
    { id: "rps", title: "Rock Paper Scissors", blurb: "First to 3. The CEO studies your habits." },
  ];

  const LINES = {
    menu: ["Pick your battle.", "Care for a game? I have eleven minutes.", "Choose wisely. I never lose.", "Let's settle this like executives."],
    start: ["Let's see what you've got.", "Make it quick. I have a board meeting.", "I don't lose. I reallocate.", "Your move, whenever you're ready."],
    play: ["Interesting. Wrong, but interesting.", "Bold strategy.", "I've seen this in a quarterly report.", "Noted. Adding it to your performance review.", "Hmm. Calculated risk, or an accident?"],
    think: ["Running the numbers…", "Consulting my advisors…", "Hmm…", "Synergising…"],
    cpuWin: ["That's a win for the company.", "Synergy achieved. Mostly mine.", "Better luck next fiscal year.", "Efficient. As always."],
    playerWin: ["You win. Don't let it go to your head.", "Fine. I'll call it a learning investment.", "Impressive. You're not fired.", "A rare dip in my quarterly numbers."],
    draw: ["A draw. Let's call it a merger.", "Stalemate. Nobody gets a bonus.", "We cancel each other out. How diplomatic."],
    roundWin: ["Round to you. Enjoy it.", "Lucky guess.", "I'll allow that one."],
    roundLose: ["Round to me. Predictable.", "I saw that coming.", "Your pattern is in my files."],
    roundTie: ["Tie. Great minds.", "Same move. Awkward."],
  };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const ui = {
    stage: null,
    screen: "menu", // menu | ttt | c4 | rps
    level: "manager",
    game: null,
    msg: "",
    timer: null,
    scores: loadScores(),
    plays: { ttt: 0, c4: 0 }, // alternates who moves first
    streak: 0,
    muted: loadMuted(),
  };

  const say = (kind) => { ui.msg = pick(LINES[kind]); };

  // ---------- persistence ----------

  function loadScores() {
    const base = { ttt: { w: 0, l: 0, d: 0 }, c4: { w: 0, l: 0, d: 0 }, rps: { w: 0, l: 0, d: 0 } };
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (raw && typeof raw === "object") {
        for (const k of Object.keys(base)) if (raw[k]) base[k] = { ...base[k], ...raw[k] };
      }
    } catch {}
    return base;
  }
  function saveScores() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(ui.scores)); } catch {}
  }
  function loadMuted() {
    try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
  }

  function record(gameId, result) {
    const s = ui.scores[gameId];
    if (result === "win") s.w += 1;
    else if (result === "loss") s.l += 1;
    else s.d += 1;
    saveScores();
  }

  // ---------- sound (tiny WebAudio blips; no assets) ----------

  let actx = null;
  function tone(freq, dur = 0.12, type = "sine", vol = 0.05, delay = 0) {
    if (ui.muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime + delay;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t);
      o.stop(t + dur);
    } catch {}
  }
  const SFX = {
    place: () => tone(520, 0.09, "triangle"),
    cpu: () => tone(330, 0.1, "triangle"),
    tick: () => tone(660, 0.06, "square", 0.035),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, "square", 0.045, i * 0.11)),
    lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.22, "sawtooth", 0.04, i * 0.14)),
    draw: () => { tone(392, 0.15, "sine", 0.05); tone(392, 0.15, "sine", 0.05, 0.18); },
  };

  // ---------- the bot ----------

  const bot = () => window.GeometricBot;
  const botMood = (mood, ms) => bot()?.setMood?.(mood, ms);

  function botThink() {
    botMood("working", 700);
  }
  function botResult(result) {
    if (result === "loss") bot()?.celebrate?.(); // the CEO won
    else if (result === "win") bot()?.defeat?.(2600);
  }

  // ---------- timing ----------

  function clearTimer() {
    if (ui.timer) clearTimeout(ui.timer);
    ui.timer = null;
  }
  function later(ms, fn) {
    clearTimer();
    ui.timer = setTimeout(() => { ui.timer = null; fn(); }, ms);
  }

  // The CEO answers shortly after the player, so it reads as thinking.
  function scheduleCpu(g, fn) {
    botThink();
    ui.msg = pick(LINES.think);
    later(600, () => {
      if (ui.game !== g || g.over) return;
      fn();
      paint();
    });
  }

  // ---------- Tic-Tac-Toe (player X, CEO O) ----------

  const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

  function tttWinner(b) {
    for (const l of TTT_LINES) {
      if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return { p: b[l[0]], line: l };
    }
    return null;
  }

  function tttMinimax(b, turn, depth) {
    const w = tttWinner(b);
    if (w) return w.p === "O" ? 10 - depth : depth - 10;
    if (b.every(Boolean)) return 0;
    let best = turn === "O" ? -Infinity : Infinity;
    for (let i = 0; i < 9; i++) {
      if (b[i]) continue;
      b[i] = turn;
      const v = tttMinimax(b, turn === "O" ? "X" : "O", depth + 1);
      b[i] = "";
      best = turn === "O" ? Math.max(best, v) : Math.min(best, v);
    }
    return best;
  }

  function tttCpuMove(g) {
    const empty = g.b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    const optimal = { intern: 0.25, manager: 0.7, ceo: 1 }[ui.level];
    if (Math.random() >= optimal) return pick(empty);
    if (empty.length === 9) return pick([0, 2, 6, 8]);
    let bestScore = -Infinity;
    let moves = [];
    for (const i of empty) {
      g.b[i] = "O";
      const v = tttMinimax(g.b, "X", 1);
      g.b[i] = "";
      if (v > bestScore) { bestScore = v; moves = [i]; } else if (v === bestScore) moves.push(i);
    }
    return pick(moves);
  }

  function startTtt() {
    const cpuFirst = ui.plays.ttt++ % 2 === 1;
    const g = { type: "ttt", b: Array(9).fill(""), turn: cpuFirst ? "O" : "X", over: false, result: null, line: [], last: -1 };
    ui.game = g;
    ui.screen = "ttt";
    say("start");
    if (cpuFirst) scheduleCpu(g, () => tttPlace(g, tttCpuMove(g)));
  }

  function tttPlace(g, i) {
    const byCpu = g.turn === "O";
    g.b[i] = g.turn;
    g.last = i;
    byCpu ? SFX.cpu() : SFX.place();
    const w = tttWinner(g.b);
    if (w) {
      g.over = true; g.line = w.line;
      g.result = w.p === "X" ? "win" : "loss";
    } else if (g.b.every(Boolean)) {
      g.over = true; g.result = "draw";
    } else {
      g.turn = g.turn === "X" ? "O" : "X";
      if (g.turn === "X") say("play");
    }
    if (g.over) finish("ttt", g.result);
  }

  function tttClick(i) {
    const g = ui.game;
    if (!g || g.over || g.turn !== "X" || g.b[i]) return;
    bot()?.lookAt?.(((i % 3) - 1) * 0.3, (1 - Math.floor(i / 3)) * 0.22, 900);
    tttPlace(g, i);
    if (!g.over) scheduleCpu(g, () => tttPlace(g, tttCpuMove(g)));
  }

  // ---------- Connect Four (player 1 = red, CEO 2 = gold) ----------

  const C4_ROWS = 6;
  const C4_COLS = 7;
  const C4_ORDER = [3, 2, 4, 1, 5, 0, 6];
  const C4_DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  function c4Drop(b, c, p) {
    for (let r = C4_ROWS - 1; r >= 0; r--) {
      if (!b[r * C4_COLS + c]) { b[r * C4_COLS + c] = p; return r; }
    }
    return -1;
  }

  function c4Find(b) {
    for (let r = 0; r < C4_ROWS; r++) {
      for (let c = 0; c < C4_COLS; c++) {
        const p = b[r * C4_COLS + c];
        if (!p) continue;
        for (const [dr, dc] of C4_DIRS) {
          const cells = [];
          for (let k = 0; k < 4; k++) {
            const rr = r + dr * k, cc = c + dc * k;
            if (rr < 0 || rr >= C4_ROWS || cc < 0 || cc >= C4_COLS || b[rr * C4_COLS + cc] !== p) break;
            cells.push(rr * C4_COLS + cc);
          }
          if (cells.length === 4) return { p, cells };
        }
      }
    }
    return null;
  }

  // Heuristic: reward open windows of 4 that hold our discs, penalise theirs,
  // and prefer the centre columns.
  function c4Eval(b, p) {
    const opp = 3 - p;
    let score = 0;
    for (let r = 0; r < C4_ROWS; r++) if (b[r * C4_COLS + 3] === p) score += 3;
    for (let r = 0; r < C4_ROWS; r++) {
      for (let c = 0; c < C4_COLS; c++) {
        for (const [dr, dc] of C4_DIRS) {
          let mine = 0, theirs = 0, ok = true;
          for (let k = 0; k < 4; k++) {
            const rr = r + dr * k, cc = c + dc * k;
            if (rr < 0 || rr >= C4_ROWS || cc < 0 || cc >= C4_COLS) { ok = false; break; }
            const v = b[rr * C4_COLS + cc];
            if (v === p) mine++; else if (v === opp) theirs++;
          }
          if (!ok) continue;
          if (theirs === 0) score += mine === 3 ? 5 : mine === 2 ? 2 : 0;
          if (mine === 0) score -= theirs === 3 ? 6 : theirs === 2 ? 2 : 0;
        }
      }
    }
    return score;
  }

  function c4Negamax(b, depth, alpha, beta, p) {
    const w = c4Find(b);
    if (w) return w.p === p ? 100000 + depth : -(100000 + depth);
    if (b.every(Boolean)) return 0;
    if (depth === 0) return c4Eval(b, p);
    let best = -Infinity;
    for (const c of C4_ORDER) {
      const r = c4Drop(b, c, p);
      if (r < 0) continue;
      const v = -c4Negamax(b, depth - 1, -beta, -alpha, 3 - p);
      b[r * C4_COLS + c] = 0;
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function c4CpuMove(g) {
    const open = C4_ORDER.filter((c) => !g.b[c]);
    if (ui.level === "intern" && Math.random() < 0.3) return pick(open);
    const depth = { intern: 1, manager: 3, ceo: 5 }[ui.level];
    let bestScore = -Infinity;
    let moves = [];
    for (const c of open) {
      const r = c4Drop(g.b, c, 2);
      const v = -c4Negamax(g.b, depth - 1, -Infinity, Infinity, 1);
      g.b[r * C4_COLS + c] = 0;
      if (v > bestScore) { bestScore = v; moves = [c]; } else if (v === bestScore) moves.push(c);
    }
    return pick(moves);
  }

  function startC4() {
    const cpuFirst = ui.plays.c4++ % 2 === 1;
    const g = { type: "c4", b: Array(C4_ROWS * C4_COLS).fill(0), turn: cpuFirst ? 2 : 1, over: false, result: null, line: [], last: -1 };
    ui.game = g;
    ui.screen = "c4";
    say("start");
    if (cpuFirst) scheduleCpu(g, () => c4Place(g, c4CpuMove(g)));
  }

  function c4Place(g, c) {
    const byCpu = g.turn === 2;
    const r = c4Drop(g.b, c, g.turn);
    if (r < 0) return;
    g.last = r * C4_COLS + c;
    setTimeout(byCpu ? SFX.cpu : SFX.place, 260); // lands as the disc does
    const w = c4Find(g.b);
    if (w) {
      g.over = true; g.line = w.cells;
      g.result = w.p === 1 ? "win" : "loss";
    } else if (g.b.every(Boolean)) {
      g.over = true; g.result = "draw";
    } else {
      g.turn = 3 - g.turn;
      if (g.turn === 1) say("play");
    }
    if (g.over) finish("c4", g.result, 520);
  }

  function c4Click(c) {
    const g = ui.game;
    if (!g || g.over || g.turn !== 1 || g.b[c]) return;
    bot()?.lookAt?.((c - 3) * 0.13, 0.12, 900);
    c4Place(g, c);
    if (!g.over) scheduleCpu(g, () => c4Place(g, c4CpuMove(g)));
  }

  // ---------- Rock Paper Scissors (first to 3) ----------

  const RPS = [
    { id: "rock", emoji: "✊", label: "Rock", beats: "scissors", key: "r" },
    { id: "paper", emoji: "✋", label: "Paper", beats: "rock", key: "p" },
    { id: "scissors", emoji: "✌️", label: "Scissors", beats: "paper", key: "s" },
  ];
  const rpsById = (id) => RPS.find((m) => m.id === id);
  const rpsCounter = (id) => RPS.find((m) => m.beats === id).id; // the move that beats `id`

  function rpsCpuMove(g) {
    const hist = g.history;
    if (ui.level === "intern" || !hist.length) return pick(RPS).id;
    if (Math.random() < 0.15) return pick(RPS).id; // keep the CEO beatable
    let predicted;
    if (ui.level === "ceo" && hist.length > 1) {
      // What did the player usually throw right after their last move?
      const last = hist[hist.length - 1];
      const counts = {};
      for (let i = 0; i < hist.length - 1; i++) {
        if (hist[i] === last) counts[hist[i + 1]] = (counts[hist[i + 1]] || 0) + 1;
      }
      predicted = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    }
    if (!predicted) {
      const counts = {};
      for (const h of hist) counts[h] = (counts[h] || 0) + 1;
      predicted = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    }
    return rpsCounter(predicted);
  }

  function startRps() {
    ui.game = { type: "rps", you: 0, cpu: 0, history: [], round: null, phase: "pick", call: "", over: false, result: null };
    ui.screen = "rps";
    say("start");
  }

  // "Rock… Paper… Scissors!" countdown, then the reveal.
  function rpsClick(id) {
    const g = ui.game;
    if (!g || g.over || g.phase !== "pick") return;
    g.phase = "shake";
    g.pending = id;
    g.round = null;
    botThink();
    const calls = ["Rock…", "Paper…", "Scissors!"];
    let step = 0;
    const tick = () => {
      if (ui.game !== g) return;
      if (step < calls.length) {
        g.call = calls[step++];
        SFX.tick();
        paint();
        later(380, tick);
      } else {
        rpsReveal(g, id);
      }
    };
    tick();
  }

  function rpsReveal(g, id) {
    const cpu = rpsCpuMove(g);
    g.history.push(id);
    let outcome = "tie";
    if (rpsById(id).beats === cpu) { outcome = "win"; g.you++; }
    else if (rpsById(cpu).beats === id) { outcome = "loss"; g.cpu++; }
    g.round = { you: id, cpu, outcome };
    g.phase = "pick";
    g.call = "";
    if (g.you === 3 || g.cpu === 3) {
      g.over = true;
      g.result = g.you === 3 ? "win" : "loss";
      finish("rps", g.result);
    } else {
      say(outcome === "win" ? "roundWin" : outcome === "loss" ? "roundLose" : "roundTie");
      if (outcome === "win") { SFX.place(); bot()?.defeat?.(1100); }
      else if (outcome === "loss") { SFX.cpu(); bot()?.celebrate?.(); }
      else SFX.draw();
    }
    paint();
  }

  // ---------- shared ----------

  function finish(gameId, result, delay = 0) {
    record(gameId, result);
    ui.streak = result === "win" ? ui.streak + 1 : 0;
    say(result === "win" ? "playerWin" : result === "loss" ? "cpuWin" : "draw");
    setTimeout(() => {
      if (!ui.stage) return;
      botResult(result);
      if (result === "win") { SFX.win(); confetti(); }
      else if (result === "loss") { SFX.lose(); shake(); }
      else SFX.draw();
    }, delay);
  }

  function startGame(id) {
    clearTimer();
    if (id === "ttt") startTtt();
    else if (id === "c4") startC4();
    else if (id === "rps") startRps();
    botMood("idle");
    bot()?.react?.("curious", 1200);
  }

  function toMenu() {
    clearTimer();
    ui.screen = "menu";
    ui.game = null;
    say("menu");
    paint();
  }

  function leave() {
    clearTimer();
    switchView("home");
  }

  function confetti() {
    const fx = ui.stage?.querySelector("#gm-fx");
    if (!fx) return;
    const colors = ["#e5484d", "#f5c542", "#5469dc", "#30c48d", "#ffffff", "#df6212"];
    let html = "";
    for (let i = 0; i < 44; i++) {
      html += `<i class="gm-confetti" style="--x:${(Math.random() * 100).toFixed(1)}%;--dx:${(Math.random() * 240 - 120).toFixed(0)}px;--r:${(Math.random() * 720 - 360).toFixed(0)}deg;--c:${colors[i % colors.length]};--d:${(1.4 + Math.random() * 1.2).toFixed(2)}s;--w:${(Math.random() * 0.25).toFixed(2)}s"></i>`;
    }
    fx.innerHTML = html;
    setTimeout(() => { if (fx.isConnected) fx.innerHTML = ""; }, 3200);
  }

  function shake() {
    const el = ui.stage?.querySelector(".gm-main");
    if (!el) return;
    el.classList.remove("gm-shake");
    void el.offsetWidth;
    el.classList.add("gm-shake");
  }

  // ---------- rendering ----------

  const ic = (name) => `<i data-lucide="${name}"></i>`;

  const SVG_DEFS = `
    <svg class="gm-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="gm-gx" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset="1" stop-color="#e5484d"/></linearGradient>
        <linearGradient id="gm-go" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ad1ff"/><stop offset="1" stop-color="#5469dc"/></linearGradient>
        <linearGradient id="gm-grid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#36d6c3"/></linearGradient>
        <linearGradient id="gm-gwin" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#ff7a59"/></linearGradient>
      </defs>
    </svg>`;

  function levelPicker() {
    return `<div class="gm-levels" role="group" aria-label="Difficulty">
      ${LEVELS.map((l) => `<button type="button" class="gm-level${ui.level === l.id ? " on" : ""}" data-act="level" data-id="${l.id}"${ui.screen !== "menu" ? " disabled" : ""}>${l.label}</button>`).join("")}
    </div>`;
  }

  // ---- menu ----

  const ART_TTT = `
    <svg viewBox="0 0 120 120" class="gm-art" aria-hidden="true">
      <path d="M40 10V110M80 10V110M10 40H110M10 80H110" stroke="url(#gm-grid)" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M17 17L33 33M33 17L17 33" stroke="url(#gm-gx)" stroke-width="6" stroke-linecap="round"/>
      <circle cx="60" cy="60" r="12" stroke="url(#gm-go)" stroke-width="6" fill="none"/>
      <path d="M87 87L103 103M103 87L87 103" stroke="url(#gm-gx)" stroke-width="6" stroke-linecap="round"/>
      <circle cx="100" cy="20" r="11" stroke="url(#gm-go)" stroke-width="6" fill="none" opacity=".55"/>
    </svg>`;
  const ART_C4 = (() => {
    const rows = [
      [0, 0, 0, 0], [0, 0, 1, 0], [0, 2, 1, 0], [2, 1, 1, 2],
    ];
    const col = { 0: "#0e1752", 1: "#e5484d", 2: "#f5c542" };
    let holes = "";
    rows.forEach((row, r) => row.forEach((v, c) => {
      holes += `<circle cx="${22 + c * 25}" cy="${22 + r * 25}" r="9.5" fill="${col[v]}"/>`;
    }));
    return `<svg viewBox="0 0 120 120" class="gm-art" aria-hidden="true"><rect x="4" y="4" width="112" height="112" rx="16" fill="#2a4bd7"/>${holes}</svg>`;
  })();
  const ART_RPS = `
    <div class="gm-art gm-art-rps" aria-hidden="true"><span>✊</span><span>✋</span><span>✌️</span></div>`;

  function menuMain() {
    const art = { ttt: ART_TTT, c4: ART_C4, rps: ART_RPS };
    return `
      <div class="gm-menu">
        <div class="gm-menu-head">
          <h2>Choose your battle</h2>
          <p>Pick a game and a difficulty. The CEO is watching.</p>
        </div>
        <div class="gm-cards">
          ${GAMES.map((g) => {
            const s = ui.scores[g.id];
            return `<button type="button" class="gm-card" data-act="start" data-id="${g.id}">
              <span class="gm-card-art">${art[g.id]}</span>
              <span class="gm-card-title">${g.title}</span>
              <span class="gm-card-blurb">${g.blurb}</span>
              <span class="gm-card-score"><b>${s.w}</b> W &nbsp;<b>${s.l}</b> L &nbsp;<b>${s.d}</b> D</span>
              <span class="gm-card-play">Play ${ic("play")}</span>
            </button>`;
          }).join("")}
        </div>
      </div>`;
  }

  // ---- shared game chrome ----

  function turnPill(g, mineTurn) {
    if (g.over) return `<div class="gm-turn over ${g.result}">${g.result === "win" ? "You win!" : g.result === "loss" ? "CEO wins" : "Draw"}</div>`;
    return mineTurn
      ? `<div class="gm-turn mine"><span class="gm-dot"></span>Your move</div>`
      : `<div class="gm-turn cpu">CEO is thinking<span class="gm-dots"><i></i><i></i><i></i></span></div>`;
  }

  function resultBar(g) {
    if (!g.over) return "";
    return `<div class="gm-result ${g.result}">
      <div class="gm-result-title">${g.result === "win" ? "VICTORY" : g.result === "loss" ? "DEFEAT" : "DRAW"}</div>
      <div class="gm-result-actions">
        <button type="button" class="gm-btn primary" data-act="again">${ic("rotate-ccw")} Play again</button>
        <button type="button" class="gm-btn" data-act="menu">All games</button>
      </div>
    </div>`;
  }

  // ---- Tic-Tac-Toe ----

  function tttMark(v, isNew) {
    const n = isNew ? " new" : "";
    if (v === "X") {
      return `<svg viewBox="0 0 100 100" class="gm-mark x${n}"><path pathLength="1" d="M26 26 L74 74"/><path pathLength="1" class="s2" d="M74 26 L26 74"/></svg>`;
    }
    return `<svg viewBox="0 0 100 100" class="gm-mark o${n}"><circle pathLength="1" cx="50" cy="50" r="25"/></svg>`;
  }

  function tttMain(g) {
    const cells = g.b.map((v, i) => {
      const dis = g.over || g.turn !== "X" || v ? " disabled" : "";
      const win = g.line.includes(i) ? " win" : "";
      return `<button type="button" class="gm-cell${win}" data-act="ttt" data-i="${i}" aria-label="Cell ${i + 1}${v ? ", " + v : ""}"${dis}>${v ? tttMark(v, i === g.last) : ""}</button>`;
    }).join("");
    let line = "";
    if (g.line.length) {
      const pt = (i) => `${(i % 3) * 100 + 50}`;
      const a = g.line[0], c = g.line[2];
      line = `<svg class="gm-winline" viewBox="0 0 300 300"><line pathLength="1" x1="${pt(a)}" y1="${(Math.floor(a / 3)) * 100 + 50}" x2="${pt(c)}" y2="${(Math.floor(c / 3)) * 100 + 50}"/></svg>`;
    }
    return `${turnPill(g, g.turn === "X")}
      <div class="gm-ttt">
        <svg class="gm-grid" viewBox="0 0 300 300" aria-hidden="true"><path d="M100 14V286M200 14V286M14 100H286M14 200H286" stroke="url(#gm-grid)" stroke-width="6" stroke-linecap="round" fill="none"/></svg>
        <div class="gm-cells">${cells}</div>${line}
      </div>
      ${resultBar(g)}
      <div class="gm-keys">Keys 1–9</div>`;
  }

  // ---- Connect Four ----

  function c4Main(g) {
    let cols = "";
    for (let c = 0; c < C4_COLS; c++) {
      const full = !!g.b[c];
      const dis = g.over || g.turn !== 1 || full ? " disabled" : "";
      let inner = `<span class="gm-ghost" style="grid-row:1;grid-column:${c + 1}"><i class="gm-disc p1"></i></span>`;
      for (let r = 0; r < C4_ROWS; r++) {
        const idx = r * C4_COLS + c;
        const v = g.b[idx];
        const cls = ["gm-disc", v ? "p" + v : "", idx === g.last ? "new" : "", g.line.includes(idx) ? "win" : ""].filter(Boolean).join(" ");
        const disc = v ? `<i class="${cls}" style="--fall:${r + 1.4}"></i>` : "";
        inner += `<span class="gm-hole" style="grid-row:${r + 2};grid-column:${c + 1}">${disc}</span>`;
      }
      cols += `<button type="button" class="gm-col" data-act="c4" data-c="${c}" aria-label="Drop in column ${c + 1}"${dis}>${inner}</button>`;
    }
    return `${turnPill(g, g.turn === 1)}
      <div class="gm-c4">
        <div class="gm-frame"></div>
        ${cols}
      </div>
      ${resultBar(g)}
      <div class="gm-keys">Keys 1–7</div>`;
  }

  // ---- Rock Paper Scissors ----

  function pips(n, who) {
    return [0, 1, 2].map((i) => `<i class="gm-pip ${who}${i < n ? " on" : ""}"></i>`).join("");
  }

  function rpsMain(g) {
    const shaking = g.phase === "shake";
    const r = g.round;
    const youFace = shaking ? "✊" : r ? rpsById(r.you).emoji : "❔";
    const cpuFace = shaking ? "✊" : r ? rpsById(r.cpu).emoji : "❔";
    const youCls = !shaking && r ? (r.outcome === "win" ? " winner" : r.outcome === "loss" ? " loser" : "") : "";
    const cpuCls = !shaking && r ? (r.outcome === "loss" ? " winner" : r.outcome === "win" ? " loser" : "") : "";
    const caption = shaking ? g.call : g.over ? "" : r ? (r.outcome === "win" ? "You take the round" : r.outcome === "loss" ? "CEO takes the round" : "Tie — go again") : "Choose your move";
    const dis = g.over || shaking ? " disabled" : "";
    return `
      <div class="gm-rps">
        <div class="gm-rps-score">
          <div class="gm-rps-side"><span>YOU</span><div class="gm-pips">${pips(g.you, "you")}</div></div>
          <div class="gm-rps-first">first to 3</div>
          <div class="gm-rps-side right"><span>CEO</span><div class="gm-pips">${pips(g.cpu, "cpu")}</div></div>
        </div>
        <div class="gm-rps-ring">
          <div class="gm-orb you${shaking ? " shaking" : ""}${youCls}"><span>${youFace}</span></div>
          <div class="gm-vs">VS</div>
          <div class="gm-orb cpu${shaking ? " shaking" : ""}${cpuCls}"><span>${cpuFace}</span></div>
        </div>
        <div class="gm-rps-call${shaking ? " beat" : ""}">${caption}</div>
        ${g.over ? resultBar(g) : `<div class="gm-picks">
          ${RPS.map((m) => `<button type="button" class="gm-pick" data-act="rps" data-id="${m.id}"${dis}><span class="gm-pick-emoji">${m.emoji}</span><span>${m.label}</span><kbd>${m.key.toUpperCase()}</kbd></button>`).join("")}
        </div>`}
      </div>`;
  }

  // ---- paint ----

  function hudHtml() {
    if (ui.screen === "menu") {
      const t = Object.values(ui.scores).reduce((a, s) => ({ w: a.w + s.w, l: a.l + s.l, d: a.d + s.d }), { w: 0, l: 0, d: 0 });
      return `<div class="gm-stat w"><b>${t.w}</b><span>Wins</span></div><div class="gm-stat l"><b>${t.l}</b><span>Losses</span></div><div class="gm-stat d"><b>${t.d}</b><span>Draws</span></div>`;
    }
    const s = ui.scores[ui.screen];
    return `<div class="gm-stat w"><b>${s.w}</b><span>Wins</span></div><div class="gm-stat l"><b>${s.l}</b><span>Losses</span></div><div class="gm-stat d"><b>${s.d}</b><span>Draws</span></div>
      ${ui.streak > 1 ? `<div class="gm-streak">🔥 ${ui.streak} win streak</div>` : ""}`;
  }

  function paint() {
    const st = ui.stage;
    if (!st) return;
    const g = ui.game;
    const meta = GAMES.find((x) => x.id === ui.screen);
    st.dataset.screen = ui.screen;
    st.querySelector("#gm-title").textContent = meta ? meta.title : "Game Room";
    st.querySelector("#gm-back-label").textContent = ui.screen === "menu" ? "Home" : "Games";
    st.querySelector("#gm-levels").innerHTML = levelPicker();
    st.querySelector("#gm-mute").innerHTML = ic(ui.muted ? "volume-x" : "volume-2");
    st.querySelector("#gm-mute").setAttribute("aria-label", ui.muted ? "Unmute sound" : "Mute sound");
    st.querySelector("#gm-bubble").innerHTML = `<b>CEO</b><span>${ui.msg || ""}</span>`;
    st.querySelector("#gm-hud").innerHTML = hudHtml();
    st.querySelector("#gm-main").innerHTML =
      ui.screen === "menu" ? menuMain()
      : ui.screen === "ttt" ? tttMain(g)
      : ui.screen === "c4" ? c4Main(g)
      : rpsMain(g);
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const { act, id, i, c } = el.dataset;
    if (act === "back") ui.screen === "menu" ? leave() : toMenu();
    else if (act === "mute") {
      ui.muted = !ui.muted;
      try { localStorage.setItem(MUTE_KEY, ui.muted ? "1" : "0"); } catch {}
      paint();
    }
    else if (act === "level") { ui.level = id; paint(); }
    else if (act === "start") { startGame(id); paint(); }
    else if (act === "again") { startGame(ui.screen); paint(); }
    else if (act === "menu") toMenu();
    else if (act === "ttt") { tttClick(Number(i)); paint(); }
    else if (act === "c4") { c4Click(Number(c)); paint(); }
    else if (act === "rps") { rpsClick(id); }
  }

  function buildStage() {
    const st = document.createElement("div");
    st.className = "gm-stage";
    st.innerHTML = `
      ${SVG_DEFS}
      <div class="gm-top">
        <button type="button" class="gm-back" data-act="back">${ic("arrow-left")}<span id="gm-back-label">Home</span></button>
        <h1 class="gm-title" id="gm-title">Game Room</h1>
        <div id="gm-levels"></div>
        <button type="button" class="gm-mute" id="gm-mute" data-act="mute"></button>
      </div>
      <div class="gm-arena">
        <aside class="gm-side">
          <div class="gm-bot-slot" id="gm-bot-slot"></div>
          <div class="gm-bubble" id="gm-bubble"></div>
          <div class="gm-hud" id="gm-hud"></div>
        </aside>
        <section class="gm-main" id="gm-main"></section>
      </div>
      <div class="gm-fx" id="gm-fx" aria-hidden="true"></div>`;
    st.addEventListener("click", onClick);
    // Once an entrance animation has played, never replay it when the app's
    // periodic render() re-attaches this node.
    st.addEventListener("animationend", (e) => {
      e.target.closest?.(".new")?.classList.add("settled");
    });
    return st;
  }

  function mountBot() {
    const slot = ui.stage?.querySelector("#gm-bot-slot");
    const eng = bot();
    if (!slot || !eng) return;
    eng.mount(slot);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  // ---------- integration with the app shell ----------

  VIEW_RENDERERS.game = function renderGameView() {
    return `<div class="gm-view"><div id="gm-host"></div></div>`;
  };

  VIEW_ATTACHERS.push(function attachGame() {
    if (state.view !== "game") return;
    const host = document.getElementById("gm-host");
    if (!host) return;
    if (!ui.stage) {
      ui.stage = buildStage();
      say("menu");
      paint();
    }
    host.appendChild(ui.stage);
    mountBot();
  });

  function openGame() {
    clearTimer();
    ui.screen = "menu";
    ui.game = null;
    ui.streak = 0;
    say("menu");
    if (state.view === "game") {
      paint();
      return;
    }
    switchView("game");
    paint();
  }

  document.addEventListener("keydown", (e) => {
    if (typeof state === "undefined" || state.view !== "game" || !ui.stage) return;
    if (e.target?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") { ui.screen === "menu" ? leave() : toMenu(); return; }
    const k = e.key.toLowerCase();
    if (ui.screen === "ttt" && /^[1-9]$/.test(k)) { tttClick(Number(k) - 1); paint(); }
    else if (ui.screen === "c4" && /^[1-7]$/.test(k)) { c4Click(Number(k) - 1); paint(); }
    else if (ui.screen === "rps") {
      const m = RPS.find((x) => x.key === k);
      if (m) rpsClick(m.id);
    }
  });

  // Capture phase, so this runs before the page's own submit handlers and a
  // "/game" message never becomes an agent run.
  const COMMAND_INPUTS = {
    "composer-form": "composer-input",
    "chat-new-form": "chat-new-goal-input",
    "chat-reply-form": "chat-reply-input",
  };
  document.addEventListener("submit", (e) => {
    const form = e.target;
    const inputId = form instanceof HTMLFormElement ? COMMAND_INPUTS[form.id] : null;
    if (!inputId) return;
    const input = document.getElementById(inputId);
    if (!input || input.value.trim().toLowerCase() !== "/game") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    input.value = "";
    state.composerDraft = "";
    state.chatDraftGoal = "";
    state.chatReplyDraft = "";
    openGame();
  }, true);

  // Test hook (node harness only; harmless in the browser).
  if (typeof globalThis.__GAME_TEST__ === "object") {
    Object.assign(globalThis.__GAME_TEST__, { ui, startTtt, tttPlace, tttCpuMove, startC4, c4Place, c4CpuMove, startRps, rpsReveal });
  }
})();
