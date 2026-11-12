// LED Dome Bot — a 3D (three.js) companion with a smoked-glass dome head.
//
// The face is NOT made of separate lights stuck onto the head. The head is a
// single glossy shell, and behind it sits a curved LED-matrix "screen". The
// eyes and mouth are just patterns lit on that hidden matrix, softened by the
// shell, so the face reads as one integrated display.
//
// Head layers, inside → out:
//   core     opaque near-black interior (what you see through the glass)
//   display  curved LED sector just in front of the core (additive dots)
//   tint     smoked translucent shell (dims + diffuses the LEDs)
//   bleed    blurred LED light caught *in* the shell surface (diffusion)
//   gloss    reflection-only clear coat (additive, fresnel highlights)
//
// No post-processing: bloom on a transparent canvas composited over the page
// looks wrong, so the glow is baked into the face texture instead, and
// reflections come from a procedurally painted environment map.
//
// Drop-in compatible with GeometricBot's public API (mount, setShape, react,
// celebrate, defeat, lookAt, setMood, getModes, getCurrentMode) and it fires
// the same "ceo-bot-mode-change" event, so the home page can switch between
// the two designs without other changes.

import * as THREE from "../vendor/three/three.module.js";

// ---------- modes ----------

const MODES = [
  { id: "ready", name: "Ready", modeTitle: "Ready & Friendly", badgeText: "✦ Ready" },
  { id: "thinking", name: "Thinking", modeTitle: "Thinking & Working", badgeText: "⚡ Thinking" },
  { id: "celebrate", name: "Celebrate", modeTitle: "Goal Done & Celebrating", badgeText: "🎉 Celebrate" },
  { id: "review", name: "Review", modeTitle: "Attention & Review", badgeText: "⚠️ Review" },
];

// Every visual knob lives here so the Bot Lab can tune it live and export it.
export const DEFAULT_CONFIG = {
  // LED colour per mode (ready, thinking, celebrate, review)
  modeColors: ["#ffaa45", "#52d2ff", "#bf8bff", "#ffd84a"],

  // shell
  shellTint: "#808080",
  shellOpacity: 0.32,
  shellRoughness: 0.6,
  gloss: 0,
  interior: "#000000",

  // LED matrix
  cols: 58,
  dotSize: 0.76, // fraction of a cell
  ledIntensity: 2.9,
  glow: 0.95,
  glowRadius: 3.5,
  bleed: 0.52,
  unlit: 0.08,
  flicker: 0.15,
  scanOnChange: true,

  // face layout (design units on a 720-wide display)
  eyeW: 98,
  eyeH: 149,
  eyeGap: 170,
  eyeY: -59,
  eyeRound: 0.52,
  mouthW: 154,
  mouthY: 92,
  mouthThick: 32,
  gazeRange: 2,

  // motion
  bob: 0.4,
  bobSpeed: 0.6,
  headFollow: 2,
  squash: 1.5,
  blinkEvery: 10, // seconds (average)
  energy: 1.5,

  // body
  body: "head", // "full" | "head"
  bodyColor: "#2b2e35",
  metalness: 0,
  bodyRoughness: 0.34,
  accentGlow: 0.8,
  shadow: 0.3,

  // camera / quality
  zoom: 0.84,
  fov: 30,
  maxDpr: 2,
};

// Tuning controls, shared by the Bot Lab and the Settings page.
// [key, label, min, max, step] for sliders, or [key, label, "color"|"toggle"]
// and [key, label, "select", [[value, label], ...]].
export const CONFIG_SCHEMA = [
  ["Shell", [
    ["shellTint", "Tint", "color"],
    ["shellOpacity", "Smoke", 0, 1, 0.01],
    ["shellRoughness", "Roughness", 0, 0.6, 0.01],
    ["gloss", "Reflections", 0, 3, 0.05],
    ["interior", "Interior", "color"],
  ]],
  ["LED matrix", [
    ["cols", "Columns", 32, 112, 2],
    ["dotSize", "Dot size", 0.4, 1, 0.02],
    ["ledIntensity", "Brightness", 0.5, 5, 0.1],
    ["glow", "Glow", 0, 2, 0.05],
    ["glowRadius", "Glow radius", 0, 14, 0.5],
    ["bleed", "Shell bleed", 0, 1.2, 0.02],
    ["unlit", "Unlit dots", 0, 0.3, 0.01],
    ["flicker", "Flicker", 0, 0.15, 0.005],
    ["scanOnChange", "Scan on mode", "toggle"],
  ]],
  ["Face layout", [
    ["eyeW", "Eye width", 50, 180, 1],
    ["eyeH", "Eye height", 30, 180, 1],
    ["eyeGap", "Eye spacing", 120, 360, 2],
    ["eyeY", "Eye height pos", -100, 60, 1],
    ["eyeRound", "Eye roundness", 0, 1, 0.02],
    ["mouthW", "Mouth width", 40, 260, 2],
    ["mouthY", "Mouth pos", 20, 160, 1],
    ["mouthThick", "Line weight", 10, 44, 1],
    ["gazeRange", "Eye travel", 0, 2, 0.05],
  ]],
  ["Motion", [
    ["bob", "Float amount", 0, 2.5, 0.05],
    ["bobSpeed", "Float speed", 0.3, 2.5, 0.05],
    ["headFollow", "Head follow", 0, 2, 0.05],
    ["squash", "Squash", 0, 1.5, 0.05],
    ["blinkEvery", "Blink every (s)", 1, 10, 0.1],
    ["energy", "Energy", 0.2, 1.5, 0.05],
  ]],
  ["Body", [
    ["body", "Show", "select", [["full", "Head + body"], ["head", "Head only"]]],
    ["bodyColor", "Body colour", "color"],
    ["metalness", "Metalness", 0, 1, 0.01],
    ["bodyRoughness", "Roughness", 0, 1, 0.01],
    ["accentGlow", "Accent lights", 0, 2, 0.05],
    ["shadow", "Ground shadow", 0, 0.8, 0.01],
  ]],
  ["Camera & quality", [
    ["zoom", "Zoom", 0.6, 1.6, 0.01],
    ["fov", "Lens (fov)", 12, 45, 1],
    ["maxDpr", "Max pixel ratio", 1, 3, 0.5],
  ]],
];

// ---------- face parameters ----------
// Sizes are multipliers on the config's base layout so tuning the base face
// in the lab carries through every expression.

const BASE = {
  pal: 0,
  ex: 1, ey: 1, er: 1, eyeDY: 0, eyeAsym: 0,
  rect: 1, chevron: 0, squint: 0, arc: 0, spiral: 0, heart: 0,
  lid: 0, lidTilt: 0, lowLid: 0,
  mBar: 1, mCurve: 0.3, mw: 1, mThick: 1, mOpen: 0, mO: 0, mOR: 1, squiggle: 0, dots: 0, mouthDY: 0,
  bright: 1, sparkle: 0,
};
const EXPRESSIONS = {
  happy: {},
  curious: { ex: 1.04, ey: 1.12, eyeAsym: 0.2, eyeDY: -6, mBar: 0, mO: 1, mOR: 0.45 },
  delighted: { ex: 1.08, lowLid: 0.42, mCurve: 0.6, mOpen: 0.75, mw: 1.12 },
  thinking: { pal: 1, ey: 0.6, ex: 1.06, eyeDY: -4, mBar: 0, dots: 1 },
  surprised: { pal: 1, ex: 1.06, ey: 1.24, er: 1.8, eyeDY: -10, mBar: 0, mO: 1, mOR: 1 },
  sad: { pal: 1, lid: 0.38, lidTilt: -1, ey: 0.92, eyeDY: 8, mCurve: -0.5, mw: 0.72, bright: 0.85 },
  laugh: { pal: 2, rect: 0, chevron: 1, mCurve: 0.7, mOpen: 1, mw: 1.15, sparkle: 1 },
  love: { pal: 2, rect: 0, heart: 1, mCurve: 0.55, mOpen: 0.55, sparkle: 0.6 },
  dizzy: { pal: 2, rect: 0, spiral: 1, mBar: 0.25, mCurve: 0, squiggle: 0.85 },
  grumpy: { pal: 3, lid: 0.44, lidTilt: 1, ey: 0.86, mBar: 0.15, mCurve: -0.1, squiggle: 1, mw: 0.85 },
  oops: { pal: 3, rect: 0, squint: 1, mCurve: -0.35, mw: 0.62 },
  drowsy: { lid: 0.6, mCurve: 0.05, mw: 0.55, bright: 0.75 },
  asleep: { rect: 0, arc: 1, mBar: 0, mO: 0.75, mOR: 0.35, bright: 0.5 },
};
const DISCRETE = new Set(["pal"]);
const SHAPE_EXPRESSIONS = ["happy", "thinking", "laugh", "grumpy"]; // mode pills 0..3
const HEAD_ROLL = { curious: 0.14, asleep: 0.1, sad: -0.06, love: 0.08, drowsy: 0.05 };

const DROWSY_MS = 30000;
const SLEEP_MS = 45000;
const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const CANVAS_OVERSIZE = 1.35; // canvas extends past the slot so jumps never clip

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (k, dt) => 1 - Math.pow(1 - k, dt / 16.67);
const rad = (d) => (d * Math.PI) / 180;
const hexRgb = (h) => {
  const s = String(h).replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) || 0);
};

// ---------- geometry ----------

