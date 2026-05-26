/**
 * Agent walker manager.
 *
 * Each broker feed spawns a walker that walks from the agent's hex card to the
 * brain center. Walking is REAL:
 *   - Speed in px/sec, scaled by feed intensity (no Math.random for motion)
 *   - Quadratic bezier path with a control point biased by sector
 *   - Step phase = total px travelled / step_length → leg swing matches pace
 *   - Leg/arm/body transforms set directly from JS (not CSS trig) so motion
 *     is guaranteed and inspectable in DevTools
 *   - Footprints emit ONCE per step (when step phase wraps), not per frame
 *   - Direction-aware: sprite flips horizontally to face heading
 *   - Speech bubble carries the actual payload summary from the broker
 */
import './AgentSprite.css';

const STEP_LENGTH_PX = 22;           // a stride covers 2 * STEP_LENGTH_PX
const BASE_SPEED_PX_S = 180;         // at intensity 1.0 (~brisk walk)
const MIN_SPEED_PX_S = 75;           // floor for intensity 0 (casual stroll)
const LEG_SWING_DEG = 38;            // max leg rotation
const ARM_SWING_DEG = 26;            // arms swing opposite to legs

const SECTOR_ARC = {
  PREFRONTAL:     { dx: 0,    dy: -120 },
  CONCEPT_LAYER:  { dx: -40,  dy: -80 },
  SENSORY_CORTEX: { dx: 80,   dy: -40 },
  TEMPORAL:       { dx: -100, dy: 0    },
  PARIETAL:       { dx: 0,    dy: -140 },
  OCCIPITAL:      { dx: 0,    dy: 60   },
  HIPPOCAMPUS:    { dx: -60,  dy: 80   },
  CEREBELLUM:     { dx: -90,  dy: 40   },
};

