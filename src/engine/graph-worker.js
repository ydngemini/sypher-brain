self.onmessage = function (e) {
  const { type, nodes, associations, attractorPos } = e.data;

  if (type === 'COMPUTE_GRAVITY_PULL') {
    const updatedNodes = structuredClone(nodes);

    for (const assoc of associations) {
      const sourceIdx = updatedNodes.findIndex(n =>
        n.label.toLowerCase().includes(assoc.sourceNode?.toLowerCase())
      );
      const targetIdx = updatedNodes.findIndex(n =>
        n.label.toLowerCase().includes(assoc.targetNode?.toLowerCase())
      );

      if (sourceIdx >= 0 && targetIdx >= 0) {
        const src = updatedNodes[sourceIdx];
        const tgt = updatedNodes[targetIdx];
        const pullStrength = assoc.weight * 0.15;

        const dx = tgt.position[0] - src.position[0];
        const dy = tgt.position[1] - src.position[1];
        const dz = tgt.position[2] - src.position[2];

        src.position[0] += dx * pullStrength;
        src.position[1] += dy * pullStrength;
        src.position[2] += dz * pullStrength;

        src.glow = Math.min(src.glow + 0.3, 1.0);
        tgt.glow = Math.min(tgt.glow + 0.3, 1.0);
      } else if (sourceIdx >= 0 && attractorPos) {
        const src = updatedNodes[sourceIdx];
        const pullStrength = (assoc.weight || 0.5) * 0.08;

        src.position[0] += (attractorPos[0] - src.position[0]) * pullStrength;
        src.position[1] += (attractorPos[1] - src.position[1]) * pullStrength;
        src.position[2] += (attractorPos[2] - src.position[2]) * pullStrength;
        src.glow = Math.min(src.glow + 0.2, 1.0);
      }
    }

    self.postMessage({ type: 'GRAVITY_COMPUTED', updatedNodes });
  }

  if (type === 'COMPUTE_REPULSION') {
    const updatedNodes = structuredClone(nodes);
    const repulsionStrength = 0.02;
    const minDist = 0.15;

    for (let i = 0; i < updatedNodes.length; i++) {
      for (let j = i + 1; j < updatedNodes.length; j++) {
        const a = updatedNodes[i];
        const b = updatedNodes[j];
        const dx = a.position[0] - b.position[0];
        const dy = a.position[1] - b.position[1];
        const dz = a.position[2] - b.position[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist < minDist && dist > 0.001) {
          const force = repulsionStrength / (dist * dist);
          const nx = dx / dist;
          const ny = dy / dist;
          const nz = dz / dist;

          a.position[0] += nx * force;
          a.position[1] += ny * force;
          a.position[2] += nz * force;
          b.position[0] -= nx * force;
          b.position[1] -= ny * force;
          b.position[2] -= nz * force;
        }
      }
    }

    self.postMessage({ type: 'REPULSION_COMPUTED', updatedNodes });
  }
};
