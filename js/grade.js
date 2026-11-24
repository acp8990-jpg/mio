// Corrección de color en la GPU (WebGL). Recibe el fotograma de la cámara, lo recorta al encuadre
// de salida (vertical u horizontal) y aplica los ajustes de imagen. Si no hay WebGL, usa Canvas 2D
// con los filtros básicos (brillo, contraste, saturación).

export const ADJUST_DEFAULTS = {
  exposure: 0, // pasos de diafragma, -2..2
  brightness: 0, // -1..1
  contrast: 0, // -1..1
  saturation: 0, // -1..1
  vibrance: 0, // -1..1
  temperature: 0, // -1 (frío) .. 1 (cálido)
  tint: 0, // -1 (verde) .. 1 (magenta)
  highlights: 0, // -1 (recuperar) .. 1
  shadows: 0, // -1 .. 1 (levantar)
  sharpness: 0, // 0..1
  smoothing: 0, // 0..1 suavizado de piel
  vignette: 0, // 0..1
};

export const PRESETS = {
  natural: { label: 'Natural', values: {} },
  vivo: { label: 'Vivo', values: { contrast: 0.12, vibrance: 0.35, saturation: 0.05, sharpness: 0.25 } },
  calido: { label: 'Cálido', values: { temperature: 0.35, tint: 0.05, vibrance: 0.15, shadows: 0.1 } },
  frio: { label: 'Frío', values: { temperature: -0.35, contrast: 0.08, vibrance: 0.1 } },
  retrato: {
    label: 'Retrato',
    values: { smoothing: 0.55, temperature: 0.12, exposure: 0.15, shadows: 0.15, highlights: -0.15, vibrance: 0.1 },
  },
  cine: {
    label: 'Cine',
    values: { contrast: 0.18, saturation: -0.12, temperature: 0.08, highlights: -0.25, shadows: -0.05, vignette: 0.35 },
  },
  bn: { label: 'B/N', values: { saturation: -1, contrast: 0.22, sharpness: 0.2, vignette: 0.2 } },
};

