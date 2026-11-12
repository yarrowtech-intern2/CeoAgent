// Bot Lab — side-by-side sandbox for the current GeometricBot and the new
// LED Dome bot: trigger every expression/event, tune the new design live,
// and export the tuned config.

import LedBot, { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./led-bot.js";

const STORE_KEY = "botlab.ledConfig";
const UI_KEY = "botlab.ui";
const $ = (s) => document.querySelector(s);

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode etc. — tuning just won't persist */
    }
  },
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1600);
}

// ---------- mount both bots ----------

const cur = window.GeometricBot?.mount($("#cur-slot")) || null;

let led = null;
const savedCfg = store.get(STORE_KEY, {});
if (LedBot.isSupported()) {
  led = LedBot.create($("#led-slot"), {
    globalSync: false, // keep the page-wide accent vars for the current bot
    config: savedCfg,
    speech: { tips: ["You can change my style from Settings. Try it!", "Psst… I come in two styles. Switch me in Settings!"] },
    onModeChange: ({ index, glow }) => {
      $("#card-led").style.setProperty("--halo", glow);
      document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === index));
    },
  });
  window.ledBot = led; // handy for poking from DevTools
} else {
  const note = $("#led-note");
  note.hidden = false;
  note.textContent = "WebGL isn't available in this browser, so the 3D bot can't render.";
}

// ---------- toolbar ----------

const ui = { theme: document.documentElement.getAttribute("data-theme"), size: "300", view: "both", halo: "on", target: "both", ...store.get(UI_KEY, {}) };

function segment(id, key, apply) {
  const seg = document.getElementById(id);
  const sync = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === ui[key]));
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    ui[key] = b.dataset.v;
    store.set(UI_KEY, ui);
    sync();
    apply(ui[key]);
  });
  sync();
  apply(ui[key]);
}

segment("theme-seg", "theme", (v) => {
  document.documentElement.setAttribute("data-theme", v);
  store.set("botlab.theme", v);
});
segment("size-seg", "size", (v) => $("#stage").style.setProperty("--bot-size-pick", `${v}px`));
segment("view-seg", "view", (v) => {
  $("#card-cur").hidden = v === "led";
  $("#card-led").hidden = v === "cur";
});
segment("halo-seg", "halo", (v) => $("#stage").classList.toggle("no-halo", v === "off"));
segment("target-seg", "target", () => {});

setInterval(() => {
  $("#fps").textContent = led ? `${led.fps} fps` : "– fps";
}, 500);

// ---------- mode pills ----------

const MODE_NAMES = ["Ready", "Thinking", "Celebrate", "Review"];
function renderModes() {
  const colors = led ? led.cfg.modeColors : DEFAULT_CONFIG.modeColors;
  const active = led ? led.palIdx : 0;
  $("#modes").innerHTML = MODE_NAMES.map(
    (n, i) => `<button type="button" class="mode${i === active ? " on" : ""}" data-i="${i}" style="--c:${colors[i]}"><i></i>${n}</button>`,
  ).join("");
}
renderModes();
$("#modes").addEventListener("click", (e) => {
  const b = e.target.closest(".mode");
  if (!b) return;
  each((bot) => bot.setShape(Number(b.dataset.i)));
});

// ---------- triggers ----------

// Runs fn on whichever bots the "Send to" switch selects.
function each(fn) {
  if (ui.target !== "led" && cur) fn(cur, "cur");
  if (ui.target !== "cur" && led) fn(led, "led");
}

$("#expr-btns").innerHTML = LedBot.EXPRESSIONS.map((x) => `<button class="btn" data-expr="${x}">${x}</button>`).join("");
$("#expr-btns").addEventListener("click", (e) => {
  const b = e.target.closest("[data-expr]");
  if (!b) return;
  const x = b.dataset.expr;
  each((bot) => bot.react(x, 3000, { jump: x === "laugh" || x === "surprised" || x === "love" }));
});

function forceIdle(bot, ms) {
  if (bot.forceIdle) return bot.forceIdle(ms);
  bot.lastActivity = performance.now() - ms;
  bot.hover = false;
  bot.lastType = 0;
  bot.pointer.last = 0;
  bot.override = null;
}

function updateRunStatus() {
  const r = window.state.runs.find((x) => x.status === "running");
  $("#run-status").textContent = r ? "Agent run in progress… (bots show 'thinking')" : "No run in progress.";
}

function autoType(text, done) {
  const input = $("#typer-input");
  input.focus();
  input.value = "";
  let i = 0;
  const tick = () => {
    if (i >= text.length) return done?.();
    input.value += text[i++];
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(tick, 55 + Math.random() * 60);
  };
  tick();
}

