// LaserFlow — High-fidelity WebGL Energy Stream & Fiber Optic Flow Background
// Replicates the luminous sweeping energy strands from Relay.app and CEO Agent reference UI.
// Built with Three.js (ES module), 60 FPS GPU shaders, interactive mouse hover/parallax,
// diagonal Top-Right -> Bottom-Left cascade, and adaptive Dark & Light mode palettes.

import * as THREE from "../vendor/three/three.module.js";

// ---------- Color & Theme Palettes ----------

const THEMES = {
  dark: {
    isDark: 1.0,
    core: [0.85, 0.98, 0.62],      // #d9f99d (electric neon lime core)
    body: [0.29, 0.87, 0.50],      // #4ade80 (vibrant emerald green)
    outer: [0.08, 0.50, 0.24],     // #15803d (deep forest green)
    haloCore: [0.85, 0.98, 0.62],  // #d9f99d
    haloOuter: [0.13, 0.77, 0.37], // #22c55e
    haloIntensity: 0.0,            // Completely removed shadow/halo behind bot
    strandOpacity: 0.92,
    ribbonOpacity: 0.42,
    particleCore: [1.0, 1.0, 1.0], // #ffffff
    particleBody: [0.52, 0.94, 0.67], // #86efac
    particleOpacity: 0.88,
  },
  light: {
    isDark: 0.0,
    core: [0.85, 0.98, 0.62],      // #d9f99d (same green palette as dark mode)
    body: [0.29, 0.87, 0.50],      // #4ade80
    outer: [0.08, 0.50, 0.24],     // #15803d
    haloCore: [0.85, 0.98, 0.62],  // #d9f99d
    haloOuter: [0.13, 0.77, 0.37], // #22c55e
    haloIntensity: 0.0,            // Completely removed shadow/halo behind bot
    strandOpacity: 0.78,           // Crisp, vibrant green visibility against light background
    ribbonOpacity: 0.32,
    particleCore: [0.29, 0.87, 0.50], // #4ade80 (white would vanish on light bg)
    particleBody: [0.52, 0.94, 0.67], // #86efac
    particleOpacity: 0.72,
  },
};

// ---------- GLSL Shaders ----------

// 1. Fiber Strands Shaders
const STRAND_VERT = `
precision highp float;

uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uFocalOffset;

attribute float aProgress;
attribute float aLane;
attribute float aIntensity;
attribute float aApexDist;
attribute float aSeed;
attribute float aColorType; // 0.0 neon lime, 0.5 emerald, 1.0 deep forest green

varying float vProgress;
varying float vIntensity;
varying float vApexDist;
varying float vSeed;
varying float vColorType;
varying vec3 vWorldPos;

void main() {
  vProgress = aProgress;
  vIntensity = aIntensity;
  vApexDist = aApexDist;
  vSeed = aSeed;
  vColorType = aColorType;

  vec3 pos = position;

  // Align apex dynamically with .orbit-sphere position in viewport
  pos.xy += uFocalOffset * (1.0 - aApexDist * 0.75);

  // Gentle organic undulating current (sine harmonics)
  float freq = 3.6 + aSeed * 2.2;
  float speed = 1.8 + aSeed * 0.9;
  float wave = sin(aProgress * freq * 3.14159 - uTime * speed + aSeed * 6.28);
  pos.y += wave * 0.05 * (1.0 - aApexDist * 0.4);
  pos.z += wave * 0.03 * aLane;

  // Interactive Mouse Hover Reaction (accurate World Space distance)
  vec2 mDiff = pos.xy - uMouse;
  float mDist = length(mDiff);
  float mInfluence = smoothstep(2.0, 0.0, mDist);
  vec2 mDir = mDist > 0.001 ? normalize(mDiff) : vec2(0.0, 1.0);

  // Elastic displacement away from cursor + ripple lift
  pos.xy += mDir * (mInfluence * 0.42);
  pos.z += mInfluence * 0.30;

  vWorldPos = pos;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const STRAND_FRAG = `
precision highp float;

uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uColorCore;
uniform vec3 uColorBody;
uniform vec3 uColorOuter;
uniform float uGlobalOpacity;
uniform float uIsDark;

varying float vProgress;
varying float vIntensity;
varying float vApexDist;
varying float vSeed;
varying float vColorType;
varying vec3 vWorldPos;