function bezier(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function bezierLength(p0, p1, p2, samples = 24) {
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= samples; i++) {
    const p = bezier(p0, p1, p2, i / samples);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

export class AgentSpriteManager {
  constructor(container) {
    this.container = container;
    this.walkers = [];
    this._raf = null;
    this._lastTime = 0;
  }

  spawnMovingAgent(name, color, startVec, targetVec, feedData) {
    const sectorArc = SECTOR_ARC[feedData?.targetSector] || { dx: 0, dy: -80 };
    const ctrl = {
      x: (startVec.x + targetVec.x) / 2 + sectorArc.dx,
      y: (startVec.y + targetVec.y) / 2 + sectorArc.dy,
    };
    const pathLength = Math.max(40, bezierLength(startVec, ctrl, targetVec));
    const intensity = Math.max(0, Math.min(1, feedData?.intensity ?? 0.5));
    const speed = MIN_SPEED_PX_S + (BASE_SPEED_PX_S - MIN_SPEED_PX_S) * intensity;

    // Build sprite DOM
    const el = document.createElement('div');
    el.className = 'agent-walker';
    el.style.left = `${startVec.x}px`;
    el.style.top = `${startVec.y}px`;
    el.style.setProperty('--agent-color', color);
    el.style.setProperty('--shadow-color', color + '88');

    el.innerHTML = `
      <div class="walker-shadow"></div>
      <div class="walker-leg left"></div>
      <div class="walker-leg right"></div>
      <div class="walker-body"></div>
      <div class="walker-arm left"></div>
      <div class="walker-arm right"></div>
      <div class="walker-head"></div>
      <div class="walker-eye"></div>
      <div class="walker-payload"></div>
      <div class="walker-label">${escapeHtml(name)}</div>
    `;

    // Bubble starts as a thinking placeholder; agent-mind replaces it via
    // updateBubbleForFeed() when the LLM thought arrives.
    const bubble = document.createElement('div');
    bubble.className = 'walker-bubble';
    bubble.textContent = '...';
    bubble.dataset.thinking = '1';
    el.appendChild(bubble);

    this.container.appendChild(el);

    // Cache part refs so we don't requery every frame
    const parts = {
      legL:  el.querySelector('.walker-leg.left'),
      legR:  el.querySelector('.walker-leg.right'),
      armL:  el.querySelector('.walker-arm.left'),
      armR:  el.querySelector('.walker-arm.right'),
      body:  el.querySelector('.walker-body'),
      head:  el.querySelector('.walker-head'),
      shadow:el.querySelector('.walker-shadow'),
    };

    this.walkers.push({
      el, parts, bubble,
      start: { ...startVec },
      ctrl,
      target: { ...targetVec },
      pathLength,
      distance: 0,
      speed,
      lastStepDistance: 0,
      lastX: startVec.x,
      lastY: startVec.y,
      face: 1,
      color,
      feedData,
      feedId: feedData?.id,
    });

    if (this._raf == null) this._startLoop();
  }

  _startLoop() {
    this._lastTime = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.1, (now - this._lastTime) / 1000);
      this._lastTime = now;
      this._update(dt);
      if (this.walkers.length > 0) {
        this._raf = requestAnimationFrame(loop);
      } else {
        this._raf = null;
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  _update(dt) {
    for (let i = this.walkers.length - 1; i >= 0; i--) {
      const w = this.walkers[i];

      w.distance += w.speed * dt;
      const t = Math.min(1, w.distance / w.pathLength);
      const pos = bezier(w.start, w.ctrl, w.target, t);

      // Facing (from previous frame movement)
      const dx = pos.x - w.lastX;
      if (Math.abs(dx) > 0.15) {
        w.face = dx >= 0 ? 1 : -1;
        // Flip the body horizontally via scaleX on the inner parts only
        w.el.style.setProperty('--face', String(w.face));
      }

      // Step phase in [0, 1), advances by distance/STEP_LENGTH_PX
      const phase = (w.distance / STEP_LENGTH_PX) % 1;
      const swing = Math.sin(phase * Math.PI * 2);           // -1..1
      const bob   = Math.abs(Math.sin(phase * Math.PI * 2)); // 0..1 (twice per stride)

      // Drive transforms directly from JS — no CSS trig dependency
      const legAngle = swing * LEG_SWING_DEG * w.face;
      const armAngle = -swing * ARM_SWING_DEG * w.face;
      const bobY = -bob * 1.1;

      if (w.parts.legL) w.parts.legL.style.transform = `rotate(${legAngle}deg)`;
      if (w.parts.legR) w.parts.legR.style.transform = `rotate(${-legAngle}deg)`;
      if (w.parts.armL) w.parts.armL.style.transform = `rotate(${armAngle}deg)`;
      if (w.parts.armR) w.parts.armR.style.transform = `rotate(${-armAngle}deg)`;
      if (w.parts.body) w.parts.body.style.transform = `translateY(${bobY}px) scaleX(${w.face})`;
      if (w.parts.head) w.parts.head.style.transform = `translateY(${bobY}px) scaleX(${w.face})`;
      if (w.parts.shadow) {
        const sScale = 1 + 0.12 * Math.sin(phase * Math.PI * 2);
        w.parts.shadow.style.transform = `translateX(-50%) scaleX(${sScale})`;
      }

      w.el.style.left = `${pos.x}px`;
      w.el.style.top  = `${pos.y}px`;

      // Footprint: one drop per half-stride
      const halfStride = STEP_LENGTH_PX;
      if (w.distance - w.lastStepDistance >= halfStride) {
        const strideIdx = Math.floor(w.distance / halfStride);
        const footOffset = strideIdx % 2 === 0 ? -2 : 2;
        const heading = Math.atan2(pos.y - w.lastY, pos.x - w.lastX);
        const perpX = -Math.sin(heading) * footOffset;
        const perpY =  Math.cos(heading) * footOffset;
        this._emitFootprint(pos.x + perpX, pos.y + perpY + 6, heading, w.color);
        w.lastStepDistance += halfStride;
      }

      w.lastX = pos.x;
      w.lastY = pos.y;

      // Fade-out in the last 15%
      if (t > 0.85) {
        w.el.style.opacity = String(Math.max(0, 1 - (t - 0.85) / 0.15));
      }

      if (t >= 1) {
        this._arrival(w);
        w.el.remove();
        this.walkers.splice(i, 1);
      }
    }
  }

  _emitFootprint(x, y, heading, color) {
    const fp = document.createElement('div');
    fp.className = 'agent-footprint';
    fp.style.left = `${x}px`;
    fp.style.top = `${y}px`;
    fp.style.setProperty('--print-color', color);
    fp.style.setProperty('--print-rot', `${(heading * 180) / Math.PI}deg`);
    this.container.appendChild(fp);
    setTimeout(() => fp.remove(), 1800);
  }

  _arrival(w) {
    const flash = document.createElement('div');
    flash.className = 'sprite-impact-flash';
    flash.style.left = `${w.target.x}px`;
    flash.style.top = `${w.target.y}px`;
    flash.style.setProperty('--flash-color', w.color);
    this.container.appendChild(flash);
    setTimeout(() => flash.remove(), 650);

    window.dispatchEvent(new CustomEvent('synapse-impact', {
      detail: {
        position: w.target,
        feedData: w.feedData,
      },
    }));
  }

  /**
   * Called when agent-mind generates a thought for a feed. Finds the live
   * walker carrying that feedId and swaps its bubble text. If the walker has
   * already arrived/expired, the thought is silently dropped.
   */
  updateBubbleForFeed(feedId, thought) {
    if (!feedId || !thought) return;
    for (const w of this.walkers) {
      if (w.feedId === feedId && w.bubble) {
        w.bubble.textContent = thought;
        w.bubble.dataset.thinking = '0';
        // Brief re-fade so the new text reads as a thought arriving
        w.bubble.style.animation = 'none';
        // eslint-disable-next-line no-unused-expressions
        w.bubble.offsetWidth; // force reflow so the animation can re-trigger
        w.bubble.style.animation = 'bubble-fade 400ms ease-out forwards';
        return;
      }
    }
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    for (const w of this.walkers) w.el.remove();
    this.walkers = [];
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
