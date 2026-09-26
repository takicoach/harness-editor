// className ↔ アプリ入口から読み込まれる CSS 突合の共通ロジック。
// 「クラスはあるのに CSS 未定義」（素のテキスト状態のボタン等）の再発防止に使う。
// - collectUsedClasses: src/app 配下 *.tsx の className 内の静的トークンを抽出
// - collectDefinedClasses: main.tsx の import グラフと CSS @import を辿ってクラス名を抽出
// - ALLOWLIST: 見た目を持たない意図的なマーカークラス（JS/テストフック等）
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
  // NativeKeyframeSettings の実操作監査フック。section自体は
  // .native-inspector section で装飾され、専用クラスの装飾は持たない。
  'native-position-keys',
  // 純粋なラッパー/スロット（子要素側がスタイルを持つ）
  'ins-pane',
  'conv-banner-slot',
  // NativeSegmented に渡す className prop。実DOMでは "native-seg native-tools" に
  // 合成され、表示は共通ルートクラス .native-seg が担う（工具列専用の単独定義はない）。
  'native-tools',
  // 各キーの子native-propertyと共通buttonが表示を担当するグループ。
  'native-motion-key',
  // 旧カット読み込みのグループ。子の共通button/native-subtle/TaskProgressが表示を担当する。
  'native-source-gaps',
  // インラインstyleで完結している要素
  // タイムラインの復元選択帯は位置・幅・枠・背景をインライン指定する。
  'native-cut-restore-selection',
  'pv-shape-preview',
  'ins-note',
  'ins-vi-speed-warn',
  'ins-vi-source-overflow-warn',
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
 * 「どのクラスも読み込まれる CSS に現れない要素」を検出する。
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

/** Only styles reachable from the application entry count as definitions. */
export function collectDefinedClasses(entry = join(APP_DIR, 'main.tsx')) {
  const seen = new Set();
  const styles = [];
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    function follow(specifier) {
      if (!specifier.startsWith('.')) return;
      const base = resolve(dirname(file), specifier);
      const target = [base, ...['.ts', '.tsx', '.js', '.mjs'].map((ext) => base + ext),
        ...['index.ts', 'index.tsx', 'index.js'].map((name) => join(base, name))]
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (target && ['.ts', '.tsx', '.js', '.mjs', '.css'].includes(extname(target))) visit(target);
    }
    if (extname(file) === '.css') {
      // Preserve offsets while masking strings and comments: declaration examples
      // and filenames must not become either imports or class selectors.
      let css = source.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
        (token) => ' '.repeat(token.length));
      let depth = 0;
      for (let index = 0; index < css.length; index++) {
        if (css[index] === '{') depth++;
        if (css[index] === '}') depth--;
        if (depth !== 0 || !css.slice(index).startsWith('@import')) continue;
        const statement = /^@import\b[^;{}]*;/.exec(css.slice(index));
        if (!statement) continue;
        const original = source.slice(index, index + statement[0].length);
        const imported = /^@import\s+(?:['"]([^'"]+)['"]|url\(\s*(?:['"]([^'"]+)['"]|([^\s)'";]+))\s*\))/.exec(original);
        if (imported) follow(imported[1] ?? imported[2] ?? imported[3]);
        css = css.slice(0, index) + ' '.repeat(statement[0].length) + css.slice(index + statement[0].length);
        index += statement[0].length - 1;
      }
      styles.push(css);
      return;
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function scan(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && !node.isTypeOnly && !node.importClause?.isTypeOnly) {
        const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
        const inlineTypesOnly = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
          && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
          && !node.importClause?.name;
        if (!inlineTypesOnly) follow(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) follow(node.arguments[0].text);
      ts.forEachChild(node, scan);
    }
    scan(ast);
  }
  visit(resolve(entry));
  const css = styles.join('\n');
  const defined = new Set();
  // Only rule preludes define selectors. Declaration URLs and @supports/media
  // conditions can mention .tokens without defining their appearance.
  for (const rule of css.matchAll(/([^{};]+)\{/g)) {
    const selector = rule[1].trim();
    if (selector.startsWith('@')) continue;
    for (const token of selector.matchAll(/\.([a-z][a-z0-9-]*)/g)) defined.add(token[1]);
  }
  return defined;
}