// Head silhouette: a perfect sphere (superellipse exponent 2, equal radii,
// profile running pole to pole — no flat underside, no rim).
const HEAD = { R: 1, Ht: 1, Hb: 1, n: 2, bottomDeg: -90 };
// Display sector (rad wide, deg tall). The vertical span keeps the face
// screen at the proportions it was tuned at (~1.75:1, equator ~56% down).
const FACE_SPAN = { phi: 1.92, top: 35, bottom: -28 };

function headPoint(deg) {
  const a = rad(deg);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const e = 2 / HEAD.n;
  return new THREE.Vector2(Math.max(1e-4, HEAD.R * Math.pow(Math.abs(c), e)), (s >= 0 ? HEAD.Ht : -HEAD.Hb) * Math.pow(Math.abs(s), e));
}
const HEAD_BASE = headPoint(HEAD.bottomDeg); // underside rim (x = radius, y < 0)
const HEAD_LIFT = -HEAD_BASE.y + 0.02; // head centre above the neck pivot

// Profile from `fromDeg` (bottom) to `toDeg` (top), resampled to equal arc
// length so a texture maps onto it without vertical stretching.
function headProfile(scale, fromDeg, toDeg, steps, withBottom) {
  const raw = [];
  for (let i = 0; i <= 400; i++) raw.push(headPoint(fromDeg + ((toDeg - fromDeg) * i) / 400));
  const len = [0];
  for (let i = 1; i < raw.length; i++) len.push(len[i - 1] + raw[i].distanceTo(raw[i - 1]));
  const total = len[len.length - 1];
  const pts = [];
  let j = 1;
  for (let k = 0; k <= steps; k++) {
    const want = (total * k) / steps;
    while (j < len.length - 1 && len[j] < want) j++;
    const t = (want - len[j - 1]) / (len[j] - len[j - 1] || 1);
    pts.push(raw[j - 1].clone().lerp(raw[j], clamp(t, 0, 1)));
  }
  if (withBottom) {
    const b = pts[0];
    pts.unshift(new THREE.Vector2(b.x * 0.985, b.y), new THREE.Vector2(1e-4, b.y));
  }
  return { pts: pts.map((p) => p.multiplyScalar(scale)), length: total * scale };
}

// ---------- procedural studio environment (for reflections) ----------

function paintEnvironment() {
  const W = 1024;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#3c414d");
  g.addColorStop(0.42, "#16181d");
  g.addColorStop(0.58, "#0a0b0e");
  g.addColorStop(1, "#060607");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  const box = (cx, cy, w, h, color, blur) => {
    x.save();
    x.filter = `blur(${blur}px)`;
    x.fillStyle = color;
    x.beginPath();
    const r = Math.min(w, h) * 0.3;
    x.moveTo(cx - w / 2 + r, cy - h / 2);
    x.arcTo(cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, r);
    x.arcTo(cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2, r);
    x.arcTo(cx - w / 2, cy + h / 2, cx - w / 2, cy - h / 2, r);
    x.arcTo(cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, r);
    x.fill();
    x.restore();
  };
  // u = 0.75 is straight behind the camera, so front-facing surfaces reflect
  // that part of the map. Key softbox upper-left, strip light right, a soft
  // overhead band and a faint warm floor bounce.
  box(W * 0.86, H * 0.2, 170, 96, "#ffffff", 10);
  box(W * 0.75, H * 0.03, 640, 34, "rgba(255,255,255,0.55)", 14);
  box(W * 0.56, H * 0.4, 46, 230, "rgba(225,235,255,0.9)", 8);
  box(W * 0.97, H * 0.45, 40, 200, "rgba(225,235,255,0.55)", 10);
  box(W * 0.3, H * 0.25, 260, 80, "rgba(255,255,255,0.35)", 18);
  box(W * 0.72, H * 0.82, 420, 70, "rgba(255,170,90,0.18)", 24);
  return c;
}

// ---------- speech ----------
// Short lines the bot says in a speech bubble. Each event has a pool; one is
// picked at random (never the same one twice in a row).

const LINES = {
  greet(hour) {
    if (hour < 5) return ["Burning the midnight oil? I'll keep the lights on. 💡", "It's very late… or very early. Either way, I'm here!"];
    if (hour < 12) return ["Good morning! ☀️ Coffee's on you, ideas are on me.", "Morning, boss! Let's make today ridiculously productive.", "Rise and shine! My LEDs are already caffeinated."];
    if (hour < 17) return ["Good afternoon! Ready to build an empire?", "Hey there! Lunch done? Let's crush some goals.", "Afternoon! Perfect time for a big idea. 💡"];
    if (hour < 22) return ["Good evening! 🌙 Night shift crew, reporting in.", "Evening! My LEDs are warmed up and ready.", "Hey! Let's wrap up the day with a win."];
    return ["Late-night genius hours, huh? I'm in. 🌙", "Shh… the best ideas come out at night."];
  },
  idle: [
    "I'd give you a high five, but… no arms. ✋",
    "Fun fact: I'm 100% bug-free. Mostly. Probably.",
    "Is it just me, or is this dashboard looking extra sharp today?",
    "I run on electricity and your good ideas.",
    "Beep boop. Translation: you're doing great.",
    "Pro tip: big goals are just small tasks wearing a trench coat.",
    "If you need me, I'll be here. Glowing. Majestically.",
    "My spirit animal is a progress bar at 99%.",
    "Ask me anything. Except my password. I don't have one. 🤫",
    "Staring contest? I can't blink unless I want to.",
  ],
  hover: ["Hi there! 👋", "Oh hey, you found me!", "Boop? 👀", "Hello, human friend!"],
  poke: ["Hehe, that tickles!", "Beep boop! 🤖", "Again! Again!", "Boop received."],
  grumpy: ["Okay, okay! I'm awake. Stop poking! 😤", "Personal space, please. I'm a sensitive dome."],
  dizzy: ["Whoa… the room is spinning. 😵‍💫", "Stop shaking! My pixels are scrambling!"],
  typing: ["Ooh, what are we writing?", "Typing fast! I'm taking notes. 📝", "I can't read over your shoulder. Okay, maybe a little."],
  oops: ["Backspace marathon? Happens to the best of us.", "Delete, delete, delete… we'll get there!"],
  send: ["Message sent! On it. 🚀", "Got it, passing it to the team!"],
  thinking: ["Crunching numbers… and a few snacks.", "Thinking… please hold. ⏳", "Big brain mode: ON. 🧠"],
  success: ["Nailed it! 🎉", "Done and dusted! High five? ✋", "Another win for the team!"],
  fail: ["Hmm, that didn't go to plan. Let's take another swing.", "Plot twist! Something failed. Let's check it out."],
  celebrate: ["Party mode activated! 🎉", "Approved! I love it when a plan comes together."],
  sleep: ["Zzz… dreaming of quarterly targets…", "Powering down to screensaver mode… zzz"],
  wake: ["Huh? I wasn't sleeping! I was… defragmenting.", "I'm up! I'm up! 👀", "Oh! You're back! I totally didn't nap."],
};

const BUBBLE_CSS = `
/* Floating caption to the upper-left of the head: no background, no border
   — just text, with a small LED dot (current mode colour) on the side
   nearest the bot. A soft text shadow keeps it legible over busy backdrops. */
.led-bot-bubble {
  position: absolute;
  right: 90%;
  top: 12%;
  z-index: 20;
  display: flex;
  flex-direction: row-reverse;
  align-items: baseline;
  gap: 8px;
  width: max-content;
  max-width: min(190px, 34vw);
  padding: 0;
  background: none;
  color: var(--text, #26263a);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.45;
  letter-spacing: 0.005em;
  text-align: right;
  text-shadow: 0 0 10px var(--bg, #eef0f7), 0 0 3px var(--bg, #eef0f7);
  opacity: 0;
  filter: blur(3px);
  transform: translateX(8px);
  transition: opacity 0.22s ease, transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), filter 0.22s ease;
  pointer-events: none;
  cursor: default;
  user-select: none;
}
.led-bot-bubble.show { opacity: 1; filter: none; transform: none; pointer-events: auto; }
.led-bot-bubble .led-bot-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  align-self: flex-start;
  margin-top: 6px;
  background: var(--led-color, #ffaa45);
  box-shadow: 0 0 8px var(--led-color, #ffaa45);
}
.led-bot-bubble .led-bot-rest { color: transparent; text-shadow: none; } /* reserves the final size while typing */
.led-bot-bubble .led-bot-go { margin-left: 4px; color: var(--accent, #c25e1a); font-weight: 600; transition: margin 0.2s ease; }
.led-bot-bubble.is-tip { cursor: pointer; }
.led-bot-bubble.is-tip:hover .led-bot-typed { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 35%, transparent); }
.led-bot-bubble.is-tip:hover .led-bot-go { margin-left: 7px; }

/* Narrow containers (Settings preview) have no room at the side: sit above. */
.bot-settings-slot .led-bot-bubble {
  right: auto;
  left: 50%;
  top: auto;
  bottom: 98%;
  flex-direction: row;
  text-align: left;
  max-width: 220px;
  transform: translate(-50%, 6px);
}
.bot-settings-slot .led-bot-bubble.show { transform: translate(-50%, 0); }

@media (prefers-reduced-motion: reduce) {
  .led-bot-bubble { transition: opacity 0.2s ease; transform: none; filter: none; }
  .bot-settings-slot .led-bot-bubble { transform: translate(-50%, 0); }
}
`;

function injectBubbleCss() {
  if (document.getElementById("led-bot-bubble-css")) return;
  const st = document.createElement("style");
  st.id = "led-bot-bubble-css";
  st.textContent = BUBBLE_CSS;
  document.head.appendChild(st);
}