const VERT = `
attribute vec2 aPos;
uniform vec4 uCrop;
varying vec2 vUv;
varying vec2 vOut;
void main() {
  vec2 uv = vec2(aPos.x, 1.0 - aPos.y);
  vOut = uv;
  vUv = uCrop.xy + uv * uCrop.zw;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
varying vec2 vOut;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uExposure, uBrightness, uContrast, uSaturation, uVibrance;
uniform float uTemp, uTint, uHigh, uShadow, uSharp, uSmooth, uVignette;

vec3 px(vec2 o) { return texture2D(uTex, vUv + o * uTexel).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 c = px(vec2(0.0));

  if (uSharp > 0.0 || uSmooth > 0.0) {
    // Desenfoque 3x3 (radio 1.5 px) para nitidez y suavizado.
    vec3 b = c * 4.0;
    b += (px(vec2(1.5, 0.0)) + px(vec2(-1.5, 0.0)) + px(vec2(0.0, 1.5)) + px(vec2(0.0, -1.5))) * 2.0;
    b += px(vec2(1.5, 1.5)) + px(vec2(-1.5, 1.5)) + px(vec2(1.5, -1.5)) + px(vec2(-1.5, -1.5));
    b /= 16.0;
    if (uSmooth > 0.0) {
      // Suavizado que respeta bordes: solo mezcla donde la diferencia es pequeña (piel), no en ojos o contornos.
      vec3 wide = (px(vec2(3.0, 0.0)) + px(vec2(-3.0, 0.0)) + px(vec2(0.0, 3.0)) + px(vec2(0.0, -3.0))) * 0.25;
      vec3 soft = mix(b, wide, 0.5);
      float edge = smoothstep(0.02, 0.10, length(c - soft));
      c = mix(c, soft, uSmooth * (1.0 - edge) * 0.85);
    }
    if (uSharp > 0.0) c += (c - b) * uSharp * 1.6;
  }

  c *= exp2(uExposure);

  // Balance de blancos
  c *= vec3(1.0 + uTemp * 0.12, 1.0 - uTint * 0.08, 1.0 - uTemp * 0.12);
  c += vec3(uTemp * 0.035, -uTint * 0.025, -uTemp * 0.035);

  // Luces y sombras
  float l = clamp(luma(c), 0.0, 1.0);
  c += uShadow * 0.30 * (1.0 - l) * (1.0 - l);
  c += uHigh * 0.30 * l * l;

  c += uBrightness * 0.20;
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  l = luma(c);
  c = mix(vec3(l), c, 1.0 + uSaturation);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1.0 + uVibrance * (1.0 - clamp(mx - mn, 0.0, 1.0)));

  vec2 d = vOut - 0.5;
  c *= 1.0 - uVignette * smoothstep(0.35, 0.95, length(d) * 1.35);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/** Recorte tipo «cover»: la parte central del fotograma con la proporción de salida. */
export function coverCrop(srcW, srcH, outW, outH) {
  const srcA = srcW / srcH;
  const outA = outW / outH;
  if (srcA > outA) {
    const w = outA / srcA;
    return [(1 - w) / 2, 0, w, 1];
  }
  const h = srcA / outA;
  return [0, (1 - h) / 2, 1, h];
}

export class Grader {
  constructor(canvas) {
    this.canvas = canvas;
    this.adjust = { ...ADJUST_DEFAULTS };
    this.gl = null;
    try {
      this.gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true, // necesario para captureStream en algunos navegadores
      });
    } catch {
      this.gl = null;
    }
    if (this.gl) this.#initGl();
    else this.ctx = canvas.getContext('2d', { alpha: false });
  }

  get usesGpu() {
    return !!this.gl;
  }

  set(values) {
    this.adjust = { ...ADJUST_DEFAULTS, ...values };
  }

  #initGl() {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.u = {};
    for (const n of ['uCrop', 'uTexel', 'uExposure', 'uBrightness', 'uContrast', 'uSaturation', 'uVibrance',
      'uTemp', 'uTint', 'uHigh', 'uShadow', 'uSharp', 'uSmooth', 'uVignette']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
  }

  /** Dibuja un fotograma de `source` (vídeo de la cámara) en el canvas de salida. */
  draw(source, srcW, srcH) {
    const { canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    if (!srcW || !srcH) return;
    const [cx, cy, cw, ch] = coverCrop(srcW, srcH, W, H);
    const a = this.adjust;

    if (!this.gl) {
      const ctx = this.ctx;
      const f = [
        `brightness(${(1 + a.brightness * 0.4) * 2 ** a.exposure})`,
        `contrast(${1 + a.contrast})`,
        `saturate(${Math.max(0, 1 + a.saturation + a.vibrance * 0.5)})`,
      ];
      if ('filter' in ctx) ctx.filter = f.join(' ');
      ctx.drawImage(source, cx * srcW, cy * srcH, cw * srcW, ch * srcH, 0, 0, W, H);
      return;
    }

    const gl = this.gl;
    gl.viewport(0, 0, W, H);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
    const u = this.u;
    gl.uniform4f(u.uCrop, cx, cy, cw, ch);
    gl.uniform2f(u.uTexel, 1 / srcW, 1 / srcH);
    gl.uniform1f(u.uExposure, a.exposure);
    gl.uniform1f(u.uBrightness, a.brightness);
    gl.uniform1f(u.uContrast, a.contrast);
    gl.uniform1f(u.uSaturation, a.saturation);
    gl.uniform1f(u.uVibrance, a.vibrance);
    gl.uniform1f(u.uTemp, a.temperature);
    gl.uniform1f(u.uTint, a.tint);
    gl.uniform1f(u.uHigh, a.highlights);
    gl.uniform1f(u.uShadow, a.shadows);
    gl.uniform1f(u.uSharp, a.sharpness);
    gl.uniform1f(u.uSmooth, a.smoothing);
    gl.uniform1f(u.uVignette, a.vignette);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