void main() {
  // Fast traveling light pulses flowing from Top-Right down to Bottom-Left
  float pulseSpeed = 2.4 + vSeed * 0.8;
  float pulsePhase = vProgress * 22.0 - uTime * pulseSpeed + vSeed * 6.28;
  float pulse = pow(clamp(sin(pulsePhase) * 0.5 + 0.5, 0.0, 1.0), 3.8);

  // Intense focal luminescence at the apex waist (around sphere)
  float apexGlow = exp(-vApexDist * vApexDist * 10.0);

  // Edge dissolve at stream endpoints so lines never abruptly end
  float edgeFade = smoothstep(0.0, 0.12, vProgress) * (1.0 - smoothstep(0.88, 1.0, vProgress));

  // Dynamic brightness combination
  float brightness = (0.45 + 0.85 * pulse + 2.4 * apexGlow) * vIntensity * edgeFade;

  // Interactive mouse hover glow boost
  float mDist = length(vWorldPos.xy - uMouse);
  float hoverGlow = smoothstep(1.8, 0.0, mDist);
  brightness += hoverGlow * 0.85;

  // Harmonious greenish palette (same electric neon lime, vibrant emerald & deep forest green as dark mode):
  vec3 strandColor;
  if (vColorType < 0.35) {
    // Electric neon lime accent strand
    strandColor = mix(uColorBody, uColorCore, 0.35);
  } else if (vColorType < 0.70) {
    // Vibrant emerald strand
    strandColor = uColorBody;
  } else {
    // Deep forest green strand
    strandColor = mix(uColorBody, uColorOuter, 0.45);
  }

  vec3 col = mix(uColorOuter, strandColor, clamp(pulse * 0.45 + (1.0 - vApexDist), 0.0, 1.0));
  col = mix(col, uColorCore, apexGlow * 0.85 + hoverGlow * 0.4);

  float alpha = brightness * uGlobalOpacity;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

// 2. Volumetric Silk Ribbon Shaders
const RIBBON_VERT = `
precision highp float;

uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uFocalOffset;

attribute float aProgress;
attribute float aApexDist;
attribute float aSeed;
attribute float aSide; // -1.0 left edge, 1.0 right edge

varying float vProgress;
varying float vApexDist;
varying float vSide;
varying float vSeed;
varying vec3 vWorldPos;

void main() {
  vProgress = aProgress;
  vApexDist = aApexDist;
  vSide = aSide;
  vSeed = aSeed;

  vec3 pos = position;
  pos.xy += uFocalOffset * (1.0 - aApexDist * 0.75);

  // Subtle fluid wave
  float wave = sin(aProgress * 4.0 * 3.14159 - uTime * 1.5 + aSeed * 6.28);
  pos.y += wave * 0.04 * (1.0 - aApexDist * 0.3);

  // Mouse hover deflection in world space
  vec2 mDiff = pos.xy - uMouse;
  float mDist = length(mDiff);
  float mInfluence = smoothstep(2.0, 0.0, mDist);
  vec2 mDir = mDist > 0.001 ? normalize(mDiff) : vec2(0.0, 1.0);
  pos.xy += mDir * (mInfluence * 0.35);

  vWorldPos = pos;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const RIBBON_FRAG = `
precision highp float;

uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uColorCore;
uniform vec3 uColorBody;
uniform vec3 uColorOuter;
uniform float uRibbonOpacity;
uniform float uIsDark;

varying float vProgress;
varying float vApexDist;
varying float vSide;
varying float vSeed;
varying vec3 vWorldPos;

void main() {
  // Soft cosine cross-section across ribbon width (soft velvety light tube)
  float crossSection = cos(vSide * 1.5707963);
  crossSection = pow(clamp(crossSection, 0.0, 1.0), 1.8);

  // Traveling wave pulse
  float pulse = pow(clamp(sin(vProgress * 14.0 - uTime * 2.2 + vSeed * 6.28) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  float apexGlow = exp(-vApexDist * vApexDist * 8.0);
  float edgeFade = smoothstep(0.0, 0.16, vProgress) * (1.0 - smoothstep(0.84, 1.0, vProgress));

  float mDist = length(vWorldPos.xy - uMouse);
  float hoverGlow = smoothstep(1.8, 0.0, mDist);

  vec3 col = mix(uColorOuter, uColorBody, 0.5 + 0.5 * pulse);
  col = mix(col, uColorCore, apexGlow * 0.75 + hoverGlow * 0.4);

  float alpha = crossSection * (0.35 + 0.65 * apexGlow + 0.35 * pulse + hoverGlow * 0.4) * edgeFade * uRibbonOpacity;

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

// 3. Focal Halo Bloom Shaders
const HALO_VERT = `
precision highp float;
uniform vec2 uFocalOffset;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 pos = position;
  pos.xy += uFocalOffset;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const HALO_FRAG = `
precision highp float;
uniform vec3 uHaloCore;
uniform vec3 uHaloOuter;
uniform float uHaloIntensity;
uniform float uIsDark;
varying vec2 vUv;

void main() {
  vec2 center = vec2(0.5);
  float dist = length(vUv - center) * 2.0;
  if (dist > 1.0) discard;

  // Luminous exponential Gaussian falloff
  float coreGlow = exp(-dist * dist * 10.0);
  float wideGlow = exp(-dist * 2.8);
  float glow = coreGlow * 0.80 + wideGlow * 0.40;

  vec3 col = mix(uHaloOuter, uHaloCore, coreGlow);
  float alpha = clamp(glow * uHaloIntensity, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
}
`;

// 4. Floating Bokeh & Dust Particles Shaders
const PARTICLE_VERT = `
precision highp float;

uniform float uTime;
uniform vec2 uMouse;
uniform float uPixelRatio;

attribute float aSize;
attribute float aSpeed;
attribute vec2 aTwinkle; // (freq, phase)
attribute float aAlpha;

varying float vAlpha;
varying vec2 vTwinkle;

void main() {
  vAlpha = aAlpha;
  vTwinkle = aTwinkle;

  vec3 pos = position;

  // Drift continuously down-left along stream direction (Top-Right -> Bottom-Left)
  pos.x -= uTime * aSpeed * 0.8;
  pos.y -= uTime * aSpeed * 0.6 + sin(pos.x * 1.5 + vTwinkle.y) * 0.08;

  // Boundary loop (-4.5 to 4.5)
  float spanX = 9.0;
  float spanY = 7.5;
  pos.x = mod(pos.x + 4.5, spanX) - 4.5;
  pos.y = mod(pos.y + 3.75, spanY) - 3.75;

  // Mouse hover reaction: particles swirl away from cursor in world space
  vec2 mDiff = pos.xy - uMouse;
  float mDist = length(mDiff);
  float mForce = smoothstep(2.2, 0.0, mDist);
  vec2 mDir = mDist > 0.001 ? normalize(mDiff) : vec2(0.0, 1.0);
  vec2 mTan = vec2(-mDir.y, mDir.x);
  pos.xy += (mDir * 0.55 + mTan * 0.45) * mForce;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Point size scaled by camera distance and screen pixel ratio
  gl_PointSize = aSize * (3.8 / -mvPosition.z) * uPixelRatio;
}
`;

const PARTICLE_FRAG = `
precision highp float;

uniform float uTime;
uniform vec3 uParticleCore;
uniform vec3 uParticleBody;
uniform float uParticleOpacity;

varying float vAlpha;
varying vec2 vTwinkle;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord) * 2.0;
  if (dist > 1.0) discard;

  // Soft Gaussian bokeh disc
  float disc = exp(-dist * dist * 6.5);
  float twinkle = 0.65 + 0.35 * sin(uTime * vTwinkle.x + vTwinkle.y);

  vec3 col = mix(uParticleBody, uParticleCore, disc);
  float alpha = disc * twinkle * vAlpha * uParticleOpacity;

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

// ---------- Spline & Curve Construction (Top-Right to Bottom-Left) ----------

// Evaluates a cubic Bézier curve at parameter t
function cubicBezier(p0, p1, p2, p3, t) {
  const it = 1.0 - t;
  const it2 = it * it;
  const it3 = it2 * it;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: it3 * p0.x + 3 * it2 * t * p1.x + 3 * it * t2 * p2.x + t3 * p3.x,
    y: it3 * p0.y + 3 * it2 * t * p1.y + 3 * it * t2 * p2.y + t3 * p3.y,
    z: it3 * p0.z + 3 * it2 * t * p1.z + 3 * it * t2 * p2.z + t3 * p3.z,
  };
}

// Generates 3D points flowing diagonally from TOP-RIGHT to BOTTOM-LEFT
function generateStrandPath(type, lane, seed, pointsCount) {
  const randNorm = (Math.random() - 0.5) * 2.0;

  // Focal apex coordinates (around the central sphere)
  const apex = {
    x: -0.05 + Math.cos(lane * 1.1) * 0.16,
    y: 0.15 + Math.sin(lane * 1.1) * 0.16,
    z: Math.sin(lane * 1.8) * 0.25,
  };

  let p0, p1, p2, p3, p4, p5;

  if (type === 0) {
    // Upper-to-Lower Diagonal Stream 1 (Top-Right across sphere to Lower-Left)
    const spread = lane * 0.75;
    p0 = { x: 3.8 + spread + randNorm * 0.2, y: 3.4 + spread * 0.6, z: -0.2 };
    p1 = { x: apex.x + 1.4 + spread * 0.35, y: apex.y + 1.3 + spread * 0.3, z: 0.1 };
    p2 = apex;
    p3 = apex;
    p4 = { x: apex.x - 1.3 - spread * 0.45, y: apex.y - 1.2 - spread * 0.4, z: 0.15 };
    p5 = { x: -4.2 - spread * 0.8, y: -2.4 - Math.max(0, -lane) * 1.5, z: -0.2 };
  } else if (type === 1) {
    // Upper-to-Lower Diagonal Stream 2 (Top-Right across sphere to bottom center/left)
    const spread = lane * 0.75;
    p0 = { x: 4.2 + spread * 0.8, y: 2.5 + spread * 0.5, z: -0.15 };
    p1 = { x: apex.x + 1.6 + spread * 0.3, y: apex.y + 0.8 + spread * 0.2, z: 0.1 };
    p2 = apex;
    p3 = apex;
    p4 = { x: apex.x - 0.9 - spread * 0.4, y: apex.y - 1.6 - spread * 0.5, z: 0.15 };
    p5 = { x: -2.8 - spread * 0.9, y: -3.8 - Math.max(0, lane) * 1.2, z: -0.2 };
  } else {
    // Vortex / Halo loop tightly wrapping the sphere perimeter
    const angle = lane * Math.PI * 0.6;
    p0 = { x: 2.8 + Math.cos(angle) * 0.8, y: 2.6 + Math.sin(angle) * 0.8, z: 0.0 };
    p1 = { x: apex.x + 0.8, y: apex.y + 0.9, z: 0.15 };
    p2 = { x: apex.x + Math.sin(angle) * 0.35, y: apex.y + Math.cos(angle) * 0.3, z: 0.3 };
    p3 = p2;
    p4 = { x: apex.x - 0.9, y: apex.y - 0.8, z: 0.15 };
    p5 = { x: -3.6 - Math.cos(angle) * 0.6, y: -2.2 - Math.sin(angle) * 0.6, z: -0.1 };
  }

  const points = [];
  const half = Math.floor(pointsCount / 2);

  // Segment 1: p0 (Top-Right) -> p1 -> p2 (Apex)
  for (let i = 0; i <= half; i++) {
    const t = i / half;
    points.push(cubicBezier(p0, p1, p1, p2, t));
  }

  // Segment 2: p3 (Apex) -> p4 -> p5 (Bottom-Left)
  for (let i = 1; i <= pointsCount - half - 1; i++) {
    const t = i / (pointsCount - half - 1);
    points.push(cubicBezier(p3, p4, p4, p5, t));
  }

  return points;
}

// ---------- Main Mount Function ----------

function mount(container, options = {}) {
  // 1. Renderer Setup
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
    premultipliedAlpha: false,
  });

  const getDpr = () => Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(getDpr());
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight, false);
  renderer.setClearColor(0x000000, 0);

  const canvas = renderer.domElement;
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.pointerEvents = "none";
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault(); // Required by WebGL specification to allow context restoration!
  }, false);
  container.appendChild(canvas);

  // 2. Scene & Camera Setup
  const scene = new THREE.Scene();
  const fov = 45;
  const camera = new THREE.PerspectiveCamera(
    fov,
    (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight),
    0.1,
    100,
  );
  camera.position.set(0, 0, 5.0);
  camera.lookAt(0, 0, 0);

  // 3. Theme State
  let currentThemeName =
    options.theme ||
    document.documentElement.getAttribute("data-theme") ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  if (currentThemeName !== "dark" && currentThemeName !== "light") currentThemeName = "dark";

  let targetTheme = THEMES[currentThemeName];
  let currentThemeValues = {
    isDark: targetTheme.isDark,
    core: [...targetTheme.core],
    body: [...targetTheme.body],
    outer: [...targetTheme.outer],
    haloCore: [...targetTheme.haloCore],
    haloOuter: [...targetTheme.haloOuter],
    haloIntensity: targetTheme.haloIntensity,
    strandOpacity: targetTheme.strandOpacity,
    ribbonOpacity: targetTheme.ribbonOpacity,
    particleCore: [...targetTheme.particleCore],
    particleBody: [...targetTheme.particleBody],
    particleOpacity: targetTheme.particleOpacity,
  };

  // Uniforms
  const strandUniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uFocalOffset: { value: new THREE.Vector2(0, 0) },
    uColorCore: { value: new THREE.Color(...targetTheme.core) },
    uColorBody: { value: new THREE.Color(...targetTheme.body) },
    uColorOuter: { value: new THREE.Color(...targetTheme.outer) },
    uGlobalOpacity: { value: targetTheme.strandOpacity },
    uIsDark: { value: targetTheme.isDark },
  };

  const ribbonUniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uFocalOffset: { value: new THREE.Vector2(0, 0) },
    uColorCore: { value: new THREE.Color(...targetTheme.core) },
    uColorBody: { value: new THREE.Color(...targetTheme.body) },
    uColorOuter: { value: new THREE.Color(...targetTheme.outer) },
    uRibbonOpacity: { value: targetTheme.ribbonOpacity },
    uIsDark: { value: targetTheme.isDark },
  };

  const haloUniforms = {
    uFocalOffset: { value: new THREE.Vector2(0, 0) },
    uHaloCore: { value: new THREE.Color(...targetTheme.haloCore) },
    uHaloOuter: { value: new THREE.Color(...targetTheme.haloOuter) },
    uHaloIntensity: { value: targetTheme.haloIntensity },
    uIsDark: { value: targetTheme.isDark },
  };

  const particleUniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uPixelRatio: { value: getDpr() },
    uParticleCore: { value: new THREE.Color(...targetTheme.particleCore) },
    uParticleBody: { value: new THREE.Color(...targetTheme.particleBody) },
    uParticleOpacity: { value: targetTheme.particleOpacity },
  };

  // 4. Build Fiber Strands Geometry (LineSegments)
  const STRAND_COUNT = 160;
  const POINTS_PER_STRAND = 64;
  const totalSegments = STRAND_COUNT * (POINTS_PER_STRAND - 1);
  const totalLineVerts = totalSegments * 2;

  const linePositions = new Float32Array(totalLineVerts * 3);
  const lineProgress = new Float32Array(totalLineVerts);
  const lineLane = new Float32Array(totalLineVerts);
  const lineIntensity = new Float32Array(totalLineVerts);
  const lineApexDist = new Float32Array(totalLineVerts);
  const lineSeed = new Float32Array(totalLineVerts);
  const lineColorType = new Float32Array(totalLineVerts);

  let vIdx = 0;
  for (let s = 0; s < STRAND_COUNT; s++) {
    const type = s < 72 ? 0 : s < 144 ? 1 : 2;
    const lane = (s % 72) / 36 - 1.0;
    const seed = Math.random();

    // 15% hero strands with intensified radiance, others normal or ambient wisps
    const isHero = s % 7 === 0;
    const intensity = isHero ? 1.6 + Math.random() * 0.4 : 0.80 + Math.random() * 0.45;

    // Color distribution across green spectrum: ~35% neon lime, ~35% emerald, ~30% forest green
    const colorType = (s % 3) === 0 ? 0.0 : (s % 3) === 1 ? 0.5 : 1.0;

    const points = generateStrandPath(type, lane, seed, POINTS_PER_STRAND);

    for (let p = 0; p < points.length - 1; p++) {
      const ptA = points[p];
      const ptB = points[p + 1];

      const progA = p / (points.length - 1);
      const progB = (p + 1) / (points.length - 1);

      const apexDistA = Math.abs(progA - 0.5) * 2.0;
      const apexDistB = Math.abs(progB - 0.5) * 2.0;

      // Vertex A
      linePositions[vIdx * 3] = ptA.x;
      linePositions[vIdx * 3 + 1] = ptA.y;
      linePositions[vIdx * 3 + 2] = ptA.z;
      lineProgress[vIdx] = progA;
      lineLane[vIdx] = lane;
      lineIntensity[vIdx] = intensity;
      lineApexDist[vIdx] = apexDistA;
      lineSeed[vIdx] = seed;
      lineColorType[vIdx] = colorType;
      vIdx++;

      // Vertex B
      linePositions[vIdx * 3] = ptB.x;
      linePositions[vIdx * 3 + 1] = ptB.y;
      linePositions[vIdx * 3 + 2] = ptB.z;
      lineProgress[vIdx] = progB;
      lineLane[vIdx] = lane;
      lineIntensity[vIdx] = intensity;
      lineApexDist[vIdx] = apexDistB;
      lineSeed[vIdx] = seed;
      lineColorType[vIdx] = colorType;
      vIdx++;
    }
  }

  const strandGeometry = new THREE.BufferGeometry();
  strandGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  strandGeometry.setAttribute("aProgress", new THREE.BufferAttribute(lineProgress, 1));
  strandGeometry.setAttribute("aLane", new THREE.BufferAttribute(lineLane, 1));
  strandGeometry.setAttribute("aIntensity", new THREE.BufferAttribute(lineIntensity, 1));
  strandGeometry.setAttribute("aApexDist", new THREE.BufferAttribute(lineApexDist, 1));
  strandGeometry.setAttribute("aSeed", new THREE.BufferAttribute(lineSeed, 1));
  strandGeometry.setAttribute("aColorType", new THREE.BufferAttribute(lineColorType, 1));

  const strandMaterial = new THREE.ShaderMaterial({
    vertexShader: STRAND_VERT,
    fragmentShader: STRAND_FRAG,
    uniforms: strandUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: currentThemeName === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const strandMesh = new THREE.LineSegments(strandGeometry, strandMaterial);
  scene.add(strandMesh);

  // 5. Build Volumetric Silk Ribbons (Triangle Strips / Triangles)
  const RIBBON_COUNT = 10;
  const RIBBON_STEPS = 50;
  const ribbonQuads = RIBBON_COUNT * (RIBBON_STEPS - 1);
  const ribbonVertCount = ribbonQuads * 6;

  const ribbonPositions = new Float32Array(ribbonVertCount * 3);
  const ribbonProgress = new Float32Array(ribbonVertCount);
  const ribbonApexDist = new Float32Array(ribbonVertCount);
  const ribbonSeed = new Float32Array(ribbonVertCount);
  const ribbonSide = new Float32Array(ribbonVertCount);

  let rIdx = 0;
  for (let r = 0; r < RIBBON_COUNT; r++) {
    const type = r < 5 ? 0 : 1;
    const lane = (r % 5) / 2.5 - 0.8;
    const seed = 0.15 * r;
    const points = generateStrandPath(type, lane, seed, RIBBON_STEPS);
    const baseWidth = 0.08 + Math.random() * 0.04;

    for (let p = 0; p < points.length - 1; p++) {
      const pA = points[p];
      const pB = points[p + 1];

      const progA = p / (points.length - 1);
      const progB = (p + 1) / (points.length - 1);

      const apexA = Math.abs(progA - 0.5) * 2.0;
      const apexB = Math.abs(progB - 0.5) * 2.0;

      // Ribbon width expands at the focal apex
      const wA = baseWidth * (1.0 + (1.0 - apexA) * 1.5);
      const wB = baseWidth * (1.0 + (1.0 - apexB) * 1.5);

      // Normal perpendicular to segment
      const dx = pB.x - pA.x;
      const dy = pB.y - pA.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;

      const pA_L = { x: pA.x + nx * wA * 0.5, y: pA.y + ny * wA * 0.5, z: pA.z };
      const pA_R = { x: pA.x - nx * wA * 0.5, y: pA.y - ny * wA * 0.5, z: pA.z };
      const pB_L = { x: pB.x + nx * wB * 0.5, y: pB.y + ny * wB * 0.5, z: pB.z };
      const pB_R = { x: pB.x - nx * wB * 0.5, y: pB.y - ny * wB * 0.5, z: pB.z };

      const quadVerts = [
        [pA_L, progA, apexA, -1.0],
        [pA_R, progA, apexA, 1.0],
        [pB_L, progB, apexB, -1.0],
        [pB_L, progB, apexB, -1.0],
        [pA_R, progA, apexA, 1.0],
        [pB_R, progB, apexB, 1.0],
      ];

      for (const [pt, prg, apx, side] of quadVerts) {
        ribbonPositions[rIdx * 3] = pt.x;
        ribbonPositions[rIdx * 3 + 1] = pt.y;
        ribbonPositions[rIdx * 3 + 2] = pt.z;
        ribbonProgress[rIdx] = prg;
        ribbonApexDist[rIdx] = apx;
        ribbonSeed[rIdx] = seed;
        ribbonSide[rIdx] = side;
        rIdx++;
      }
    }
  }

  const ribbonGeometry = new THREE.BufferGeometry();
  ribbonGeometry.setAttribute("position", new THREE.BufferAttribute(ribbonPositions, 3));
  ribbonGeometry.setAttribute("aProgress", new THREE.BufferAttribute(ribbonProgress, 1));
  ribbonGeometry.setAttribute("aApexDist", new THREE.BufferAttribute(ribbonApexDist, 1));
  ribbonGeometry.setAttribute("aSeed", new THREE.BufferAttribute(ribbonSeed, 1));
  ribbonGeometry.setAttribute("aSide", new THREE.BufferAttribute(ribbonSide, 1));

  const ribbonMaterial = new THREE.ShaderMaterial({
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    uniforms: ribbonUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: currentThemeName === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const ribbonMesh = new THREE.Mesh(ribbonGeometry, ribbonMaterial);
  scene.add(ribbonMesh);

  // 6. Build Focal Halo Bloom Plane (Disabled — zero shadow/halo behind sphere)
  const haloGeo = new THREE.PlaneGeometry(3.2, 3.2);
  const haloMat = new THREE.ShaderMaterial({
    vertexShader: HALO_VERT,
    fragmentShader: HALO_FRAG,
    uniforms: haloUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: currentThemeName === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const haloMesh = new THREE.Mesh(haloGeo, haloMat);
  haloMesh.visible = false;
  // Intentionally NOT added to scene to ensure zero shadow behind the bot:
  // scene.add(haloMesh);

  // 7. Build Floating Bokeh Particles
  const PARTICLE_COUNT = 140;
  const pPositions = new Float32Array(PARTICLE_COUNT * 3);
  const pSizes = new Float32Array(PARTICLE_COUNT);
  const pSpeeds = new Float32Array(PARTICLE_COUNT);
  const pTwinkle = new Float32Array(PARTICLE_COUNT * 2);
  const pAlphas = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const x = (Math.random() - 0.5) * 8.5;
    const y = (Math.random() - 0.5) * 5.5;
    const z = (Math.random() - 0.5) * 1.5;

    pPositions[i * 3] = x;
    pPositions[i * 3 + 1] = y;
    pPositions[i * 3 + 2] = z;

    const roll = Math.random();
    if (roll < 0.65) pSizes[i] = 12.0 + Math.random() * 12.0;
    else if (roll < 0.9) pSizes[i] = 24.0 + Math.random() * 18.0;
    else pSizes[i] = 45.0 + Math.random() * 25.0;

    pSpeeds[i] = 0.12 + Math.random() * 0.28;
    pTwinkle[i * 2] = 2.0 + Math.random() * 3.5;
    pTwinkle[i * 2 + 1] = Math.random() * 6.28;
    pAlphas[i] = 0.5 + Math.random() * 0.5;
  }

  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(pPositions, 3));
  particleGeometry.setAttribute("aSize", new THREE.BufferAttribute(pSizes, 1));
  particleGeometry.setAttribute("aSpeed", new THREE.BufferAttribute(pSpeeds, 1));
  particleGeometry.setAttribute("aTwinkle", new THREE.BufferAttribute(pTwinkle, 2));
  particleGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(pAlphas, 1));

  const particleMaterial = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    uniforms: particleUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: currentThemeName === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const particleMesh = new THREE.Points(particleGeometry, particleMaterial);
  scene.add(particleMesh);

  // 8. Dynamic Sphere Tracking & NDC Sync
  let focalOffset = new THREE.Vector2(0, 0);

  function syncSpherePosition() {
    if (isDestroyed) return;
    const sphere = document.querySelector(".orbit-sphere");
    if (!sphere) {
      // Retain existing focal offset rather than abruptly resetting to (0, 0)
      return;
    }
    const rect = sphere.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // Guard against 0-dimension during DOM reflow!

    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const winW = window.innerWidth || 1200;
    const winH = window.innerHeight || 800;

    // Convert screen px to Normalized Device Coordinates (-1 to 1)
    const ndcX = (cx / winW) * 2 - 1;
    const ndcY = -(cy / winH) * 2 + 1;

    // Convert NDC to Three.js world coordinates on plane at z = 0
    const vFOV = (fov * Math.PI) / 180;
    const planeH = 2.0 * Math.tan(vFOV * 0.5) * 5.0;
    const planeW = planeH * (camera.aspect || 1.5);

    const targetWorldX = ndcX * (planeW * 0.5);
    const targetWorldY = ndcY * (planeH * 0.5);

    if (!Number.isFinite(targetWorldX) || !Number.isFinite(targetWorldY)) return;

    // Clamp strictly so strands can NEVER be displaced off-screen during scroll or resize
    const safeX = Math.max(-0.6, Math.min(0.6, targetWorldX));
    const safeY = Math.max(-0.5, Math.min(0.5, targetWorldY - 0.1));

    focalOffset.set(safeX, safeY);
    strandUniforms.uFocalOffset.value.copy(focalOffset);
    ribbonUniforms.uFocalOffset.value.copy(focalOffset);
    if (haloUniforms?.uFocalOffset) haloUniforms.uFocalOffset.value.copy(focalOffset);
    if (haloMesh && haloMesh.visible) haloMesh.position.set(safeX, safeY, -0.05);
  }

  // 9. Interactive Mouse Tracking (Real 3D World Space Coordinates)
  const mouseTarget = new THREE.Vector2(0, 0);
  const mouseSmooth = new THREE.Vector2(0, 0);

  const onPointerMove = (e) => {
    // Convert client coordinates directly to 3D World Coordinates on the z = 0 plane
    const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
    const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;

    const vFOV = (fov * Math.PI) / 180;
    const planeH = 2.0 * Math.tan(vFOV * 0.5) * 5.0;
    const planeW = planeH * camera.aspect;

    const worldMouseX = ndcX * (planeW * 0.5);
    const worldMouseY = ndcY * (planeH * 0.5);

    mouseTarget.set(worldMouseX, worldMouseY);
  };
  window.addEventListener("pointermove", onPointerMove, { passive: true });

  // 10. Resize & Observer Handlers
  let isPaused = false;
  let isDestroyed = false;

  function resize() {
    if (isDestroyed) return;
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    const dpr = getDpr();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    particleUniforms.uPixelRatio.value = dpr;
    syncSpherePosition();
  }

  window.addEventListener("resize", resize);
  const resizeObs = new ResizeObserver(resize);
  resizeObs.observe(container);

  const onVis = () => {
    isPaused = document.hidden;
  };
  document.addEventListener("visibilitychange", onVis);

  // 11. Animation Loop with Smooth Theme Interpolation
  const clock = new THREE.Clock();
  let frameCount = 0;
  let rafId = 0;

  function animate() {
    rafId = requestAnimationFrame(animate);
    if (isPaused || isDestroyed) return;

    frameCount++;
    if (frameCount % 45 === 0) {
      syncSpherePosition();
    }

    const dt = Math.max(0.001, Math.min(clock.getDelta() || 0.016, 0.05));
    const time = clock.getElapsedTime() || 0;

    // Uniform time updates
    strandUniforms.uTime.value = time;
    ribbonUniforms.uTime.value = time;
    particleUniforms.uTime.value = time;

    // Smooth mouse interpolation in world space
    mouseSmooth.lerp(mouseTarget, 0.08);
    strandUniforms.uMouse.value.copy(mouseSmooth);
    ribbonUniforms.uMouse.value.copy(mouseSmooth);
    particleUniforms.uMouse.value.copy(mouseSmooth);

    // Dynamic 3D camera parallax tilt
    const vFOV = (fov * Math.PI) / 180;
    const planeH = 2.0 * Math.tan(vFOV * 0.5) * 5.0;
    const planeW = planeH * camera.aspect;
    camera.position.x = (mouseSmooth.x / (planeW * 0.5)) * 0.40;
    camera.position.y = (mouseSmooth.y / (planeH * 0.5)) * 0.30;
    camera.lookAt(0, 0, 0);

    // Smooth theme color & opacity transitions
    const lerpFactor = Math.min(1.0, Math.max(0.0, 1.0 - Math.exp(-dt * 5.5)));

    currentThemeValues.isDark += (targetTheme.isDark - currentThemeValues.isDark) * lerpFactor;
    strandUniforms.uIsDark.value = currentThemeValues.isDark;
    ribbonUniforms.uIsDark.value = currentThemeValues.isDark;
    haloUniforms.uIsDark.value = currentThemeValues.isDark;

    for (let c = 0; c < 3; c++) {
      currentThemeValues.core[c] += (targetTheme.core[c] - currentThemeValues.core[c]) * lerpFactor;
      currentThemeValues.body[c] += (targetTheme.body[c] - currentThemeValues.body[c]) * lerpFactor;
      currentThemeValues.outer[c] += (targetTheme.outer[c] - currentThemeValues.outer[c]) * lerpFactor;
      currentThemeValues.haloCore[c] += (targetTheme.haloCore[c] - currentThemeValues.haloCore[c]) * lerpFactor;
      currentThemeValues.haloOuter[c] += (targetTheme.haloOuter[c] - currentThemeValues.haloOuter[c]) * lerpFactor;
      currentThemeValues.particleCore[c] += (targetTheme.particleCore[c] - currentThemeValues.particleCore[c]) * lerpFactor;
      currentThemeValues.particleBody[c] += (targetTheme.particleBody[c] - currentThemeValues.particleBody[c]) * lerpFactor;
    }

    strandUniforms.uColorCore.value.setRGB(...currentThemeValues.core);
    strandUniforms.uColorBody.value.setRGB(...currentThemeValues.body);
    strandUniforms.uColorOuter.value.setRGB(...currentThemeValues.outer);

    ribbonUniforms.uColorCore.value.setRGB(...currentThemeValues.core);
    ribbonUniforms.uColorBody.value.setRGB(...currentThemeValues.body);
    ribbonUniforms.uColorOuter.value.setRGB(...currentThemeValues.outer);

    haloUniforms.uHaloCore.value.setRGB(...currentThemeValues.haloCore);
    haloUniforms.uHaloOuter.value.setRGB(...currentThemeValues.haloOuter);

    particleUniforms.uParticleCore.value.setRGB(...currentThemeValues.particleCore);
    particleUniforms.uParticleBody.value.setRGB(...currentThemeValues.particleBody);

    currentThemeValues.strandOpacity += (targetTheme.strandOpacity - currentThemeValues.strandOpacity) * lerpFactor;
    if (!Number.isFinite(currentThemeValues.strandOpacity) || currentThemeValues.strandOpacity <= 0.05) {
      currentThemeValues.strandOpacity = targetTheme.strandOpacity;
    }
    strandUniforms.uGlobalOpacity.value = currentThemeValues.strandOpacity;

    currentThemeValues.ribbonOpacity += (targetTheme.ribbonOpacity - currentThemeValues.ribbonOpacity) * lerpFactor;
    if (!Number.isFinite(currentThemeValues.ribbonOpacity) || currentThemeValues.ribbonOpacity <= 0.05) {
      currentThemeValues.ribbonOpacity = targetTheme.ribbonOpacity;
    }
    ribbonUniforms.uRibbonOpacity.value = currentThemeValues.ribbonOpacity;

    currentThemeValues.haloIntensity += (targetTheme.haloIntensity - currentThemeValues.haloIntensity) * lerpFactor;
    haloUniforms.uHaloIntensity.value = currentThemeValues.haloIntensity;

    currentThemeValues.particleOpacity += (targetTheme.particleOpacity - currentThemeValues.particleOpacity) * lerpFactor;
    if (!Number.isFinite(currentThemeValues.particleOpacity) || currentThemeValues.particleOpacity <= 0.05) {
      currentThemeValues.particleOpacity = targetTheme.particleOpacity;
    }
    particleUniforms.uParticleOpacity.value = currentThemeValues.particleOpacity;

    renderer.render(scene, camera);
  }

  // Initial sync & trigger
  syncSpherePosition();
  animate();

  // 12. Returned Handle Interface
  const handle = {
    canvas,
    get isDestroyed() {
      return isDestroyed;
    },
    setTheme(theme) {
      const mode = theme === "dark" || theme === "light" ? theme : "dark";
      currentThemeName = mode;
      targetTheme = THEMES[mode];
      const blendingMode = mode === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending;
      strandMaterial.blending = blendingMode;
      ribbonMaterial.blending = blendingMode;
      haloMat.blending = blendingMode;
      particleMaterial.blending = blendingMode;
      strandMaterial.needsUpdate = true;
      ribbonMaterial.needsUpdate = true;
      haloMat.needsUpdate = true;
      particleMaterial.needsUpdate = true;
    },
    syncSphere: syncSpherePosition,
    pause() {
      isPaused = true;
    },
    resume() {
      isPaused = false;
      syncSpherePosition();
    },
    destroy() {
      if (isDestroyed) return;
      isDestroyed = true;
      if (activeLaserInstance === handle) {
        activeLaserInstance = null;
      }
      cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
      resizeObs.disconnect();

      strandGeometry.dispose();
      strandMaterial.dispose();
      ribbonGeometry.dispose();
      ribbonMaterial.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();

      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  };
  return handle;
}

// Global Export & Custom Event for Seamless Integration
let activeLaserInstance = null;

function safeMount(container, options) {
  try {
    if (activeLaserInstance && !activeLaserInstance.isDestroyed) {
      if (container.contains(activeLaserInstance.canvas)) {
        if (options && options.theme) activeLaserInstance.setTheme(options.theme);
        activeLaserInstance.resume();
        return activeLaserInstance;
      }
      container.innerHTML = "";
      container.appendChild(activeLaserInstance.canvas);
      if (options && options.theme) activeLaserInstance.setTheme(options.theme);
      activeLaserInstance.resume();
      return activeLaserInstance;
    }
    activeLaserInstance = mount(container, options);
    return activeLaserInstance;
  } catch (err) {
    console.error("LaserFlow WebGL mount error:", err);
    return null;
  }
}

window.LaserFlow = {
  mount: safeMount,
  getInstance() {
    return activeLaserInstance;
  },
};
window.dispatchEvent(new CustomEvent("laserflow:ready"));
