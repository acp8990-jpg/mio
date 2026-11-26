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
uniform sampler2D uBlurTex;
uniform sampler2D uMask;
uniform sampler2D uBgImage;
uniform float uBg;
uniform float uBgMode; // 1 desenfoque, 2 color, 3 imagen
uniform vec3 uBgColor;
uniform vec4 uBgCrop;
uniform vec2 uMaskTexel;

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

  if (uBg > 0.0) {
    // Fondo sustituido detrás de la persona. La máscara de MediaPipe es pequeña: se suaviza con 5 muestras
    // y una transición amplia para que el borde del pelo y los hombros no quede recortado.
    vec2 mt = uMaskTexel * 1.25;
    float mr = texture2D(uMask, vUv).r * 0.36
      + (texture2D(uMask, vUv + vec2(mt.x, 0.0)).r + texture2D(uMask, vUv - vec2(mt.x, 0.0)).r
      + texture2D(uMask, vUv + vec2(0.0, mt.y)).r + texture2D(uMask, vUv - vec2(0.0, mt.y)).r) * 0.16;
    float m = smoothstep(0.18, 0.82, mr);
    vec3 bg;
    if (uBgMode < 1.5) {
      // Desenfoque «sin halo»: el fondo se desenfocó sin la persona (alfa = cuánto fondo hubo en cada zona).
      vec4 bb = texture2D(uBlurTex, vUv);
      bg = bb.a > 0.02 ? bb.rgb / bb.a : c;
    }
    else if (uBgMode < 2.5) bg = uBgColor;
    else bg = texture2D(uBgImage, uBgCrop.xy + vOut * uBgCrop.zw).rgb;
    c = mix(bg, c, m);
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

const BLUR_VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

// Gaussiano de 9 muestras en una dirección; con uDir = 0 es una copia (reducción de tamaño).
const BLUR_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * 0.227;
  c += texture2D(uTex, vUv + uDir * 1.385).rgb * 0.316;
  c += texture2D(uTex, vUv - uDir * 1.385).rgb * 0.316;
  c += texture2D(uTex, vUv + uDir * 3.231).rgb * 0.070;
  c += texture2D(uTex, vUv - uDir * 3.231).rgb * 0.070;
  gl_FragColor = vec4(c, 1.0);
}`;

// Reducción + preparación del desenfoque: guarda el color solo donde hay fondo (sin la persona), para que
// al desenfocar la silueta no «manche» el fondo con un halo.
const PREP_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uUseMask;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float bgW = uUseMask > 0.5 ? 1.0 - smoothstep(0.25, 0.7, texture2D(uMask, vUv).r) : 1.0;
  bgW = max(bgW, 0.015);
  gl_FragColor = vec4(c * bgW, bgW);
}`;

