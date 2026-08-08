// className ↔ styles.css 突合の共通ロジック。
// 「クラスはあるのに CSS 未定義」（素のテキスト状態のボタン等）の再発防止に使う。
// - collectUsedClasses: src/app 配下 *.tsx の className 内の静的トークンを抽出
// - collectDefinedClasses: styles.css の全セレクタに現れるクラス名を抽出
// - ALLOWLIST: 見た目を持たない意図的なマーカークラス（JS/テストフック等）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = dirname(fileURLToPath(import.meta.url));

/** 見た目を持たなくてよいクラス（JSフック・テストフック・状態マーカー）。追加時は理由を書く。 */
export const ALLOWLIST = new Set([
  // 状態マーカー: 親側の複合セレクタ（.foo.on 等）でのみ参照され単独定義を持たない
  'on',
  'active',
  'selected',
  'open-mode',
  'ghost',
  'start',
  'end',
  // JSフック: querySelector 用でスタイル不要
  'ml-thumb-video-el',
  // 純粋なラッパー/スロット（子要素側がスタイルを持つ）
  'ins-pane',
  'conv-banner-slot',
  // インラインstyleで完結している要素
  'pv-shape-preview',
  'ins-note',
  'ins-vi-speed-warn',
  // className式の中の比較用文字列で、クラス名ではない（抽出器の限界による誤検知）
  'normal',
  // InstallCtaButton の className prop（実DOMでは ins-pack-install が合成されてスタイル済み。
  // 静的解析ではコンポーネント prop と DOM 属性を区別できないため個別許容）
  'ins-bgm-install',
  'ins-install-cta',
  'ins-speed-install',
  'ins-video-install',
  'ins-shape-install',
  'ins-telop-pack-install',
]);

function walkTsx(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTsx(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * className 属性内の引用文字列から静的クラストークンを「属性ごとのグループ」で抽出する。
 * 1要素に複数クラスがある場合、どれか1つでもスタイル定義があれば「素のテキスト状態」
 * にはならないため、判定はグループ単位で行う。
 */
export function extractClassGroupsFromSource(src) {
  const groups = [];
  const attrRe = /className=\{([\s\S]*?)\}|className="([^"]*)"|className='([^']*)'/g;
  let m;
  while ((m = attrRe.exec(src)) !== null) {
    const expr = m[1];
    const plain = m[2] ?? m[3];
    const texts = [];
    if (plain !== undefined) texts.push(plain);
    if (expr !== undefined) {
      const strRe = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;
      let sm;
      while ((sm = strRe.exec(expr)) !== null) {
        let t = sm[1] ?? sm[2] ?? sm[3] ?? '';
        t = t.replace(/\$\{[^}]*\}/g, ' ');
        texts.push(t);
      }
    }
    const tokens = new Set();
    for (const t of texts) {
      for (const token of t.split(/\s+/)) {
        if (/^[a-z][a-z0-9-]*$/.test(token) && !token.endsWith('-')) tokens.add(token);
      }
    }
    if (tokens.size > 0) groups.push(tokens);
  }
  return groups;
}

/** className 属性内の引用文字列から静的クラストークンを抽出する。 */
export function extractClassesFromSource(src) {
  const out = new Set();
  // className= に続く式を大づかみに取り、その中の引用文字列を走査する。
  // テンプレートリテラルは ${...} を除いた静的部分だけを対象にする。
  const attrRe = /className=\{([\s\S]*?)\}|className="([^"]*)"|className='([^']*)'/g;
  let m;
  while ((m = attrRe.exec(src)) !== null) {
    const expr = m[1];
    const plain = m[2] ?? m[3];
    const texts = [];
    if (plain !== undefined) texts.push(plain);
    if (expr !== undefined) {
      const strRe = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;
      let sm;
      while ((sm = strRe.exec(expr)) !== null) {
        let t = sm[1] ?? sm[2] ?? sm[3] ?? '';
        t = t.replace(/\$\{[^}]*\}/g, ' ');
        texts.push(t);
      }
    }
    for (const t of texts) {
      for (const token of t.split(/\s+/)) {
        // 動的接頭辞の断片（例: `diff-badge-` + kind）は完全なクラス名でないため除外
        if (/^[a-z][a-z0-9-]*$/.test(token) && !token.endsWith('-')) out.add(token);
      }
    }
  }
  return out;
}

export function collectUsedClasses() {
  const used = new Set();
  for (const file of walkTsx(APP_DIR, [])) {
    for (const c of extractClassesFromSource(readFileSync(file, 'utf8'))) used.add(c);
  }
  return used;
}

/**
 * 「どのクラスも styles.css に現れない要素」を検出する。
 * 戻り値: [{ file, classes }] — 完全に未スタイルの className グループ。
 */
export function findUnstyledGroups() {
  const defined = collectDefinedClasses();
  const results = [];
  for (const file of walkTsx(APP_DIR, [])) {
    for (const group of extractClassGroupsFromSource(readFileSync(file, 'utf8'))) {
      const tokens = [...group].filter((c) => !ALLOWLIST.has(c));
      if (tokens.length === 0) continue;
      if (tokens.every((c) => !defined.has(c))) {
        results.push({ file: file.slice(APP_DIR.length + 1), classes: tokens.join(' ') });
      }
    }
  }
  return results;
}

export function collectDefinedClasses() {
  const css = readFileSync(join(APP_DIR, 'styles.css'), 'utf8');
  const defined = new Set();
  // コメントを除去してから、セレクタ位置に限らず .class 出現をすべて拾う
  // （数値開始の .5s のような時間表記は除外される）。
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /\.([a-z][a-z0-9-]*)/g;
  let m;
  while ((m = re.exec(noComments)) !== null) defined.add(m[1]);
  return defined;
}
