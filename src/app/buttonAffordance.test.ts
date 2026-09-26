import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — 監査ロジックは scripts からも使う素の ESM（型定義なし）
import { extractClassGroupsFromSource } from './cssClassAudit.mjs';

/**
 * 「クラスはあるのに、見た目がボタンになっていない」の回帰ガード。
 *
 * `styles.css` 冒頭の reset（`button { background:none; border:0; padding:0 }`）により、
 * 見た目を書き忘れたボタンは**素のテキスト**になる。`cssClassAudit` はクラスが CSS に
 * 存在するかしか見ないので、`.trash-restore { font-size: 11px }` のような
 * 「クラスはあるが面も枠も無い」規則を通してしまう（実際に 2026-08-26 の実機
 * フィードバックで指摘された）。ここでは操作ボタンごとに
 * **土台・面/枠・4 状態**が CSS で与えられていることを直接確かめる。
 */

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(APP_DIR, 'styles.css'), 'utf8');

/**
 * 操作ボタンを持つコンポーネント（ホーム・ゴミ箱・各ダイアログ・ヘルプ・チュートリアル）。
 * この一覧の `<button>` の className を全部列挙し、`ACTION_BUTTONS ∪ EXEMPT` と
 * **集合として一致する**ことを下のテストで確かめる（＝ボタンを足したのに一覧へ
 * 足し忘れると赤くなる。直書き一覧が現物から乖離するのを防ぐ・レビュー M-1）。
 */
const BUTTON_SOURCES = [
  'App.tsx',
  'panels/HomeDashboard.tsx',
  'panels/TrashView.tsx',
  'panels/TrashDialog.tsx',
  'panels/ExportDialog.tsx',
  'panels/MediaPicker.tsx',
  'panels/TrashConfirmDialog.tsx',
  'panels/HeavyJobConfirmDialog.tsx',
  'help/HelpModal.tsx',
  'tutorial/TutorialOverlay.tsx',
] as const;

/** 画面上の操作ボタン（編集画面本体は対象外）。ここに足したら「ボタン共通系統」にも足す。 */
const ACTION_BUTTONS = [
  'home-create-btn',
  'home-create-link-btn',
  'home-trash-open',
  'home-trash-back',
  'home-select-toggle',
  'home-select-move',
  'trash-restore',
  'trash-purge',
  'trash-empty-all',
  'export-cancel',
  'export-start',
  'hjc-dismiss',
  'hjc-confirm',
  'help-nav-btn',
  'help-replay-btn',
  'tut-next',
  'tut-skip',
] as const;

/**
 * 「ボタン共通系統」の 4 階層に乗せない `<button>`。除外は理由つきでここにだけ書く。
 * （見た目を持たないわけではなく、**別系統の意匠を持つ**もの。）
 */
const EXEMPT: Record<string, string> = {
  'home-view-btn': 'ビュー切替のセグメンテッドコントロール（押しっぱなしの選択状態を持つ別系統）',
  'home-card-delete': 'カード右上のアイコンボタン（ホバーで出る 24px 角・寸法規約が別）',
  'dd-item': 'ドロップダウンの行（メニュー項目であり単独のボタンではない）',
  'export-details-toggle': '詳細の開閉ディスクロージャ（テキストリンク意匠が正）',
  'help-chip': '図鑑のフィルタチップ（選択状態を持つチップ系統）',
  'help-item': '図鑑の項目リストの行（リスト項目）',
  'help-close': 'モーダルの × 閉じる（アイコンボタン系統・focus リングだけ共通系統）',
  'tut-close': 'チュートリアルの × 閉じる（同上）',
  'mp-root': 'フォルダ選択の場所チップ（選択状態を持つチップ系統）',
  'mp-row': 'フォルダ選択のファイル/ディレクトリ行（リスト項目）',
};

/** `<button>` タグの className から基底クラス（先頭トークン）を集める。 */
function buttonBaseClasses(): Set<string> {
  const out = new Set<string>();
  for (const rel of BUTTON_SOURCES) {
    const src = readFileSync(resolve(APP_DIR, rel), 'utf8');
    for (const tag of src.match(/<button\b[\s\S]*?>/g) ?? []) {
      const groups = extractClassGroupsFromSource(tag) as Array<Set<string>>;
      for (const group of groups) {
        const base = [...group][0];
        if (base !== undefined) out.add(base);
      }
    }
  }
  return out;
}

interface Rule { selectors: string[]; body: string }

/** `@media` を**ブロックごと**取り除く（プレリュードだけ外すと中身が地の規則に混ざる・M-2）。 */
function stripAtMediaBlocks(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open === -1) { i = css.length; break; }
    let depth = 0;
    let j = open;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
    }
    i = j;
  }
  return out;
}