const ACTIONS = {
  "run-start"() {
    window.state.runs.unshift({ id: `lab-${Date.now()}`, status: "running", createdAt: new Date().toISOString() });
    updateRunStatus();
  },
  "run-ok"() {
    const r = window.state.runs.find((x) => x.status === "running");
    if (!r) return toast("Start a run first");
    r.status = "success";
    updateRunStatus();
  },
  "run-fail"() {
    const r = window.state.runs.find((x) => x.status === "running");
    if (!r) return toast("Start a run first");
    r.status = "error";
    updateRunStatus();
  },
  celebrate: () => each((b) => b.celebrate()),
  defeat: () => each((b) => b.defeat()),
  dizzy: () => each((b) => { b.react("dizzy", 2400); b.squash?.(0.1); }),
  poke() {
    const roots = [];
    each((b) => roots.push(b.root));
    for (let i = 0; i < 5; i++) setTimeout(() => roots.forEach((r) => r.dispatchEvent(new MouseEvent("click", { bubbles: true }))), i * 90);
  },
  type: () => autoType("Draft a launch plan for the Q3 pricing update"),
  backspace() {
    const input = $("#typer-input");
    if (!input.value) input.value = "Some text to delete again";
    input.focus();
    for (let i = 0; i < 8; i++) {
      setTimeout(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
        input.value = input.value.slice(0, -1);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, i * 70);
    }
  },
  submit() {
    const input = $("#typer-input");
    if (!input.value.trim()) input.value = "Ship it";
    $("#typer").requestSubmit();
  },
  drowsy: () => each((b) => forceIdle(b, 31000)),
  sleep: () => each((b) => forceIdle(b, 46000)),
  "look-l": () => each((b) => b.lookAt(-0.45, 0, 1600)),
  "look-r": () => each((b) => b.lookAt(0.45, 0, 1600)),
  "look-u": () => each((b) => b.lookAt(0, 0.3, 1600)),
  say: () => led?.saySomething(),
  tip: () => led?.sayTip(true),
};
document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => ACTIONS[b.dataset.act]()));
$("#typer").addEventListener("submit", (e) => {
  e.preventDefault();
  setTimeout(() => ($("#typer-input").value = ""), 50);
});

// ---------- tuning ----------

const GROUPS = CONFIG_SCHEMA;

const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v);

function controlHtml([key, label, a, b, c]) {
  const v = led ? led.cfg[key] : DEFAULT_CONFIG[key];
  const id = `cfg-${key}`;
  if (a === "color") return `<div class="row"><label for="${id}">${label}</label><input id="${id}" type="color" data-key="${key}" value="${v}"><output></output></div>`;
  if (a === "toggle") return `<div class="row"><label for="${id}">${label}</label><input id="${id}" type="checkbox" data-key="${key}" ${v ? "checked" : ""} style="justify-self:start"><output></output></div>`;
  if (a === "select") return `<div class="row"><label for="${id}">${label}</label><select id="${id}" data-key="${key}">${b.map(([val, l]) => `<option value="${val}" ${val === v ? "selected" : ""}>${l}</option>`).join("")}</select><output></output></div>`;
  return `<div class="row"><label for="${id}">${label}</label><input id="${id}" type="range" data-key="${key}" min="${a}" max="${b}" step="${c}" value="${v}"><output>${fmt(v)}</output></div>`;
}

function renderTuning() {
  $("#tune-groups").innerHTML = GROUPS.map(
    ([title, rows], i) => `<details ${i < 2 ? "open" : ""}><summary>${title}</summary><div class="sec">${rows.map(controlHtml).join("")}</div></details>`,
  ).join("");
  const colors = led ? led.cfg.modeColors : DEFAULT_CONFIG.modeColors;
  $("#colors").innerHTML = MODE_NAMES.map((n, i) => `<label>${n}<input type="color" data-mode="${i}" value="${colors[i]}"></label>`).join("");
}
renderTuning();

function diffConfig() {
  const cfg = led ? led.getConfig() : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (JSON.stringify(cfg[k]) !== JSON.stringify(DEFAULT_CONFIG[k])) out[k] = cfg[k];
  }
  return out;
}

function persist() {
  store.set(STORE_KEY, diffConfig());
}

$("#panel").addEventListener("input", (e) => {
  const el = e.target;
  if (!led) return;
  if (el.dataset.mode !== undefined) {
    const colors = [...led.cfg.modeColors];
    colors[Number(el.dataset.mode)] = el.value;
    led.setConfig({ modeColors: colors });
    renderModes();
    persist();
    return;
  }
  const key = el.dataset.key;
  if (!key) return;
  let v = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
  led.setConfig({ [key]: v });
  const out = el.parentElement.querySelector("output");
  if (out && el.type === "range") out.textContent = fmt(v);
  persist();
});
$("#panel").addEventListener("change", (e) => {
  if (e.target.tagName === "SELECT") e.target.dispatchEvent(new Event("input", { bubbles: true }));
});

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    const ta = $("#import");
    ta.value = text;
    ta.select();
    toast("Clipboard blocked: config placed in the box below");
  }
}
$("#copy-diff").addEventListener("click", () => copy(JSON.stringify(diffConfig(), null, 2), "Changes"));
$("#copy-full").addEventListener("click", () => copy(JSON.stringify(led ? led.getConfig() : DEFAULT_CONFIG, null, 2), "Full config"));
$("#reset").addEventListener("click", () => {
  if (!led) return;
  led.setConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  store.set(STORE_KEY, {});
  renderTuning();
  renderModes();
  toast("Reset to defaults");
});
$("#import-btn").addEventListener("click", () => {
  if (!led) return;
  try {
    const parsed = JSON.parse($("#import").value);
    const clean = {};
    for (const k of Object.keys(parsed)) if (k in DEFAULT_CONFIG) clean[k] = parsed[k];
    led.setConfig(clean);
    persist();
    renderTuning();
    renderModes();
    toast("Config applied");
  } catch {
    toast("That isn't valid JSON");
  }
});