// Gaussiano de 9 muestras sobre RGBA (color premultiplicado + peso del fondo).
const BLUR4_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec4 c = texture2D(uTex, vUv) * 0.227;
  c += texture2D(uTex, vUv + uDir * 1.385) * 0.316;
  c += texture2D(uTex, vUv - uDir * 1.385) * 0.316;
  c += texture2D(uTex, vUv + uDir * 3.231) * 0.070;
  c += texture2D(uTex, vUv - uDir * 3.231) * 0.070;
  gl_FragColor = c;
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
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const link = (vs, fs) => {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      return { prog, aPos: gl.getAttribLocation(prog, 'aPos') };
    };
    this.main = link(VERT, FRAG);
    this.blur = link(BLUR_VERT, BLUR_FRAG);
    this.prep = link(BLUR_VERT, PREP_FRAG);
    this.blur4 = link(BLUR_VERT, BLUR4_FRAG);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);

    this.tex = this.#texture();
    this.maskTex = this.#texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    this.maskVersion = -1;
    this.fbos = null;

    gl.useProgram(this.main.prog);
    this.u = {};
    for (const n of ['uCrop', 'uTexel', 'uExposure', 'uBrightness', 'uContrast', 'uSaturation', 'uVibrance',
      'uTemp', 'uTint', 'uHigh', 'uShadow', 'uSharp', 'uSmooth', 'uVignette', 'uBg', 'uTex', 'uBlurTex', 'uMask', 'uBgImage', 'uBgMode', 'uBgColor', 'uBgCrop', 'uMaskTexel']) {
      this.u[n] = gl.getUniformLocation(this.main.prog, n);
    }
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uBlurTex, 1);
    gl.uniform1i(this.u.uMask, 2);
    gl.uniform1i(this.u.uBgImage, 3);
    this.bgImageTex = this.#texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
    this.bgImage = null;
    this.bgImageSize = [1, 1];
    gl.useProgram(this.blur.prog);
    this.ub = { uTex: gl.getUniformLocation(this.blur.prog, 'uTex'), uDir: gl.getUniformLocation(this.blur.prog, 'uDir') };
    gl.uniform1i(this.ub.uTex, 0);
    gl.useProgram(this.prep.prog);
    this.up = { uMask: gl.getUniformLocation(this.prep.prog, 'uMask'), uUseMask: gl.getUniformLocation(this.prep.prog, 'uUseMask') };
    gl.uniform1i(gl.getUniformLocation(this.prep.prog, 'uTex'), 0);
    gl.uniform1i(this.up.uMask, 2);
    gl.useProgram(this.blur4.prog);
    this.ub4 = { uDir: gl.getUniformLocation(this.blur4.prog, 'uDir') };
    gl.uniform1i(gl.getUniformLocation(this.blur4.prog, 'uTex'), 0);
  }

  /** Imagen de fondo (ImageBitmap) para el modo «imagen». */
  setBackgroundImage(img) {
    if (!this.gl || this.bgImage === img) return;
    const gl = this.gl;
    this.bgImage = img;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.bgImageTex);
    if (img) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      this.bgImageSize = [img.width, img.height];
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  #texture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Dos texturas de render a tamaño reducido para el fondo desenfocado. */
  #ensureFbos(w, h) {
    if (this.fbos && this.fbos.w === w && this.fbos.h === h) return this.fbos;
    const gl = this.gl;
    const make = () => {
      const tex = this.#texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    };
    if (this.fbos) {
      for (const f of [this.fbos.a, this.fbos.b]) {
        gl.deleteTexture(f.tex);
        gl.deleteFramebuffer(f.fb);
      }
    }
    this.fbos = { w, h, a: make(), b: make() };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.fbos;
  }

  #pass(program, target, w, h) {
    const gl = this.gl;
    gl.useProgram(program.prog);
    gl.enableVertexAttribArray(program.aPos);
    gl.vertexAttribPointer(program.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Genera el fondo desenfocado. `amount` (0..1) es progresivo: al principio es un desenfoque muy leve,
   * como el de un objetivo luminoso, y al final uno fuerte. El radio se calcula en píxeles del lado corto
   * (para 1080 px: de ~1 px a ~45 px) y la imagen se reduce solo lo necesario.
   */
  #blurBackground(srcW, srcH, amount, useMask) {
    const gl = this.gl;
    const short = Math.min(srcW, srcH);
    const sigma = (0.6 + 44 * Math.pow(Math.max(0, amount), 1.7)) * (short / 1080);
    const scale = Math.min(0.5, Math.max(0.07, 3 / Math.max(1, sigma)));
    const w = Math.max(16, Math.round(srcW * scale));
    const h = Math.max(16, Math.round(srcH * scale));
    const { a, b } = this.#ensureFbos(w, h);
    // reducir + quitar la persona
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.useProgram(this.prep.prog);
    gl.uniform1f(this.up.uUseMask, useMask ? 1 : 0);
    this.#pass(this.prep, a.fb, w, h);
    // dos pasadas H+V: sigma total ≈ 2,8 × separación (en píxeles reducidos)
    const spread = Math.max(0.35, (sigma * scale) / 2.8);
    gl.useProgram(this.blur4.prog);
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform2f(this.ub4.uDir, spread / w, 0);
      this.#pass(this.blur4, b.fb, w, h);
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.uniform2f(this.ub4.uDir, 0, spread / h);
      this.#pass(this.blur4, a.fb, w, h);
    }
    return a.tex;
  }

  /** Dibuja un fotograma de `source` (vídeo de la cámara) en el canvas de salida. */
  /**
   * @param {{data:Uint8Array,width:number,height:number,version:number}|null} mask máscara de persona
   * @param {{mode:'none'|'blur'|'color'|'image', blur:number, color:number[]}} bg fondo
   */
  draw(source, srcW, srcH, mask = null, bg = null) {
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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);

    const mode = bg?.mode ?? 'none';
    const useBg = mode !== 'none' && (mode !== 'blur' || bg.blur > 0) && mask?.data;
    let blurTex = null;
    if (useBg) {
      if (mask.version !== this.maskVersion) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, mask.width, mask.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, mask.data);
        this.maskVersion = mask.version;
      }
      if (mode === 'blur') blurTex = this.#blurBackground(srcW, srcH, bg.blur, true);
    }

    gl.useProgram(this.main.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurTex ?? this.tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.bgImageTex);
    gl.activeTexture(gl.TEXTURE0);
    const u = this.u;
    gl.uniform1f(u.uBg, useBg ? 1 : 0);
    if (useBg) {
      gl.uniform1f(u.uBgMode, { blur: 1, color: 2, image: 3 }[mode]);
      const col = bg.color || [0, 0, 0];
      gl.uniform3f(u.uBgColor, col[0], col[1], col[2]);
      const [ix, iy, iw, ih] = coverCrop(this.bgImageSize[0], this.bgImageSize[1], W, H);
      gl.uniform4f(u.uBgCrop, ix, iy, iw, ih);
      gl.uniform2f(u.uMaskTexel, 1 / Math.max(1, mask.width), 1 / Math.max(1, mask.height));
    }
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
    this.#pass(this.main, null, W, H);
  }
}
