/**
 * captureRuntime: spring（'remotion' の spring と同名 export・同値）
 *
 * 数値互換の参照: remotion@4.0.522（初期実装は 4.0.489）
 *   - `node_modules/remotion/dist/cjs/spring/index.js`（引数処理・from/to 適用）
 *   - `node_modules/remotion/dist/cjs/spring/spring-utils.js`（`springCalculation` / `advance`）
 * 減衰調和振動の解析解を 1 フレームずつ前進積分する構造を理解した上で自分の表現で実装した
 * （逐語転載はしていない）。式そのものは物理の解析解であり、Remotion 固有の表現ではない。
 *
 * 実使用は `{frame, fps, config:{damping, stiffness, mass}}` のみ
 * （from/to/durationInFrames/durationRestThreshold/delay/reverse/overshootClamping は
 *  M2a Task2 Step1 の機械抽出で 0 件）。未使用オプションは明示 throw する。
 */

export type SpringConfig = {
  damping?: number;
  stiffness?: number;
  mass?: number;
};

export type SpringOptions = {
  frame: number;
  fps: number;
  config?: SpringConfig;
};

/** Remotion の defaultSpringConfig と同値（spring-utils.js） */
const DEFAULT_DAMPING = 10;
const DEFAULT_MASS = 1;
const DEFAULT_STIFFNESS = 100;

/** Remotion の advance() が deltaTime に掛けている上限（ms） */
const MAX_STEP_MS = 64;

const SUPPORTED_TOP_LEVEL_KEYS = new Set(['frame', 'fps', 'config']);
const SUPPORTED_CONFIG_KEYS = new Set(['damping', 'stiffness', 'mass']);

const unimplemented = (what: string): never => {
  throw new Error(`captureRuntime: 未実装オプション spring ${what}`);
};

type SpringState = {
  position: number;
  velocity: number;
  timeMs: number;
};

/**
 * 1 ステップ前進させる。目標値 1・開始 0 の固定系。
 *
 * ζ = c / (2√(km)) が 1 未満なら劣減衰（振動しながら収束＝オーバーシュートあり）、
 * 1 以上なら臨界減衰の式を使う。
 */
const advance = (
  state: SpringState,
  nowMs: number,
  damping: number,
  mass: number,
  stiffness: number,
): SpringState => {
  const toValue = 1;
  const deltaMs = Math.min(nowMs - state.timeMs, MAX_STEP_MS);
  const t = deltaMs / 1000;

  const v0 = -state.velocity;
  const x0 = toValue - state.position;

  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const omega0 = Math.sqrt(stiffness / mass);
  const omega1 = omega0 * Math.sqrt(1 - zeta ** 2);

  if (zeta < 1) {
    const sin1 = Math.sin(omega1 * t);
    const cos1 = Math.cos(omega1 * t);
    const envelope = Math.exp(-zeta * omega0 * t);
    const displacement =
      envelope * (sin1 * ((v0 + zeta * omega0 * x0) / omega1) + x0 * cos1);
    return {
      position: toValue - displacement,
      // 上の変位式の時間微分。
      velocity:
        zeta * omega0 * displacement -
        envelope * (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1),
      timeMs: nowMs,
    };
  }

  const envelope = Math.exp(-omega0 * t);
  return {
    position: toValue - envelope * (x0 + (v0 + omega0 * x0) * t),
    velocity: envelope * (v0 * (t * omega0 - 1) + t * x0 * omega0 * omega0),
    timeMs: nowMs,
  };
};

export function spring(options: SpringOptions): number {
  for (const key of Object.keys(options)) {
    if (!SUPPORTED_TOP_LEVEL_KEYS.has(key)) {
      unimplemented(`{${key}}（実使用は frame/fps/config のみ）`);
    }
  }

  const { frame, fps, config = {} } = options;

  for (const key of Object.keys(config)) {
    if (!SUPPORTED_CONFIG_KEYS.has(key)) {
      unimplemented(`config.${key}（実使用は damping/stiffness/mass のみ）`);
    }
  }

  if (typeof frame !== 'number' || Number.isNaN(frame)) {
    throw new Error('frame must be a number');
  }
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`fps must be a positive finite number, but got ${String(fps)}`);
  }

  const damping = config.damping ?? DEFAULT_DAMPING;
  const mass = config.mass ?? DEFAULT_MASS;
  const stiffness = config.stiffness ?? DEFAULT_STIFFNESS;

  if (damping <= 0) {
    throw new Error(
      'Spring damping must be greater than 0, otherwise the spring() animation will never end, causing an infinite loop.',
    );
  }

  // 負フレームは 0 に丸めてから積分する（Remotion の frameClamped と同じ）。
  const frameClamped = Math.max(0, frame);
  const wholeFrames = Math.floor(frameClamped);
  // 整数境界まで積分した後、端数ぶんを独立したステップで進める。
  // 最終整数ステップを端数時刻に置き換えると浮動小数点の丸め順が変わる。
  const unevenRest = frameClamped % 1;

  let state: SpringState = { position: 0, velocity: 0, timeMs: 0 };
  // f=0 は deltaTime=0 の空回し（Remotion と同じくループ回数まで一致させる）。
  for (let f = 0; f <= wholeFrames; f++) {
    state = advance(state, (f / fps) * 1000, damping, mass, stiffness);
  }
  if (unevenRest !== 0) {
    state = advance(state, (frameClamped / fps) * 1000, damping, mass, stiffness);
  }

  return state.position;
}
