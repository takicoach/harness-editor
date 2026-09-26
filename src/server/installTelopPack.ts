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
//                   `export type TelopTemplateId = 1 | 2 | ... | 30;`（新テンプレート）

/** (1) フィールドに数値リテラル union を直書きしている形。 */
const DIRECT_TEMPLATE_UNION = /template\?\s*:\s*\d+(?:\s*\|\s*\d+)+\s*;/;

/** template フィールドの型注釈が「単一の識別子」の形（= エイリアス参照の候補）。 */
const TEMPLATE_ALIAS_REF = /template\?\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;/;

/** template フィールドが（必須/任意を問わず）存在するか。 */
const HAS_TEMPLATE_FIELD = /template\s*\??\s*:/;

/** template が既に number なら widen 不要。 */
const TEMPLATE_ALREADY_NUMBER = /template\s*\??\s*:\s*number\s*;/;

/** 予約語・型名を正規表現へ埋め込む前の安全確認（識別子のみ許可＝正規表現インジェクション防止）。 */
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * `type <name> = 1 | 2 | ... ;`（先頭 `|` と改行を許容・`export` 有無どちらも）を探す。
 * 数値リテラルだけの union に限定し、それ以外の中身なら null を返す（＝広げない）。
 */
function numericAliasDeclaration(src: string, name: string): RegExp | null {
  if (!SAFE_IDENTIFIER.test(name)) return null;
  const re = new RegExp(`(^|\\n)([ \\t]*)(export[ \\t]+)?type[ \\t]+${name}[ \\t]*=\\s*\\|?\\s*\\d+(?:\\s*\\|\\s*\\d+)*\\s*;`);
  return re.test(src) ? re : null;
}

/**
 * telopTypes.ts の中身から「どう widen するか」を決める。書き込みは一切しない。
 * - `null`  … widen 不要（template 無し / 既に number）
 * - 文字列  … widen 後の telopTypes.ts 全文
 * - throw   … 自動で広げられない＝中途半端な導入を避けるため中断
 */
export function widenTelopTypes(src: string): string | null {
  if (DIRECT_TEMPLATE_UNION.test(src)) {
    return src.replace(DIRECT_TEMPLATE_UNION, 'template?: number;');
  }
  if (!HAS_TEMPLATE_FIELD.test(src) || TEMPLATE_ALREADY_NUMBER.test(src)) {
    return null;
  }
  // エイリアス参照（`template?: TelopTemplateId;`）は、同一ファイル内に数値 union の
  // 宣言が実在するときだけ、その宣言側を number へ広げる。フィールド側の参照は残すため
  // 型名が未使用にならず、import 由来のエイリアス（中身を検証できない）は広げない。
  const aliasName = TEMPLATE_ALIAS_REF.exec(src)?.[1];
  if (aliasName !== undefined) {
    const decl = numericAliasDeclaration(src, aliasName);
    if (decl !== null) {
      return src.replace(decl, (_m, lead: string, indent: string, exported: string | undefined) =>
        `${lead}${indent}${exported ?? ''}type ${aliasName} = number;`);
    }
  }
  throw new HttpError(
    400,
    'telopTypes.ts の template 型を自動で number へ拡張できませんでした。手動で `template?: number;` に変更してから再実行してください。',
  );
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
  // 対象が実在のハーネス形式の案件であることを確認してから書き込む
  // （resolveProjectDir はパス封じ込めのみ・非プロジェクトの subdir へ書かない）。
  if (!existsSync(join(dir, 'src', 'videoConfig.ts'))) {
    throw new HttpError(400, '対応する動画プロジェクトではないため導入できません（src/videoConfig.ts が見つかりません）');
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
  // 共有式。これを配らないと案件側の Telop.tsx が解決できず、導入直後に真っ白になる。
  writeFileSync(join(destDir, 'telopLegacyAnimation.ts'),
    readFileSync(join(PACK_SRC, 'telopLegacyAnimation.ts'), 'utf8'), 'utf8');

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
