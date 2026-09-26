/**
 * colorGrade（payload ローカル・自己完結）— メイン動画のカラー補正（F-2）。
 *
 * COLOR_GRADE_V1
 * COLOR_WHEELS_V1
 *
 * これは案件へコピーされる複製。エディタ側の正典は SuperMovie Editor の
 * `src/core/colorGrade.ts` で、`src/server/colorGradeParity.test.ts` が
 * 両者の出力一致（行列文字列・恒等判定）を全数走査で固定する。
 * **`src/core` を import しない**（案件は単体で `remotion render` できる必要がある）。
 *
 * 適用順は 彩度 → コントラスト → 明るさ → 色温度。順を変えると同じ数値から違う絵が出る。
 */

/** カラー補正のパラメータ（各 -100..100・0 が無補正）。 */
export interface ColorGrade {
  /** 明るさ。-100 で真っ黒寄り、+100 で 2 倍。 */
  brightness: number;
  /** コントラスト。中間 0.5 を軸に伸縮。 */
  contrast: number;
  /** 彩度。-100 で白黒、+100 で 2 倍。 */
  saturation: number;
  /** 色温度。+ で暖色（赤寄り）、- で寒色（青寄り）。 */
  temperature: number;
  wheels?: ColorWheels;
}

/** Lift/Gamma/Gain: optional for legacy projects; coordinates use screen axes. */
export type ColorWheelName = 'lift' | 'gamma' | 'gain';
export type ColorGradeField = 'brightness' | 'contrast' | 'saturation' | 'temperature';
export interface ColorWheelValue { x: number; y: number; level: number }
export type ColorWheels = Record<ColorWheelName, ColorWheelValue>;
export function normalizeColorWheel(raw: unknown): ColorWheelValue {
  const o = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.max(-100, Math.min(100, v)) : 0;
  let x = num(o.x), y = num(o.y);
  const radius = Math.hypot(x, y);
  if (radius > 100) { x *= 100 / radius; y *= 100 / radius; }
  return { x, y, level: num(o.level) };
}
export function normalizeColorWheels(raw: unknown): ColorWheels {
  const o = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return { lift: normalizeColorWheel(o.lift), gamma: normalizeColorWheel(o.gamma), gain: normalizeColorWheel(o.gain) };
}
export function isIdentityColorWheels(raw: unknown): boolean {
  return Object.values(normalizeColorWheels(raw)).every(w => w.x === 0 && w.y === 0 && w.level === 0);
}
export interface ColorWheelTransfer { slope: number; intercept: number; amplitude: number; exponent: number }
export function colorWheelTransfers(g: ColorGrade): [ColorWheelTransfer, ColorWheelTransfer, ColorWheelTransfer] {
  const wheels = normalizeColorWheels(g.wheels);
  const direction = (w: ColorWheelValue, channel: number) => {
    const offsets = [w.x, -.5 * w.x - Math.sqrt(3) / 2 * w.y, -.5 * w.x + Math.sqrt(3) / 2 * w.y];
    return Math.max(-1, Math.min(1, (offsets[channel]! + w.level) / 100));
  };
  return [0, 1, 2].map(channel => {
    const lift = .25 * direction(wheels.lift, channel);
    return { slope: 1 - lift, intercept: lift, amplitude: 2 ** direction(wheels.gain, channel), exponent: 2 ** -direction(wheels.gamma, channel) };
  }) as [ColorWheelTransfer, ColorWheelTransfer, ColorWheelTransfer];
}


/** 無補正（既定）。 */
export const DEFAULT_COLOR_GRADE: ColorGrade = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
};

/** 各パラメータのクランプ範囲。 */
export const COLOR_GRADE_MIN = -100;
export const COLOR_GRADE_MAX = 100;

/** 色温度 ±100 のときの R/B ゲイン幅（±30%）。 */
const TEMPERATURE_GAIN = 0.3;

/** feColorMatrix の彩度行列で使う輝度係数（SVG 仕様 `saturate` と同じ値）。 */
const LUM_R = 0.213;
const LUM_G = 0.715;
const LUM_B = 0.072;

/**
 * -100..100 へクランプ。NaN は 0、±Infinity は境界値
 * （`clampRotation`（src/core/mainLayout.ts）と同じ規約）。
 */
export function clampColorGradeValue(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(COLOR_GRADE_MAX, Math.max(COLOR_GRADE_MIN, v));
}

/** 無補正か（既存案件の見た目が 1 画素も変わらないための素通し判定）。 */
export function isIdentityColorGrade(g: ColorGrade | undefined | null): boolean {
  if (g === undefined || g === null) return true;
  return (
    clampColorGradeValue(g.brightness) === 0 &&
    clampColorGradeValue(g.contrast) === 0 &&
    clampColorGradeValue(g.saturation) === 0 &&
    clampColorGradeValue(g.temperature) === 0 &&
    isIdentityColorWheels(g.wheels)
  );
}

/** 既定値の新しいコピー。 */
export function defaultColorGrade(): ColorGrade {
  return { ...DEFAULT_COLOR_GRADE };
}

/**
 * RGB のアフィン変換 1 段（3 行 × [r, g, b, offset]）。
 * 出力 c_i = sum_j m[i][j] * c_j + m[i][3]
 */
type Affine = readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
];

const IDENTITY: Affine = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];

