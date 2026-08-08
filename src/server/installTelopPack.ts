import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { TELOP_PACK } from './telopPack/manifest';
import { currentPackVersion } from './packUpgrade';

const TELOP_DIR = 'テロップテンプレート';
const PACK_SRC = join(import.meta.dirname, 'telopPack');
const MARKER = 'telop-pack.json';

// ── telopTypes.ts の template 型を number へ広げるための検出 ──
//
// 広げてよいのは「数値リテラルだけで構成された制限ユニオン」に限る。
// 任意の型宣言を正規表現で書き換えると、ユーザーのプロジェクトのソースを
// 想定外に改変してしまう（＝パック導入が任意のコード書き換え口になる）ため、
// **形が確定できたものだけ** 広げ、それ以外は書き込み前に中断する。
//
// 対応する2形態:
//   (1) 直書き   : `template?: 1 | 2 | 3;`（旧テンプレート）
//   (2) エイリアス: `template?: TelopTemplateId;` ＋ 同一ファイル内の
//                   `export type TelopTemplateId = 1 | 2 | 3;`（新テンプレート）
//
// 置換は **全件** に対して行う。先頭1件だけを置換すると、interface が2つある・
// エイリアスが2種類ある・同じ記述がコメントにも現れる、といったファイルで
// 「導入は成功したのに実際のフィールドは narrow なまま」＝ビルドが壊れた状態を
// 完了として返してしまう。さらに置換後に **事後条件** を検査し、広げられなかった
// template が1件でも残っていれば throw する（＝書き込みゼロで中断・部分適用しない）。
//
// `template` の直前には単語境界（`\b`）を要求する。`subtemplate?: 1 | 2;` のような
// 別フィールドを巻き込んで書き換えない／事後条件で誤って中断しないため。

/** (1) フィールドに数値リテラル union を直書きしている形（全件）。 */
const DIRECT_TEMPLATE_UNION = /\btemplate\?\s*:\s*\d+(?:\s*\|\s*\d+)+\s*;/g;

/** template フィールドの型注釈が「単一の識別子」の形（= エイリアス参照の候補・全件）。 */
const TEMPLATE_ALIAS_REF = /\btemplate\?\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;/g;

/** template フィールド（必須/任意を問わず）の出現（全件）。 */
const TEMPLATE_FIELD = /\btemplate\s*\??\s*:/g;

/** template フィールドと、その型注釈（同一行・`;` 終端・全件）。 */
const TEMPLATE_FIELD_TYPED = /\btemplate\s*\??\s*:\s*([^;\n]*?)\s*;/g;

/**
 * 型名を正規表現へ **埋め込んでよいか** の安全確認（正規表現インジェクション防止）。
 *
 * TS の識別子は `$` を含めてよいが、`$` は正規表現のメタ文字（行末アンカー）なので
 * エスケープせずに埋め込むと意図しないパターンになる。ここは「埋め込み可否」の門番
 * なので `$` を含む名前は許可しない — 該当する型名は widen されず、事後条件検査で
 * 400 として中断する（誤って広げるより、広げずに止める側へ倒す）。
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const WIDEN_FAILED =
  'telopTypes.ts の template 型を自動で number へ拡張できませんでした。手動で `template?: number;` に変更してから再実行してください。';

function countMatches(src: string, re: RegExp): number {
  return Array.from(src.matchAll(re)).length;
}

/**
 * `type <name> = 1 | 2 | ... ;`（先頭 `|` と改行を許容・`export` 有無どちらも）を探す。
 * 数値リテラルだけの union に限定し、それ以外の中身なら null を返す（＝広げない）。
 */
function numericAliasDeclaration(src: string, name: string): RegExp | null {
  if (!SAFE_IDENTIFIER.test(name)) return null;
  const re = new RegExp(`(^|\\n)([ \\t]*)(export[ \\t]+)?type[ \\t]+${name}[ \\t]*=\\s*\\|?\\s*\\d+(?:\\s*\\|\\s*\\d+)*\\s*;`, 'g');
  return countMatches(src, re) > 0 ? re : null;
}

/** name が同一ファイル内で `type <name> = number;` として宣言されているか。 */
function isNumberAlias(src: string, name: string): boolean {
  if (!SAFE_IDENTIFIER.test(name)) return false;
  return new RegExp(`(^|\\n)[ \\t]*(export[ \\t]+)?type[ \\t]+${name}[ \\t]*=\\s*number\\s*;`).test(src);
}

/**
 * 事後条件: すべての template フィールドが number（直接 or number エイリアス経由）に
 * なっていることを確認する。1件でも判別できない形が残っていれば throw する。
 */
function assertAllTemplatesWidened(src: string): void {
  const fieldCount = countMatches(src, TEMPLATE_FIELD);
  if (fieldCount === 0) return;
  const typed = Array.from(src.matchAll(TEMPLATE_FIELD_TYPED));
  // 型注釈を同一行で切り出せない形（複数行・`;` 無し）が混ざっていたら判別不能として中断。
  if (typed.length !== fieldCount) throw new HttpError(400, WIDEN_FAILED);
  for (const m of typed) {
    const annotation = m[1] ?? '';
    if (annotation === 'number') continue;
    if (isNumberAlias(src, annotation)) continue;
    throw new HttpError(400, WIDEN_FAILED);
  }
}