// ---------- LED face renderer ----------
// Shapes are drawn into a tiny mask (one pixel per LED), then expanded into
// round dots plus a blurred glow. Anti-aliased edges in the mask come out as
// half-lit LEDs, which reads as soft diffusion through the shell.

class LedFace {
  constructor(cols, aspect, dotSize) {
    this.W = 720;
    this.cell = 12;
    this.build(cols, aspect, dotSize);
  }

  build(cols, aspect, dotSize) {
    this.cols = Math.round(clamp(cols, 24, 128));
    this.rows = Math.max(8, Math.round(this.cols / aspect));
    this.aspect = aspect;
    this.H = this.W / aspect;
    this.dotSize = dotSize;
    const mk = (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    };
    const tw = this.cols * this.cell;
    const th = this.rows * this.cell;
    this.mask = mk(this.cols, this.rows);
    this.mctx = this.mask.getContext("2d", { willReadFrequently: true });
    this.lit = mk(tw, th);
    this.display = mk(tw, th);
    this.glow = mk(this.cols * 4, this.rows * 4);
    this.dots = mk(tw, th);
    this.unlitGrid = mk(tw, th);
    this.blurOk = (() => {
      try {
        const t = mk(20, 20).getContext("2d");
        t.filter = "blur(4px)";
        t.fillRect(8, 8, 4, 4);
        return t.getImageData(3, 10, 1, 1).data[3] > 0;
      } catch {
        return false;
      }
    })();
    this.paintDotGrids();
    this.prevMask = null;
  }

  paintDotGrids() {
    const cell = this.cell;
    const one = document.createElement("canvas");
    one.width = one.height = cell;
    const o = one.getContext("2d");
    const r = (cell / 2) * this.dotSize;
    const g = o.createRadialGradient(cell / 2, cell / 2, 0, cell / 2, cell / 2, r);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.6, "rgba(255,255,255,0.92)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    o.fillStyle = g;
    o.fillRect(0, 0, cell, cell);
    for (const [canvas, style] of [[this.dots, null], [this.unlitGrid, "#9097a3"]]) {
      const x = canvas.getContext("2d");
      x.clearRect(0, 0, canvas.width, canvas.height);
      x.fillStyle = x.createPattern(one, "repeat");
      x.fillRect(0, 0, canvas.width, canvas.height);
      if (style) {
        x.globalCompositeOperation = "source-in";
        x.fillStyle = style;
        x.fillRect(0, 0, canvas.width, canvas.height);
        x.globalCompositeOperation = "source-over";
      }
    }
  }

  roundRect(m, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    m.beginPath();
    m.moveTo(x + r, y);
    m.arcTo(x + w, y, x + w, y + h, r);
    m.arcTo(x + w, y + h, x, y + h, r);
    m.arcTo(x, y + h, x, y, r);
    m.arcTo(x, y, x + w, y, r);
    m.closePath();
  }

  drawEye(m, side, cx, cy, bot, now) {
    const p = bot.p;
    const cfg = bot.cfg;
    const asym = 1 + side * p.eyeAsym;
    const w = cfg.eyeW * p.ex * asym;
    const hFull = cfg.eyeH * p.ey * asym;
    const h = Math.max(cfg.eyeH * 0.14, hFull * bot.blink.scale);
    const x = cx + (side * cfg.eyeGap) / 2;
    const y = cy + cfg.eyeY + p.eyeDY;
    const t = cfg.mouthThick;

    if (p.rect > 0.01) {
      m.save();
      m.globalAlpha = Math.min(1, p.rect);
      if (p.lid > 0.01) {
        const lidY = y - h / 2 + p.lid * h;
        const tilt = p.lidTilt * h * 0.38 * Math.min(1, p.lid * 2.5);
        const innerX = x - side * (w / 2 + 6);
        const outerX = x + side * (w / 2 + 6);
        m.beginPath();
        m.moveTo(outerX, lidY - tilt);
        m.lineTo(innerX, lidY + tilt);
        m.lineTo(innerX, y + h);
        m.lineTo(outerX, y + h);
        m.closePath();
        m.clip();
      }
      this.roundRect(m, x - w / 2, y - h / 2, w, h, (Math.min(w, h) / 2) * clamp(cfg.eyeRound * p.er, 0, 1));
      m.fill();
      m.restore();
    }
    m.lineWidth = t;
    if (p.chevron > 0.01) {
      m.globalAlpha = Math.min(1, p.chevron);
      m.beginPath();
      m.moveTo(x - w * 0.42, y + hFull * 0.2);
      m.lineTo(x, y - hFull * 0.24);
      m.lineTo(x + w * 0.42, y + hFull * 0.2);
      m.stroke();
    }
    if (p.squint > 0.01) {
      m.globalAlpha = Math.min(1, p.squint);
      m.beginPath();
      m.moveTo(x + side * w * 0.36, y - hFull * 0.3);
      m.lineTo(x - side * w * 0.3, y);
      m.lineTo(x + side * w * 0.36, y + hFull * 0.3);
      m.stroke();
    }
    if (p.arc > 0.01) {
      m.globalAlpha = Math.min(1, p.arc);
      m.beginPath();
      m.arc(x, y - w * 0.3, w * 0.46, Math.PI * 0.22, Math.PI * 0.78);
      m.stroke();
    }
    if (p.spiral > 0.01) {
      m.globalAlpha = Math.min(1, p.spiral);
      m.lineWidth = t * 0.7;
      m.beginPath();
      const rot = now * 0.006 * side;
      for (let i = 0; i <= 60; i++) {
        const k = i / 60;
        const a = rot + k * 2.2 * Math.PI * 2;
        const r = w * 0.5 * k;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r * 0.92;
        if (i) m.lineTo(px, py);
        else m.moveTo(px, py);
      }
      m.stroke();
    }
    if (p.heart > 0.01) {
      m.globalAlpha = Math.min(1, p.heart);
      const s = w * 0.56 * (1 + Math.sin(now * 0.012) * 0.08);
      m.beginPath();
      m.moveTo(x, y + s * 0.75);
      m.bezierCurveTo(x - s * 1.25, y - s * 0.1, x - s * 0.55, y - s * 1.0, x, y - s * 0.35);
      m.bezierCurveTo(x + s * 0.55, y - s * 1.0, x + s * 1.25, y - s * 0.1, x, y + s * 0.75);
      m.fill();
    }
    m.globalAlpha = 1;
    return { x, y, w, h };
  }

  drawMask(bot, now) {
    const m = this.mctx;
    const p = bot.p;
    const cfg = bot.cfg;
    const W = this.W;
    const H = this.H;
    const s = this.cols / W;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = "source-over";
    m.globalAlpha = 1;
    m.clearRect(0, 0, this.cols, this.rows);
    m.setTransform(s, 0, 0, s, 0, 0);
    m.fillStyle = m.strokeStyle = "#fff";
    m.lineCap = "round";
    m.lineJoin = "round";

    const fx = W / 2 + bot.face.x;
    const fy = H / 2 + bot.face.y;
    const eyes = [-1, 1].map((side) => this.drawEye(m, side, fx, fy, bot, now));

    // Happy squint: bite a curve out of the bottom of each eye (◠ eyes).
    if (p.lowLid > 0.01 && p.rect > 0.05) {
      m.globalCompositeOperation = "destination-out";
      for (const e of eyes) {
        const cy = e.y + e.h * 0.5 + e.h * 0.55 + 2 - p.lowLid * e.h * 1.1;
        m.beginPath();
        m.ellipse(e.x, cy, e.w * 0.78, e.h * 0.55, 0, 0, Math.PI * 2);
        m.fill();
      }
      m.globalCompositeOperation = "source-over";
    }

    // Mouth (parallax: it trails the eyes so the face feels curved)
    const mx = W / 2 + bot.face.x * 0.75;
    const my = H / 2 + cfg.mouthY + p.mouthDY + bot.face.y * 0.75;
    const mw = cfg.mouthW * p.mw;
    const k = p.mCurve * mw * 0.32;
    const t = cfg.mouthThick * p.mThick;
    if (p.mOpen > 0.01) {
      m.globalAlpha = Math.min(1, p.mOpen * 1.4);
      m.beginPath();
      m.moveTo(mx - mw / 2, my - k * 0.5);
      m.quadraticCurveTo(mx, my + k * 0.6, mx + mw / 2, my - k * 0.5);
      m.quadraticCurveTo(mx, my + k * 1.5 + p.mOpen * mw * 0.42, mx - mw / 2, my - k * 0.5);
      m.fill();
    }
    if (p.mBar > 0.01) {
      m.globalAlpha = Math.min(1, p.mBar);
      m.lineWidth = t;
      m.beginPath();
      m.moveTo(mx - mw / 2, my - k * 0.5);
      m.quadraticCurveTo(mx, my + k * 1.5, mx + mw / 2, my - k * 0.5);
      m.stroke();
    }
    if (p.mO > 0.01) {
      const breathe = bot.expr === "asleep" ? 1 + Math.sin(now * 0.0022) * 0.25 : 1;
      const r = (10 + 24 * p.mOR) * breathe;
      m.globalAlpha = Math.min(1, p.mO);
      m.lineWidth = t * 0.85;
      m.beginPath();
      m.ellipse(mx, my, r, r * 1.08, 0, 0, Math.PI * 2);
      m.stroke();
    }
    if (p.squiggle > 0.01) {
      m.globalAlpha = Math.min(1, p.squiggle);
      m.lineWidth = t * 0.8;
      m.beginPath();
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const px = mx - mw * 0.45 + (mw * 0.9 * i) / n;
        const py = my + (i % 2 ? -1 : 1) * 11 + Math.sin(now * 0.02 + i) * 2;
        if (i) m.lineTo(px, py);
        else m.moveTo(px, py);
      }
      m.stroke();
    }
    if (p.dots > 0.01) {
      for (let i = 0; i < 3; i++) {
        const b = 0.25 + 0.75 * Math.max(0, Math.sin(now * 0.007 - i * 0.95));
        m.globalAlpha = Math.min(1, p.dots) * b;
        m.beginPath();
        m.arc(mx + (i - 1) * cfg.mouthW * 0.3, my - b * 6, t * 0.55, 0, Math.PI * 2);
        m.fill();
      }
    }

