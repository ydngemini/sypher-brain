export class AgentSpriteManager {
  constructor(container) {
    this.container = container;
    this.activeAgents = [];
    this._raf = null;
    this._running = false;
  }

  spawnMovingAgent(name, color, startVec, targetVec, feedData) {
    const el = document.createElement('div');
    el.className = 'moving-agent-sprite';
    el.innerText = name;
    el.style.color = color;
    el.style.textShadow = `0 0 8px ${color}, 0 0 16px ${color}44`;

    el.style.left = `${startVec.x}px`;
    el.style.top = `${startVec.y}px`;

    this.container.appendChild(el);

    this.activeAgents.push({
      element: el,
      progress: 0,
      speed: 0.008 + Math.random() * 0.004,
      start: startVec,
      target: targetVec,
      driftY: (Math.random() - 0.5) * 40,
      driftX: (Math.random() - 0.5) * 20,
      feedData,
    });

    if (!this._running) this._startLoop();
  }

  _startLoop() {
    this._running = true;
    const loop = () => {
      this._update();
      if (this.activeAgents.length > 0) {
        this._raf = requestAnimationFrame(loop);
      } else {
        this._running = false;
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  _update() {
    for (let i = this.activeAgents.length - 1; i >= 0; i--) {
      const agent = this.activeAgents[i];
      agent.progress += agent.speed;

      const t = agent.progress;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      let currentX = agent.start.x + (agent.target.x - agent.start.x) * ease;
      let currentY = agent.start.y + (agent.target.y - agent.start.y) * ease;

      currentY += Math.sin(t * Math.PI) * agent.driftY;
      currentX += Math.sin(t * Math.PI * 1.5) * agent.driftX;

      agent.element.style.left = `${currentX}px`;
      agent.element.style.top = `${currentY}px`;

      const scale = 1.0 - t * 0.3;
      const opacity = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
      agent.element.style.transform = `translate(-50%, -50%) scale(${scale})`;
      agent.element.style.opacity = opacity;

      if (agent.progress >= 1) {
        this._triggerCoreImpact(agent);
        agent.element.remove();
        this.activeAgents.splice(i, 1);
      }
    }
  }

  _triggerCoreImpact(agent) {
    // Spawn 2D flash at arrival point
    const flash = document.createElement('div');
    flash.className = 'sprite-impact-flash';
    flash.style.left = `${agent.target.x}px`;
    flash.style.top = `${agent.target.y}px`;
    flash.style.color = agent.element.style.color;
    flash.style.background = agent.element.style.color;
    this.container.appendChild(flash);
    setTimeout(() => flash.remove(), 650);

    window.dispatchEvent(new CustomEvent('synapse-impact', {
      detail: {
        position: agent.target,
        feedData: agent.feedData,
      }
    }));
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const agent of this.activeAgents) {
      agent.element.remove();
    }
    this.activeAgents = [];
    this._running = false;
  }
}
