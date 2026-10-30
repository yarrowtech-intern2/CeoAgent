// Metallic Bot — High-Fidelity 3D WebGL Metallic Co-Founder Assistant
// Pure procedural Three.js geometry, PBR physical metallic shaders, studio lighting,
// dynamic curved OLED visor, 3D glowing LED capsule eyes, screen-wide cursor tracking,
// autonomous glancing/blinking, and elastic spring physics. ZERO IMAGES & ZERO RINGS.

(function () {
  if (window.GeometricBot) {
    window.MetallicBot = window.GeometricBot;
    window.FluffyBot = window.GeometricBot;
    return;
  }
  let activeInstance = null;

  class MetallicBot {
    constructor(container) {
      this.container = container;
      this.destroyed = false;
      this.rafId = 0;

      // Cursor tracking across viewport
      this.mouse = {
        x: 0, y: 0,
        nx: 0, ny: 0, // normalized [-1, 1] relative to bot center
        vx: 0, vy: 0,
      };
      this.isHovered = false; // directly over the bot sphere
      this.isMouseDown = false;
      this.lastMouseMoveTime = performance.now();

      // Spring-mass-damper physics
      this.physics = {
        pos: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
        scale: { x: 1, y: 1, z: 1, vx: 0, vy: 0, vz: 0 },
        rot: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
        targetRot: { x: 0, y: 0, z: 0 },
      };

      // Eyes state & autonomous timing
      this.eyes = {
        x: 0, y: 0,
        targetX: 0, targetY: 0,
        scaleY: 1,
        isBlinking: false,
        winkR: 0, // 0 = open, 1 = wink
        nextBlinkTime: performance.now() + 2200,
        nextGlanceTime: performance.now() + 2000,
      };

      // DOM init
      this.initDOM();
      this.initThree();
      this.bindEvents();
    }

    initDOM() {
      this.container.innerHTML = `
        <div class="metallic-bot-root" id="metallic-bot-root" role="button" aria-label="3D Metallic CEO Bot">
          <canvas class="metallic-bot-canvas"></canvas>
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
      this.width = rect.width || 220;
      this.height = rect.height || 220;

      // 1. Scene & Camera
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(36, this.width / this.height, 0.1, 50);
      this.camera.position.set(0, 0, 4.4);

      // 2. Renderer
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
      this.renderer.toneMappingExposure = 1.3;
      this.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
      }, false);

      // 3. Build 3D Metallic Meshes & 3D Glowing Eyes (NO RINGS & NO BEZEL)
      this.buildBotModel();

      // 4. Lighting Studio
      this.buildLighting();

      // 5. Theme adaptation
      this.updateThemeColors();
      this.themeObserver = new MutationObserver(() => this.updateThemeColors());
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      // Start loop
      this.loop = this.loop.bind(this);
      this.rafId = requestAnimationFrame(this.loop);
    }

    buildBotModel() {
      const THREE = this.THREE;

      // Master hierarchy
      this.botGroup = new THREE.Group();
      this.scene.add(this.botGroup);

      // 1. Main Metallic Sphere Body
      const bodyGeom = new THREE.SphereGeometry(1.0, 64, 48);
      this.bodyMat = new THREE.MeshPhysicalMaterial({
        color: 0xe4e1f7,
        metalness: 0.58,
        roughness: 0.22,
        clearcoat: 1.0,
        clearcoatRoughness: 0.10,
        reflectivity: 0.95,
      });
      this.bodyMesh = new THREE.Mesh(bodyGeom, this.bodyMat);
      this.botGroup.add(this.bodyMesh);

      // 2. Visor Screen Face (mounted seamlessly on the front surface of the sphere — NO OUTER RING/BEZEL)
      this.visorGroup = new THREE.Group();
      this.visorGroup.position.set(0.12, -0.02, 0.92);
      this.visorGroup.rotation.set(-0.05, 0.14, -0.08);
      this.botGroup.add(this.visorGroup);

      // Curved Ellipse Visor Screen
      const shape = new THREE.Shape();
      const rx = 0.54; // horizontal radius
      const ry = 0.40; // vertical radius
      shape.absellipse(0, 0, rx, ry, 0, Math.PI * 2, false, 0);

      const visorGeom = new THREE.ShapeGeometry(shape, 48);
      const pos = visorGeom.attributes.position;
      const R = 1.018;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const dSq = x * x + y * y;
        const z = Math.sqrt(Math.max(0, R * R - dSq)) - R;
        pos.setZ(i, z + 0.02);
      }
      visorGeom.computeVertexNormals();

      this.visorMat = new THREE.MeshPhysicalMaterial({
        color: 0x05040a,
        metalness: 0.25,
        roughness: 0.03,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        side: THREE.DoubleSide,
      });
      this.visorMesh = new THREE.Mesh(visorGeom, this.visorMat);
      this.visorGroup.add(this.visorMesh);

      // 3. 3D Glowing Capsule LED Eyes (Substantially Enlarged & Expressive)
      this.eyesGroup = new THREE.Group();
      this.eyesGroup.position.set(0, 0, 0.035);
      this.visorGroup.add(this.eyesGroup);

      const createCapsuleEye = () => {
        const eyeObj = new THREE.Group();

        // Inner brilliant white core (enlarged)
        const coreGeom = new THREE.CapsuleGeometry(0.078, 0.20, 16, 24);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const coreMesh = new THREE.Mesh(coreGeom, coreMat);
        eyeObj.add(coreMesh);

        // Neon lavender glowing halo (enlarged)
        const haloGeom = new THREE.CapsuleGeometry(0.102, 0.22, 16, 24);
        const haloMat = new THREE.MeshBasicMaterial({
          color: 0xfb923c,
          transparent: true,
          opacity: 0.68,
          blending: THREE.AdditiveBlending,
        });
        const haloMesh = new THREE.Mesh(haloGeom, haloMat);
        eyeObj.add(haloMesh);

        // Outer electric purple bloom (enlarged)
        const bloomGeom = new THREE.CapsuleGeometry(0.132, 0.24, 16, 24);
        const bloomMat = new THREE.MeshBasicMaterial({
          color: 0xea7a35,
          transparent: true,
          opacity: 0.38,
          blending: THREE.AdditiveBlending,
        });
        const bloomMesh = new THREE.Mesh(bloomGeom, bloomMat);
        eyeObj.add(bloomMesh);

        return eyeObj;
      };

      this.leftEye = createCapsuleEye();
      this.leftEye.position.set(-0.165, 0, 0);
      this.eyesGroup.add(this.leftEye);

      this.rightEye = createCapsuleEye();
      this.rightEye.position.set(0.165, 0, 0);
      this.eyesGroup.add(this.rightEye);

      // Eye point light that illuminates the visor face
      this.eyeLight = new THREE.PointLight(0xf97316, 2.2, 3.0);
      this.eyeLight.position.set(0, 0, 0.12);
      this.eyesGroup.add(this.eyeLight);
    }

    buildLighting() {
      const THREE = this.THREE;

      // Key light: bright crisp specular highlight
      this.keyLight = new THREE.DirectionalLight(0xffffff, 3.6);
      this.keyLight.position.set(-3.5, 4.0, 4.0);
      this.scene.add(this.keyLight);

      // Rim light: electric lavender/purple edge contour
      this.rimLight = new THREE.DirectionalLight(0xea7a35, 3.2);
      this.rimLight.position.set(3.5, -2.0, -3.5);
      this.scene.add(this.rimLight);

      // Fill light: celestial blue soft reflections
      this.fillLight = new THREE.PointLight(0x60a5fa, 1.8, 12);
      this.fillLight.position.set(-2.5, -3.0, 2.5);
      this.scene.add(this.fillLight);

      // Visor specular light: crisp reflection on the dark glass
      this.glassLight = new THREE.PointLight(0xffffff, 1.6, 6);
      this.glassLight.position.set(0.6, 0.8, 2.8);
      this.scene.add(this.glassLight);

      // Ambient environment fill
      this.ambientLight = new THREE.AmbientLight(0xc2bcaf, 2.0);
      this.scene.add(this.ambientLight);
    }

    updateThemeColors() {
      if (!this.THREE || !this.bodyMat) return;
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";

      if (isDark) {
        // Dark theme: Sleek Gunmetal / Titanium Chrome
        this.bodyMat.color.setHex(0x232226);
        this.bodyMat.metalness = 0.65;
        this.bodyMat.roughness = 0.26;
        this.bodyMat.clearcoat = 1.0;
        this.bodyMat.clearcoatRoughness = 0.12;
        this.ambientLight.color.setHex(0x2c2622);
        this.ambientLight.intensity = 1.6;
        this.keyLight.intensity = 3.0;
        this.rimLight.color.setHex(0xea7a35);
        this.rimLight.intensity = 4.0;
      } else {
        // Light theme: Gleaming Liquid Chrome / Platinum Silver
        this.bodyMat.color.setHex(0xe4e1f7);
        this.bodyMat.metalness = 0.58;
        this.bodyMat.roughness = 0.22;
        this.bodyMat.clearcoat = 1.0;
        this.bodyMat.clearcoatRoughness = 0.10;
        this.ambientLight.color.setHex(0xa39ec4);
        this.ambientLight.intensity = 2.0;
        this.keyLight.intensity = 3.6;
        this.rimLight.color.setHex(0xa855f7);
        this.rimLight.intensity = 3.2;
      }
    }

    bindEvents() {
      // Screen-wide cursor tracking
      this.onPointerMove = (e) => {
        this.lastMouseMoveTime = performance.now();

        const rect = this.canvas.getBoundingClientRect();
        const cx = rect.left + rect.width * 0.5;
        const cy = rect.top + rect.height * 0.5;

        const dx = e.clientX - cx;
        const dy = e.clientY - cy;

        // Velocity tracking for physics
        this.mouse.vx = (dx - this.mouse.x) * 0.7;
        this.mouse.vy = (dy - this.mouse.y) * 0.7;
        this.mouse.x = dx;
        this.mouse.y = dy;

        // Viewport-wide normalized cursor direction [-1, 1]
        const rangeX = Math.max(window.innerWidth * 0.45, 320);
        const rangeY = Math.max(window.innerHeight * 0.45, 320);
        const nx = Math.max(-1, Math.min(1, dx / rangeX));
        const ny = Math.max(-1, Math.min(1, dy / rangeY));

        this.mouse.nx = nx;
        this.mouse.ny = ny;

        // Direct proximity / hover over the bot sphere
        const dist = Math.hypot(dx, dy);
        const radius = rect.width * 0.5;
        this.isHovered = dist < (radius + 35);

        if (this.isHovered) {
          this.root.setAttribute("data-mood", "active");
        } else {
          this.root.setAttribute("data-mood", "idle");
        }

        // Active cursor following (always follows across the screen)
        // 3D Head rotation:
        // Horizontal: turns right when cursor is right (+nx -> +Y rot), left when cursor is left (-nx -> -Y rot)
        this.physics.targetRot.y = nx * 0.72;
        // Vertical: tilts DOWN when cursor is down (+ny -> +X rot), tilts UP when cursor is up (-ny -> -X rot)
        this.physics.targetRot.x = ny * 0.48;
        // Natural banking roll
        this.physics.targetRot.z = -nx * 0.14;

        // 3D Capsule Eyes shift within the visor:
        // Look right when cursor is right, left when left
        this.eyes.targetX = nx * 0.95;
        // Look up when cursor is up (-ny < 0 -> +Y), down when cursor is down (+ny > 0 -> -Y)
        this.eyes.targetY = -ny * 0.85;

        // Drag displacement when holding pointer
        if (this.isMouseDown) {
          this.physics.pos.x = nx * 0.22;
          this.physics.pos.y = -ny * 0.22;
        }
      };

      this.onPointerDown = () => {
        this.isMouseDown = true;
        // Squishy spring bounce jiggle
        this.physics.scale.vy -= 0.38;
        this.physics.scale.vx += 0.28;
        this.physics.scale.vz += 0.28;
        this.physics.rot.vx += (Math.random() - 0.5) * 0.4;

        // Playful eye wink on click
        this.eyes.winkR = 1.0;
        setTimeout(() => { this.eyes.winkR = 0; }, 450);
      };

      this.onPointerUp = () => {
        this.isMouseDown = false;
        // Elastic snap-back
        this.physics.scale.vy += 0.45;
        this.physics.scale.vx -= 0.32;
        this.physics.scale.vz -= 0.32;
      };

      this.onResize = () => {
        if (!this.renderer || !this.camera) return;
        const rect = this.canvas.getBoundingClientRect();
        this.width = rect.width || 220;
        this.height = rect.height || 220;
        this.camera.aspect = this.width / this.height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.width, this.height, false);
      };

      this.onPointerLeave = () => {
        this.isHovered = false;
        this.root.setAttribute("data-mood", "idle");
        this.physics.targetRot.x = 0;
        this.physics.targetRot.y = 0;
        this.physics.targetRot.z = 0;
        this.eyes.targetX = 0;
        this.eyes.targetY = 0;
      };

      window.addEventListener("pointermove", this.onPointerMove, { passive: true });
      window.addEventListener("pointerup", this.onPointerUp, { passive: true });
      document.addEventListener("mouseleave", this.onPointerLeave);
      window.addEventListener("resize", this.onResize);
      this.root.addEventListener("pointerdown", this.onPointerDown);
    }

    updatePhysics(time) {
      // Spring stiffness & damping
      const k = 0.16;
      const d = 0.82;

      // 1. Scale Spring (recovers to 1, 1, 1)
      const axScaleX = -k * (this.physics.scale.x - 1) - d * this.physics.scale.vx;
      const axScaleY = -k * (this.physics.scale.y - 1) - d * this.physics.scale.vy;
      const axScaleZ = -k * (this.physics.scale.z - 1) - d * this.physics.scale.vz;
      this.physics.scale.vx += axScaleX;
      this.physics.scale.vy += axScaleY;
      this.physics.scale.vz += axScaleZ;
      this.physics.scale.x += this.physics.scale.vx * 0.65;
      this.physics.scale.y += this.physics.scale.vy * 0.65;
      this.physics.scale.z += this.physics.scale.vz * 0.65;

      // 2. Position Spring (recovers to 0, 0, 0)
      if (!this.isMouseDown) {
        const axPosX = -k * this.physics.pos.x - d * this.physics.pos.vx;
        const axPosY = -k * this.physics.pos.y - d * this.physics.pos.vy;
        this.physics.pos.vx += axPosX;
        this.physics.pos.vy += axPosY;
        this.physics.pos.x += this.physics.pos.vx * 0.6;
        this.physics.pos.y += this.physics.pos.vy * 0.6;
      }

      // 3. Rotation Spring toward target
      const axRotX = -k * (this.physics.rot.x - this.physics.targetRot.x) - d * this.physics.rot.vx;
      const axRotY = -k * (this.physics.rot.y - this.physics.targetRot.y) - d * this.physics.rot.vy;
      const axRotZ = -k * (this.physics.rot.z - this.physics.targetRot.z) - d * this.physics.rot.vz;
      this.physics.rot.vx += axRotX;
      this.physics.rot.vy += axRotY;
      this.physics.rot.vz += axRotZ;
      this.physics.rot.x += this.physics.rot.vx * 0.6;
      this.physics.rot.y += this.physics.rot.vy * 0.6;
      this.physics.rot.z += this.physics.rot.vz * 0.6;

      // 4. Autonomous Looking & Blinking (only when mouse is inactive for > 3.2s)
      const now = performance.now();
      const isMouseInactive = (now - this.lastMouseMoveTime) > 3200;

      if (isMouseInactive && !this.isHovered) {
        if (now > this.eyes.nextGlanceTime) {
          const glances = [
            { x: 0, y: 0, rotY: 0, rotX: 0 },
            { x: -0.85, y: 0, rotY: -0.25, rotX: 0 },       // look left
            { x: 0.85, y: 0, rotY: 0.25, rotX: 0 },        // look right
            { x: 0, y: 0.7, rotY: 0, rotX: -0.18 },        // look up
            { x: 0, y: -0.7, rotY: 0, rotX: 0.18 },        // look down
            { x: -0.6, y: 0.5, rotY: -0.18, rotX: -0.14 }, // top-left
            { x: 0.6, y: 0.5, rotY: 0.18, rotX: -0.14 },   // top-right
            { x: -0.5, y: -0.5, rotY: -0.14, rotX: 0.14 }, // bottom-left
          ];
          const g = glances[Math.floor(Math.random() * glances.length)];
          this.eyes.targetX = g.x;
          this.eyes.targetY = g.y;
          this.physics.targetRot.y = g.rotY;
          this.physics.targetRot.x = g.rotX;
          this.physics.targetRot.z = 0;
          this.eyes.nextGlanceTime = now + 1800 + Math.random() * 2400;
        }
      }

      // Smooth eye position lerp
      this.eyes.x += (this.eyes.targetX - this.eyes.x) * 0.16;
      this.eyes.y += (this.eyes.targetY - this.eyes.y) * 0.16;

      // Natural autonomous blinking
      if (now > this.eyes.nextBlinkTime && !this.eyes.isBlinking) {
        this.eyes.isBlinking = true;
        this.eyes.scaleY = 0.04;
        setTimeout(() => {
          this.eyes.scaleY = 1.0;
          if (Math.random() < 0.32) {
            setTimeout(() => {
              this.eyes.scaleY = 0.04;
              setTimeout(() => { this.eyes.scaleY = 1.0; this.eyes.isBlinking = false; }, 90);
            }, 125);
          } else {
            this.eyes.isBlinking = false;
          }
        }, 95);
        this.eyes.nextBlinkTime = now + 3200 + Math.random() * 3200;
      }

      // 5. Update 3D Capsule Eyes position and scale
      if (this.leftEye && this.rightEye) {
        const eyeShiftX = this.eyes.x * 0.07;
        const eyeShiftY = this.eyes.y * 0.055;
        this.leftEye.position.set(-0.165 + eyeShiftX, eyeShiftY, 0);
        this.rightEye.position.set(0.165 + eyeShiftX, eyeShiftY, 0);

        // When directly hovered, eyes slightly widen in joy
        const hoverWiden = this.isHovered ? 1.15 : 1.0;
        const leftScaleY = Math.max(0.04, this.eyes.scaleY * hoverWiden);
        const rightScaleY = Math.max(0.04, this.eyes.scaleY * (1.0 - this.eyes.winkR) * hoverWiden);
        this.leftEye.scale.set(1.0, leftScaleY, 1.0);
        this.rightEye.scale.set(1.0, rightScaleY, 1.0);
      }

      // 6. Apply transforms to 3D meshes (Pristine Metallic Sphere without rings)
      if (this.botGroup) {
        const floatY = Math.sin(time * 2.2) * 0.06;
        this.botGroup.position.set(
          this.physics.pos.x,
          this.physics.pos.y + floatY,
          this.physics.pos.z
        );
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
    }

    loop() {
      if (this.destroyed) return;
      const time = performance.now() * 0.001;
      this.updatePhysics(time);
      if (this.renderer && this.scene && this.camera && (!this.root || this.root.isConnected)) {
        this.renderer.render(this.scene, this.camera);
      }
      this.rafId = requestAnimationFrame(this.loop);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.rafId);
      if (this.themeObserver) this.themeObserver.disconnect();
      window.removeEventListener("pointermove", this.onPointerMove);
      window.removeEventListener("pointerup", this.onPointerUp);
      document.removeEventListener("mouseleave", this.onPointerLeave);
      window.removeEventListener("resize", this.onResize);
      if (this.renderer) {
        this.renderer.forceContextLoss();
        this.renderer.dispose();
      }
    }
  }

  // Export both MetallicBot and FluffyBot for seamless drop-in compatibility
  window.MetallicBot = {
    mount(container) {
      // If we already have an active instance, reuse it and preserve the WebGL context
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
      activeInstance = new MetallicBot(container);
      return activeInstance;
    },
    getInstance() {
      return activeInstance;
    },
  };
  window.FluffyBot = window.MetallicBot;
})();
