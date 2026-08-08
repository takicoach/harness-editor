import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { currentPackVersion } from './packUpgrade';
import { serializeMainLayoutData, parseMainLayoutFile } from '../core/mainLayoutData';
import type { MainLayout, SegmentLayout } from '../core/types';
import type { LayoutKeyframe } from '../core/layoutKeyframes';
import { cutDataImport } from './cutDataImport';

const MAIN_LAYOUT_DIR = 'MainLayout';
const MARKER = 'main-layout.json';
const PAYLOAD_SRC = join(import.meta.dirname, '..', 'server', 'mainLayoutPayload');

export function isMainLayoutInstalled(dir: string): boolean {
  return existsSync(join(dir, 'src', MAIN_LAYOUT_DIR, MARKER));
}

/** 最後の import 行の直後に 1 行追加（既にあれば no-op）。installSpeed と同一実装。 */
function addImportLine(source: string, line: string): string {
  if (source.includes(line)) return source;
  const importRe = /^import .*$/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) last = m;
  if (last === null) return source;
  const lastLine = last[0];
  if (lastLine === undefined) return source;
  const after = last.index + lastLine.length;
  return source.slice(0, after) + '\n' + line + source.slice(after);
}

/** 導入後に常在させる mainLayoutData.ts（恒等でも MAIN_LAYOUT＋SEGMENT_LAYOUTS＋LAYOUT_KEYFRAMES を必ず出力）。 */
export function writeMainLayoutAlways(
  layout: MainLayout,
  segmentLayouts: Record<number, SegmentLayout> = {},
  layoutKeyframes: LayoutKeyframe[] = [],
): string {
  return (
    serializeMainLayoutData(layout, segmentLayouts, layoutKeyframes) ??
    `// Harness Editor が生成・更新します（メイン動画のレイアウト）\n\n` +
      `export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1, background: '#000000' };\n` +
      `export const SEGMENT_LAYOUTS: Record<number, { position: { x: number; y: number }; scale: number; rotation?: number; flipH?: boolean; flipV?: boolean }> = {  };\n` +
      `export const LAYOUT_KEYFRAMES: { originalFrame: number; x: number; y: number; scale: number; rotation: number }[] = [];\n`
  );
}

type BaseKind = 'speed' | 'transition' | 'cut' | 'rawVideo' | null;

/** MainVideo.tsx のベース動画要素の種別を判定する。 */
function detectBaseKind(source: string): BaseKind {
  if (/<SpeedPlayer\b/.test(source)) return 'speed';
  if (/<CutPlayerWithTransitions\b/.test(source)) return 'transition';
  if (/<CutPlayer\s*\/>/.test(source)) return 'cut';
  const offRe = /<(?:OffthreadVideo|Video)\b[\s\S]*?\/>/g;
  let mm: RegExpExecArray | null;
  while ((mm = offRe.exec(source)) !== null) {
    if (mm[0].includes('VIDEO_FILE')) return 'rawVideo';
  }
  return null;
}

/**
 * MainVideo.tsx のベース動画要素を <MainLayout ...> でラップ（差し替えない）＋import 注入。
 * frameAware（SpeedPlayer/CutPlayer ベース）のときは区間ごと props（segmentLayouts/cutData/mainSpeed/segmentSpeeds）も配線。
 * 既に base-only で包まれている既存導入は、frameAware なら不足 props/import を追記して格上げする。
 * frameAware=false（transition/rawVideo）は従来の base-only。アンカー無しは null。
 */
function injectMainVideoLayout(source: string, frameAware: boolean, cutImport: string | null): string | null {
  const openTag = frameAware
    ? '<MainLayout layout={MAIN_LAYOUT} segmentLayouts={SEGMENT_LAYOUTS} cutData={cutData} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} layoutKeyframes={LAYOUT_KEYFRAMES}>'
    : '<MainLayout layout={MAIN_LAYOUT}>';

  const addFrameImports = (s: string): string => {
    let out = addImportLine(s, "import { MainLayout } from './MainLayout';");
    out = addImportLine(out, "import { MAIN_LAYOUT } from './mainLayoutData';");
    if (frameAware) {
      out = addImportLine(out, "import { SEGMENT_LAYOUTS, LAYOUT_KEYFRAMES } from './mainLayoutData';");
      if (cutImport !== null) out = addImportLine(out, `import { cutData } from '${cutImport}';`);
      out = addImportLine(out, "import { MAIN_SPEED, SEGMENT_SPEEDS } from './speedData';");
    }
    return out;
  };

  // 既に <MainLayout> あり＝導入済み。
  if (source.includes('<MainLayout')) {
    // frameAware かつ base-only／layoutKeyframes 未配線なら格上げ。
    if (frameAware && !source.includes('segmentLayouts=')) {
      let out = source.replace('<MainLayout layout={MAIN_LAYOUT}>', () => openTag);
      out = addFrameImports(out);
      return out;
    }
    if (frameAware && source.includes('segmentLayouts=') && !source.includes('layoutKeyframes=')) {
      let out = source.replace(
        '<MainLayout layout={MAIN_LAYOUT} segmentLayouts={SEGMENT_LAYOUTS} cutData={cutData} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS}>',
        () => openTag,
      );
      out = addImportLine(out, "import { LAYOUT_KEYFRAMES } from './mainLayoutData';");
      return out;
    }
    return source; // 冪等（既に目的の形）
  }

  // 未ラップ: ベース要素を検出して包む。
  let target: string | null = null;
  for (const re of [/<SpeedPlayer\b[\s\S]*?\/>/, /<CutPlayerWithTransitions\b[\s\S]*?\/>/, /<CutPlayer\s*\/>/]) {
    const m = re.exec(source);
    if (m !== null) {
      target = m[0];
      break;
    }
  }
  if (target === null) {
    const offRe = /<(?:OffthreadVideo|Video)\b[\s\S]*?\/>/g;
    let mm: RegExpExecArray | null;
    while ((mm = offRe.exec(source)) !== null) {
      if (mm[0].includes('VIDEO_FILE')) {
        target = mm[0];
        break;
      }
    }
  }
  if (target === null) return null;

  const wrapped = `${openTag}\n        ${target}\n      </MainLayout>`;
  // replace の第 2 引数は関数形式にして target 内の `$` が特殊解釈されるのを防ぐ。
  let out = source.replace(target, () => wrapped);
  out = addFrameImports(out);
  return out;
}