    // Floating z's, lit on the matrix itself
    if (bot.zs.length) {
      m.textAlign = "center";
      for (const z of bot.zs) {
        const age = (now - z.born) / 2600;
        m.globalAlpha = Math.sin(age * Math.PI);
        m.font = `800 ${Math.round(48 + age * 26)}px system-ui, sans-serif`;
        m.fillText("z", W / 2 + 200 + age * 70, H / 2 - 20 - age * 120);
      }
    }

    // Colourize (brightness rides on the alpha), with a faint living flicker.
    const flick = 1 - cfg.flicker * (0.5 + 0.5 * Math.sin(now * 0.051) * Math.sin(now * 0.0137));
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = "source-in";
    m.globalAlpha = clamp(p.bright * flick, 0, 1);
    m.fillStyle = bot.ledColor;
    m.fillRect(0, 0, this.cols, this.rows);
    m.globalCompositeOperation = "source-over";
    m.globalAlpha = 1;

    // Celebration sparkles: single LEDs twinkling around the face
    if (p.sparkle > 0.04) {
      if (now >= bot.nextSpark) {
        const edge = Math.random() < 0.5;
        const sx = edge ? Math.floor(Math.random() * this.cols) : Math.random() < 0.5 ? Math.floor(Math.random() * 6) : this.cols - 1 - Math.floor(Math.random() * 6);
        const sy = edge ? (Math.random() < 0.5 ? Math.floor(Math.random() * 4) : this.rows - 1 - Math.floor(Math.random() * 4)) : Math.floor(Math.random() * this.rows);
        bot.sparks.push({ x: sx, y: sy, born: now, life: 500 + Math.random() * 500 });
        bot.nextSpark = now + 50 + Math.random() * 90;
      }
      m.fillStyle = bot.ledColor;
      for (const sp of bot.sparks) {
        const a = (now - sp.born) / sp.life;
        if (a < 1) {
          m.globalAlpha = Math.sin(a * Math.PI) * Math.min(1, p.sparkle);
          m.fillRect(sp.x, sp.y, 1, 1);
        }
      }
      m.globalAlpha = 1;
    }
    bot.sparks = bot.sparks.filter((sp) => now - sp.born < sp.life);

    // Refresh scan: rows below the beam are dimmed, the beam row is lit.
    if (bot.scan) {
      const a = (now - bot.scan.start) / bot.scan.dur;
      if (a >= 1) bot.scan = null;
      else {
        const row = Math.floor(a * (this.rows + 2)) - 1;
        m.globalCompositeOperation = "destination-out";
        m.globalAlpha = 0.85;
        m.fillRect(0, row + 1, this.cols, this.rows);
        m.globalCompositeOperation = "source-over";
        m.globalAlpha = 0.9;
        m.fillStyle = bot.ledColor;
        m.fillRect(0, row, this.cols, 1);
        m.globalAlpha = 1;
      }
    }
  }

  // Returns true when the texture content changed.
  render(bot, now) {
    this.drawMask(bot, now);
    const data = this.mctx.getImageData(0, 0, this.cols, this.rows).data;
    if (this.prevMask && this.prevMask.length === data.length && !this.dirtyStyle) {
      let same = true;
      for (let i = 0; i < data.length; i++) if (data[i] !== this.prevMask[i]) { same = false; break; }
      if (same) return false;
    }
    this.prevMask = data;
    this.dirtyStyle = false;

    const cfg = bot.cfg;
    const tw = this.display.width;
    const th = this.display.height;

    // glow (also used as the shell's "bleed" texture)
    const g = this.glow.getContext("2d");
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, this.glow.width, this.glow.height);
    g.imageSmoothingEnabled = true;
    if (this.blurOk) g.filter = `blur(${cfg.glowRadius}px)`;
    g.drawImage(this.mask, 0, 0, this.glow.width, this.glow.height);
    g.filter = "none";

    // lit dots
    const l = this.lit.getContext("2d");
    l.globalCompositeOperation = "source-over";
    l.clearRect(0, 0, tw, th);
    l.imageSmoothingEnabled = false;
    l.drawImage(this.mask, 0, 0, tw, th);
    l.globalCompositeOperation = "destination-in";
    l.drawImage(this.dots, 0, 0);
    l.globalCompositeOperation = "source-over";

    const d = this.display.getContext("2d");
    d.globalCompositeOperation = "source-over";
    d.globalAlpha = 1;
    d.clearRect(0, 0, tw, th);
    if (cfg.unlit > 0) {
      d.globalAlpha = cfg.unlit;
      d.drawImage(this.unlitGrid, 0, 0);
    }
    d.globalCompositeOperation = "lighter";
    d.globalAlpha = clamp(cfg.glow, 0, 2) / 2;
    d.imageSmoothingEnabled = true;
    d.drawImage(this.glow, 0, 0, tw, th);
    if (cfg.glow > 1) d.drawImage(this.glow, 0, 0, tw, th);
    d.globalAlpha = 1;
    d.drawImage(this.lit, 0, 0);
    d.globalCompositeOperation = "source-over";
    return true;
  }
}

// ---------- the bot ----------

