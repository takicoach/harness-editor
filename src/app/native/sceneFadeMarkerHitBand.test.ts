import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, it} from 'vitest';

/**
 * 場面フェードの印は分割点＝トリムハンドルと同じ座標に置かれ、`onPointerDown` で
 * `stopPropagation` する。素の button の min-height（--btn-h:30px）のままだと当たり判定が
 * クリップの上 3/4 を覆い、端ドラッグ（＝「詰める」の join / push を起こす唯一の操作）の
 * pointerdown を奪う。ブラウザ実測で確認した不具合なので、幾何の不変条件を CSS から機械検査する。
 *
 * 不変条件: フェードの印の当たり判定の下端が、トリムハンドルの縦中央より上で終わること。
 * （ハンドルはクリップと同じ高さ・`top:0;bottom:0`。フェードの印は z-index 4 でハンドルの 2 より
 * 前面なので、自分の帯の中では従来どおり押せる。）
 *
 * `.native-clip` の `top` / `height` は 4 つの CSS が別々に指定する（native.css の `calc(…)`、
 * native-polish.css の実数、native-studio.css / native-restoration.css の詳細度の高い上書き）。
 * どれが効くかは CSS のカスケード＝「詳細度 → 同点なら読み込み順」で決まるので、規則を 1 つ決め打ちせず
 * 同じ順で勝者を選ぶ。読み込み順は NativeWorkspace.tsx の import から読む（列を手で書くと import が
 * 変わったとき黙って古くなる）。効く組み合わせはトラックの種類で変わるので、ありうる文脈すべての
 * 「床」＝ハンドル縦中央がいちばん低くなる場合で不変条件を見る。
 */
const nativeDirectory = __dirname;
const workspace = readFileSync(resolve(nativeDirectory, 'NativeWorkspace.tsx'), 'utf8');
/** カスケード順＝この画面が CSS を読み込む順。NativeWorkspace.tsx の `import './x.css'` の並びが正本。 */
const cssFiles = [...workspace.matchAll(/^import '\.\/([\w-]+\.css)';$/gm)].map(match => match[1]!);
if (!cssFiles.includes('native.css')) throw new Error('NativeWorkspace.tsx から CSS の読み込み順が読めません');