/** コメントと @media ブロックを外して、規則を平らに取り出す。 */
function parseRules(css: string): Rule[] {
  const flat = stripAtMediaBlocks(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    const prelude = m[1];
    const body = m[2];
    if (prelude === undefined || body === undefined) continue;
    rules.push({ selectors: prelude.split(',').map((sel) => sel.trim()).filter((sel) => sel !== ''), body });
  }
  return rules;
}

const RULES = parseRules(CSS);

/** そのクラスが「単独のクラスセレクタ」として現れる規則（`.a.b` や `.a .b` は数えない）。 */
function rulesForBareClass(cls: string): Rule[] {
  return RULES.filter((r) => r.selectors.includes(`.${cls}`));
}

/** そのクラスが、擬似クラス付きも含めて現れる規則。 */
function rulesMentioning(cls: string, pseudo: string): Rule[] {
  return RULES.filter((r) => r.selectors.some((sel) => sel.startsWith(`.${cls}${pseudo}`)));
}

describe('操作ボタンのアフォーダンス（styles.css）', () => {
  it.each(ACTION_BUTTONS)('%s は寸法と角丸を持つ（素のテキストにしない）', (cls) => {
    const bodies = rulesForBareClass(cls).map((r) => r.body).join(' ');
    expect(bodies, `${cls}: padding が無い`).toMatch(/padding\s*:/);
    expect(bodies, `${cls}: min-height が無い`).toMatch(/min-height\s*:/);
    expect(bodies, `${cls}: border-radius が無い`).toMatch(/border-radius\s*:/);
  });

  it.each(ACTION_BUTTONS)('%s は面か枠のどちらかを持つ', (cls) => {
    const bodies = rulesForBareClass(cls).map((r) => r.body).join(' ');
    expect(bodies, `${cls}: background も border(-color) も無い`).toMatch(/background\s*:|border(-color)?\s*:/);
  });

  it.each(ACTION_BUTTONS)('%s は hover / focus-visible / disabled の 3 状態を持つ', (cls) => {
    expect(rulesMentioning(cls, ':hover').length, `${cls}: :hover 規則が無い`).toBeGreaterThan(0);
    expect(rulesMentioning(cls, ':focus-visible').length, `${cls}: :focus-visible 規則が無い`).toBeGreaterThan(0);
    expect(rulesMentioning(cls, ':disabled').length, `${cls}: :disabled 規則が無い`).toBeGreaterThan(0);
  });

  it('破壊的操作は danger（赤）で、復元・キャンセルと同じ見た目にしない', () => {
    for (const cls of ['trash-purge', 'trash-empty-all', 'home-select-move']) {
      const bodies = rulesForBareClass(cls).map((r) => r.body).join(' ');
      expect(bodies, `${cls}: --danger を使っていない`).toMatch(/var\(--danger/);
    }
    // 戻せる操作（復元・キャンセル）は赤にしない＝危険度の差が見た目に出ていること。
    for (const cls of ['trash-restore', 'export-cancel', 'hjc-dismiss']) {
      const bodies = rulesForBareClass(cls).map((r) => r.body).join(' ');
      expect(bodies, `${cls}: 危険色になっている`).not.toMatch(/var\(--danger[^-]/);
    }
  });

  it('不可逆の確定（完全削除）だけ赤の塗りになる', () => {
    const danger = RULES.filter((r) => r.selectors.includes('.hjc-confirm.hjc-danger'));
    expect(danger.length, '.hjc-confirm.hjc-danger の規則が無い').toBeGreaterThan(0);
    // 面は赤（--danger 由来）。実値は白文字とのコントラストのため暗く寄せてある
    // （下の「文字と面のコントラスト」テストが数値を固定する）。
    expect(danger.map((r) => r.body).join(' ')).toMatch(/background\s*:[^;]*var\(--danger\)/);
  });

  it('対象ボタンの一覧が実際の <button> と一致する（足し忘れ・消し忘れを検出）', () => {
    const actual = [...buttonBaseClasses()].sort();
    const expected = [...new Set([...ACTION_BUTTONS, ...Object.keys(EXEMPT)])].sort();
    expect(actual).toEqual(expected);
  });
});

/* ========================================================================
   文字と面のコントラスト（WCAG 2.1 AA = 4.5:1）。
   色は styles.css から**実際に読んで**計算する（テスト側に色を書き写さない）。
   ホバーで `color-mix` が文字色トークンへ寄ると、テーマによってはコントラストが
   必ず下がる（実測: ライトの `.hjc-confirm:hover` が 3.77:1 だった）。
   ======================================================================== */

/** 規則の body から宣言を拾う（同じプロパティが複数回出るときは最後が勝つ＝CSS と同じ）。 */
function declOf(rules: Rule[], prop: string): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(r.body)) !== null) found = m[1]?.trim();
  }
  return found;
}

