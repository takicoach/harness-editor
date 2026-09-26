import type { DuckEnvelope } from '../core/types';

/**
 * ダッキング区分線形（duckFactorAt: core/ducking.ts:103-122）を ffmpeg volume 式へ転写するための
 * 中間表現（AST）。ffmpeg 式文字列化（toFfmpegExpr）と JS 数値評価（evalDuckGainAst）の
 * 両方をここから導出することで、式の意味バグと文字列化バグを分離する。
 */
export type Expr =
  | { op: 'const'; value: number }
  | { op: 't' }
  | { op: 'add'; a: Expr; b: Expr }
  | { op: 'sub'; a: Expr; b: Expr }
  | { op: 'mul'; a: Expr; b: Expr }
  | { op: 'div'; a: Expr; b: Expr }
  | { op: 'lt'; a: Expr; b: Expr }
  | { op: 'if'; cond: Expr; then: Expr; else: Expr }
  | { op: 'min'; a: Expr; b: Expr };

const K = (value: number): Expr => ({ op: 'const', value });
const T: Expr = { op: 't' };
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const sub = (a: Expr, b: Expr): Expr => ({ op: 'sub', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const div = (a: Expr, b: Expr): Expr => ({ op: 'div', a, b });
const lt = (a: Expr, b: Expr): Expr => ({ op: 'lt', a, b });
const iff = (cond: Expr, then: Expr, els: Expr): Expr => ({ op: 'if', cond, then, else: els });
const minE = (a: Expr, b: Expr): Expr => ({ op: 'min', a, b });

/** AST を t（秒）で JS 数値評価する。lt は 1/0（ffmpeg の真偽表現に合わせる）。 */
export function evalDuckGainAst(node: Expr, t: number): number {
  switch (node.op) {
    case 'const':
      return node.value;
    case 't':
      return t;
    case 'add':
      return evalDuckGainAst(node.a, t) + evalDuckGainAst(node.b, t);
    case 'sub':
      return evalDuckGainAst(node.a, t) - evalDuckGainAst(node.b, t);
    case 'mul':
      return evalDuckGainAst(node.a, t) * evalDuckGainAst(node.b, t);
    case 'div':
      return evalDuckGainAst(node.a, t) / evalDuckGainAst(node.b, t);
    case 'lt':
      return evalDuckGainAst(node.a, t) < evalDuckGainAst(node.b, t) ? 1 : 0;
    case 'if':
      return evalDuckGainAst(node.cond, t) !== 0 ? evalDuckGainAst(node.then, t) : evalDuckGainAst(node.else, t);
    case 'min':
      return Math.min(evalDuckGainAst(node.a, t), evalDuckGainAst(node.b, t));
  }
}

/** 数値リテラルの文字列化。sec()（ffmpegTime.ts）と同じ toFixed(6) 精度に合わせる。 */
function fmt(n: number): string {
  return n.toFixed(6);
}

/** AST を ffmpeg expr 文字列へ。全ノードを括弧で包み演算子優先順位の曖昧さを排除する。 */
export function toFfmpegExpr(node: Expr): string {
  switch (node.op) {
    case 'const':
      return fmt(node.value);
    case 't':
      return 't';
    case 'add':
      return `(${toFfmpegExpr(node.a)}+${toFfmpegExpr(node.b)})`;
    case 'sub':
      return `(${toFfmpegExpr(node.a)}-${toFfmpegExpr(node.b)})`;
    case 'mul':
      return `(${toFfmpegExpr(node.a)}*${toFfmpegExpr(node.b)})`;
    case 'div':
      return `(${toFfmpegExpr(node.a)}/${toFfmpegExpr(node.b)})`;
    case 'lt':
      return `lt(${toFfmpegExpr(node.a)},${toFfmpegExpr(node.b)})`;
    case 'if':
      return `if(${toFfmpegExpr(node.cond)},${toFfmpegExpr(node.then)},${toFfmpegExpr(node.else)})`;
    case 'min':
      return `min(${toFfmpegExpr(node.a)},${toFfmpegExpr(node.b)})`;
  }
}

/**
 * region 1 個分の AST。f = t*fps をインライン展開し、duckFactorAt の区分線形を
 * lt() の入れ子（[start,end) 排他）で逐語転写する:
 *   f < s-a        → 1
 *   s-a <= f < s   → 1+(gain-1)*(f-(s-a))/a
 *   s <= f < e     → gain
 *   e <= f < e+r   → gain+(1-gain)*(f-e)/r
 *   それ以外        → 1
 * a<=0 / r<=0 の羽根は省略する（0 除算を作らない防御）。
 */
function regionExpr(
  region: { start: number; end: number },
  gain: number,
  attackFrames: number,
  releaseFrames: number,
  fps: number,
): Expr {
  const s = region.start;
  const e = region.end;
  const hasAttack = attackFrames > 0;
  const hasRelease = releaseFrames > 0;
  const f = mul(T, K(fps));

  const attackFormula: Expr = add(K(1), div(mul(sub(K(gain), K(1)), sub(f, K(s - attackFrames))), K(attackFrames)));
  const releaseFormula: Expr = add(K(gain), div(mul(sub(K(1), K(gain)), sub(f, K(e))), K(releaseFrames)));

  let expr: Expr = hasRelease ? iff(lt(f, K(e + releaseFrames)), releaseFormula, K(1)) : K(1);
  expr = iff(lt(f, K(e)), K(gain), expr);
  if (hasAttack) {
    expr = iff(lt(f, K(s)), attackFormula, expr);
    expr = iff(lt(f, K(s - attackFrames)), K(1), expr);
  } else {
    expr = iff(lt(f, K(s)), K(1), expr);
  }
  return expr;
}

/**
 * region 数の安全上限（av_expr_parse の再帰深度上限 100 に対する安全弁）。
 *
 * 根拠（実測・scratch-depthcheck{,2}.ts で検証済み）:
 *   - region 1 個分の AST 深度（regionExpr、attack/release 両方あり）は 10。
 *   - min 畳み込みを平衡木にした場合の追加深度は ceil(log2(N))（線形畳み込みの旧実装は +N で、
 *     N=92 で深度 101 に達し実 ffmpeg 8.1.2 で parse 失敗することを実証済み — 平衡木化の理由）。
 *   - 合計深度 = 10 + ceil(log2(N))。N=4096 でも 10 + 12 = 22 で、上限 100 に対し 78 の余裕がある
 *     （regionExpr 自体が将来複雑化しても十分な余白）。
 * 実プロジェクトの region 数（〜数百）を大きく超える 4096 を上限とし、超過時は
 * DuckGainRegionLimitExceededError を投げて呼び出し側（fastCutPlan）に Remotion 経路への
 * 退避を強制する。
 */
export const MAX_DUCK_REGIONS = 4096;

/** MAX_DUCK_REGIONS を超える region 数で buildDuckGainAst / buildDuckGainExpr が投げる専用エラー。
 * null（「ducking 不要」の意味で使用済み）と区別するため、例外として明示的に失敗を伝える。 */
export class DuckGainRegionLimitExceededError extends Error {
  constructor(public readonly regionCount: number) {
    super(
      `ducking region 数 ${regionCount} が安全上限 ${MAX_DUCK_REGIONS} を超えています` +
        '（ffmpeg 式パーサの再帰深度上限に対する安全弁）。Remotion 経路へ退避してください。',
    );
    this.name = 'DuckGainRegionLimitExceededError';
  }
}

/**
 * buildDuckGainExpr の中間 AST。env 無し / regions 空 → null。
 * region 数が MAX_DUCK_REGIONS を超える場合は DuckGainRegionLimitExceededError を投げる。
 *
 * min は結合則・可換則を満たし、float でも評価順に依らず値は厳密に不変（IEEE754 の Math.min /
 * ffmpeg min() は交換可能な二項演算として振る舞う）。この不変性の証拠は duckGainExpr.test.ts の
 * 全フレーム同値テスト（平衡木化前後で無変更）が通ることそのもの。
 */
export function buildDuckGainAst(env: DuckEnvelope | undefined, fps: number): Expr | null {
  if (!env || env.regions.length === 0) return null;
  if (env.regions.length > MAX_DUCK_REGIONS) throw new DuckGainRegionLimitExceededError(env.regions.length);
  let parts: Expr[] = env.regions.map((r) => regionExpr(r, env.gain, env.attackFrames, env.releaseFrames, fps));
  while (parts.length > 1) {
    const next: Expr[] = [];
    for (let i = 0; i < parts.length; i += 2) next.push(i + 1 < parts.length ? minE(parts[i]!, parts[i + 1]!) : parts[i]!);
    parts = next;
  }
  return parts[0]!;
}

/**
 * ダッキング区分線形（duckFactorAt と同値。フレーム境界 t=n/fps で厳密一致）を
 * ffmpeg volume フィルタ式（変数 t = クリップ相対秒）へ転写する。
 * env 無し / regions 空 → null（フィルタ不要）。region 数上限超過 → DuckGainRegionLimitExceededError。
 */
export function buildDuckGainExpr(env: DuckEnvelope | undefined, fps: number): string | null {
  const ast = buildDuckGainAst(env, fps);
  return ast ? toFfmpegExpr(ast) : null;
}