class LedDomeBot {
  constructor(container, opts = {}) {
    const now = performance.now();
    this.container = container;
    this.opts = { globalSync: true, speech: false, ...opts };
    // speech: false | true | { tips: string[], onTipClick() } — tips are app
    // hints (e.g. "change my style in Settings") mixed in with the jokes.
    this.speech = opts.speech ? { tips: [], ...(opts.speech === true ? {} : opts.speech) } : null;
    this.lastLine = {};
    this.lineCooldown = {};
    this.lastSpoke = 0;
    this.bubbleUntil = 0;
    this.talkingUntil = 0;
    this.nextIdleLine = now + 40000;
    this.speechTimers = [];
    this.cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    this.destroyed = false;
    this.rafId = 0;
    this.visible = true;
    this.fps = 0;
    this.frames = 0;
    this.fpsAt = now;

    this.p = { ...BASE };
    this.target = { ...BASE };
    this.expr = "happy";
    this.palIdx = 0;
    this.palW = [1, 0, 0, 0];
    this.override = null;
    this.gazeOverride = null;
    this.nudge = null;

    this.gaze = { x: 0, y: 0 };
    this.face = { x: 0, y: 0 };
    this.wander = { x: 0.3, y: -0.2, next: 0 };
    this.pointer = { x: 0, y: 0, last: 0, prevX: null, sign: 0, reversals: [] };
    this.hover = false;
    this.clicks = [];
    this.lastType = 0;
    this.typeEl = null;
    this.backspaces = [];
    this.lastActivity = now;
    this.sleepStage = "awake";
    this.dizzyCooldown = 0;

    this.runStatus = new Map();
    this.runsPrimed = false;
    this.runningCount = 0;

    this.blink = { scale: 0.05, phase: "opening", next: now + 2200, again: false };
    this.physics = { y: 0, vy: 0, sx: 1, sy: 1, vsx: 0, vsy: 0 };
    this.head = { yaw: 0, pitch: 0, roll: 0 };
    this.shake = null;
    this.zs = [];
    this.nextZ = 0;
    this.sparks = [];
    this.nextSpark = 0;
    this.scan = this.cfg.scanOnChange ? { start: now, dur: 650 } : null; // boot-up sweep
    this.lastFrame = now;
    this.nextFidget = now + 8000;
    this.ledColor = this.cfg.modeColors[0];

    this.initDOM();
    this.initScene();
    this.applyConfig();
    this.bindEvents();
    this.syncAmbientGlow(0);
    this.react("delighted", 1400, { jump: true });
    if (this.speech) {
      this.later(() => this.say("greet", { force: true }), 900);
      if (this.speech.tips.length) this.later(() => this.sayTip(), 9000);
    }

    this.runTimer = setInterval(() => this.watchRuns(), 1000);
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  get energy() {
    return (REDUCED ? 0.4 : 1) * this.cfg.energy;
  }

  initDOM() {
    const inset = (-(CANVAS_OVERSIZE - 1) / 2) * 100;
    this.container.innerHTML = `
      <div class="metallic-bot-root led-bot-root" role="button" aria-label="CEO Agent LED Dome Bot" style="cursor: pointer;">
        <canvas class="metallic-bot-canvas led-bot-canvas" style="position:absolute; inset:${inset}%; width:${CANVAS_OVERSIZE * 100}%; height:${CANVAS_OVERSIZE * 100}%; pointer-events:none;"></canvas>
        <div class="led-bot-bubble" role="status" aria-live="polite"></div>
      </div>`;
    this.root = this.container.querySelector(".led-bot-root");
    this.canvas = this.container.querySelector(".led-bot-canvas");
    this.bubble = this.container.querySelector(".led-bot-bubble");
    injectBubbleCss();
    this.bubble.addEventListener("click", (e) => {
      e.stopPropagation(); // don't count as a poke
      if (this.bubble.classList.contains("is-tip")) {
        this.hideBubble();
        this.speech?.onTipClick?.();
      }
    });
  }

  initScene() {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(this.cfg.fov, 1, 0.1, 100);

    const envCanvas = paintEnvironment();
    const envTex = new THREE.CanvasTexture(envCanvas);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromEquirectangular(envTex).texture;
    envTex.dispose();
    pmrem.dispose();
    scene.environment = this.envMap;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-3, 4, 5);
    const rim = new THREE.DirectionalLight(0xcfdcff, 1.1);
    rim.position.set(4, 2, -3);
    scene.add(key, rim, new THREE.HemisphereLight(0x8a96aa, 0x0d0d10, 0.45));

    // --- hierarchy: bot → torso / neck / headPivot → head
    this.bot = new THREE.Group();
    scene.add(this.bot);
    this.headPivot = new THREE.Group();
    this.headPivot.position.y = 0.3;
    this.bot.add(this.headPivot);
    this.headGroup = new THREE.Group();
    this.headGroup.position.y = HEAD_LIFT;
    this.headPivot.add(this.headGroup);

    // --- materials
    this.mats = {
      core: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide }),
      display: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      tint: new THREE.MeshPhysicalMaterial({ metalness: 0, transparent: true, depthWrite: false, envMapIntensity: 0.7, clearcoat: 0.4 }),
      bleed: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      gloss: new THREE.MeshPhysicalMaterial({ color: 0x000000, metalness: 0, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      metal: new THREE.MeshPhysicalMaterial({ clearcoat: 0.35, clearcoatRoughness: 0.3 }),
      darkMetal: new THREE.MeshPhysicalMaterial({ color: 0x121317, metalness: 0.8, roughness: 0.4 }),
      accent: new THREE.MeshBasicMaterial({ toneMapped: true }),
      chest: new THREE.MeshBasicMaterial({ toneMapped: true }),
      shadow: null,
    };

    // --- head layers
    const shell = headProfile(1, HEAD.bottomDeg, 90, 120, false);
    const core = headProfile(0.95, HEAD.bottomDeg, 90, 90, false);
    const shellGeo = new THREE.LatheGeometry(shell.pts, 128);
    const coreMesh = new THREE.Mesh(new THREE.LatheGeometry(core.pts, 96), this.mats.core);
    const tint = new THREE.Mesh(shellGeo, this.mats.tint);
    const gloss = new THREE.Mesh(shellGeo, this.mats.gloss);
    coreMesh.renderOrder = 0;
    tint.renderOrder = 2;
    gloss.renderOrder = 4;
    this.headGroup.add(coreMesh, tint, gloss);

    const faceProf = headProfile(0.968, FACE_SPAN.bottom, FACE_SPAN.top, 48, false);
    const faceWidth = 0.968 * HEAD.R * FACE_SPAN.phi;
    this.faceAspect = faceWidth / faceProf.length;
    const displayMesh = new THREE.Mesh(new THREE.LatheGeometry(faceProf.pts, 72, -FACE_SPAN.phi / 2, FACE_SPAN.phi), this.mats.display);
    displayMesh.renderOrder = 1;
    const bleedProf = headProfile(1.004, FACE_SPAN.bottom, FACE_SPAN.top, 48, false);
    const bleedMesh = new THREE.Mesh(new THREE.LatheGeometry(bleedProf.pts, 72, -FACE_SPAN.phi / 2, FACE_SPAN.phi), this.mats.bleed);
    bleedMesh.renderOrder = 3;
    this.headGroup.add(displayMesh, bleedMesh);


    // --- neck: a short ribbed column
    this.neck = new THREE.Group();
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.36, 32), this.mats.darkMetal);
    column.position.y = 0.14;
    this.neck.add(column);
    for (const y of [0.06, 0.15, 0.24]) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.026, 12, 40), this.mats.metal);
      rib.rotation.x = Math.PI / 2;
      rib.position.y = y;
      this.neck.add(rib);
    }
    this.bot.add(this.neck);

    // --- torso: a compact rounded body with a chest status light
    this.torso = new THREE.Group();
    const torsoCurve = new THREE.SplineCurve([
      new THREE.Vector2(0.001, -0.95), new THREE.Vector2(0.32, -0.92), new THREE.Vector2(0.52, -0.78),
      new THREE.Vector2(0.6, -0.5), new THREE.Vector2(0.6, -0.26), new THREE.Vector2(0.54, -0.1),
      new THREE.Vector2(0.38, -0.01), new THREE.Vector2(0.18, 0.02), new THREE.Vector2(0.001, 0.025),
    ]);
    const torsoMesh = new THREE.Mesh(new THREE.LatheGeometry(torsoCurve.getPoints(64), 72), this.mats.metal);
    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.012, 8, 72), this.mats.darkMetal);
    seam.rotation.x = Math.PI / 2;
    seam.position.y = -0.56;
    const chestRing = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.014, 10, 36), this.mats.darkMetal);
    chestRing.position.set(0, -0.3, 0.6);
    const chest = new THREE.Mesh(new THREE.CircleGeometry(0.068, 32), this.mats.chest);
    chest.position.set(0, -0.3, 0.603);
    this.chest = chest;
    this.torso.add(torsoMesh, seam, chestRing, chest);
    this.bot.add(this.torso);

    // --- soft ground shadow
    const sc = document.createElement("canvas");
    sc.width = sc.height = 128;
    const sx = sc.getContext("2d");
    const sg = sx.createRadialGradient(64, 64, 0, 64, 64, 64);
    sg.addColorStop(0, "rgba(0,0,0,1)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    sx.fillStyle = sg;
    sx.fillRect(0, 0, 128, 128);
    this.mats.shadow = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false, color: 0x000000 });
    this.shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.9), this.mats.shadow);
    this.shadowMesh.rotation.x = -Math.PI / 2;
    this.shadowMesh.position.y = -0.97;
    this.shadowMesh.scale.set(1, 0.32, 1);
    scene.add(this.shadowMesh);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.root);
    this.ioObs = new IntersectionObserver((entries) => {
      this.visible = entries.some((e) => e.isIntersecting);
    });
    this.ioObs.observe(this.root);
  }

  buildFace() {
    const cfg = this.cfg;
    if (this.ledFace && this.ledFace.cols === Math.round(cfg.cols) && this.ledFace.dotSize === cfg.dotSize) return;
    this.ledFace = new LedFace(cfg.cols, this.faceAspect, cfg.dotSize);
    this.dotTex?.dispose();
    this.glowTex?.dispose();
    this.dotTex = new THREE.CanvasTexture(this.ledFace.display);
    this.glowTex = new THREE.CanvasTexture(this.ledFace.glow);
    for (const t of [this.dotTex, this.glowTex]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
    }
    this.mats.display.map = this.dotTex;
    this.mats.bleed.map = this.glowTex;
    this.mats.display.needsUpdate = this.mats.bleed.needsUpdate = true;
  }

  // Applies the whole config; cheap enough to call on every slider tick.
  applyConfig() {
    const c = this.cfg;
    const m = this.mats;
    m.core.color.set(c.interior);
    m.tint.color.set(c.shellTint);
    m.tint.opacity = c.shellOpacity;
    m.tint.roughness = c.shellRoughness;
    m.gloss.envMapIntensity = c.gloss;
    m.display.color.setScalar(c.ledIntensity);
    m.bleed.opacity = c.bleed;
    m.bleed.color.setScalar(1.6);
    m.metal.color.set(c.bodyColor);
    m.metal.metalness = c.metalness;
    m.metal.roughness = c.bodyRoughness;
    m.shadow.opacity = c.shadow;
    const full = c.body !== "head";
    this.torso.visible = this.neck.visible = full;
    this.shadowMesh.visible = full && c.shadow > 0;
    this.buildFace();
    if (this.ledFace) this.ledFace.dirtyStyle = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, c.maxDpr));
    this.resize();
  }

  setConfig(patch = {}) {
    this.cfg = { ...this.cfg, ...patch };
    if (patch.modeColors) this.cfg.modeColors = [...patch.modeColors];
    this.applyConfig();
    if (patch.modeColors) this.syncAmbientGlow(this.palIdx);
  }

  getConfig() {
    return JSON.parse(JSON.stringify(this.cfg));
  }

  resize() {
    const w = this.root.clientWidth || 280;
    const size = Math.round(w * CANVAS_OVERSIZE);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.cfg.maxDpr));
    this.renderer.setSize(size, size, false);
    this.frame();
  }

  frame() {
    const c = this.cfg;
    const full = c.body !== "head";
    const top = 0.3 + HEAD_LIFT + HEAD.Ht;
    const bottom = full ? -0.98 : 0.3 + HEAD_LIFT + HEAD_BASE.y;
    const h = top - bottom;
    const ty = (top + bottom) / 2;
    const visible = (h * CANVAS_OVERSIZE * 1.1) / c.zoom;
    const d = visible / (2 * Math.tan(rad(c.fov) / 2));
    this.camera.fov = c.fov;
    this.camera.aspect = 1;
    this.camera.position.set(0, ty + d * 0.05, d);
    this.camera.lookAt(0, ty, 0);
    this.camera.updateProjectionMatrix();
  }

  syncAmbientGlow(idx) {
    const mode = MODES[idx] || MODES[0];
    const hex = this.cfg.modeColors[idx] || this.cfg.modeColors[0];
    const [r, g, b] = hexRgb(hex);
    const glow = `rgba(${r}, ${g}, ${b}, 0.40)`;
    const character = { ...mode, colorHex: (r << 16) | (g << 8) | b, accentGlow: glow, body: { outer: hex, inner: "#ffffff" } };
    if (this.opts.globalSync) {
      document.documentElement.style.setProperty("--bot-accent-color", hex);
      document.documentElement.style.setProperty("--bot-accent-glow", glow);
      const lf = window.LaserFlow?.getInstance?.();
      if (lf && typeof lf.setAccentColor === "function") lf.setAccentColor(r / 255, g / 255, b / 255);
      window.dispatchEvent(new CustomEvent("ceo-bot-mode-change", {
        detail: { index: idx, character, modeKey: mode.id, modeTitle: mode.modeTitle, badgeText: mode.badgeText, source: "led" },
      }));
    }
    this.root?.style.setProperty("--led-color", hex);
    this.opts.onModeChange?.({ index: idx, character, color: hex, glow });
  }

  // ---------- speech ----------

  later(fn, ms) {
    this.speechTimers.push(setTimeout(fn, ms));
  }

  // Say a line from LINES[kind]. Options: chance (0..1), cooldown (ms per
  // kind), force (interrupt whatever is showing and skip the global gap).
  say(kind, { chance = 1, cooldown = 15000, force = false } = {}) {
    if (!this.speech || this.destroyed || !this.root.isConnected || document.hidden) return false;
    const now = performance.now();
    if (Math.random() > chance) return false;
    if (now < (this.lineCooldown[kind] || 0)) return false;
    if (!force && (this.bubbleUntil > now || now - this.lastSpoke < 5000)) return false;
    const pool = typeof LINES[kind] === "function" ? LINES[kind](new Date().getHours()) : LINES[kind];
    if (!pool?.length) return false;
    let line = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && line === this.lastLine[kind]) line = pool[(pool.indexOf(line) + 1) % pool.length];
    this.lastLine[kind] = line;
    this.lineCooldown[kind] = now + cooldown;
    this.showBubble(line);
    return true;
  }

  sayTip(force = false) {
    const tips = this.speech?.tips || [];
    if (!tips.length || this.destroyed || !this.root.isConnected || document.hidden) return false;
    const now = performance.now();
    if (!force && (this.bubbleUntil > now || now - this.lastSpoke < 5000)) return false;
    this.showBubble(tips[Math.floor(Math.random() * tips.length)], { tip: true });
    return true;
  }

  showBubble(text, { tip = false } = {}) {
    const b = this.bubble;
    clearInterval(this.typeTimer);
    clearTimeout(this.hideTimer);
    const now = performance.now();
    const hold = clamp(2200 + text.length * 55, 3200, 7500) + (tip ? 2000 : 0);
    this.lastSpoke = now;
    this.bubbleUntil = now + hold;
    const clickable = tip && !!this.speech.onTipClick;
    b.classList.toggle("is-tip", clickable);
    b.title = clickable ? "Open Settings" : "";

    // [dot][typed][rest] — the untyped rest is drawn transparent so the
    // bubble is its final size from the first frame (no jittery growth).
    b.textContent = "";
    const el = (cls, txt = "") => {
      const n = document.createElement("span");
      n.className = cls;
      n.textContent = txt;
      return n;
    };
    const textWrap = el("led-bot-text");
    const typed = el("led-bot-typed");
    const rest = el("led-bot-rest", text);
    textWrap.append(typed, rest);
    if (clickable) textWrap.append(el("led-bot-go", "→"));
    b.append(el("led-bot-dot"), textWrap);
    b.classList.add("show");

    if (REDUCED) {
      typed.textContent = text;
      rest.textContent = "";
    } else {
      // typewriter, in step with a little "talking" mouth flap
      const chars = Array.from(text);
      let i = 0;
      this.talkingUntil = now + chars.length * 24;
      this.typeTimer = setInterval(() => {
        i += 1;
        typed.textContent = chars.slice(0, i).join("");
        rest.textContent = chars.slice(i).join("");
        if (i >= chars.length) clearInterval(this.typeTimer);
      }, 24);
    }
    this.hideTimer = setTimeout(() => this.hideBubble(), hold);
  }

  hideBubble() {
    clearInterval(this.typeTimer);
    clearTimeout(this.hideTimer);
    this.bubbleUntil = 0;
    this.talkingUntil = 0;
    this.bubble?.classList.remove("show");
  }

  // Lab / app hook: say something right now (a random idle line or a tip).
  saySomething() {
    if (this.speech?.tips.length && Math.random() < 0.3) return this.sayTip(true);
    return this.say("idle", { force: true, cooldown: 0 });
  }

  // ---------- reactions ----------

  react(expr, ms, opts = {}) {
    if (this.destroyed || !EXPRESSIONS[expr]) return;
    const now = performance.now();
    this.override = { expr, until: now + ms, start: now, fidget: !!opts.fidget };
    if (opts.jump) this.jump();
  }

  jump(vy = 0.075, stretch = 1.12) {
    const E = this.energy;
    const s = this.cfg.squash;
    this.physics.vy = vy * E;
    this.physics.sy = 1 + (stretch - 1) * E * s;
    this.physics.sx = 1 - (stretch - 1) * E * s;
  }

  squash(amount = 0.1) {
    const E = this.energy * this.cfg.squash;
    this.physics.sy = 1 - amount * E;
    this.physics.sx = 1 + amount * E;
  }

  shakeHead(amp = 0.22, ms = 650) {
    this.shake = { amp: amp * this.energy, start: performance.now(), ms };
  }

  setMood(mood, durationMs = 0) {
    if (mood === "ready" || mood === "idle") { this.override = null; return; }
    const map = {
      working: "thinking", thinking: "thinking",
      celebrating: "laugh", celebrate: "laugh",
      review: "grumpy", attention: "grumpy", error: "grumpy",
      defeated: "sad", typing: "curious",
    };
    const expr = map[mood] || (EXPRESSIONS[mood] ? mood : null);
    if (expr) this.react(expr, durationMs > 0 ? durationMs : 4000, { jump: expr === "laugh" });
  }

  celebrate() {
    this.react("laugh", 3200, { jump: true });
    this.say("celebrate", { force: true, cooldown: 4000 });
  }

  defeat(ms = 2600) {
    this.react("sad", ms);
    this.squash(0.12);
  }

  lookAt(x, y, ms = 1400) {
    this.gazeOverride = { x: clamp(x / 0.45, -1, 1), y: clamp(-y / 0.3, -1, 1), until: performance.now() + ms };
  }

  setShape(idx) {
    if (idx < 0 || idx >= SHAPE_EXPRESSIONS.length) return;
    this.react(SHAPE_EXPRESSIONS[idx], 6000, { jump: true });
  }

  cycleNext() {
    this.setShape((this.palIdx + 1) % SHAPE_EXPRESSIONS.length);
  }

  // Lab helper: pretend nobody has touched anything for `ms`.
  forceIdle(ms) {
    this.lastActivity = performance.now() - ms;
    this.hover = false;
    this.lastType = 0;
    this.pointer.last = 0;
    this.override = null;
  }

  markActivity() {
    const now = performance.now();
    if (this.sleepStage !== "awake") {
      const wasAsleep = this.sleepStage === "asleep";
      this.sleepStage = "awake";
      this.react("surprised", 1000);
      this.jump(0.09, 1.15);
      this.blinkNow();
      if (wasAsleep) this.say("wake", { force: true, cooldown: 30000 });
    }
    this.lastActivity = now;
  }

  blinkNow() {
    if (this.blink.phase === "open") this.blink.phase = "closing";
  }

  watchRuns() {
    const st = globalThis.state;
    if (!st) return;
    const runs = [...(st.runs || [])];
    if (st.openRun?.id) runs.push(st.openRun);
    const recent = Date.now() - 3 * 3600 * 1000;
    let running = 0;
    const seen = new Set();
    for (const r of runs) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      const prev = this.runStatus.get(r.id);
      if (r.status === "running" && new Date(r.createdAt).getTime() > recent) running++;
      if (this.runsPrimed && prev === "running" && r.status !== "running") {
        if (r.status === "success") {
          this.react("laugh", 3500, { jump: true });
          this.say("success", { force: true, cooldown: 3000 });
        } else {
          this.react("grumpy", 3800, { jump: true });
          this.say("fail", { force: true, cooldown: 3000 });
        }
      }
      this.runStatus.set(r.id, r.status);
    }
    if (this.runsPrimed && running > this.runningCount) this.say("thinking", { chance: 0.6, cooldown: 45000 });
    this.runningCount = running;
    this.runsPrimed = true;
  }

  // ---------- per-frame update ----------

  resolveExpression(now) {
    const idle = now - this.lastActivity;
    const busy = this.runningCount > 0 || now - this.lastType < 4000 || this.hover;
    const prevStage = this.sleepStage;
    this.sleepStage = busy ? "awake" : idle > SLEEP_MS ? "asleep" : idle > DROWSY_MS ? "drowsy" : "awake";
    if (this.sleepStage === "asleep" && prevStage !== "asleep") this.say("sleep", { force: true, cooldown: 120000 });
    // Idle chatter: a joke (or an app tip) every 40-75s while awake and nobody is typing.
    if (this.speech && now >= this.nextIdleLine) {
      this.nextIdleLine = now + 40000 + Math.random() * 35000;
      if (this.sleepStage === "awake" && now - this.lastType > 5000 && this.runningCount === 0) {
        if (this.speech.tips.length && Math.random() < 0.3) this.sayTip();
        else this.say("idle", { cooldown: 0 });
      }
    }
    if (this.override?.fidget && this.lastActivity > this.override.start) this.override = null;
    if (this.override && now < this.override.until) return this.override.expr;
    this.override = null;
    if (this.sleepStage === "asleep") return "asleep";
    if (this.sleepStage === "drowsy") return "drowsy";
    if (this.hover) return "delighted";
    if (now - this.lastType < 1800) return "curious";
    if (this.runningCount > 0) return "thinking";
    if (now >= this.nextFidget && now - this.pointer.last > 3000) return this.fidget(now);
    return "happy";
  }

  fidget(now) {
    const r = Math.random();
    const [expr, ms] = r < 0.3 ? ["curious", 1500] : r < 0.55 ? ["surprised", 1000] : r < 0.8 ? ["laugh", 1400] : ["oops", 1300];
    this.nextFidget = now + (12000 + Math.random() * 12000) / Math.max(0.2, this.energy);
    this.react(expr, ms, { jump: expr === "laugh" || expr === "surprised", fidget: true });
    return expr;
  }

  applyExpression(expr) {
    const prev = this.expr;
    this.expr = expr;
    this.target = { ...BASE, ...EXPRESSIONS[expr] };
    if (this.target.pal !== this.palIdx) {
      this.palIdx = this.target.pal;
      this.syncAmbientGlow(this.palIdx);
      if (this.cfg.scanOnChange) this.scan = { start: performance.now(), dur: 380 };
    }
    if ((expr === "grumpy" || expr === "oops") && prev !== expr) this.shakeHead(expr === "oops" ? 0.12 : 0.2);
    if (this.target.rect > 0.5 && expr !== "drowsy") this.blinkNow();
  }

  caretPoint(el) {
    const r = el.getBoundingClientRect();
    const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (typeof el.selectionStart !== "number" || typeof el.value !== "string") return mid;
    const cs = getComputedStyle(el);
    this.mctx = this.mctx || document.createElement("canvas").getContext("2d");
    this.mctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const innerW = Math.max(20, el.clientWidth - padL - padR);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.3;
    const lines = el.value.slice(0, el.selectionStart).split("\n");
    const multi = el.tagName === "TEXTAREA";
    let row = 0;
    if (multi) for (let i = 0; i < lines.length - 1; i++) row += 1 + Math.floor(this.mctx.measureText(lines[i]).width / innerW);
    let w = this.mctx.measureText(lines[lines.length - 1]).width;
    if (multi) { row += Math.floor(w / innerW); w %= innerW; }
    return {
      x: clamp(r.left + padL + w - el.scrollLeft, r.left, r.right),
      y: multi ? clamp(r.top + padT + (row + 0.5) * lh - el.scrollTop, r.top, r.bottom) : mid.y,
    };
  }

  updateGaze(now, dt) {
    const rect = this.root.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height * 0.38; // the head sits above centre
    const size = rect.width || 280;
    const toGaze = (x, y, scale) => ({ x: Math.tanh((x - cx) / scale), y: Math.tanh((y - cy) / scale) });

    let g = { x: 0, y: 0 };
    if (this.gazeOverride && now < this.gazeOverride.until) {
      g = this.gazeOverride;
    } else if (this.expr === "asleep") {
      g = { x: 0, y: 0.4 };
    } else if (this.expr === "dizzy") {
      g = { x: Math.sin(now * 0.01) * 0.6, y: Math.cos(now * 0.01) * 0.4 };
    } else if (now - this.lastType < 1800 && this.typeEl?.isConnected) {
      const pt = this.caretPoint(this.typeEl);
      g = toGaze(pt.x, pt.y, size * 1.2);
    } else if (now - this.pointer.last < 2200) {
      g = toGaze(this.pointer.x, this.pointer.y, size * 0.9);
    } else if (this.expr === "thinking") {
      g = { x: Math.sin(now * 0.0021) * 0.7, y: -0.4 + Math.sin(now * 0.0013) * 0.18 };
    } else {
      if (now >= this.wander.next) {
        const quick = Math.random() < 0.28;
        const ang = Math.random() * Math.PI * 2;
        const r = 0.35 + Math.random() * 0.65;
        this.wander.x = Math.cos(ang) * r;
        this.wander.y = Math.sin(ang) * r * 0.85;
        if (Math.random() < 0.18) { this.wander.x = 0; this.wander.y = 0; }
        this.wander.next = now + (quick ? 260 + Math.random() * 260 : (1000 + Math.random() * 1700) / Math.max(0.2, this.energy));
      }
      g = this.wander;
    }
    if (this.nudge && now < this.nudge.until) g = { x: g.x, y: clamp(g.y + this.nudge.y, -1, 1) };

    this.gaze.x += (g.x - this.gaze.x) * ease(0.3, dt);
    this.gaze.y += (g.y - this.gaze.y) * ease(0.3, dt);

    // The lit face slides across the matrix toward the gaze (eyes lead,
    // the head follows more slowly in updatePhysics).
    const drift = this.expr === "asleep" ? 0 : this.energy;
    const range = this.cfg.gazeRange;
    let fx = this.gaze.x * 62 * range + (Math.sin(now * 0.0011) * 5 + Math.sin(now * 0.0017 + 1) * 3) * drift;
    let fy = this.gaze.y * 38 * range + Math.sin(now * 0.0013 + 2) * 4 * drift;
    this.face.x += (fx - this.face.x) * ease(0.14, dt);
    this.face.y += (fy - this.face.y) * ease(0.14, dt);
  }

  updateBlink(now, dt) {
    const b = this.blink;
    const canBlink = this.p.rect > 0.5 && this.expr !== "asleep";
    const every = this.cfg.blinkEvery * 1000;
    if (b.phase === "open") {
      b.scale += (1 - b.scale) * ease(0.3, dt);
      if (canBlink && now >= b.next) b.phase = "closing";
    } else if (b.phase === "closing") {
      b.scale += (0.05 - b.scale) * ease(this.expr === "drowsy" ? 0.12 : 0.5, dt);
      if (b.scale < 0.12) b.phase = "opening";
    } else {
      b.scale += (1 - b.scale) * ease(this.expr === "drowsy" ? 0.08 : 0.4, dt);
      if (b.scale > 0.95) {
        b.phase = "open";
        if (b.again) { b.again = false; b.next = now + 130; }
        else { b.again = Math.random() < 0.2; b.next = now + (every * 0.6 + Math.random() * every * 0.8) * (this.expr === "drowsy" ? 0.6 : 1); }
      }
    }
  }

  updatePhysics(now, dt) {
    const ph = this.physics;
    const c = this.cfg;
    const E = this.energy;
    const asleep = this.expr === "asleep";
    const thinking = this.expr === "thinking";
    const freq = (asleep ? 0.0011 : thinking ? 0.0034 : 0.0022) * c.bobSpeed;
    const amp = (asleep ? 0.025 : thinking ? 0.035 : 0.05) * E * c.bob;
    const breath = Math.sin(now * (asleep ? 0.0011 : 0.0018) * c.bobSpeed) * (asleep ? 0.016 : 0.007) * c.bob;
    let floatY = Math.sin(now * freq) * amp;
    if (this.expr === "laugh") floatY += Math.abs(Math.sin(now * 0.02)) * 0.03 * E;

    ph.vsx = (ph.vsx + (1 - breath - ph.sx) * 0.14) * 0.78;
    ph.vsy = (ph.vsy + (1 + breath - ph.sy) * 0.14) * 0.78;
    ph.sx += ph.vsx;
    ph.sy += ph.vsy;
    ph.vy = (ph.vy + (floatY - ph.y) * 0.12) * 0.76;
    ph.y += ph.vy;

    const follow = c.headFollow;
    let yaw = this.gaze.x * 0.42 * follow;
    let pitch = this.gaze.y * 0.22 * follow;
    let roll = (HEAD_ROLL[this.expr] || 0) - this.gaze.x * 0.05 * follow;
    if (this.expr === "dizzy") roll += Math.sin(now * 0.011) * 0.16 * E;
    if (asleep) pitch += 0.12;
    if (this.shake) {
      const t = now - this.shake.start;
      if (t > this.shake.ms) this.shake = null;
      else yaw += this.shake.amp * Math.sin(t * 0.045) * (1 - t / this.shake.ms);
    }
    const k = ease(0.1, dt);
    this.head.yaw += (yaw - this.head.yaw) * k;
    this.head.pitch += (pitch - this.head.pitch) * k;
    this.head.roll += (roll - this.head.roll) * k;
  }

  update(now, dt) {
    const expr = this.resolveExpression(now);
    if (expr !== this.expr) this.applyExpression(expr);

    const k = ease(0.18, dt);
    for (const key in this.target) {
      if (DISCRETE.has(key)) this.p[key] = this.target[key];
      else this.p[key] += (this.target[key] - this.p[key]) * k;
    }
    // "Talking": flap the mouth open while the bubble types out.
    if (this.talkingUntil > now && this.p.mBar > 0.5) {
      this.p.mOpen = Math.max(this.p.mOpen, Math.max(0, Math.sin(now * 0.045)) * 0.55);
    }
    const kp = ease(0.08, dt);
    for (let i = 0; i < 4; i++) this.palW[i] += ((i === this.palIdx ? 1 : 0) - this.palW[i]) * kp;
    let r = 0, g = 0, b = 0, ws = 0;
    this.palW.forEach((w, i) => {
      const [cr, cg, cb] = hexRgb(this.cfg.modeColors[i]);
      r += cr * w; g += cg * w; b += cb * w; ws += w;
    });
    ws = ws || 1;
    this.ledRgb = [r / ws, g / ws, b / ws];
    this.ledColor = `rgb(${Math.round(r / ws)}, ${Math.round(g / ws)}, ${Math.round(b / ws)})`;

    this.updateGaze(now, dt);
    this.updateBlink(now, dt);
    this.updatePhysics(now, dt);

    if (this.expr === "asleep" && now >= this.nextZ) {
      this.zs.push({ born: now });
      this.nextZ = now + 1300;
    }
    this.zs = this.zs.filter((z) => now - z.born < 2600);
  }

  applyPose(now) {
    const ph = this.physics;
    this.bot.position.y = ph.y;
    this.bot.scale.set(ph.sx, ph.sy, ph.sx);
    this.headPivot.rotation.set(this.head.pitch, this.head.yaw, this.head.roll, "YXZ");
    this.torso.rotation.y = this.head.yaw * 0.22;
    this.neck.rotation.y = this.head.yaw * 0.5;
    const s = 1 - clamp(ph.y, -0.2, 0.3) * 0.9;
    this.shadowMesh.scale.set(s, 0.32 * s, 1);
    this.mats.shadow.opacity = this.cfg.shadow * clamp(s, 0.4, 1.2);

    // accent lights follow the LED colour; the chest light "breathes"
    const [r, g, b] = this.ledRgb || [255, 170, 70];
    const speed = this.expr === "thinking" ? 0.008 : this.expr === "asleep" ? 0.0015 : 0.003;
    const pulse = 0.65 + 0.35 * Math.sin(now * speed);
    const a = this.cfg.accentGlow;
    this.mats.accent.color.setRGB((r / 255) * a * 2, (g / 255) * a * 2, (b / 255) * a * 2, THREE.SRGBColorSpace);
    this.chest.scale.setScalar(0.9 + 0.1 * pulse);
    this.mats.chest.color.copy(this.mats.accent.color).multiplyScalar(0.7 + 0.6 * pulse);
  }

  loop() {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = clamp(now - this.lastFrame, 1, 64);
    this.lastFrame = now;
    if (!this.root.isConnected || !this.visible || document.hidden) return;
    this.update(now, dt);
    if (this.ledFace.render(this, now)) {
      this.dotTex.needsUpdate = true;
      this.glowTex.needsUpdate = true;
    }
    this.applyPose(now);
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    if (now - this.fpsAt >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsAt));
      this.frames = 0;
      this.fpsAt = now;
    }
  }

  // ---------- input ----------

  bindEvents() {
    const isField = (t) => t && t.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, [contenteditable=''], [contenteditable='true']");

    this.onPointerMove = (e) => {
      const now = performance.now();
      const pt = this.pointer;
      pt.x = e.clientX;
      pt.y = e.clientY;
      pt.last = now;
      this.markActivity();
      if (pt.prevX !== null) {
        const dx = e.clientX - pt.prevX;
        const sign = Math.sign(dx);
        if (Math.abs(dx) > 18 && sign && sign !== pt.sign) {
          pt.sign = sign;
          pt.reversals.push(now);
        }
      }
      pt.prevX = e.clientX;
      pt.reversals = pt.reversals.filter((t) => now - t < 900);
      if (pt.reversals.length >= 6 && now > this.dizzyCooldown) {
        pt.reversals = [];
        this.dizzyCooldown = now + 4000;
        this.react("dizzy", 2400);
        this.squash(0.08);
        this.say("dizzy", { force: true, cooldown: 10000 });
      }
    };
    this.onMouseOut = (e) => {
      if (!e.relatedTarget) this.pointer.last = 0;
    };
    this.onKeyDown = (e) => {
      this.markActivity();
      if (e.key === "Backspace" && isField(e.target)) {
        const now = performance.now();
        this.backspaces = this.backspaces.filter((t) => now - t < 2000);
        this.backspaces.push(now);
        if (this.backspaces.length >= 7) {
          this.backspaces = [];
          this.react("oops", 1300);
          this.say("oops", { chance: 0.6, cooldown: 60000 });
        }
      }
    };
    this.onInput = (e) => {
      if (!isField(e.target)) return;
      if (performance.now() - this.lastType > 8000) this.say("typing", { chance: 0.35, cooldown: 120000 });
      this.lastType = performance.now();
      this.typeEl = e.target;
      this.markActivity();
      this.physics.sy = Math.min(this.physics.sy + 0.02 * this.energy * this.cfg.squash, 1.05);
      this.physics.vy += 0.012 * this.energy;
    };
    this.onSubmit = (e) => {
      const field = e.target?.querySelector?.("textarea, input[type=text], input:not([type])");
      if (field && field.value.trim()) {
        this.react("surprised", 900, { jump: true });
        this.say("send", { chance: 0.5, cooldown: 30000, force: true });
      }
    };
    this.onWheel = (e) => {
      this.markActivity();
      this.nudge = { y: Math.sign(e.deltaY) * 0.6, until: performance.now() + 500 };
    };
    this.onActivity = () => this.markActivity();
    this.onVisibility = () => { if (!document.hidden) this.markActivity(); };
    this.onEnter = () => {
      this.hover = true;
      this.markActivity();
      this.say("hover", { chance: 0.5, cooldown: 25000 });
    };
    this.onLeave = () => { this.hover = false; };
    this.onClick = () => {
      const now = performance.now();
      this.clicks = this.clicks.filter((t) => now - t < 2200);
      this.clicks.push(now);
      if (this.clicks.length >= 5) {
        this.clicks = [];
        this.react("grumpy", 2600);
        this.squash(0.1);
        this.say("grumpy", { force: true, cooldown: 8000 });
      } else {
        this.react("laugh", 1200, { jump: true });
        this.say("poke", { chance: 0.4, cooldown: 6000 });
      }
    };

    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onActivity, { passive: true });
    window.addEventListener("wheel", this.onWheel, { passive: true });
    window.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("mouseout", this.onMouseOut);
    document.addEventListener("input", this.onInput, true);
    document.addEventListener("submit", this.onSubmit, true);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.root.addEventListener("pointerenter", this.onEnter);
    this.root.addEventListener("pointerleave", this.onLeave);
    this.root.addEventListener("click", this.onClick);
  }

  destroy() {
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    clearInterval(this.runTimer);
    clearInterval(this.typeTimer);
    clearTimeout(this.hideTimer);
    this.speechTimers.forEach(clearTimeout);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onActivity);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("mouseout", this.onMouseOut);
    document.removeEventListener("input", this.onInput, true);
    document.removeEventListener("submit", this.onSubmit, true);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.resizeObs?.disconnect();
    this.ioObs?.disconnect();
    if (this.root) {
      this.root.removeEventListener("pointerenter", this.onEnter);
      this.root.removeEventListener("pointerleave", this.onLeave);
      this.root.removeEventListener("click", this.onClick);
    }
    this.scene?.traverse((o) => o.geometry?.dispose());
    Object.values(this.mats || {}).forEach((m) => { m?.map?.dispose?.(); m?.dispose?.(); });
    this.dotTex?.dispose();
    this.glowTex?.dispose();
    this.envMap?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
  }
}