interface Rule {order: number; file: string; selector: string; spec: readonly [number, number, number]; body: string; conditional: boolean}
/** 詳細度（id 数・クラス/属性/擬似クラス数・要素数）。`:not(...)` の中身も数える（CSS の規則どおり）。 */
const specificity = (selector: string): readonly [number, number, number] => [
  (selector.match(/#[\w-]+/g) ?? []).length,
  (selector.match(/\.[\w-]+/g) ?? []).length + (selector.match(/\[[^\]]+\]/g) ?? []).length + (selector.match(/:(?!not\b)[\w-]+/g) ?? []).length,
  (selector.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length,
];
/** コメントを外し、`{}` の深さを数えながら規則を拾う。`@media` などの中の規則には conditional の印を付ける。 */
function readRules(file: string, base: number): Rule[] {
  const css = readFileSync(resolve(nativeDirectory, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      const prelude = css.slice(start, i).trim();
      if (depth === 0 && prelude.startsWith('@')) {depth = 1; start = i + 1; continue;}
      const close = css.indexOf('}', i);
      if (close < 0) break;
      for (const selector of prelude.split(',').map(value => value.trim()).filter(Boolean))
        rules.push({order: base + rules.length, file, selector, spec: specificity(selector), body: css.slice(i + 1, close), conditional: depth === 1});
      i = close; start = i + 1;
    } else if (css[i] === '}') {depth = Math.max(0, depth - 1); start = i + 1;}
  }
  return rules;
}
const rules: Rule[] = cssFiles.flatMap((file, index) => readRules(file, index * 100_000));
if (!rules.length) throw new Error('CSS の規則が 1 件も読めません');

interface Context {self: string[]; ancestors: string[]}
const classesOf = (compound: string) => (compound.replace(/:not\([^)]*\)/g, '').match(/\.[\w-]+/g) ?? []).map(name => name.slice(1));
const excludedOf = (compound: string) => [...compound.matchAll(/:not\(\.([\w-]+)\)/g)].map(match => match[1]!);
const covers = (pool: string[], compound: string) =>
  classesOf(compound).every(name => pool.includes(name)) && excludedOf(compound).every(name => !pool.includes(name));
/** この照合が扱えるのはクラスと `:not(.クラス)` だけ。要素名・属性・擬似要素を含む複合は扱わない。 */
const modeled = (compound: string) => compound.replace(/:not\(\.[\w-]+\)/g, '').replace(/\.[\w-]+/g, '').trim() === '';
const compoundsOf = (selector: string) => selector.split(/\s*[>\s+~]\s*/).filter(Boolean);
/**
 * 末尾の複合セレクタを自分に、それより前を祖先に当てる簡易照合。`>` と子孫結合子は区別しない
 * （`.native-clip` 系はどれも親＝トラック行だけを見ており、区別しても結果が変わらない）。
 */
const matches = (selector: string, context: Context): boolean => {
  const compounds = compoundsOf(selector);
  if (!compounds.every(modeled)) return false;
  return covers(context.self, compounds.at(-1)!) && compounds.slice(0, -1).every(compound => covers(context.ancestors, compound));
};
/**
 * px の四則だけを解く。解けない書き方（`%`・未定義の変数・関数）は明示的に落とす。
 *
 * I-1: `overrides` は `--native-visual-track-height` を CSS の既定値（46px）ではなく実行時に
 * JS が入れる値（例: 最小の 28px）で解くためのもの。トラックの高さは JS が実行時にインラインで
 * 入れるので、CSS が静的に持つのは既定値の方だけ ― overrides はその代わりに使う値を渡す。
 */
function px(value: string, why: string, overrides: Readonly<Record<string, number>> = {}): number {
  const expression = value.trim()
    .replace(/calc\(/g, '(')
    .replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_all: string, name: string, fallback?: string) => {
      if (name in overrides) return `(${overrides[name]})`;
      // CSS 側に定義があればそれを、無ければ var() の既定値を使う（トラックの高さは JS が実行時に
      // インラインで入れるので、CSS が静的に持つのは既定値の方）。
      const declared = rules.map(rule => new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`).exec(rule.body)?.[1]).filter(Boolean).at(-1);
      const resolved = declared ?? fallback;
      if (!resolved) throw new Error(`${why}: 変数 ${name} を解決できません（CSS に定義も既定値もありません）`);
      return `(${resolved.trim()})`;
    })
    .replace(/(-?\d+(?:\.\d+)?)px\b/g, '$1');
  if (!/^[-+*/()\d.\s]+$/.test(expression)) throw new Error(`${why}: px の四則以外が含まれます（${value.trim()}）`);
  const result = Number(new Function(`return (${expression});`)());
  if (!Number.isFinite(result)) throw new Error(`${why}: 数値になりません（${value.trim()}）`);
  return result;
}
const declaration = (body: string, property: string): string | null =>
  new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`).exec(body)?.[1] ?? null;
/** カスケードの勝者（詳細度が最大、同点なら後勝ち）。 */
function cascade(property: string, context: Context, why: string, overrides: Readonly<Record<string, number>> = {}): number {
  // 扱えない形（要素名・属性・擬似要素）で同じ要素を狙う規則が増えたら、黙って無視せず落とす。
  const unmodeled = rules.find(rule => declaration(rule.body, property) !== null && !compoundsOf(rule.selector).every(modeled)
    && context.self.some(name => compoundsOf(rule.selector).at(-1)!.includes(`.${name}`)));
  if (unmodeled) throw new Error(`${why}: ${property} を ${unmodeled.file} の ${unmodeled.selector} が指定しており、この照合では扱えません`);
  const candidates = rules.filter(rule => matches(rule.selector, context) && declaration(rule.body, property) !== null);
  if (!candidates.length) throw new Error(`${why}: ${property} を決める規則がありません`);
  const conditional = candidates.find(rule => rule.conditional);
  if (conditional) throw new Error(`${why}: ${property} が条件付き規則（${conditional.file} の ${conditional.selector}）で上書きされており静的に解決できません`);
  const beats = (a: Rule, b: Rule) => {
    for (let i = 0; i < 3; i++) if (a.spec[i]! !== b.spec[i]!) return a.spec[i]! > b.spec[i]!;
    return a.order > b.order;
  };
  const winner = candidates.reduce((best, rule) => beats(rule, best) ? rule : best);
  return px(declaration(winner.body, property)!, `${why}（${winner.file} の ${winner.selector}）`, overrides);
}

/** 行頭のセレクタ列が完全一致する規則だけを拾う（`.a,.b {` の複合規則を `.a {` と取り違えない）。 */
const css = readFileSync(resolve(nativeDirectory, 'native.css'), 'utf8');
const block = (selector: string): string => {
  const at = `\n${css}`.indexOf(`\n${selector} {`);
  expect(at, `${selector} の規則が見つかりません`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};
const num = (source: string, property: string): number => {
  const found = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*(-?\\d+)`).exec(source);
  expect(found, `${property} が見つかりません`).not.toBeNull();
  return Number(found![1]);
};
/** フェードの印が並ぶトラック行。どれでも成り立つ必要があるので、いちばん低い縦中央を床にする。 */
const TRACK_CONTEXTS: ReadonlyArray<readonly [string, Context]> = [
  ['映像トラック', {self: ['native-clip'], ancestors: ['native-track']}],
  ['カットのあるトラック', {self: ['native-clip'], ancestors: ['native-track', 'native-track-with-cuts']}],
  ['音声トラック', {self: ['native-clip'], ancestors: ['native-track', 'native-track-audio']}],
];

/**
 * I-1: 印の高さも `.native-clip` の高さも `--native-visual-track-height` から導かれるので、
 * 不変条件はトラックの高さごとに解き直す必要がある。最小（28px。MIN_TRACK_HEIGHT）と
 * 既定（46px。DEFAULT_TRACK_HEIGHT）の両方で成り立つことを assert する。
 */
for (const trackHeight of [28, 46] as const) {
  it(`フェードの印の当たり判定はトリムハンドルの縦中央より上で終わる（行の高さ ${trackHeight}px）`, () => {
    const overrides = {'--native-visual-track-height': trackHeight};
    const marker = block('.native-scene-fade-edge,.native-scene-fade-join');
    const markerHeight = px(declaration(marker, 'height')!, 'フェードの印の height', overrides);
    // min-height を 0 にしておかないと --btn-h（30px）が height を押し戻す。
    expect(marker).toMatch(/min-height\s*:\s*0/);
    const middles = TRACK_CONTEXTS.map(([name, context]) => ({name, middle: cascade('top', context, name, overrides) + cascade('height', context, name, overrides) / 2}));
    const floor = middles.reduce((low, entry) => entry.middle < low.middle ? entry : low);
    expect(floor.middle, 'ハンドルの縦中央が読めていません（存在検査）').toBeGreaterThan(0);
    for (const [name, selector] of [['join', '.native-scene-fade-join'], ['edge', '.native-scene-fade-edge']] as const) {
      const markerTop = px(declaration(block(selector), 'top')!, `${name} の top`, overrides);
      expect(markerTop + markerHeight, `${name} のフェードの印が ${floor.name} でハンドルの中央を覆っています（行の高さ ${trackHeight}px）`).toBeLessThan(floor.middle);
    }
  });
}

it('トリムハンドルはクリップ全体を覆い、フェードの印より背面にいる（フェードの印自身の帯ではフェードの印が勝つ）', () => {
  const trim = block('.native-trim'), marker = block('.native-scene-fade-edge,.native-scene-fade-join');
  expect(trim).toMatch(/top\s*:\s*0/);
  expect(trim).toMatch(/bottom\s*:\s*0/);
  expect(num(marker, 'z-index')).toBeGreaterThan(num(trim, 'z-index'));
});