/** `b` を先に、`a` を後に適用する合成（a ∘ b）。 */
function compose(a: Affine, b: Affine): Affine {
  const out: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const row = a[i]!;
    const r: number[] = [0, 0, 0, row[3]];
    for (let k = 0; k < 3; k++) {
      const coef = row[k]!;
      const bk = b[k]!;
      r[0]! += coef * bk[0]!;
      r[1]! += coef * bk[1]!;
      r[2]! += coef * bk[2]!;
      r[3]! += coef * bk[3]!;
    }
    out.push(r);
  }
  return [
    [out[0]![0]!, out[0]![1]!, out[0]![2]!, out[0]![3]!],
    [out[1]![0]!, out[1]![1]!, out[1]![2]!, out[1]![3]!],
    [out[2]![0]!, out[2]![1]!, out[2]![2]!, out[2]![3]!],
  ];
}

/** 彩度（-100..100 → 係数 0..2）。 */
function saturationAffine(saturation: number): Affine {
  const s = 1 + clampColorGradeValue(saturation) / 100;
  if (s === 1) return IDENTITY;
  return [
    [LUM_R + s * (1 - LUM_R), LUM_G - s * LUM_G, LUM_B - s * LUM_B, 0],
    [LUM_R - s * LUM_R, LUM_G + s * (1 - LUM_G), LUM_B - s * LUM_B, 0],
    [LUM_R - s * LUM_R, LUM_G - s * LUM_G, LUM_B + s * (1 - LUM_B), 0],
  ];
}

/** コントラスト（中間 0.5 を軸に伸縮）。 */
function contrastAffine(contrast: number): Affine {
  const k = 1 + clampColorGradeValue(contrast) / 100;
  if (k === 1) return IDENTITY;
  const off = 0.5 * (1 - k);
  return [
    [k, 0, 0, off],
    [0, k, 0, off],
    [0, 0, k, off],
  ];
}

/** 明るさ（乗算）。 */
function brightnessAffine(brightness: number): Affine {
  const k = 1 + clampColorGradeValue(brightness) / 100;
  if (k === 1) return IDENTITY;
  return [
    [k, 0, 0, 0],
    [0, k, 0, 0],
    [0, 0, k, 0],
  ];
}

/** 色温度（R を上げ B を下げる／またはその逆）。 */
function temperatureAffine(temperature: number): Affine {
  const t = clampColorGradeValue(temperature) / 100;
  if (t === 0) return IDENTITY;
  const gr = 1 + TEMPERATURE_GAIN * t;
  const gb = 1 - TEMPERATURE_GAIN * t;
  return [
    [gr, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, gb, 0],
  ];
}

/**
 * 4 段（彩度 → コントラスト → 明るさ → 色温度）の合成アフィン。
 * **この適用順が仕様**（順を変えると同じ数値から違う絵が出る）。
 */
function colorGradeAffine(g: ColorGrade): Affine {
  let m = saturationAffine(g.saturation);
  m = compose(contrastAffine(g.contrast), m);
  m = compose(brightnessAffine(g.brightness), m);
  m = compose(temperatureAffine(g.temperature), m);
  return m;
}

/** 小数の揺れで文字列が変わらないよう 6 桁で丸める（-0 は 0 へ）。 */
function fmt(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

/**
 * `feColorMatrix type="matrix"` の values（4 行 × 5 列 = 20 個）。
 * アルファ行は恒等（色だけを触る）。
 */
export function colorGradeMatrixValues(g: ColorGrade): string {
  const m = colorGradeAffine(g);
  const rows: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const r = m[i]!;
    rows.push([r[0]!, r[1]!, r[2]!, 0, r[3]!]);
  }
  rows.push([0, 0, 0, 1, 0]);
  return rows.map((r) => r.map(fmt).join(' ')).join(' ');
}

/**
 * CPU 側の同一モデル（書き出した画素との突合用）。
 * 入力・出力とも sRGB の 0..1。仕様どおり最後に 0..1 へクランプする。
 */
function applyColorGrade(
  g: ColorGrade,
  rgb: readonly [number, number, number],
): [number, number, number] {
  const m = colorGradeAffine(g);
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = m[i]!;
    const v = r[0]! * rgb[0]! + r[1]! * rgb[1]! + r[2]! * rgb[2]! + r[3]!;
    out.push(Math.min(1, Math.max(0, v)));
  }
  if (!isIdentityColorWheels(g.wheels)) {
    colorWheelTransfers(g).forEach((t, i) => {
      const lifted = Math.min(1, Math.max(0, t.slope * out[i]! + t.intercept));
      out[i] = Math.min(1, Math.max(0, t.amplitude * lifted ** t.exponent));
    });
  }
  return [out[0]!, out[1]!, out[2]!];
}

/** 8bit チャンネル値（0..255）へ適用する版。四捨五入して返す。 */
export function applyColorGrade8(
  g: ColorGrade,
  rgb: readonly [number, number, number],
): [number, number, number] {
  const [r, gg, b] = applyColorGrade(g, [rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255]);
  return [Math.round(r * 255), Math.round(gg * 255), Math.round(b * 255)];
}

/**
 * 補正を掛ける対象レイヤ。メイン動画とサブ動画（インサート）は DOM 上の別レイヤなので
 * filter 定義も別 id にする（同一 id が 2 つあると `url(#id)` の解決が実装依存になる）。
 */
export type ColorGradeScope = 'main' | 'insert';

/** SVG filter の id（プレビューと書き出しで同一・レイヤごとに 1 つ）。 */
export function colorGradeFilterId(scope: ColorGradeScope = 'main'): string {
  return scope === 'main' ? 'sme-main-color-grade' : 'sme-insert-color-grade';
}