// ---------- public API (mirrors window.GeometricBot) ----------

let activeInstance = null;

let webglProbe = null;
function webglSupported() {
  if (webglProbe !== null) return webglProbe;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    webglProbe = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext(); // free the probe context right away
  } catch {
    webglProbe = false;
  }
  return webglProbe;
}

const LedBot = {
  DEFAULT_CONFIG,
  CONFIG_SCHEMA,
  EXPRESSIONS: Object.keys(EXPRESSIONS),
  isSupported: webglSupported,
  // Independent instance (the lab uses this).
  create(container, opts) {
    return new LedDomeBot(container, opts);
  },
  // Singleton mount, same semantics as GeometricBot.mount.
  mount(container, opts) {
    if (activeInstance && !activeInstance.destroyed && activeInstance.root) {
      if (container.contains(activeInstance.root)) return activeInstance;
      container.innerHTML = "";
      container.appendChild(activeInstance.root);
      activeInstance.container = container;
      return activeInstance;
    }
    if (activeInstance) activeInstance.destroy();
    if (!webglSupported()) return null;
    activeInstance = new LedDomeBot(container, opts);
    return activeInstance;
  },
  unmount() {
    activeInstance?.destroy();
    activeInstance = null;
  },
  getInstance() { return activeInstance; },
  setMood(mood, duration) { activeInstance?.setMood(mood, duration); },
  react(expr, ms = 2000) { activeInstance?.react(expr, ms, { jump: expr === "laugh" || expr === "surprised" }); },
  celebrate() { activeInstance?.celebrate(); },
  saySomething() { return activeInstance?.saySomething(); },
  defeat(ms) { activeInstance?.defeat(ms); },
  lookAt(x, y, ms) { activeInstance?.lookAt(x, y, ms); },
  setShape(idx) { activeInstance?.setShape(idx); },
  cycleNext() { activeInstance?.cycleNext(); },
  getModes() {
    const colors = (activeInstance?.cfg || DEFAULT_CONFIG).modeColors;
    return MODES.map((m, index) => ({ index, name: m.name, modeKey: m.id, modeTitle: m.modeTitle, badgeText: m.badgeText, colorHex: parseInt(colors[index].slice(1), 16) }));
  },
  getCurrentMode() {
    const idx = activeInstance ? activeInstance.palIdx : 0;
    return { index: idx, ...MODES[idx] };
  },
};

window.LedBot = LedBot;
window.dispatchEvent(new Event("ledbot-ready"));
export default LedBot;
