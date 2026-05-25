import { NodeProgram } from 'sigma/rendering';

const VERTEX_SHADER = `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec2 v_uv;
varying float v_border;

const float bias = 255.0 / 254.0;
const float marginRatio = 1.05;

void main() {
  float size = a_size * u_correctionRatio * u_sizeRatio * 4.0;
  vec2 diffVector = size * vec2(cos(a_angle), sin(a_angle));
  vec2 position = a_position + diffVector * marginRatio;
  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);

  v_uv = vec2(cos(a_angle), sin(a_angle)) * marginRatio * 0.5 + 0.5;
  v_color = a_color;
  v_color.a *= bias;
  v_border = 0.5 - 0.5 / size;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

varying vec4 v_color;
varying vec2 v_uv;
varying float v_border;

uniform float u_time;

void main() {
  float d = length(v_uv - 0.5) * 2.0;

  // SDF circle with soft edge
  float core = smoothstep(0.35, 0.15, d);

  // Gaussian halo for glow effect
  float glow = v_color.a;
  float halo = exp(-d * d * 3.0) * glow;

  // Subtle pulse on active nodes
  float pulse = 1.0 + 0.12 * sin(u_time * 2.5) * glow;

  // Combine core + halo
  vec3 color = v_color.rgb * pulse;
  float alpha = core + halo * 0.7;

  if (alpha < 0.01) discard;

  gl_FragColor = vec4(color * alpha, alpha);
}
`;

export class NodeGlowProgram extends NodeProgram {
  getDefinition() {
    return {
      VERTICES: 3,
      VERTEX_SHADER_SOURCE: VERTEX_SHADER,
      FRAGMENT_SHADER_SOURCE: FRAGMENT_SHADER,
      UNIFORMS: ['u_matrix', 'u_sizeRatio', 'u_correctionRatio', 'u_time'],
      ATTRIBUTES: [
        { name: 'a_position', size: 2, type: 'FLOAT' },
        { name: 'a_size', size: 1, type: 'FLOAT' },
        { name: 'a_color', size: 4, type: 'UNSIGNED_BYTE', normalized: true },
        { name: 'a_id', size: 4, type: 'UNSIGNED_BYTE', normalized: true },
        { name: 'a_angle', size: 1, type: 'FLOAT' }
      ]
    };
  }

  draw(params) {
    const { gl, program } = params;
    const timeLocation = gl.getUniformLocation(program, 'u_time');
    gl.uniform1f(timeLocation, performance.now() / 1000);

    // Enable additive blending for glow accumulation
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    super.draw(params);

    // Reset to standard blending
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }
}

export default NodeGlowProgram;