/**
 * メイン動画レイアウト書き出し機能をプロジェクトへ導入する。
 * speed と違い Root.tsx は変更しない（レイアウトは合成尺に影響しない）。
 * ベースが SpeedPlayer / CutPlayer（＋cutData.ts あり）のときは frame 対応（区間ごとレイアウト）を配線し、
 * speedData.ts を常設する。CutPlayerWithTransitions（Plan 3）／生 Video（区間無し）は base-only。
 * 既存の base-only 導入は、再導入時に frame 対応へ格上げする（冪等・失敗時ゼロ副作用）。
 *
 * 処理順（失敗時ゼロ副作用）:
 * 1. ハーネス形式検証（src/videoConfig.ts）
 * 2. MainVideo.tsx 存在チェック
 * 3. ベース判定＋ラップ/格上げ結果を書込前に確定 ← ここまで副作用なし
 * 4. 部品コピー（src/MainLayout/）
 * 5. mainLayoutData.ts 確保（既存値＋既存 SEGMENT_LAYOUTS 保全・不在は恒等・常時両 export）
 * 6. frame 対応時は speedData.ts を常設（速度未導入でも payload の import 解決）
 * 7. MainVideo が変わるときだけバックアップ（無ければ）→書込
 * 8. marker 書込（再導入で最新化）
 */
export function installMainLayout(dir: string): { installed: boolean } {
  if (!existsSync(join(dir, 'src', 'videoConfig.ts'))) {
    throw new HttpError(
      400,
      'ハーネス形式のプロジェクトではないため導入できません（src/videoConfig.ts が見つかりません）',
    );
  }
  const mainVideoPath = join(dir, 'src', 'MainVideo.tsx');
  if (!existsSync(mainVideoPath)) {
    throw new HttpError(400, 'src/MainVideo.tsx が見つかりません');
  }

  const mainVideoSrc = readFileSync(mainVideoPath, 'utf8');
  const baseKind = detectBaseKind(mainVideoSrc);
  const cutImport = cutDataImport(dir);
  const frameAware = (baseKind === 'speed' || baseKind === 'cut') && cutImport !== null;

  const injected = injectMainVideoLayout(mainVideoSrc, frameAware, cutImport);
  if (injected === null) {
    throw new HttpError(
      400,
      'MainVideo.tsx のベース動画要素が見つかりませんでした。手動で <MainLayout layout={MAIN_LAYOUT}> でラップしてください。',
    );
  }

  // ── ここより下は副作用あり ──
  const destDir = join(dir, 'src', MAIN_LAYOUT_DIR);
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(PAYLOAD_SRC)) {
    if (entry.includes('.test.')) continue;
    cpSync(join(PAYLOAD_SRC, entry), join(destDir, entry), { recursive: true });
  }

  // mainLayoutData.ts 確保（既存値＋既存 SEGMENT_LAYOUTS を保全・不在は恒等・常時両 export）
  const layoutPath = join(dir, 'src', 'mainLayoutData.ts');
  const curSrc = existsSync(layoutPath) ? readFileSync(layoutPath, 'utf8') : null;
  const { layout: curLayout, segmentLayouts: curSeg, layoutKeyframes: curKf } = parseMainLayoutFile(curSrc);
  writeFileSync(layoutPath, writeMainLayoutAlways(curLayout, curSeg, curKf), 'utf8');

  // frame 対応時は speedData.ts を常設（速度未導入でも payload の import 解決・後から速度導入で自動追従）
  if (frameAware) {
    const speedPath = join(dir, 'src', 'speedData.ts');
    if (!existsSync(speedPath)) {
      writeFileSync(
        speedPath,
        `// Harness Editor が生成・更新します（メイン動画の速度）\n\nexport const MAIN_SPEED = 1;\nexport const SEGMENT_SPEEDS: Record<number, number> = {  };\n`,
        'utf8',
      );
    }
  }

  // MainVideo が変わるときだけ書き戻す（backup は既存を温存）
  if (injected !== mainVideoSrc) {
    const bak = join(dir, 'src', 'MainVideo.original.bak.tsx');
    if (!existsSync(bak)) renameSync(mainVideoPath, bak);
    writeFileSync(mainVideoPath, injected, 'utf8');
  }

  // marker（version 更新＝再導入で最新化）
  writeFileSync(
    join(destDir, MARKER),
    JSON.stringify({ feature: 'mainLayout', installedAt: 'editor', version: currentPackVersion('mainLayout') }, null, 2),
    'utf8',
  );
  return { installed: true };
}