/**
 * telopTypes.ts の中身から「どう widen するか」を決める。書き込みは一切しない。
 * - `null`  … widen 不要（template 無し / 既に number）
 * - 文字列  … widen 後の telopTypes.ts 全文
 * - throw   … 自動で広げられない＝中途半端な導入を避けるため中断
 */
export function widenTelopTypes(src: string): string | null {
  // (1) 直書き union を全件 number へ。
  let out = src.replace(DIRECT_TEMPLATE_UNION, 'template?: number;');

  // (2) エイリアス参照（`template?: TelopTemplateId;`）は、同一ファイル内に数値 union の
  // 宣言が実在するときだけ、その宣言側を number へ広げる。フィールド側の参照は残すため
  // 型名が未使用にならず、import 由来のエイリアス（中身を検証できない）は広げない。
  for (const name of new Set(Array.from(out.matchAll(TEMPLATE_ALIAS_REF), (m) => m[1] ?? ''))) {
    const decl = numericAliasDeclaration(out, name);
    if (decl === null) continue;
    out = out.replace(decl, (_m, lead: string, indent: string, exported: string | undefined) =>
      `${lead}${indent}${exported ?? ''}type ${name} = number;`);
  }

  // (3) 事後条件。広げ残しがあればここで中断する（呼び出し側は書き込み前）。
  assertAllTemplatesWidened(out);

  return out === src ? null : out;
}

/** プロジェクトにテロップパックが導入済みか（marker で判定）。 */
export function isTelopPackInstalled(dir: string): boolean {
  return existsSync(join(dir, 'src', TELOP_DIR, MARKER));
}

/**
 * テロップパックをプロジェクトの src/テロップテンプレート/ へ導入する。
 * - 既に導入済みなら no-op。
 * - 元 Telop.tsx を Telop.original.bak.tsx へ退避（既存バックアップは上書きしない）。
 * - アダプタ Telop.tsx・styles/・manifest 由来の marker(telop-pack.json) を書き込む。
 * - 既存 telopTypes.ts の template 型を **その場で** number へ widen（パックは telopTypes.ts を
 *   同梱しない＝プロジェクト固有の型ファイルを温存する）。自動 widen できない型なら導入を中断する。
 */
export function installTelopPack(dir: string): { installed: boolean } {
  const destDir = join(dir, 'src', TELOP_DIR);
  if (isTelopPackInstalled(dir)) return { installed: true };
  // 対象が実在のハーネス形式プロジェクトであることを確認してから書き込む
  // （resolveProjectDir はパス封じ込めのみ・非プロジェクトの subdir へ書かない）。
  if (!existsSync(join(dir, 'src', 'videoConfig.ts'))) {
    throw new HttpError(400, 'ハーネス形式のプロジェクトではないため導入できません（src/videoConfig.ts が見つかりません）');
  }

  // telopTypes.ts の template 型を number へ広げられるかを「書き込み前」に確定する。
  // 制限ユニオン → 後で widen。number 済み or template フィールド無し → そのまま。
  // それ以外（自動で広げられない template 型）→ 中途半端な導入を避けるため marker を書かず中断。
  const typesPath = join(destDir, 'telopTypes.ts');
  let widenedTypes: string | null = null;
  if (existsSync(typesPath)) {
    // 広げられない型なら widenTelopTypes が throw する（＝ここで中断・書き込みゼロ）。
    widenedTypes = widenTelopTypes(readFileSync(typesPath, 'utf8'));
  }

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  // 1. 元 Telop.tsx をバックアップ（あれば・既存 .bak は保持）。
  const telopPath = join(destDir, 'Telop.tsx');
  const bakPath = join(destDir, 'Telop.original.bak.tsx');
  if (existsSync(telopPath) && !existsSync(bakPath)) {
    renameSync(telopPath, bakPath);
  }

  // 2. アダプタ Telop.tsx と styles/ をコピー。
  writeFileSync(telopPath, readFileSync(join(PACK_SRC, 'Telop.tsx'), 'utf8'), 'utf8');
  cpSync(join(PACK_SRC, 'styles'), join(destDir, 'styles'), { recursive: true });

  // 3. telopTypes.ts の template を number へ widen（事前検証済み・対象時のみ）。
  if (widenedTypes !== null) {
    writeFileSync(typesPath, widenedTypes, 'utf8');
  }

  // 4. marker を書き込む（導入済み判定＋件数記録）。
  writeFileSync(
    join(destDir, MARKER),
    JSON.stringify({ pack: 'telop-templates', count: TELOP_PACK.length, version: currentPackVersion('telopPack') }, null, 2),
    'utf8',
  );
  return { installed: true };
}