function rulesForSelector(sel: string): Rule[] {
  return RULES.filter((r) => r.selectors.includes(sel));
}

/** `:root` 系の宣言ブロックからカスタムプロパティを集める。 */
function tokensOf(selector: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rulesForSelector(selector)) {
    const re = /(--[a-z0-9-]+)\s*:\s*([^;]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(r.body)) !== null) map.set(m[1] as string, (m[2] as string).trim());
  }
  return map;
}

// ダークが既定（`:root`）、ライトは `[data-theme="light"]` で上書きされる。
const DARK_TOKENS = tokensOf(':root');
const LIGHT_TOKENS = new Map([...DARK_TOKENS, ...tokensOf(':root[data-theme="light"]')]);

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

/** トップレベルのカンマで分割する（`color-mix(...)` の入れ子を壊さない）。 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

/** `#hex` / `var(--x)` / `color-mix(in srgb, A p%, B)` を実 RGB へ解く。 */
function resolveColor(expr: string, tokens: Map<string, string>): Rgb {
  const e = expr.trim();
  if (e.startsWith('#')) return parseHex(e);
  if (e.startsWith('var(')) {
    const inner = splitTopLevel(e.slice(4, e.lastIndexOf(')')));
    const name = inner[0] as string;
    const value = tokens.get(name) ?? inner[1];
    if (value === undefined) throw new Error(`未定義のトークン: ${name}`);
    return resolveColor(value, tokens);
  }
  if (e.startsWith('color-mix(')) {
    const parts = splitTopLevel(e.slice('color-mix('.length, e.lastIndexOf(')')));
    // parts[0] = 'in srgb', parts[1] = '<色> <割合>%', parts[2] = '<色>'
    const first = (parts[1] as string).match(/^(.*)\s+([\d.]+)%$/);
    if (first === null) throw new Error(`解釈できない color-mix: ${e}`);
    const p = Number(first[2]) / 100;
    const a = resolveColor(first[1] as string, tokens);
    const b = resolveColor((parts[2] as string).replace(/\s+[\d.]+%$/, ''), tokens);
    return a.map((v, i) => Math.round(v * p + (b[i] as number) * (1 - p))) as Rgb;
  }
  throw new Error(`解釈できない色: ${e}`);
}

function relativeLuminance([r, g, b]: Rgb): number {
  const [rl, gl, bl] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** 面（背景）と文字色のコントラストを見るボタン。hover は自分では color を持たず base から継ぐ。 */
const CONTRAST_CASES: Array<{ label: string; selector: string; colorFrom: string }> = [
  { label: '主操作', selector: '.btn-primary', colorFrom: '.btn-primary' },
  { label: '主操作hover', selector: '.btn-primary:hover:not(:disabled)', colorFrom: '.btn-primary' },
  { label: '確定（警告色）', selector: '.hjc-confirm', colorFrom: '.hjc-confirm' },
  { label: '確定（警告色）hover', selector: '.hjc-confirm:hover:not(:disabled)', colorFrom: '.hjc-confirm' },
  { label: '完全に削除（赤の塗り）', selector: '.btn-danger-solid', colorFrom: '.btn-danger-solid' },
  {
    label: '完全に削除（赤の塗り）hover',
    selector: '.btn-danger-solid:hover:not(:disabled)',
    colorFrom: '.btn-danger-solid',
  },
];

describe('塗りボタンの文字と面のコントラスト（両テーマで AA 4.5:1）', () => {
  for (const theme of [
    { name: 'ダーク', tokens: DARK_TOKENS },
    { name: 'ライト', tokens: LIGHT_TOKENS },
  ]) {
    it.each(CONTRAST_CASES)(`${theme.name}: $label は 4.5:1 以上`, ({ selector, colorFrom }) => {
      const bgExpr = declOf(rulesForSelector(selector), 'background');
      const fgExpr = declOf(rulesForSelector(colorFrom), 'color');
      expect(bgExpr, `${selector}: background が無い`).toBeDefined();
      expect(fgExpr, `${colorFrom}: color が無い`).toBeDefined();
      const ratio = contrast(
        resolveColor(fgExpr as string, theme.tokens),
        resolveColor(bgExpr as string, theme.tokens),
      );
      expect(ratio, `${selector}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
