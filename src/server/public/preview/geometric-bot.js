// Geometric Bot — Minimalist Geometric Assistant (2.5D Chunky Clay Aesthetic)
// Seamless fluid vertex morphing between Circle, Triangle, and Squircle
// Darker, richer reference colors: Deep Periwinkle (#5469dc), Dark Tangerine (#df6212), Deep Ocean Blue (#1173c6)
// Signature dual capsule white eyes, 3D cursor tracking, boundary-constrained roaming, and subtle tactile depth.
// 100% Smooth Surface: High-Density Indexed Geodesic Isosphere with shared Gouraud normals,
// soft friendly rounded corners, and continuous curvature (zero facets, zero sharp edges, zero creases).
// Feature 1: Living Co-Founder Personality (Mood engine: idle, typing, working, celebrating, curiosity focus)
// Feature 4: Ambient Background Sync & Working Mode Semantics (Strategy, Velocity, Analytics)

(function () {
  let activeInstance = null;

  const SHAPES = [
    {
      name: "circle",
      modeKey: "strategy",
      modeTitle: "Strategy & Vision",
      badgeText: "✦ Strategy Mode",
      colorHex: 0x5469dc, // Rich deep periwinkle cobalt
      colorRgb: [0.33, 0.41, 0.86],
      accentGlow: "rgba(84, 105, 220, 0.28)",
      label: "Circle",
      rotTilt: 0,
      defaultGlance: { x: 0.22, y: 0.16 }, // Top-right glance from drawing
    },
    {
      name: "triangle",
      modeKey: "velocity",
      modeTitle: "Velocity & Execution",
      badgeText: "⚡ Velocity Mode",
      colorHex: 0xdf6212, // Rich dark warm tangerine / terracotta orange
      colorRgb: [0.87, 0.38, 0.07],
      accentGlow: "rgba(223, 98, 18, 0.26)",
      label: "Triangle",
      rotTilt: 0.16, // subtle 9-deg playful tilt matching drawing
      defaultGlance: { x: 0.0, y: 0.24 }, // High up towards apex
    },
    {
      name: "square",
      modeKey: "analytics",
      modeTitle: "Analytics & Diligence",
      badgeText: "📊 Analytics Mode",
      colorHex: 0x1173c6, // Rich deep ocean cerulean blue
      colorRgb: [0.07, 0.45, 0.78],
      accentGlow: "rgba(17, 115, 198, 0.28)",
      label: "Squircle",
      rotTilt: -0.12, // subtle -7 deg tilt matching drawing
      defaultGlance: { x: -0.28, y: -0.22 }, // Lower-left corner glance from drawing
    },
  ];

  class GeometricBot {
    constructor(container) {
      this.container = container;
      this.destroyed = false;
      this.rafId = 0;

      // Living Co-founder Mood State
      this.mood = "idle"; // "idle" | "typing" | "working" | "celebrating"
      this.moodUntil = 0;

      // Cursor tracking across viewport (standard Cartesian: +X Right, +Y Up)
      this.mouse = {
        x: 0, y: 0,
        nx: 0, ny: 0,
        targetNx: 0, targetNy: 0,
        lastMoveTime: performance.now(),
      };
      this.isHovered = false;

      // Spring-mass-damper physics with subtle 2.5D tilt (reduced 3D effect)
      this.physics = {
        pos: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
        scale: { x: 1, y: 1, z: 1, vx: 0, vy: 0, vz: 0 },
        rot: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
        targetRot: { x: 0, y: 0, z: 0 },
      };

      // Eyes state & autonomous roaming / blinking
      this.eyes = {
        x: 0.22, y: 0.16,
        targetX: 0.22, targetY: 0.16,
        scaleX: 1,
        targetScaleX: 1,
        scaleY: 1,
        targetScaleY: 1,
        isBlinking: false,
        nextBlinkTime: performance.now() + 2400,
        nextGlanceTime: performance.now() + 2000,
        idleGlance: { x: 0.22, y: 0.16 },
      };

      // Continuous Fluid Morph State
      this.morph = {
        currentIdx: 0, // 0 = Circle, 1 = Triangle, 2 = Squircle
        targetIdx: 1,
        isMorphing: false,
        startTime: 0,
        duration: 2000, // 2.0s velvety smooth fluid morph
        holdDuration: 5500, // 5.5s steady display
        nextMorphTime: performance.now() + 4500,
        weights: [1, 0, 0], // weight of each shape [circle, triangle, square]
        fromWeights: [1, 0, 0],
        targetWeights: [0, 1, 0],
      };
      this.currentTilt = SHAPES[0].rotTilt;

      this.initDOM();
      this.initThree();
      this.bindEvents();
      this.syncAmbientGlow(0);
    }

    initDOM() {
      this.container.innerHTML = `
        <div class="metallic-bot-root geometric-bot-root" id="metallic-bot-root" role="button" aria-label="CEO Agent Geometric Bot">
          <canvas class="metallic-bot-canvas geometric-bot-canvas"></canvas>
        </div>
      `;
      this.root = this.container.querySelector(".metallic-bot-root");
      this.canvas = this.container.querySelector(".metallic-bot-canvas");
    }

    async initThree() {
      const THREE = await import("../vendor/three/three.module.js");
      if (this.destroyed) return;
      this.THREE = THREE;

      const rect = this.canvas.getBoundingClientRect();
      this.width = rect.width || 280;
      this.height = rect.height || 280;

      // 1. Scene & Camera (camera at z=4.8 with 36 deg FOV gives 3.12 view height, comfortably enclosing 2.2 shape height)
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(36, this.width / this.height, 0.1, 50);
      this.camera.position.set(0, 0, 4.8);

      // 2. WebGL Renderer
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(this.width, this.height, false);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;

      this.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
      }, false);

      // 3. Build Morphing Flat-Matte Body & Signature Twin Capsule Eyes
      this.buildModel();

      // 4. Soft Studio Lighting (diffuse, non-glossy, rich saturated colors)
      this.buildLighting();

      // 5. Theme adaptation
      this.updateThemeColors();
      this.themeObserver = new MutationObserver(() => this.updateThemeColors());
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      // Start Animation Loop
      this.loop = this.loop.bind(this);
      this.rafId = requestAnimationFrame(this.loop);
    }

    buildModel() {
      const THREE = this.THREE;

      this.botGroup = new THREE.Group();
      this.scene.add(this.botGroup);

      // 1. High-Density Indexed Geodesic Isosphere (Detail 16, 2,892 smoothly shared vertices)
      // Completely eliminates flat-facet shading, sharp polygon rims, and polar vortex seams.
      // Shared indexed vertices guarantee 100% continuous, smooth surface normal averaging.
      const rawGeom = new THREE.IcosahedronGeometry(1.0, 16);
      const rawPos = rawGeom.attributes.position;
      const rawCount = rawPos.count;
      const precision = 1e5;
      const map = new Map();
      const indices = [];
      const uniquePositions = [];

      for (let i = 0; i < rawCount; i++) {
        const x = rawPos.getX(i);
        const y = rawPos.getY(i);
        const z = rawPos.getZ(i);
        const key = Math.round(x * precision) + '_' + Math.round(y * precision) + '_' + Math.round(z * precision);
        if (map.has(key)) {
          indices.push(map.get(key));
        } else {
          const newIdx = uniquePositions.length / 3;
          map.set(key, newIdx);
          indices.push(newIdx);
          uniquePositions.push(x, y, z);
        }
      }

      this.geom = new THREE.BufferGeometry();
      this.geom.setAttribute('position', new THREE.Float32BufferAttribute(uniquePositions, 3));
      this.geom.setIndex(indices);
      const posAttr = this.geom.attributes.position;
      const count = posAttr.count;

      // Precompute 3D vertex positions for Circle, Rounded Triangle, and Rounded Squircle
      this.circlePos = new Float32Array(count * 3);
      this.trianglePos = new Float32Array(count * 3);
      this.squarePos = new Float32Array(count * 3);

      function getTriangleRadius(theta) {
        // Equilateral triangle with generous, friendly rounded corners matching reference drawing
        const alpha = theta - Math.PI / 2;
        const twoPi3 = (2 * Math.PI) / 3;
        let phi = ((alpha % twoPi3) + twoPi3) % twoPi3;
        if (phi > Math.PI / 3) phi = twoPi3 - phi;
        const H = 1.14; // soft rounded corner apex distance
        const d = 0.76; // edge midpoint distance
        const angleFromNorm = Math.PI / 3 - phi;
        const rStraight = d / Math.max(0.05, Math.cos(angleFromNorm));
        const rMax = H;
        const k = 0.32; // generous corner smoothing factor
        const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (rMax - rStraight) / k));
        return rMax * (1 - h) + rStraight * h - k * h * (1 - h);
      }

      function getSquircleRadius(theta) {
        // Chunky, softly rounded squircle (p = 3.2 for gentle corner curve)
        const p = 3.2;
        const c = Math.abs(Math.cos(theta));
        const s = Math.abs(Math.sin(theta));
        return 1.05 / Math.pow(Math.pow(c, p) + Math.pow(s, p), 1.0 / p);
      }

      // Smooth continuous 2.5D pebble cushion depth (zero creases, continuous curvature)
      const T = 0.24;

      for (let i = 0; i < count; i++) {
        const x0 = posAttr.getX(i);
        const y0 = posAttr.getY(i);
        const z0 = posAttr.getZ(i);

        const r0 = Math.sqrt(x0 * x0 + y0 * y0);
        const theta = r0 > 1e-6 ? Math.atan2(y0, x0) : 0;
        const z = z0 * T;

        // --- 1. Circle (Enlarged, perfectly smooth round perimeter) ---
        const rC = r0 * 1.15;
        this.circlePos[i * 3 + 0] = Math.cos(theta) * rC;
        this.circlePos[i * 3 + 1] = Math.sin(theta) * rC;
        this.circlePos[i * 3 + 2] = z;

        // --- 2. Rounded Triangle (Enlarged with soft, friendly rounded corners) ---
        const rT = r0 * getTriangleRadius(theta);
        this.trianglePos[i * 3 + 0] = Math.cos(theta) * rT;
        this.trianglePos[i * 3 + 1] = Math.sin(theta) * rT;
        this.trianglePos[i * 3 + 2] = z;

        // --- 3. Rounded Squircle (Enlarged with soft curved corners) ---
        const rS = r0 * getSquircleRadius(theta);
        this.squarePos[i * 3 + 0] = Math.cos(theta) * rS;
        this.squarePos[i * 3 + 1] = Math.sin(theta) * rS;
        this.squarePos[i * 3 + 2] = z;
      }

      // Initialize vertices to starting shape (Circle)
      for (let i = 0; i < count * 3; i++) {
        posAttr.array[i] = this.circlePos[i];
      }
      this.geom.computeVertexNormals();

      // Soft-Matte Vector / Gouache Clay Material (high roughness, zero clearcoat, no shiny 3D glare)
      this.bodyMat = new THREE.MeshStandardMaterial({
        color: SHAPES[0].colorHex,
        roughness: 0.82,
        metalness: 0.0,
      });

      this.bodyMesh = new THREE.Mesh(this.geom, this.bodyMat);
      this.botGroup.add(this.bodyMesh);

      // --- Signature Dual Capsule White Eyes ---
      this.eyesGroup = new THREE.Group();
      this.eyesGroup.position.set(this.eyes.x, this.eyes.y, 0.255);
      this.botGroup.add(this.eyesGroup);

      // Prominent capsule pills matching drawing proportions (enlarged)
      const pillRadius = 0.138;
      const pillLength = 0.38;
      const eyeGeom = new THREE.CapsuleGeometry(pillRadius, pillLength, 16, 20);

      // Pure brilliant white matte decal (unlit/diffuse so it pops boldly without glossy highlights)
      this.eyeMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
      });

      // Left eye capsule
      this.leftEye = new THREE.Mesh(eyeGeom, this.eyeMat);
      this.leftEye.position.set(-0.175, 0, 0);
      this.eyesGroup.add(this.leftEye);

      // Right eye capsule
      this.rightEye = new THREE.Mesh(eyeGeom, this.eyeMat);
      this.rightEye.position.set(0.175, 0, 0);
      this.eyesGroup.add(this.rightEye);
    }

    buildLighting() {
      const THREE = this.THREE;

      // Soft uniform wrap-around lighting to maintain deep saturated colors without white glare
      this.ambientLight = new THREE.AmbientLight(0xffffff, 2.0);
      this.scene.add(this.ambientLight);

      // Subtle directional key light for tactile 2.5D bevel depth
      this.keyLight = new THREE.DirectionalLight(0xfff8f2, 1.2);
      this.keyLight.position.set(-2.5, 3.2, 2.5);
      this.scene.add(this.keyLight);

      // Soft bottom warm fill bounce
      this.fillLight = new THREE.DirectionalLight(0xffede4, 0.5);
      this.fillLight.position.set(2.5, -2.0, 1.5);
      this.scene.add(this.fillLight);

      // Subtle rim backlight
      this.rimLight = new THREE.DirectionalLight(0xffffff, 0.7);
      this.rimLight.position.set(0, 2.0, -3.0);
      this.scene.add(this.rimLight);
    }

    updateThemeColors() {
      if (!this.THREE || !this.bodyMat) return;
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";

      if (isDark) {
        this.ambientLight.intensity = 1.7;
        this.keyLight.intensity = 1.0;
        this.fillLight.intensity = 0.4;
        this.rimLight.intensity = 0.8;
      } else {
        this.ambientLight.intensity = 2.0;
        this.keyLight.intensity = 1.2;
        this.fillLight.intensity = 0.5;
        this.rimLight.intensity = 0.7;
      }
    }

    // Feature 4: Ambient Background Sync & Theme Variables
    syncAmbientGlow(shapeIdx) {
      const shape = SHAPES[shapeIdx] || SHAPES[0];
      const hexStr = "#" + shape.colorHex.toString(16).padStart(6, "0");
      document.documentElement.style.setProperty("--bot-accent-color", hexStr);
      document.documentElement.style.setProperty("--bot-accent-glow", shape.accentGlow);

      if (window.LaserFlow && typeof window.LaserFlow.getInstance === "function") {
        const lf = window.LaserFlow.getInstance();
        if (lf && typeof lf.setAccentColor === "function") {
          lf.setAccentColor(...shape.colorRgb);
        }
      }

      window.dispatchEvent(new CustomEvent("ceo-bot-mode-change", {
        detail: {
          index: shapeIdx,
          shape: shape,
          modeKey: shape.modeKey,
          modeTitle: shape.modeTitle,
          badgeText: shape.badgeText,
        },
      }));
    }

    // Feature 1: Living Co-Founder Mood Engine
    setMood(mood, durationMs = 0) {
      if (this.destroyed) return;
      this.mood = mood;
      if (durationMs > 0) {
        this.moodUntil = performance.now() + durationMs;
      } else {
        this.moodUntil = 0;
      }

      if (mood === "celebrating") {
        // Joyful squash-and-stretch celebration jump
        this.physics.scale.y = 1.25;
        this.physics.scale.x = 0.86;
        this.physics.scale.z = 0.86;
        this.physics.pos.vy = 0.11;

        // Double happy blink
        this.eyes.isBlinking = true;
        this.eyes.targetScaleY = 0.05;
        setTimeout(() => {
          if (!this.destroyed) {
            this.eyes.targetScaleY = 1.0;
            setTimeout(() => {
              if (!this.destroyed) {
                this.eyes.isBlinking = true;
                this.eyes.targetScaleY = 0.05;
                setTimeout(() => {
                  if (!this.destroyed) this.eyes.targetScaleY = 1.0;
                }, 160);
              }
            }, 220);
          }
        }, 160);
      }
    }

    celebrate() {
      this.setMood("celebrating", 2400);
    }

    setShape(idx) {
      if (idx < 0 || idx >= SHAPES.length) return;
      if (this.morph.currentIdx === idx && !this.morph.isMorphing) return;
      this.startMorph(idx);
    }

    triggerRandomMorph() {
      // Pick next shape distinct from current
      const available = [0, 1, 2].filter((i) => i !== this.morph.currentIdx);
      const nextIdx = available[Math.floor(Math.random() * available.length)];
      this.startMorph(nextIdx);
    }

    startMorph(targetIdx) {
      this.morph.targetIdx = targetIdx;
      this.morph.isMorphing = true;
      this.morph.startTime = performance.now();
      this.morph.fromWeights = [...this.morph.weights];
      this.morph.targetWeights = [0, 0, 0];
      this.morph.targetWeights[targetIdx] = 1.0;

      // Update default glance pose to match new target shape
      const glance = SHAPES[targetIdx].defaultGlance;
      this.eyes.idleGlance = { ...glance };
      this.syncAmbientGlow(targetIdx);
    }

    updateMorph(now) {
      if (!this.geom) return;

      // Autonomous morph timing (only when user isn't actively typing or working)
      if (!this.morph.isMorphing && now >= this.morph.nextMorphTime && this.mood === "idle") {
        this.triggerRandomMorph();
        return;
      }

      if (!this.morph.isMorphing) return;

      const elapsed = now - this.morph.startTime;
      const progress = Math.min(1.0, elapsed / this.morph.duration);

      // Velvety sinusoidal smoothstep easing
      const ease = 0.5 - 0.5 * Math.cos(progress * Math.PI);

      // Interpolate weights
      for (let i = 0; i < 3; i++) {
        this.morph.weights[i] =
          this.morph.fromWeights[i] +
          (this.morph.targetWeights[i] - this.morph.fromWeights[i]) * ease;
      }

      // Smooth color morphing across darker, richer tones
      const fromColor = new this.THREE.Color(SHAPES[this.morph.currentIdx].colorHex);
      const toColor = new this.THREE.Color(SHAPES[this.morph.targetIdx].colorHex);
      this.bodyMat.color.copy(fromColor).lerp(toColor, ease);

      // Smoothly interpolate signature shape tilt
      const fromTilt = SHAPES[this.morph.currentIdx].rotTilt;
      const toTilt = SHAPES[this.morph.targetIdx].rotTilt;
      this.currentTilt = fromTilt + (toTilt - fromTilt) * ease;

      // Gentle organic breathing pulse during transition (preserves clay volume without jarring)
      const pulse = 1.0 + Math.sin(progress * Math.PI) * 0.035;
      if (this.mood !== "celebrating") {
        this.physics.scale.x = pulse;
        this.physics.scale.y = pulse;
        this.physics.scale.z = pulse;
      }

      // Interpolate vertex positions purely radially (zero circumferential shear, zero vortex)
      const w0 = this.morph.weights[0];
      const w1 = this.morph.weights[1];
      const w2 = this.morph.weights[2];

      const posArr = this.geom.attributes.position.array;
      const count3 = posArr.length;

      for (let i = 0; i < count3; i += 3) {
        posArr[i + 0] =
          w0 * this.circlePos[i + 0] +
          w1 * this.trianglePos[i + 0] +
          w2 * this.squarePos[i + 0];

        posArr[i + 1] =
          w0 * this.circlePos[i + 1] +
          w1 * this.trianglePos[i + 1] +
          w2 * this.squarePos[i + 1];

        posArr[i + 2] =
          w0 * this.circlePos[i + 2] +
          w1 * this.trianglePos[i + 2] +
          w2 * this.squarePos[i + 2];
      }

      this.geom.attributes.position.needsUpdate = true;
      this.geom.computeVertexNormals();

      // Finish morph
      if (progress >= 1.0) {
        this.morph.isMorphing = false;
        this.morph.currentIdx = this.morph.targetIdx;
        this.morph.weights = [...this.morph.targetWeights];
        this.currentTilt = SHAPES[this.morph.currentIdx].rotTilt;
        this.morph.nextMorphTime = now + this.morph.holdDuration + Math.random() * 1500;
        this.syncAmbientGlow(this.morph.currentIdx);
      }
    }

    // Mathematical clamping of eye group inside the active geometric boundary
    clampEyesToBoundary(targetX, targetY) {
      const w0 = this.morph.weights[0];
      const w1 = this.morph.weights[1];
      const w2 = this.morph.weights[2];

      // 1. Circle Boundary Constraint (radial limit)
      const dist = Math.hypot(targetX, targetY);
      const maxR = 0.50;
      const cX = dist > maxR ? targetX * (maxR / dist) : targetX;
      const cY = dist > maxR ? targetY * (maxR / dist) : targetY;

      // 2. Triangle Boundary Constraint (soft rounded triangle bounds)
      const tY = Math.max(-0.28, Math.min(0.40, targetY));
      const tNorm = (tY - -0.28) / (0.40 - -0.28); // 0 at bottom, 1 at apex
      const maxW = (1.0 - tNorm) * 0.44 + 0.16;
      const tX = Math.max(-maxW, Math.min(maxW, targetX));

      // 3. Squircle Boundary Constraint (comfortable corner boxes)
      const sqX = Math.max(-0.44, Math.min(0.44, targetX));
      const sqY = Math.max(-0.44, Math.min(0.44, targetY));

      // Continuous morph blending between the boundaries
      return {
        x: w0 * cX + w1 * tX + w2 * sqX,
        y: w0 * cY + w1 * tY + w2 * sqY,
      };
    }

    updateEyes(now) {
      if (!this.eyesGroup) return;

      // Mood expiry check
      if (this.moodUntil > 0 && now >= this.moodUntil) {
        this.mood = "idle";
        this.moodUntil = 0;
      }

      // 1. Autonomous blinking
      if (!this.eyes.isBlinking && now >= this.eyes.nextBlinkTime) {
        this.eyes.isBlinking = true;
        this.eyes.targetScaleY = 0.05; // squash shut
      }

      if (this.eyes.isBlinking) {
        this.eyes.scaleY += (this.eyes.targetScaleY - this.eyes.scaleY) * 0.45;
        if (this.eyes.scaleY < 0.12) {
          this.eyes.targetScaleY = 1.0; // snap open with bounce
        } else if (this.eyes.targetScaleY === 1.0 && this.eyes.scaleY > 0.95) {
          this.eyes.scaleY = 1.0;
          this.eyes.isBlinking = false;
          this.eyes.nextBlinkTime = now + 2400 + Math.random() * 3200;
        }
      }

      // 2. Compute Target Position based on Mood & Cursor
      let rawX = 0, rawY = 0;

      if (this.mood === "typing") {
        // Living Co-founder is attentively focused on user typing in the composer below
        rawX = this.mouse.nx * 0.18;
        rawY = -0.22 + this.mouse.ny * 0.08;
        this.eyes.targetScaleX = 1.15; // Curious wide eyes
        this.eyes.targetScaleY = this.eyes.isBlinking ? this.eyes.targetScaleY : 1.12;
      } else if (this.mood === "working") {
        // Focused scanning cadence across document / problem space
        rawX = Math.sin(now * 0.0035) * 0.28 + this.mouse.nx * 0.10;
        rawY = 0.06 + Math.cos(now * 0.002) * 0.04;
        this.eyes.targetScaleX = 0.95;
        this.eyes.targetScaleY = this.eyes.isBlinking ? this.eyes.targetScaleY : 0.92;
      } else if (this.mood === "celebrating") {
        // Joyful, lively look towards user
        rawX = this.mouse.nx * 0.40;
        rawY = 0.15 + this.mouse.ny * 0.20;
        this.eyes.targetScaleX = 1.18;
      } else {
        // Idle state: direct mouse tracking or gentle glancing
        this.eyes.targetScaleX = 1.0;
        const isMouseIdle = now - this.mouse.lastMoveTime > 1600;
        if (isMouseIdle && now >= this.eyes.nextGlanceTime) {
          const glanceOptions = [
            { x: 0.32, y: 0.26 },
            { x: -0.32, y: 0.26 },
            { x: -0.36, y: -0.24 },
            { x: 0.36, y: -0.24 },
            { x: 0.0, y: 0.32 },
            { x: 0.0, y: -0.26 },
            { x: -0.38, y: 0.0 },
            { x: 0.38, y: 0.0 },
            SHAPES[this.morph.currentIdx].defaultGlance,
          ];
          this.eyes.idleGlance = glanceOptions[Math.floor(Math.random() * glanceOptions.length)];
          this.eyes.nextGlanceTime = now + 3200 + Math.random() * 2600;
        }

        if (!isMouseIdle) {
          rawX = this.mouse.nx * 0.85;
          rawY = this.mouse.ny * 0.85;
        } else {
          rawX = this.eyes.idleGlance.x + this.mouse.nx * 0.22;
          rawY = this.eyes.idleGlance.y + this.mouse.ny * 0.22;
        }
      }

      // Smooth eye scale lerp
      this.eyes.scaleX += (this.eyes.targetScaleX - this.eyes.scaleX) * 0.15;
      this.leftEye.scale.x = this.eyes.scaleX;
      this.rightEye.scale.x = this.eyes.scaleX;
      this.leftEye.scale.y = this.eyes.scaleY;
      this.rightEye.scale.y = this.eyes.scaleY;

      // Strictly clamp inside active geometric boundary
      const clamped = this.clampEyesToBoundary(rawX, rawY);
      this.eyes.targetX = clamped.x;
      this.eyes.targetY = clamped.y;

      // Smooth organic lerp to target
      this.eyes.x += (this.eyes.targetX - this.eyes.x) * 0.15;
      this.eyes.y += (this.eyes.targetY - this.eyes.y) * 0.15;

      // Hug the front face with clean 2.5D planar depth
      const rSq = (this.eyes.x * this.eyes.x + this.eyes.y * this.eyes.y) / 1.8;
      const surfaceZ = Math.sqrt(Math.max(0.04, 1.0 - rSq)) * 0.24 + 0.035;

      this.eyesGroup.position.set(this.eyes.x, this.eyes.y, surfaceZ);

      // Subtle tilt aligned with surface contour
      this.eyesGroup.rotation.y = this.eyes.x * 0.18;
      this.eyesGroup.rotation.x = -this.eyes.y * 0.18;
    }

    updatePhysics(time) {
      if (!this.botGroup) return;

      // 1. Ambient Floating Harmonics (gentle breathing bob)
      let floatSpeed = 1.5;
      let floatAmp = 0.05;
      if (this.mood === "working") {
        floatSpeed = 3.2; // Rhythmic working pulse
        floatAmp = 0.07;
      } else if (this.mood === "typing") {
        floatSpeed = 1.1; // Calm attentive listening
        floatAmp = 0.03;
      }

      const floatY = Math.sin(time * floatSpeed) * floatAmp;
      const floatRotZ = Math.sin(time * 0.9) * 0.025;

      // 2. Mouse Orientation Tracking + Mode Tilt
      let extraTiltX = 0;
      if (this.mood === "typing") {
        extraTiltX = -0.12; // Attentive tilt forward to listen to typing
      }

      this.physics.targetRot.y = this.mouse.nx * 0.22;
      this.physics.targetRot.x = -this.mouse.ny * 0.16 + extraTiltX;
      this.physics.targetRot.z = floatRotZ - this.mouse.nx * 0.035 + (this.currentTilt || 0);

      // Spring lerp for rotation
      this.physics.rot.x += (this.physics.targetRot.x - this.physics.rot.x) * 0.09;
      this.physics.rot.y += (this.physics.targetRot.y - this.physics.rot.y) * 0.09;
      this.physics.rot.z += (this.physics.targetRot.z - this.physics.rot.z) * 0.09;

      // 3. Elastic Spring Scale (Squash-and-stretch damping)
      const springK = 0.18;
      const damping = 0.76;

      const fx = (1.0 - this.physics.scale.x) * springK;
      const fy = (1.0 - this.physics.scale.y) * springK;
      const fz = (1.0 - this.physics.scale.z) * springK;

      this.physics.scale.vx = (this.physics.scale.vx + fx) * damping;
      this.physics.scale.vy = (this.physics.scale.vy + fy) * damping;
      this.physics.scale.vz = (this.physics.scale.vz + fz) * damping;

      this.physics.scale.x += this.physics.scale.vx;
      this.physics.scale.y += this.physics.scale.vy;
      this.physics.scale.z += this.physics.scale.vz;

      // Position update with vertical float
      this.botGroup.position.set(0, floatY + this.physics.pos.y, 0);
      this.botGroup.rotation.set(
        this.physics.rot.x,
        this.physics.rot.y,
        this.physics.rot.z
      );
      this.botGroup.scale.set(
        this.physics.scale.x,
        this.physics.scale.y,
        this.physics.scale.z
      );
    }

    loop() {
      if (this.destroyed) return;
      const now = performance.now();
      const time = now * 0.001;

      // Smooth mouse lerping
      this.mouse.nx += (this.mouse.targetNx - this.mouse.nx) * 0.08;
      this.mouse.ny += (this.mouse.targetNy - this.mouse.ny) * 0.08;

      this.updateMorph(now);
      this.updateEyes(now);
      this.updatePhysics(time);

      if (this.renderer && this.scene && this.camera && (!this.root || this.root.isConnected)) {
        this.renderer.render(this.scene, this.camera);
      }
      this.rafId = requestAnimationFrame(this.loop);
    }

    bindEvents() {
      this.onPointerMove = (e) => {
        if (!this.root) return;
        const rect = this.root.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        const dx = e.clientX - cx;
        const dy = -(e.clientY - cy);

        this.mouse.lastMoveTime = performance.now();
        this.mouse.targetNx = Math.max(-1.0, Math.min(1.0, dx / (window.innerWidth * 0.45)));
        this.mouse.targetNy = Math.max(-1.0, Math.min(1.0, dy / (window.innerHeight * 0.45)));
      };

      this.onClick = () => {
        this.triggerRandomMorph();
      };

      this.onResize = () => {
        if (!this.renderer || !this.camera || !this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const w = rect.width || 280;
        const h = rect.height || 280;
        if (w !== this.width || h !== this.height) {
          this.width = w;
          this.height = h;
          this.camera.aspect = w / h;
          this.camera.updateProjectionMatrix();
          this.renderer.setSize(w, h, false);
        }
      };

      window.addEventListener("pointermove", this.onPointerMove, { passive: true });
      if (this.root) {
        this.root.addEventListener("click", this.onClick);
      }
      window.addEventListener("resize", this.onResize, { passive: true });

      // Automatically observe composer input for typing mood reaction
      const bindComposerListener = () => {
        const composer = document.getElementById("composer-input");
        if (!composer || composer._botMoodBound) return;
        composer._botMoodBound = true;
        composer.addEventListener("focus", () => this.setMood("typing"));
        composer.addEventListener("blur", () => {
          if (this.mood === "typing") this.setMood("idle");
        });
        composer.addEventListener("input", () => {
          this.setMood("typing");
          clearTimeout(this._typingTimeout);
          this._typingTimeout = setTimeout(() => {
            if (this.mood === "typing" && document.activeElement !== composer) {
              this.setMood("idle");
            }
          }, 2400);
        });
      };

      bindComposerListener();
      this.composerObserverTimer = setInterval(bindComposerListener, 1200);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.rafId);
      if (this.composerObserverTimer) clearInterval(this.composerObserverTimer);
      if (this.themeObserver) this.themeObserver.disconnect();
      window.removeEventListener("pointermove", this.onPointerMove);
      window.removeEventListener("resize", this.onResize);
      if (this.root) {
        this.root.removeEventListener("click", this.onClick);
      }
      if (this.renderer) {
        this.renderer.forceContextLoss();
        this.renderer.dispose();
      }
    }
  }

  // Export as GeometricBot, and alias MetallicBot / FluffyBot for full drop-in compatibility
  window.GeometricBot = {
    mount(container) {
      if (activeInstance && !activeInstance.destroyed && activeInstance.root) {
        if (container.contains(activeInstance.root)) {
          return activeInstance;
        }
        container.innerHTML = "";
        container.appendChild(activeInstance.root);
        activeInstance.container = container;
        return activeInstance;
      }
      if (activeInstance) activeInstance.destroy();
      activeInstance = new GeometricBot(container);
      return activeInstance;
    },
    getInstance() {
      return activeInstance;
    },
    setMood(mood, duration) {
      if (activeInstance) activeInstance.setMood(mood, duration);
    },
    celebrate() {
      if (activeInstance) activeInstance.celebrate();
    },
    setShape(idx) {
      if (activeInstance) activeInstance.setShape(idx);
    },
    getModes() {
      return SHAPES.map((s, idx) => ({
        index: idx,
        name: s.name,
        modeKey: s.modeKey,
        modeTitle: s.modeTitle,
        badgeText: s.badgeText,
        colorHex: s.colorHex,
      }));
    },
    getCurrentMode() {
      const idx = activeInstance ? activeInstance.morph.currentIdx : 0;
      return { index: idx, ...SHAPES[idx] };
    },
  };

  window.MetallicBot = window.GeometricBot;
  window.FluffyBot = window.GeometricBot;
})();
