import { colorGradeMatrixValues, colorWheelTransfers, defaultColorGrade, type ColorGrade } from '../../core/colorGrade';
import type { CubeLut, RGB } from './lut';

export interface CompositeLayer {
  id: string;
  source: TexImageSource;
  /** Pixel bounds in the output canvas, with rotation about the bounds' center. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  opacity?: number;
  grade?: ColorGrade;
  lut?: { table: CubeLut; intensity: number };
}
const VERTEX = `#version 300 es
in vec2 aPosition;
uniform vec2 uResolution;
uniform vec4 uBounds;
uniform float uRotation;
uniform vec2 uFlip;
out vec2 vUv;
void main() {
  vec2 local = (aPosition - 0.5) * uBounds.zw;
  float c = cos(uRotation), s = sin(uRotation);
  vec2 pixel = vec2(c * local.x - s * local.y, s * local.x + c * local.y) + uBounds.xy + uBounds.zw / 2.0;
  gl_Position = vec4(pixel.x / uResolution.x * 2.0 - 1.0, 1.0 - pixel.y / uResolution.y * 2.0, 0.0, 1.0);
  vUv = mix(aPosition, 1.0 - aPosition, uFlip);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uSource;
uniform sampler3D uLut;
uniform vec4 uColor0, uColor1, uColor2;
uniform vec3 uSlope, uIntercept, uAmplitude, uExponent;
uniform vec3 uDomainMin, uDomainMax;
uniform float uLutSize, uIntensity, uOpacity;
in vec2 vUv;
out vec4 outColor;
vec3 lookup(vec3 inputColor) {
  vec3 p = clamp((inputColor - uDomainMin) / (uDomainMax - uDomainMin), 0.0, 1.0) * (uLutSize - 1.0);
  vec3 base = floor(p), f = fract(p), result = vec3(0.0);
  // Fixed trilinear interpolation also works where float-texture linear filtering is unavailable.
  for (int b = 0; b < 2; b++) for (int g = 0; g < 2; g++) for (int r = 0; r < 2; r++) {
    vec3 corner = vec3(float(r), float(g), float(b));
    vec3 weight = mix(1.0 - f, f, corner);
    vec3 uvw = (min(base + corner, vec3(uLutSize - 1.0)) + 0.5) / uLutSize;
    result += texture(uLut, uvw).rgb * weight.x * weight.y * weight.z;
  }
  return result;
}
void main() {
  vec4 source = texture(uSource, vUv);
  vec4 rgb1 = vec4(source.rgb, 1.0);
  vec3 color = clamp(vec3(dot(uColor0, rgb1), dot(uColor1, rgb1), dot(uColor2, rgb1)), 0.0, 1.0);
  color = clamp(uAmplitude * pow(clamp(uSlope * color + uIntercept, 0.0, 1.0), uExponent), 0.0, 1.0);
  if (uIntensity > 0.0) color = clamp(mix(color, lookup(color), uIntensity), 0.0, 1.0);
  float alpha = source.a * uOpacity;
  outColor = vec4(color * alpha, alpha);
}`;

/** The same GPU path is used by interactive previews and offline reference capture. */
export class NativeCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vertices: WebGLBuffer;
  private readonly uniforms = new Map<string, WebGLUniformLocation>();
  private readonly sources = new Map<string, WebGLTexture>();
  private readonly luts = new Map<CubeLut, WebGLTexture>();
  private readonly emptyLut: WebGLTexture;
  private disposed = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('独自プレビューにはWebGL2が必要です');
    this.gl = gl;
    gl.drawingBufferColorSpace = 'srgb';
    if ('unpackColorSpace' in gl) gl.unpackColorSpace = 'srgb';
    const compile = (kind: number, text: string) => {
      const shader = gl.createShader(kind);
      if (!shader) throw new Error('映像シェーダーを作成できません');
      gl.shaderSource(shader, text); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
        throw new Error(`映像シェーダーの準備に失敗しました: ${error}`);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX), fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!program) throw new Error('映像合成を準備できません');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program); gl.deleteProgram(program);
      throw new Error(`映像合成の準備に失敗しました: ${error}`);
    }
    this.program = program;
    const vertices = gl.createBuffer();
    if (!vertices) throw new Error('映像バッファーを準備できません');
    this.vertices = vertices;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['uResolution', 'uBounds', 'uRotation', 'uFlip', 'uSource', 'uLut', 'uColor0', 'uColor1', 'uColor2',
      'uSlope', 'uIntercept', 'uAmplitude', 'uExponent', 'uDomainMin', 'uDomainMax', 'uLutSize', 'uIntensity', 'uOpacity']) {
      const location = gl.getUniformLocation(program, name);
      if (location === null) throw new Error(`映像パラメーターが見つかりません: ${name}`);
      this.uniforms.set(name, location);
    }
    const empty = gl.createTexture();
    if (!empty) throw new Error('LUTテクスチャーを準備できません');
    this.emptyLut = empty;
    gl.bindTexture(gl.TEXTURE_3D, empty);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, 1, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array(3));
    this.textureParameters(gl.TEXTURE_3D, gl.NEAREST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  private location(name: string): WebGLUniformLocation { return this.uniforms.get(name)!; }
  private textureParameters(target: number, filter: number): void {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }

  render(layers: readonly CompositeLayer[], background: RGB = [0, 0, 0], backgroundAlpha = 1): void {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost()) throw new Error('映像合成の接続が失われました');
    const usedSources = new Set<string>(), usedLuts = new Set<CubeLut>();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.useProgram(this.program);
    gl.clearColor(background[0] * backgroundAlpha, background[1] * backgroundAlpha, background[2] * backgroundAlpha, backgroundAlpha); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.location('uResolution'), this.canvas.width, this.canvas.height);
    gl.uniform1i(this.location('uSource'), 0); gl.uniform1i(this.location('uLut'), 1);
    for (const layer of layers) {
      if (usedSources.has(layer.id)) throw new Error('描画レイヤーのIDが重複しています');
      usedSources.add(layer.id);
      let texture = this.sources.get(layer.id);
      if (!texture) {
        texture = gl.createTexture() ?? undefined;
        if (!texture) throw new Error('映像テクスチャーを確保できません');
        this.sources.set(layer.id, texture);
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      this.textureParameters(gl.TEXTURE_2D, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source);
      gl.uniform4f(this.location('uBounds'), layer.x, layer.y, layer.width, layer.height);
      gl.uniform1f(this.location('uRotation'), (layer.rotation ?? 0) * Math.PI / 180);
      gl.uniform2f(this.location('uFlip'), layer.flipH ? 1 : 0, layer.flipV ? 1 : 0);
      gl.uniform1f(this.location('uOpacity'), layer.opacity ?? 1);
      const grade = layer.grade ?? defaultColorGrade();
      const matrix = colorGradeMatrixValues(grade).split(' ').map(Number);
      for (let row = 0; row < 3; row++) gl.uniform4f(this.location(`uColor${row}`), matrix[row * 5]!, matrix[row * 5 + 1]!, matrix[row * 5 + 2]!, matrix[row * 5 + 4]!);
      const transfers = colorWheelTransfers(grade);
      for (const [name, field] of [['uSlope', 'slope'], ['uIntercept', 'intercept'], ['uAmplitude', 'amplitude'], ['uExponent', 'exponent']] as const) {
        gl.uniform3f(this.location(name), transfers[0][field], transfers[1][field], transfers[2][field]);
      }
      gl.activeTexture(gl.TEXTURE1);
      if (layer.lut) {
        const { table, intensity } = layer.lut;
        if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) throw new Error('LUTの強度が不正です');
        usedLuts.add(table);
        let lutTexture = this.luts.get(table);
        if (!lutTexture) {
          lutTexture = gl.createTexture() ?? undefined;
          if (!lutTexture) throw new Error('LUTテクスチャーを確保できません');
          this.luts.set(table, lutTexture); gl.bindTexture(gl.TEXTURE_3D, lutTexture);
          this.textureParameters(gl.TEXTURE_3D, gl.NEAREST);
          gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, table.size, table.size, table.size, 0, gl.RGB, gl.FLOAT, table.values);
        } else gl.bindTexture(gl.TEXTURE_3D, lutTexture);
        gl.uniform3fv(this.location('uDomainMin'), table.domainMin); gl.uniform3fv(this.location('uDomainMax'), table.domainMax);
        gl.uniform1f(this.location('uLutSize'), table.size); gl.uniform1f(this.location('uIntensity'), intensity);
      } else {
        gl.bindTexture(gl.TEXTURE_3D, this.emptyLut);
        gl.uniform3f(this.location('uDomainMin'), 0, 0, 0); gl.uniform3f(this.location('uDomainMax'), 1, 1, 1);
        gl.uniform1f(this.location('uLutSize'), 1); gl.uniform1f(this.location('uIntensity'), 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    for (const [id, texture] of this.sources) if (!usedSources.has(id)) { gl.deleteTexture(texture); this.sources.delete(id); }
    for (const [table, texture] of this.luts) if (!usedLuts.has(table)) { gl.deleteTexture(texture); this.luts.delete(table); }
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`映像合成に失敗しました（WebGL ${error}）`);
  }
  /** Top-to-bottom, premultiplied RGBA bytes, before any lossy encoding. */
  readPixels(): Uint8Array<ArrayBuffer> {
    const { width, height } = this.canvas;
    const raw = new Uint8Array(width * height * 4), output = new Uint8Array(raw.length);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, raw);
    for (let y = 0; y < height; y++) output.set(raw.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4);
    return output;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.sources.values()) this.gl.deleteTexture(texture);
    for (const texture of this.luts.values()) this.gl.deleteTexture(texture);
    this.gl.deleteTexture(this.emptyLut); this.gl.deleteBuffer(this.vertices); this.gl.deleteProgram(this.program);
    this.sources.clear(); this.luts.clear();
  }
}
