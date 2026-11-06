// Expressive Co-Founder Bot — a living 2D character drawn on canvas.
//
// The face is parametric: every expression is a set of numbers (eye size,
// lids, brows, mouth curve/openness, blush, body colour...) and the bot
// eases between them, so it never snaps from face to face.
//
// Eyes are never parked: the whole face drifts across the sphere toward
// whatever the bot is looking at — the pointer, the text caret while you
// type, a scan pattern while an agent works, or random glances when idle.
//
// What it reacts to:
//   pointer      eyes chase it; hover = delighted, cross-eyed up close;
//                click = giggle, click spam = grumpy, fast shaking = dizzy
//   typing       curious face, eyes follow the caret, little hop per key;
//                lots of backspacing = "oops"
//   send         surprised "oh!" when any message form is submitted
//   agent runs   blue thinking face while a run is going, purple laugh on
//                success, yellow grumpy on failure (watches app state.runs)
//   idle         drowsy after 30s, asleep with floating z's after 45s,
//                startled awake by any activity
//
// Colour follows the mood: orange happy, blue thinking/surprised/sad,
// purple laughing/dizzy, yellow grumpy.

(function () {
  let activeInstance = null;

  // Body = two blurred discs, as designed in Figma: a saturated outer disc
  // and a pale inner glow. Orange is the exact Figma spec; the other three
  // were picked from the reference render.
  const CHARACTERS = [
    {
      id: "ready",
      name: "Ready",
      modeTitle: "Ready & Friendly",
      badgeText: "✦ Ready",
      colorHex: 0xff6404,
      accentGlow: "rgba(255, 100, 4, 0.40)",
      body: { outer: "#ff6404", inner: "#feceb0", innerOffset: { x: 0, y: -51 } },
    },
    {
      id: "thinking",
      name: "Thinking",
      modeTitle: "Thinking & Working",
      badgeText: "⚡ Thinking",
      colorHex: 0x0c86ff,
      accentGlow: "rgba(12, 134, 255, 0.40)",
      body: { outer: "#0c86ff", inner: "#c4e7ff", innerOffset: { x: 28, y: -8 } },
    },
    {
      id: "celebrate",
      name: "Celebrate",
      modeTitle: "Goal Done & Celebrating",
      badgeText: "🎉 Celebrate",
      colorHex: 0x7069e3,
      accentGlow: "rgba(112, 105, 227, 0.42)",
      body: { outer: "#7069e3", inner: "#b7bdff", innerOffset: { x: 0, y: -40 } },
    },
    {
      id: "review",
      name: "Review",
      modeTitle: "Attention & Review",
      badgeText: "⚠️ Review",
      colorHex: 0xe5ce00,
      accentGlow: "rgba(229, 206, 0, 0.40)",
      body: { outer: "#e5ce00", inner: "#fbf8e6", innerOffset: { x: -6, y: -34 } },
    },
  ];

  // ---------- body sprites (rendered once, blended per frame) ----------

  // The face is designed on an 800-unit square; the canvas is 1200 so the
  // heavy bottom blur has room to fade out (CSS oversizes the canvas to match).
  const SPRITE = 1200;
  const CANVAS_OVERSIZE = SPRITE / 800;
  const R = 310; // outer disc radius
  // Figma: outer disc 1985px with progressive blur (top -> bottom), inner disc
  // 1313px with uniform blur, centred 164px above the outer's centre. Values
  // below are in Figma units (the original spec was 25 -> 100 and 220.4,
  // boosted for a softer look). Figma's blur value is ~2x a CSS blur radius.
  const FIG = (2 * R) / 1985;
  const INNER_R = (1313 / 2) * FIG;
  const OUTER_BLUR_TOP = (70 * FIG) / 2;
  const OUTER_BLUR_BOTTOM = (460 * FIG) / 2;
  const INNER_BLUR = (440 * FIG) / 2;

  // Dotty grain over the body: fine light and dark specks.
  const GRAIN_DOTS = 3500;

  const makeCanvas = () => {
    const c = document.createElement("canvas");
    c.width = c.height = SPRITE;
    return c;
  };

  // ctx.filter isn't supported everywhere (older Safari) — test that it blurs.
  function canvasBlurWorks() {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 20;
      const x = c.getContext("2d");
      x.filter = "blur(4px)";
      x.fillRect(8, 8, 4, 4);
      return x.getImageData(3, 10, 1, 1).data[3] > 0;
    } catch {
      return false;
    }
  }

  function disc(color, r, blur) {
    const c = makeCanvas();
    const x = c.getContext("2d");
    if (blur) x.filter = `blur(${blur}px)`;
    x.fillStyle = color;
    x.beginPath();
    x.arc(SPRITE / 2, SPRITE / 2, r, 0, Math.PI * 2);
    x.fill();
    return c;
  }

  // Fallback when ctx.filter is unavailable: a feathered radial gradient.
  function softDisc(color, r, soft) {
    const c = makeCanvas();
    const x = c.getContext("2d");
    const [cr, cg, cb] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    const g = x.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, r + soft);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
    g.addColorStop(Math.max(0, (r - soft) / (r + soft)), `rgba(${cr},${cg},${cb},1)`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    x.fillStyle = g;
    x.fillRect(0, 0, SPRITE, SPRITE);
    return c;
  }

  // Progressive blur = lightly blurred disc faded into a heavily blurred one, top to bottom.
  function outerSprite(color, blurOk) {
    if (!blurOk) return softDisc(color, R, OUTER_BLUR_BOTTOM * 2);
    const top = disc(color, R, OUTER_BLUR_TOP);
    const bottom = disc(color, R, OUTER_BLUR_BOTTOM);
    // The blur only starts building below the upper third, so the top edge
    // stays crisp and the bottom melts away.
    const mask = (c, from, to) => {
      const x = c.getContext("2d");
      x.globalCompositeOperation = "destination-in";
      const g = x.createLinearGradient(0, SPRITE / 2 - R, 0, SPRITE / 2 + R);
      g.addColorStop(0, `rgba(0,0,0,${from})`);
      g.addColorStop(0.3, `rgba(0,0,0,${from})`);
      g.addColorStop(1, `rgba(0,0,0,${to})`);
      x.fillStyle = g;
      x.fillRect(0, 0, SPRITE, SPRITE);
    };
    mask(top, 1, 0);
    mask(bottom, 0, 1);
    const out = makeCanvas();
    const o = out.getContext("2d");
    o.drawImage(top, 0, 0);
    o.globalCompositeOperation = "lighter"; // premultiplied sum = exact cross-fade
    o.drawImage(bottom, 0, 0);
    return out;
  }

  function grainSprite() {
    const c = makeCanvas();
    const x = c.getContext("2d");
    const reach = R + 200; // covers the blurred fringe too
    for (let i = 0; i < GRAIN_DOTS; i++) {
      // uniform over the disc
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * reach;
      const light = Math.random() < 0.55;
      x.fillStyle = light
        ? `rgba(255, 255, 255, ${0.07 + Math.random() * 0.1})`
        : `rgba(0, 0, 0, ${0.03 + Math.random() * 0.05})`;
      x.beginPath();
      x.arc(SPRITE / 2 + Math.cos(a) * d, SPRITE / 2 + Math.sin(a) * d, 1.3 + Math.random() * 1.2, 0, Math.PI * 2);
      x.fill();
    }
    return c;
  }

  let GRAIN = null;
  let SPRITES = null;
  function sprites() {
    if (!SPRITES) {
      const blurOk = canvasBlurWorks();
      SPRITES = CHARACTERS.map((c) => ({
        outer: outerSprite(c.body.outer, blurOk),
        inner: blurOk ? disc(c.body.inner, INNER_R, INNER_BLUR) : softDisc(c.body.inner, INNER_R * 0.75, INNER_R * 0.5),
      }));
    }
    return SPRITES;
  }

  // Neutral face; each expression overrides only what it changes.
  const BASE = {
    pal: 0,
    eyeOpen: 1, eyeScale: 1, lid: 0, lidTilt: 0, pupilFlat: 0,
    capsule: 1, chevron: 0, arc: 0, arcDir: 1, spiral: 0,
    brow: 0, browAngle: 0, browLift: 0, browAsym: 0,
    mouthLine: 1, mouthCurve: 0.5, mouthOpen: 0, mouthWidth: 62, mouthDX: 26,
    mouthO: 0, mouthOR: 34, squiggle: 0, wobble: 0,
    blush: 0.12,
  };
  const EXPRESSIONS = {
    happy: {},
    curious: { eyeScale: 1.08, eyeOpen: 1.06, mouthLine: 0.3, mouthCurve: 0.3, mouthWidth: 40, mouthDX: 0, mouthO: 0.75, mouthOR: 16, brow: 0.55, browAngle: -0.18, browLift: 14, browAsym: 0.45 },
    delighted: { eyeScale: 1.1, eyeOpen: 1.05, mouthCurve: 0.75, mouthOpen: 0.42, mouthWidth: 72, mouthDX: 8, blush: 0.65 },
    thinking: { pal: 1, eyeOpen: 0.96, mouthLine: 0, mouthO: 1, mouthOR: 34, mouthDX: 0, blush: 0 },
    surprised: { pal: 1, eyeScale: 1.14, eyeOpen: 1.08, mouthLine: 0, mouthO: 1, mouthOR: 26, mouthDX: 0, brow: 0.9, browAngle: -0.22, browLift: 4, blush: 0 },
    sad: { pal: 1, eyeOpen: 0.92, lid: 0.22, lidTilt: -1, brow: 1, browAngle: -0.42, browLift: 6, mouthCurve: -0.5, mouthWidth: 48, mouthDX: 0, blush: 0 },
    laugh: { pal: 2, capsule: 0, chevron: 1, mouthCurve: 0.12, mouthOpen: 1, mouthWidth: 74, mouthDX: 0, blush: 0.4 },
    dizzy: { pal: 2, capsule: 0, spiral: 1, mouthLine: 0, wobble: 1, mouthDX: 0, blush: 0.1 },
    grumpy: { pal: 3, eyeOpen: 0.75, lid: 0.4, lidTilt: 0.6, pupilFlat: 1, brow: 1, browAngle: 0.42, browLift: -4, mouthLine: 0, squiggle: 1, blush: 0 },
    oops: { pal: 3, eyeOpen: 1.02, brow: 0.9, browAngle: -0.3, browLift: 12, mouthCurve: -0.22, mouthWidth: 40, mouthDX: 0, blush: 0 },
    drowsy: { lid: 0.62, eyeOpen: 0.9, mouthCurve: 0.08, mouthWidth: 30, mouthDX: 0, blush: 0.05 },
    asleep: { capsule: 0, arc: 1, arcDir: -1, mouthLine: 0, mouthO: 0.55, mouthOR: 12, mouthDX: 0, blush: 0.2 },
  };
  const DISCRETE = new Set(["pal", "arcDir"]);
  const SHAPE_EXPRESSIONS = ["happy", "thinking", "laugh", "grumpy"]; // mode pills 0..3

  const DROWSY_MS = 30000;
  const SLEEP_MS = 45000;
  const INK = "#141414";
  const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const ENERGY = REDUCED ? 0.4 : 1;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // Frame-rate independent smoothing factor (k is tuned for 60fps).
  const ease = (k, dt) => 1 - Math.pow(1 - k, dt / 16.67);

  class ExpressiveBot {
    constructor(container) {
      const now = performance.now();
      this.container = container;
      this.destroyed = false;
      this.rafId = 0;

      this.p = { ...BASE };
      this.target = { ...BASE };
      this.expr = "happy";
      this.palIdx = 0;
      this.palW = [1, 0, 0, 0];
      this.override = null; // { expr, until } — timed reactions
      this.gazeOverride = null; // { x, y, until } — lookAt()
      this.nudge = null; // { y, until } — scroll glance

      this.gaze = { x: 0, y: 0 };
      this.face = { x: 0, y: 0 };
      this.pupil = { x: 0, y: 0 };
      this.conv = 0; // cross-eyed amount when the pointer is right on the bot
      this.sacc = { x: 0, y: 0, next: 0 };
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

      this.blink = { scale: 1, phase: "open", next: now + 2200, again: false };
      this.physics = { y: 0, vy: 0, sx: 1, sy: 1, vsx: 0, vsy: 0, tilt: 0 };
      this.zs = [];
      this.nextZ = 0;
      this.lastFrame = now;
      this.nextFidget = now + 8000;

      this.initDOM();
      this.bindEvents();
      this.syncAmbientGlow(0);
      this.react("delighted", 1400, { jump: true }); // hello!

      this.runTimer = setInterval(() => this.watchRuns(), 1000);
      this.loop = this.loop.bind(this);
      this.rafId = requestAnimationFrame(this.loop);
    }

    initDOM() {
      this.container.innerHTML = `
        <div class="metallic-bot-root geometric-bot-root" id="metallic-bot-root" role="button" aria-label="CEO Agent Expressive Co-Founder Bot" style="cursor: pointer;">
          <canvas class="metallic-bot-canvas geometric-bot-canvas" width="${SPRITE}" height="${SPRITE}" style="inset: ${(-(CANVAS_OVERSIZE - 1) / 2) * 100}%; width: ${CANVAS_OVERSIZE * 100}%; height: ${CANVAS_OVERSIZE * 100}%;"></canvas>
        </div>
      `;
      this.root = this.container.querySelector(".metallic-bot-root");
      this.canvas = this.container.querySelector(".metallic-bot-canvas");
      this.ctx = this.canvas.getContext("2d");
    }

    syncAmbientGlow(idx) {
      const char = CHARACTERS[idx] || CHARACTERS[0];
      const hexStr = "#" + char.colorHex.toString(16).padStart(6, "0");
      document.documentElement.style.setProperty("--bot-accent-color", hexStr);
      document.documentElement.style.setProperty("--bot-accent-glow", char.accentGlow);

      const lf = window.LaserFlow?.getInstance?.();
      if (lf && typeof lf.setAccentColor === "function") {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(char.body.outer.slice(i, i + 2), 16) / 255);
        lf.setAccentColor(r, g, b);
      }

      window.dispatchEvent(new CustomEvent("ceo-bot-mode-change", {
        detail: { index: idx, character: char, modeKey: char.id, modeTitle: char.modeTitle, badgeText: char.badgeText },
      }));
    }

    // ---------- reactions ----------

    react(expr, ms, opts = {}) {
      if (this.destroyed || !EXPRESSIONS[expr]) return;
      const now = performance.now();
      this.override = { expr, until: now + ms, start: now, fidget: !!opts.fidget };
      if (opts.jump) this.jump();
    }

    jump(vy = -12, stretch = 1.22) {
      this.physics.vy = vy * ENERGY;
      this.physics.sy = 1 + (stretch - 1) * ENERGY;
      this.physics.sx = 1 - (stretch - 1) * ENERGY;
    }

    squash(amount = 0.12) {
      this.physics.sy = 1 - amount * ENERGY;
      this.physics.sx = 1 + amount * ENERGY;
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
    }

    defeat(ms = 2600) {
      this.react("sad", ms);
      this.squash(0.15);
    }

    // x, y roughly -0.45..0.45 with +y up (kept from the old 3D bot's API).
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

    markActivity() {
      const now = performance.now();
      if (this.sleepStage !== "awake") {
        // Startled awake
        this.sleepStage = "awake";
        this.react("surprised", 1000);
        this.jump(-14, 1.25);
        this.blinkNow();
      }
      this.lastActivity = now;
    }

    blinkNow() {
      if (this.blink.phase === "open") this.blink.phase = "closing";
    }

    // Watches the app's run list: running → thinking, finished → laugh / grumpy.
    watchRuns() {
      if (typeof state === "undefined" || !state) return;
      const runs = [...(state.runs || [])];
      if (state.openRun?.id) runs.push(state.openRun);
      const recent = Date.now() - 3 * 3600 * 1000; // ignore stale/orphaned "running" rows
      let running = 0;
      const seen = new Set();
      for (const r of runs) {
        if (!r?.id || seen.has(r.id)) continue;
        seen.add(r.id);
        const prev = this.runStatus.get(r.id);
        if (r.status === "running" && new Date(r.createdAt).getTime() > recent) running++;
        if (this.runsPrimed && prev === "running" && r.status !== "running") {
          if (r.status === "success") this.react("laugh", 3500, { jump: true });
          else this.react("grumpy", 3800, { jump: true });
        }
        this.runStatus.set(r.id, r.status);
      }
      this.runningCount = running;
      this.runsPrimed = true;
    }

    // ---------- per-frame update ----------

    resolveExpression(now) {
      const idle = now - this.lastActivity;
      const busy = this.runningCount > 0 || now - this.lastType < 4000 || this.hover;
      this.sleepStage = busy ? "awake" : idle > SLEEP_MS ? "asleep" : idle > DROWSY_MS ? "drowsy" : "awake";

      // A spontaneous idle face gives way the moment the user does anything.
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

    // Idle personality: every so often it pulls a face on its own, so its
    // other moods and colours show up even when nobody is interacting.
    fidget(now) {
      const r = Math.random();
      const [expr, ms] = r < 0.3 ? ["curious", 1500] : r < 0.55 ? ["surprised", 1000] : r < 0.8 ? ["laugh", 1400] : ["oops", 1300];
      this.nextFidget = now + (12000 + Math.random() * 12000) / ENERGY;
      this.react(expr, ms, { jump: expr === "laugh" || expr === "surprised", fidget: true });
      return expr;
    }

    applyExpression(expr) {
      this.expr = expr;
      this.target = { ...BASE, ...EXPRESSIONS[expr] };
      if (this.target.pal !== this.palIdx) {
        this.palIdx = this.target.pal;
        this.syncAmbientGlow(this.palIdx);
      }
      if (this.target.capsule > 0.5 && expr !== "drowsy") this.blinkNow();
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
      const cy = rect.top + rect.height / 2;
      const size = rect.width || 280;
      const toGaze = (x, y, scale) => ({ x: Math.tanh((x - cx) / scale), y: Math.tanh((y - cy) / scale) });

      let g = { x: 0, y: 0 };
      let conv = 0;
      if (this.gazeOverride && now < this.gazeOverride.until) {
        g = this.gazeOverride;
      } else if (this.expr === "asleep") {
        g = { x: 0, y: 0.35 };
      } else if (this.expr === "dizzy") {
        g = { x: Math.sin(now * 0.01) * 0.6, y: Math.cos(now * 0.01) * 0.4 };
      } else if (now - this.lastType < 1800 && this.typeEl?.isConnected) {
        const pt = this.caretPoint(this.typeEl);
        g = toGaze(pt.x, pt.y, size * 1.2);
      } else if (now - this.pointer.last < 2200) {
        g = toGaze(this.pointer.x, this.pointer.y, size * 0.9);
        if (this.hover) conv = 1 - clamp(Math.hypot(this.pointer.x - cx, this.pointer.y - cy) / (size * 0.5), 0, 1);
      } else if (this.expr === "thinking") {
        // Scanning the problem space, glancing up now and then
        g = { x: Math.sin(now * 0.0021) * 0.7, y: -0.35 + Math.sin(now * 0.0013) * 0.18 };
      } else {
        if (now >= this.wander.next) {
          const quick = Math.random() < 0.28;
          const ang = Math.random() * Math.PI * 2;
          const rad = 0.35 + Math.random() * 0.65;
          this.wander.x = Math.cos(ang) * rad;
          this.wander.y = Math.sin(ang) * rad * 0.85;
          if (Math.random() < 0.18) { this.wander.x = 0; this.wander.y = 0; } // look at you
          this.wander.next = now + (quick ? 260 + Math.random() * 260 : (1000 + Math.random() * 1700) / ENERGY);
        }
        g = this.wander;
      }
      if (this.nudge && now < this.nudge.until) g = { x: g.x, y: clamp(g.y + this.nudge.y, -1, 1) };

      this.gaze.x += (g.x - this.gaze.x) * ease(0.3, dt);
      this.gaze.y += (g.y - this.gaze.y) * ease(0.3, dt);
      this.conv += (conv - this.conv) * ease(0.15, dt);

      // Face drifts across the sphere toward the gaze, plus a slow living sway.
      const drift = this.expr === "asleep" ? 0 : ENERGY;
      let fx = this.gaze.x * 100 + (Math.sin(now * 0.0011) * 8 + Math.sin(now * 0.0017 + 1) * 5) * drift;
      let fy = this.gaze.y * 72 + (Math.sin(now * 0.0013 + 2) * 6) * drift;
      const e = Math.hypot(fx / 108, fy / 78);
      if (e > 1) { fx /= e; fy /= e; }
      this.face.x += (fx - this.face.x) * ease(0.1, dt);
      this.face.y += (fy - this.face.y) * ease(0.1, dt);

      // Pupils lead the face, with tiny saccades so they never look frozen.
      if (now >= this.sacc.next) {
        this.sacc.x = (Math.random() - 0.5) * 6;
        this.sacc.y = (Math.random() - 0.5) * 8;
        this.sacc.next = now + 400 + Math.random() * 900;
      }
      const px = this.gaze.x * 14 + this.sacc.x;
      const py = this.gaze.y * 48 + this.sacc.y;
      this.pupil.x += (px - this.pupil.x) * ease(0.32, dt);
      this.pupil.y += (py - this.pupil.y) * ease(0.32, dt);
    }

    updateBlink(now, dt) {
      const b = this.blink;
      const canBlink = this.p.capsule > 0.5 && this.expr !== "asleep";
      if (b.phase === "open") {
        b.scale += (1 - b.scale) * ease(0.3, dt);
        if (canBlink && now >= b.next) b.phase = "closing";
      } else if (b.phase === "closing") {
        b.scale += (0.05 - b.scale) * ease(this.expr === "drowsy" ? 0.12 : 0.45, dt);
        if (b.scale < 0.12) b.phase = "opening";
      } else {
        b.scale += (1 - b.scale) * ease(this.expr === "drowsy" ? 0.08 : 0.4, dt);
        if (b.scale > 0.95) {
          b.phase = "open";
          if (b.again) { b.again = false; b.next = now + 130; }
          else { b.again = Math.random() < 0.2; b.next = now + (2200 + Math.random() * 3000) * (this.expr === "drowsy" ? 0.6 : 1); }
        }
      }
    }

    updatePhysics(now) {
      const ph = this.physics;
      const asleep = this.expr === "asleep";
      const thinking = this.expr === "thinking";
      const freq = asleep ? 0.0011 : thinking ? 0.004 : 0.0024;
      const amp = (asleep ? 4 : thinking ? 6 : 8) * ENERGY;
      const breath = Math.sin(now * (asleep ? 0.0011 : 0.0018)) * (asleep ? 0.03 : 0.015);
      let floatY = Math.sin(now * freq) * amp;
      if (this.expr === "laugh") floatY += Math.sin(now * 0.035) * 4 * ENERGY; // shaking with laughter

      ph.vsx = (ph.vsx + (1 - breath - ph.sx) * 0.14) * 0.78;
      ph.vsy = (ph.vsy + (1 + breath - ph.sy) * 0.14) * 0.78;
      ph.sx += ph.vsx;
      ph.sy += ph.vsy;
      ph.vy = (ph.vy + (floatY - ph.y) * 0.12) * 0.76;
      ph.y += ph.vy;

      let tilt = (this.face.x / 100) * 0.07;
      if (this.expr === "dizzy") tilt += Math.sin(now * 0.011) * 0.14 * ENERGY;
      if (this.expr === "asleep") tilt += 0.06;
      ph.tilt += (tilt - ph.tilt) * 0.08;
    }

    update(now, dt) {
      const expr = this.resolveExpression(now);
      if (expr !== this.expr) this.applyExpression(expr);

      const k = ease(0.16, dt);
      for (const key in this.target) {
        if (DISCRETE.has(key)) this.p[key] = this.target[key];
        else this.p[key] += (this.target[key] - this.p[key]) * k;
      }
      const kp = ease(0.07, dt);
      for (let i = 0; i < 4; i++) this.palW[i] += ((i === this.palIdx ? 1 : 0) - this.palW[i]) * kp;

      this.updateGaze(now, dt);
      this.updateBlink(now, dt);
      this.updatePhysics(now);

      if (this.expr === "asleep" && now >= this.nextZ) {
        this.zs.push({ born: now, x0: 140 + Math.random() * 30 });
        this.nextZ = now + 1100;
      }
      this.zs = this.zs.filter((z) => now - z.born < 2600);
    }

    // ---------- drawing ----------

    // Outer + inner blurred discs. A single palette draws its sprites directly;
    // mid-transition palettes are summed with "lighter" (an exact cross-fade).
    // The inner glow slides with the face, so the light shifts as it looks around.
    drawBody(ctx) {
      const sp = sprites();
      const ix = this.face.x * 0.3;
      const iy = this.face.y * 0.3;
      const active = [];
      let wsum = 0;
      this.palW.forEach((w, i) => { if (w > 0.004) { active.push([w, i]); wsum += w; } });
      const innerAt = (x, i, dx = 0) => {
        const o = CHARACTERS[i].body.innerOffset;
        x.drawImage(sp[i].inner, dx + o.x + ix, dx + o.y + iy);
      };
      if (active.length === 1) {
        const i = active[0][1];
        ctx.drawImage(sp[i].outer, -SPRITE / 2, -SPRITE / 2);
        innerAt(ctx, i, -SPRITE / 2);
        return;
      }
      this.bodyCanvas = this.bodyCanvas || makeCanvas();
      this.innerCanvas = this.innerCanvas || makeCanvas();
      const b = this.bodyCanvas.getContext("2d");
      const n = this.innerCanvas.getContext("2d");
      for (const x of [b, n]) {
        x.globalCompositeOperation = "source-over";
        x.globalAlpha = 1;
        x.clearRect(0, 0, SPRITE, SPRITE);
        x.globalCompositeOperation = "lighter";
      }
      for (const [w, i] of active) {
        b.globalAlpha = n.globalAlpha = w / wsum;
        b.drawImage(sp[i].outer, 0, 0);
        innerAt(n, i);
      }
      b.globalCompositeOperation = "source-over";
      b.globalAlpha = 1;
      b.drawImage(this.innerCanvas, 0, 0);
      ctx.drawImage(this.bodyCanvas, -SPRITE / 2, -SPRITE / 2);
    }

    capsulePath(ctx, cx, cy, w, h) {
      const r = Math.min(w, h) / 2;
      ctx.beginPath();
      ctx.moveTo(cx - w / 2 + r, cy - h / 2);
      ctx.arcTo(cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, r);
      ctx.arcTo(cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2, r);
      ctx.arcTo(cx - w / 2, cy + h / 2, cx - w / 2, cy - h / 2, r);
      ctx.arcTo(cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, r);
      ctx.closePath();
    }

    // side: -1 left eye, +1 right eye
    drawEye(ctx, side, cx, cy, k, now) {
      const p = this.p;
      const ew = 96 * p.eyeScale * k;
      const fullH = 200 * p.eyeScale * k * p.eyeOpen;
      const eh = Math.max(6, fullH * this.blink.scale);
      const innerX = cx - side * ew / 2;
      const outerX = cx + side * ew / 2;

      if (p.capsule > 0.01) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.capsule);
        const lidY = cy - eh / 2 + p.lid * eh;
        const tilt = p.lidTilt * 22 * Math.min(1, p.lid * 3);
        if (p.lid > 0.01) {
          ctx.beginPath();
          ctx.moveTo(outerX, lidY - tilt);
          ctx.lineTo(innerX, lidY + tilt);
          ctx.lineTo(innerX, cy + eh);
          ctx.lineTo(outerX, cy + eh);
          ctx.closePath();
          ctx.clip();
        }
        this.capsulePath(ctx, cx, cy, ew, eh);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.clip();

        const pr = 30 * p.eyeScale * k;
        const px = cx + this.pupil.x * k - side * this.conv * 10;
        const py = cy + clamp(26 + this.pupil.y, -58, 66) * (fullH / 200);
        ctx.fillStyle = INK;
        const flat = clamp(p.pupilFlat, 0, 1);
        ctx.beginPath();
        if (flat > 0.01) {
          // squashes toward a horizontal dash
          this.capsulePath(ctx, px, py, pr * (2 + 0.5 * flat), pr * (2 - 1.2 * flat));
        } else {
          ctx.arc(px, py, pr, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * (1 - flat)})`; // catchlight
        ctx.beginPath();
        ctx.arc(px - pr * 0.32, py - pr * 0.36, pr * 0.27, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

      }

      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (p.chevron > 0.01) { // > < laughing eyes, tips pointing inward
        const s = 58 * p.eyeScale * k;
        const dir = -side;
        ctx.globalAlpha = Math.min(1, p.chevron);
        ctx.lineWidth = 17;
        ctx.beginPath();
        ctx.moveTo(cx - dir * s * 0.5, cy - s * 0.6);
        ctx.lineTo(cx + dir * s * 0.5, cy);
        ctx.lineTo(cx - dir * s * 0.5, cy + s * 0.6);
        ctx.stroke();
      }
      if (p.arc > 0.01) { // closed eyes: ^ (arcDir 1) or ︶ (arcDir -1)
        ctx.globalAlpha = Math.min(1, p.arc);
        ctx.lineWidth = 12;
        ctx.beginPath();
        ctx.moveTo(cx - 40 * k, cy + p.arcDir * 12);
        ctx.quadraticCurveTo(cx, cy - p.arcDir * 40, cx + 40 * k, cy + p.arcDir * 12);
        ctx.stroke();
      }
      if (p.spiral > 0.01) {
        ctx.globalAlpha = Math.min(1, p.spiral);
        ctx.lineWidth = 9;
        ctx.translate(cx, cy);
        ctx.rotate(now * 0.008 * side);
        ctx.beginPath();
        for (let t = 0; t <= 1; t += 0.02) {
          const a = t * Math.PI * 6;
          const r = 4 + t * 46 * k;
          if (t === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.stroke();
      }
      ctx.restore();

      if (p.brow > 0.01) {
        const top = cy - fullH / 2;
        const by = top - 30 - p.browLift - (side === -1 ? p.browAsym * 16 : 0);
        const bInner = cx - side * 44 * k;
        const bOuter = cx + side * 44 * k;
        const yInner = by + p.browAngle * 55;
        const yOuter = by - p.browAngle * 20;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.brow);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 9;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(bOuter, yOuter);
        ctx.quadraticCurveTo(cx, Math.min(yInner, yOuter) - 12, bInner, yInner);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawMouth(ctx, mx, my, fxN, now) {
      const p = this.p;
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.fillStyle = INK;
      ctx.lineWidth = 9;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (p.mouthLine > 0.01) {
        const half = (p.mouthWidth / 2) * (1 - 0.15 * Math.abs(fxN));
        const curve = p.mouthCurve * 34;
        const open = clamp(p.mouthOpen, 0, 1);
        const path = () => {
          ctx.beginPath();
          ctx.moveTo(mx - half, my);
          ctx.quadraticCurveTo(mx, my + 2 * curve * (1 - open * 0.85), mx + half, my);
          if (open > 0.02) {
            ctx.quadraticCurveTo(mx, my + 2 * curve + open * 150, mx - half, my);
            ctx.closePath();
          }
        };
        ctx.globalAlpha = Math.min(1, p.mouthLine);
        path();
        if (open > 0.02) {
          ctx.save();
          ctx.globalAlpha *= Math.min(1, open * 5);
          ctx.fill();
          ctx.restore();
        }
        ctx.stroke();
        if (open > 0.4) { // tongue
          ctx.save();
          path();
          ctx.clip();
          ctx.globalAlpha *= Math.min(1, (open - 0.4) * 3);
          ctx.fillStyle = "#ff6f86";
          ctx.beginPath();
          ctx.ellipse(mx, my + curve + open * 74, half * 0.55, 22, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
      if (p.mouthO > 0.01) {
        const pulse = this.expr === "asleep" ? 0.18 * Math.sin(now * 0.002) : this.expr === "thinking" ? 0.08 * Math.sin(now * 0.007) : 0.03 * Math.sin(now * 0.006);
        ctx.globalAlpha = Math.min(1, p.mouthO);
        ctx.beginPath();
        ctx.arc(mx, my + 6, Math.max(4, p.mouthOR * (1 + pulse)), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (p.squiggle > 0.01) {
        ctx.globalAlpha = Math.min(1, p.squiggle);
        ctx.beginPath();
        ctx.moveTo(mx - 40, my + 8);
        ctx.bezierCurveTo(mx - 10, my + 28, mx + 25, my - 22, mx + 65, my - 12);
        ctx.stroke();
      }
      if (p.wobble > 0.01) {
        ctx.globalAlpha = Math.min(1, p.wobble);
        ctx.beginPath();
        for (let x = -34; x <= 34; x += 2) {
          const y = my + Math.sin(x * 0.25 + now * 0.012) * 6;
          if (x === -34) ctx.moveTo(mx + x, y);
          else ctx.lineTo(mx + x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    renderFrame(now) {
      const ctx = this.ctx;
      if (!ctx) return;
      const p = this.p;
      const ph = this.physics;
      ctx.clearRect(0, 0, SPRITE, SPRITE);

      ctx.save();
      ctx.translate(SPRITE / 2, SPRITE / 2 + ph.y);
      ctx.rotate(ph.tilt);
      ctx.scale(ph.sx, ph.sy);
      this.drawBody(ctx);
      GRAIN = GRAIN || grainSprite();
      ctx.globalCompositeOperation = "source-atop";
      ctx.drawImage(GRAIN, -SPRITE / 2, -SPRITE / 2);
      ctx.globalCompositeOperation = "source-over";

      // Face, foreshortened as it slides toward the rim
      const fx = this.face.x;
      const fy = this.face.y;
      const fxN = clamp(fx / 108, -1, 1);
      const sp = 62 * p.eyeScale * (1 - 0.12 * Math.abs(fxN));
      const eyeCY = fy - 72;
      const kL = 1 + 0.07 * fxN; // the eye nearer the rim looks smaller
      const kR = 1 - 0.07 * fxN;

      if (p.blush > 0.01) {
        for (const side of [-1, 1]) {
          ctx.save();
          ctx.translate(fx + side * (sp + 44), fy + 48);
          ctx.scale(1, 0.55);
          const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, 48);
          bg.addColorStop(0, `rgba(255, 105, 140, ${0.55 * p.blush})`);
          bg.addColorStop(1, "rgba(255, 105, 140, 0)");
          ctx.fillStyle = bg;
          ctx.beginPath();
          ctx.arc(0, 0, 48, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      this.drawEye(ctx, -1, fx - sp, eyeCY, kL, now);
      this.drawEye(ctx, 1, fx + sp, eyeCY, kR, now);
      this.drawMouth(ctx, fx + p.mouthDX * (1 - 0.3 * Math.abs(fxN)), fy + 78 + (p.eyeScale - 1) * 60, fxN, now);
      ctx.restore();

      // Floating z's while asleep
      if (this.zs.length) {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        ctx.save();
        ctx.textAlign = "center";
        for (const z of this.zs) {
          const age = (now - z.born) / 2600;
          ctx.globalAlpha = Math.sin(age * Math.PI);
          ctx.fillStyle = dark ? "#ffffff" : "#3a3a55";
          ctx.font = `800 ${Math.round(34 + age * 30)}px system-ui, sans-serif`;
          ctx.fillText("z", SPRITE / 2 + z.x0 + age * 90 + Math.sin(age * 6) * 10, SPRITE / 2 + ph.y - 230 - age * 160);
        }
        ctx.restore();
      }
    }

    loop() {
      if (this.destroyed) return;
      this.rafId = requestAnimationFrame(this.loop);
      const now = performance.now();
      const dt = clamp(now - this.lastFrame, 1, 64);
      this.lastFrame = now;
      if (!this.root || !this.root.isConnected) return;
      this.update(now, dt);
      this.renderFrame(now);
    }

    // ---------- input ----------

    bindEvents() {
      const isField = (t) => t && t.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, [contenteditable=''], [contenteditable='true']");

      this.onPointerMove = (e) => {
        const now = performance.now();
        const pt = this.pointer;
        pt.x = e.clientX;
        pt.y = e.clientY;
        pt.last = now;
        this.markActivity();

        // Shake detection: rapid left/right reversals → dizzy
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
          this.squash(0.1);
        }
      };

      this.onMouseOut = (e) => {
        if (!e.relatedTarget) this.pointer.last = 0; // left the window: look around
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
          }
        }
      };

      this.onInput = (e) => {
        if (!isField(e.target)) return;
        this.lastType = performance.now();
        this.typeEl = e.target;
        this.markActivity();
        this.physics.sy = Math.min(this.physics.sy + 0.03 * ENERGY, 1.08); // little hop per key
        this.physics.vy -= 1.5 * ENERGY;
      };

      this.onSubmit = (e) => {
        const field = e.target?.querySelector?.("textarea, input[type=text], input:not([type])");
        if (field && field.value.trim()) this.react("surprised", 900, { jump: true });
      };

      this.onWheel = (e) => {
        this.markActivity();
        this.nudge = { y: Math.sign(e.deltaY) * 0.6, until: performance.now() + 500 };
      };

      this.onActivity = () => this.markActivity();
      this.onVisibility = () => { if (!document.hidden) this.markActivity(); };

      this.onEnter = () => { this.hover = true; this.markActivity(); };
      this.onLeave = () => { this.hover = false; };
      this.onClick = () => {
        const now = performance.now();
        this.clicks = this.clicks.filter((t) => now - t < 2200);
        this.clicks.push(now);
        if (this.clicks.length >= 5) {
          this.clicks = [];
          this.react("grumpy", 2600); // "hey, stop poking me"
          this.squash(0.14);
        } else {
          this.react("laugh", 1200, { jump: true }); // giggle
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
      window.removeEventListener("pointermove", this.onPointerMove);
      window.removeEventListener("pointerdown", this.onActivity);
      window.removeEventListener("wheel", this.onWheel);
      window.removeEventListener("keydown", this.onKeyDown, true);
      document.removeEventListener("mouseout", this.onMouseOut);
      document.removeEventListener("input", this.onInput, true);
      document.removeEventListener("submit", this.onSubmit, true);
      document.removeEventListener("visibilitychange", this.onVisibility);
      if (this.root) {
        this.root.removeEventListener("pointerenter", this.onEnter);
        this.root.removeEventListener("pointerleave", this.onLeave);
        this.root.removeEventListener("click", this.onClick);
      }
    }
  }

  // Export as GeometricBot, and alias MetallicBot / FluffyBot for drop-in compatibility
  window.GeometricBot = {
    mount(container) {
      if (activeInstance && !activeInstance.destroyed && activeInstance.root) {
        if (container.contains(activeInstance.root)) return activeInstance;
        container.innerHTML = "";
        container.appendChild(activeInstance.root);
        activeInstance.container = container;
        return activeInstance;
      }
      if (activeInstance) activeInstance.destroy();
      activeInstance = new ExpressiveBot(container);
      return activeInstance;
    },
    getInstance() {
      return activeInstance;
    },
    setMood(mood, duration) {
      activeInstance?.setMood(mood, duration);
    },
    react(expr, ms = 2000) {
      activeInstance?.react(expr, ms, { jump: expr === "laugh" || expr === "surprised" });
    },
    celebrate() {
      activeInstance?.celebrate();
    },
    defeat(ms) {
      activeInstance?.defeat(ms);
    },
    lookAt(x, y, ms) {
      activeInstance?.lookAt(x, y, ms);
    },
    setShape(idx) {
      activeInstance?.setShape(idx);
    },
    cycleNext() {
      activeInstance?.cycleNext();
    },
    getModes() {
      return CHARACTERS.map((c, idx) => ({
        index: idx,
        name: c.name,
        modeKey: c.id,
        modeTitle: c.modeTitle,
        badgeText: c.badgeText,
        colorHex: c.colorHex,
      }));
    },
    getCurrentMode() {
      const idx = activeInstance ? activeInstance.palIdx : 0;
      return { index: idx, ...CHARACTERS[idx] };
    },
  };

  window.MetallicBot = window.GeometricBot;
  window.FluffyBot = window.GeometricBot;
})();
