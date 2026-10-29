// Orbit3D — High-Precision 3D Elliptical Orbital Engine
// Mathematically accurate, perspective-scaled, depth-sorted 3D orbital dynamics.
// Features: true elliptical projection, depth-based occlusion & scaling,
// momentum drag/swipe gestures, hover deceleration, and luminous orbital track.

(function () {
  let activeInstance = null;

  class OrbitEngine {
    constructor(container) {
      this.container = container;
      this.destroyed = false;
      this.rafId = 0;

      // Orbital parameters
      this.currentAngle = 0;
      this.targetSpeed = 0.0032; // ~32s per smooth revolution
      this.currentSpeed = this.targetSpeed;
      this.isHovered = false;
      this.isDragging = false;

      // Drag physics & momentum
      this.dragStartX = 0;
      this.dragPrevX = 0;
      this.dragVelocity = 0;
      this.lastDragTime = 0;

      // Geometrical cache
      this.cx = 0;
      this.cy = 0;
      this.rx = 160;
      this.ry = 60;
      this.tilt = -14; // degrees inclination diagonal

      this.initElements();
      this.updateDimensions();
      this.bindEvents();
      this.startLoop();
    }

    initElements() {
      this.sphere = this.container.querySelector(".orbit-sphere");
      this.carousel = this.container.querySelector(".orbit-carousel");
      this.cards = Array.from(this.container.querySelectorAll(".orbit-card"));

      // Ensure carousel is positioned at center
      if (this.carousel) {
        this.carousel.style.position = "absolute";
        this.carousel.style.left = "50%";
        this.carousel.style.top = "50%";
        this.carousel.style.width = "0";
        this.carousel.style.height = "0";
        this.carousel.style.pointerEvents = "none";
      }

      // Build or update glowing orbital track SVG
      let trackSvg = this.container.querySelector(".orbit-track-svg");
      if (!trackSvg) {
        trackSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        trackSvg.setAttribute("class", "orbit-track-svg");
        trackSvg.setAttribute("aria-hidden", "true");
        trackSvg.innerHTML = `
          <defs>
            <linearGradient id="orbit-track-glow" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#4ade80" stop-opacity="0.45" />
              <stop offset="50%" stop-color="#22c55e" stop-opacity="0.20" />
              <stop offset="100%" stop-color="#15803d" stop-opacity="0.40" />
            </linearGradient>
          </defs>
          <ellipse class="orbit-track-ellipse" />
        `;
        this.container.insertBefore(trackSvg, this.container.firstChild);
      }
      this.trackSvg = trackSvg;
      this.trackEllipse = trackSvg.querySelector(".orbit-track-ellipse");
    }

    updateDimensions() {
      if (this.destroyed) return;
      const rect = this.container.getBoundingClientRect();
      const w = rect.width || 380;
      const h = rect.height || 320;

      // True co-location with bot sphere center
      this.cx = w * 0.5;
      this.cy = h * 0.5;

      // Adaptive orbital radii scaling gracefully from mobile to large desktop
      if (w < 480) {
        // Mobile screens
        this.rx = Math.max(136, Math.min(168, w * 0.38));
        this.ry = Math.round(this.rx * 0.38);
        this.tilt = -12;
      } else if (w < 880) {
        // Tablet / Foldable
        this.rx = Math.max(170, Math.min(230, w * 0.32));
        this.ry = Math.round(this.rx * 0.39);
        this.tilt = -13;
      } else {
        // Desktop
        this.rx = Math.max(220, Math.min(310, w * 0.28));
        this.ry = Math.round(this.rx * 0.40);
        this.tilt = -14;
      }

      // Update orbital guide track SVG
      if (this.trackSvg && this.trackEllipse) {
        this.trackSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        this.trackEllipse.setAttribute("cx", this.cx);
        this.trackEllipse.setAttribute("cy", this.cy);
        this.trackEllipse.setAttribute("rx", this.rx);
        this.trackEllipse.setAttribute("ry", this.ry);
        this.trackEllipse.setAttribute("transform", `rotate(${this.tilt}, ${this.cx}, ${this.cy})`);
      }
    }

    bindEvents() {
      // 1. Mouse hover slowdown
      this.onMouseEnter = () => {
        this.isHovered = true;
      };
      this.onMouseLeave = () => {
        this.isHovered = false;
      };
      this.container.addEventListener("mouseenter", this.onMouseEnter);
      this.container.addEventListener("mouseleave", this.onMouseLeave);

      // 2. Drag / Swipe gestures with inertia
      this.onPointerDown = (e) => {
        // Ignore clicks directly inside interactive inputs or if multi-touch
        if (e.target.closest("input, textarea, select")) return;
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragPrevX = e.clientX;
        this.dragVelocity = 0;
        this.lastDragTime = performance.now();
        this.container.style.cursor = "grabbing";
      };

      this.onPointerMove = (e) => {
        if (!this.isDragging) return;
        const now = performance.now();
        const dt = Math.max(1, now - this.lastDragTime);
        const dx = e.clientX - this.dragPrevX;
        this.dragPrevX = e.clientX;
        this.lastDragTime = now;

        // Angle delta proportional to horizontal radius
        const deltaAngle = (dx / (this.rx * 1.8)) * Math.PI;
        this.currentAngle += deltaAngle;
        this.dragVelocity = deltaAngle / (dt / 16.67);
      };

      this.onPointerUp = () => {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.container.style.cursor = "";
      };

      this.container.addEventListener("pointerdown", this.onPointerDown);
      window.addEventListener("pointermove", this.onPointerMove, { passive: true });
      window.addEventListener("pointerup", this.onPointerUp);
      window.addEventListener("pointercancel", this.onPointerUp);

      // 3. Responsive resize handler
      this.onResize = () => {
        this.updateDimensions();
      };
      window.addEventListener("resize", this.onResize, { passive: true });
    }

    startLoop() {
      const radTilt = (this.tilt * Math.PI) / 180;
      const cosTilt = Math.cos(radTilt);
      const sinTilt = Math.sin(radTilt);
      const cardCount = this.cards.length || 6;

      const step = () => {
        if (this.destroyed) return;

        // Inertial physics update
        if (this.isDragging) {
          // Handled in pointermove
        } else {
          // Momentum damping
          if (Math.abs(this.dragVelocity) > 0.0001) {
            this.currentAngle += this.dragVelocity;
            this.dragVelocity *= 0.93;
          }

          // Gentle speed target: crawls softly when hovered, flows gracefully otherwise
          const targetSpd = this.isHovered ? 0.0006 : this.targetSpeed;
          this.currentSpeed += (targetSpd - this.currentSpeed) * 0.08;
          this.currentAngle += this.currentSpeed;
        }

        // Trigonometric placement for each card
        for (let i = 0; i < cardCount; i++) {
          const card = this.cards[i];
          if (!card) continue;

          // Phase angle for card i around the 360-degree circuit
          const angle = this.currentAngle + (i * 2 * Math.PI) / cardCount;

          // Elliptical coordinate on inclined plane
          const rawX = Math.cos(angle) * this.rx;
          const rawY = Math.sin(angle) * this.ry;
          const depthZ = Math.sin(angle); // -1 (deepest back) to +1 (closest front)

          // 2D projection rotation by tilt angle (inclination)
          const posX = rawX * cosTilt - rawY * sinTilt;
          const posY = rawX * sinTilt + rawY * cosTilt;

          // Normalized depth factor: 0.0 at furthest back, 1.0 at closest front
          const depthFactor = (depthZ + 1.0) * 0.5;

          // Perspective depth scaling & atmospheric lighting
          const scale = 0.84 + 0.20 * depthFactor; // 0.84 (back) -> 1.04 (front)
          const opacity = 0.58 + 0.42 * depthFactor; // 0.58 (back) -> 1.0 (front)

          // Strict Z-Index Layering:
          // Bot sphere is at z-index: 3.
          // Cards with depthZ < 0 MUST pass behind the bot (z-index: 1 or 2).
          // Cards with depthZ >= 0 MUST glide in front of the bot (z-index: 4 to 8).
          let zIndex;
          if (depthZ < 0) {
            zIndex = Math.floor(1 + depthFactor * 1.8); // 1 or 2
          } else {
            zIndex = Math.floor(4 + depthZ * 4.5); // 4 to 8
          }

          // Direct GPU-accelerated translate3d
          card.style.transform = `translate3d(calc(-50% + ${posX.toFixed(1)}px), calc(-50% + ${posY.toFixed(1)}px), 0) scale(${scale.toFixed(3)})`;
          card.style.zIndex = zIndex;
          card.style.opacity = opacity.toFixed(3);
        }

        this.rafId = requestAnimationFrame(step);
      };

      this.rafId = requestAnimationFrame(step);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.rafId);

      this.container.removeEventListener("mouseenter", this.onMouseEnter);
      this.container.removeEventListener("mouseleave", this.onMouseLeave);
      this.container.removeEventListener("pointerdown", this.onPointerDown);
      window.removeEventListener("pointermove", this.onPointerMove);
      window.removeEventListener("pointerup", this.onPointerUp);
      window.removeEventListener("pointercancel", this.onPointerUp);
      window.removeEventListener("resize", this.onResize);

      if (this.trackSvg && this.trackSvg.parentNode) {
        this.trackSvg.parentNode.removeChild(this.trackSvg);
      }

      if (activeInstance === this) {
        activeInstance = null;
      }
    }
  }

  window.Orbit3D = {
    mount(container) {
      if (!container) return null;
      if (activeInstance && !activeInstance.destroyed) {
        if (activeInstance.container === container) {
          activeInstance.updateDimensions();
          return activeInstance;
        }
        activeInstance.destroy();
      }
      activeInstance = new OrbitEngine(container);
      return activeInstance;
    },
    sync() {
      const container = document.querySelector(".orbit");
      if (!container) {
        if (activeInstance) activeInstance.destroy();
        return;
      }
      this.mount(container);
    },
    destroy() {
      if (activeInstance) {
        activeInstance.destroy();
        activeInstance = null;
      }
    },
  };
})();

