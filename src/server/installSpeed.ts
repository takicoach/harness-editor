import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { currentPackVersion } from './packUpgrade';
import { parseSpeedData, serializeSpeedData } from '../core/speedData';
import { cutDataImport } from './cutDataImport';

const SPEED_DIR = 'Speed';
const MARKER = 'speed.json';
const PAYLOAD_SRC = join(import.meta.dirname, '..', 'server', 'speedPayload');

export function isSpeedInstalled(dir: string): boolean {
  return existsSync(join(dir, 'src', SPEED_DIR, MARKER));
}

/**
 * 最後の import 行の直後に 1 行追加する（既にその文字列が含まれていれば何もしない）。
 */
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

/** 導入後に常在させる speedData.ts（MAIN_SPEED＋SEGMENT_SPEEDS を必ず両方出力）。 */
function writeSpeedDataAlways(mainSpeed: number, segmentSpeeds: Record<number, number>): string {
  // serializeSpeedData は mainSpeed=1 かつ個別ゼロで null を返すので、その場合のみ空テンプレを生成。
  return (
    serializeSpeedData(mainSpeed, segmentSpeeds) ??
    `// Harness Editor が生成・更新します（メイン動画の速度）\n\nexport const MAIN_SPEED = 1;\nexport const SEGMENT_SPEEDS: Record<number, number> = {  };\n`
  );
}

/**
 * MainVideo.tsx へ SpeedPlayer 差替＋import を注入。
 * 失敗（アンカー無し）は null を返す。
 */
function injectMainVideo(source: string, cutImport: string): string | null {
  if (source.includes('<SpeedPlayer')) return source; // 冪等（速度単独ベース）

  // トランジション導入済み: ベースは <CutPlayerWithTransitions ...>。SpeedPlayer へ差し替えず、
  // 既存タグへ mainSpeed={MAIN_SPEED} プロップを注入する（cutData/staticFile/VIDEO_FILE は
  // トランジション導入時に既に import 済みのため足さない＝import パス不一致を避ける）。
  if (source.includes('<CutPlayerWithTransitions')) {
    if (/<CutPlayerWithTransitions[^>]*\bmainSpeed=/.test(source)) {
      return addImportLine(source, "import { MAIN_SPEED } from './speedData';"); // 既に注入済み（冪等）
    }
    const out = source.replace(
      /(<CutPlayerWithTransitions\b[^>]*?)(\svideoSrc=)/,
      '$1 mainSpeed={MAIN_SPEED}$2',
    );
    if (out === source) return null; // videoSrc アンカー無し（異常 MainVideo）
    return addImportLine(out, "import { MAIN_SPEED } from './speedData';");
  }

  const jsx = '<SpeedPlayer cutData={cutData} videoSrc={staticFile(VIDEO_FILE)} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} />';
  let out = source;

  // staticFile import の要否は「置換前の source」で判定する（置換後の out では常に true になる）。
  const hasStaticFileImport = /import\s*\{[^}]*\bstaticFile\b[^}]*\}\s*from\s*['"]remotion['"]/.test(source);

  // ── 1. <CutPlayer /> → <SpeedPlayer /> 置換（sample 系） ─────────────────
  const cutPlayerRe = /<CutPlayer\s*\/>/;
  if (cutPlayerRe.test(out)) {
    out = out.replace(cutPlayerRe, jsx);
  } else {
    // ── 2. VIDEO_FILE を含む OffthreadVideo ブロック（golf-drills 系・複数行） ──
    const offRe = /<(?:OffthreadVideo|Video)\b[\s\S]*?\/>/g;
    let target: string | null = null;
    let mm: RegExpExecArray | null;
    while ((mm = offRe.exec(out)) !== null) {
      if (mm[0].includes('VIDEO_FILE')) {
        target = mm[0];
        break;
      }
    }
    if (target === null) return null;
    out = out.replace(target, jsx);
  }

  // ── 3. import 追加 ────────────────────────────────────────────────────────
  out = addImportLine(out, "import { SpeedPlayer } from './Speed';");
  out = addImportLine(out, `import { cutData } from '${cutImport}';`);
  out = addImportLine(out, "import { MAIN_SPEED, SEGMENT_SPEEDS } from './speedData';");
  if (!hasStaticFileImport) out = addImportLine(out, "import { staticFile } from 'remotion';");
  out = addImportLine(out, "import { VIDEO_FILE } from './videoConfig';");
  return out;
}

/**
 * Root.tsx の durationInFrames を速度対応へ置換＋import 追加。
 * isTransition=true（CutPlayerWithTransitions 経路）は Plan 3 のため Math.round のまま維持。
 * 失敗（アンカー無し）は null を返す。
 */
function injectRoot(source: string, cutImport: string, isTransition = false): string | null {
  let out = source;
  if (isTransition) {
    // トランジション経路: 旧 Math.round 式を維持（Plan 3 で segmentSpeeds 対応予定）
    if (!out.includes('Math.round(CUT_DURATION_FRAMES / MAIN_SPEED)')) {
      const durRe = /durationInFrames=\{[^}]*\}/;
      if (!durRe.test(out)) return null;
      out = out.replace(durRe, 'durationInFrames={Math.round(CUT_DURATION_FRAMES / MAIN_SPEED)}');
    }
    out = addImportLine(out, `import { CUT_DURATION_FRAMES } from '${cutImport}';`);
    out = addImportLine(out, "import { MAIN_SPEED } from './speedData';");
    return out;
  }
  // 非トランジション経路: 区間ごと速度対応の合成尺ヘルパを使う
  const target = 'durationInFrames={speedCompositionDuration(cutData, CUT_DURATION_FRAMES, MAIN_SPEED, SEGMENT_SPEEDS)}';
  if (!out.includes(target)) {
    const durRe = /durationInFrames=\{[^}]*\}/;
    if (!durRe.test(out)) return null;
    out = out.replace(durRe, target);
  }
  out = addImportLine(out, "import { speedCompositionDuration } from './Speed';");
  out = addImportLine(out, `import { cutData, CUT_DURATION_FRAMES } from '${cutImport}';`);
  out = addImportLine(out, "import { MAIN_SPEED, SEGMENT_SPEEDS } from './speedData';");
  return out;
}

/**
 * メイン動画速度書き出し機能をプロジェクトへ導入する。
 *
 * 処理順（失敗時ゼロ副作用）:
 * 1. 冪等チェック（marker）
 * 2. ハーネス形式プロジェクト検証（src/videoConfig.ts）
 * 3. MainVideo.tsx / Root.tsx 存在チェック
 * 4. cutData.ts 検出
 * 5. 差替結果を書込前に確定（MainVideo / Root）← ここまで副作用なし
 * 6. 部品コピー（src/Speed/）
 * 7. speedData.ts 確保（既存値・不在は 1.0・常時生成）
 * 8. MainVideo バックアップ→書込
 * 9. Root 書込
 * 10. marker 書込
 */
export function installSpeed(dir: string): { installed: boolean } {
  // 1. 冪等
  if (isSpeedInstalled(dir)) return { installed: true };

  // 2. ハーネス形式プロジェクト検証
  if (!existsSync(join(dir, 'src', 'videoConfig.ts'))) {
    throw new HttpError(
      400,
      'ハーネス形式のプロジェクトではないため導入できません（src/videoConfig.ts が見つかりません）',
    );
  }

  // 3. MainVideo.tsx / Root.tsx 存在チェック
  const mainVideoPath = join(dir, 'src', 'MainVideo.tsx');
  const rootPath = join(dir, 'src', 'Root.tsx');
  if (!existsSync(mainVideoPath)) {
    throw new HttpError(400, 'src/MainVideo.tsx が見つかりません');
  }
  if (!existsSync(rootPath)) {
    throw new HttpError(400, 'src/Root.tsx が見つかりません');
  }

  // 4. cutData.ts 検出
  const cutImport = cutDataImport(dir);
  if (cutImport === null) {
    throw new HttpError(
      400,
      'カットデータ（cutData.ts）が見つかりません。先にカット編集を保存してください。',
    );
  }

  // 5. 差替結果を書込前に確定（失敗なら何も変更しない）
  const mainVideoSrc = readFileSync(mainVideoPath, 'utf8');
  const isTransition = mainVideoSrc.includes('<CutPlayerWithTransitions');
  const injectedMain = injectMainVideo(mainVideoSrc, cutImport);
  if (injectedMain === null) {
    throw new HttpError(
      400,
      'MainVideo.tsx のベース動画要素が見つかりませんでした。手動で <SpeedPlayer .../> へ差し替えてください。',
    );
  }
  const injectedRoot = injectRoot(readFileSync(rootPath, 'utf8'), cutImport, isTransition);
  if (injectedRoot === null) {
    throw new HttpError(400, 'Root.tsx に durationInFrames が見つかりませんでした。');
  }

  // ── ここより下は副作用あり（上記がすべて成功した場合のみ到達） ──────────

  // 6. 部品コピー（*.test.* 除外）
  const destDir = join(dir, 'src', SPEED_DIR);
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(PAYLOAD_SRC)) {
    if (entry.includes('.test.')) continue;
    cpSync(join(PAYLOAD_SRC, entry), join(destDir, entry), { recursive: true });
  }

  // 7. speedData.ts を確保（既存値＋既存 SEGMENT_SPEEDS を保全・不在は 1.0/空・常時両方出力）
  const speedPath = join(dir, 'src', 'speedData.ts');
  const cur = existsSync(speedPath)
    ? parseSpeedData(readFileSync(speedPath, 'utf8'))
    : { mainSpeed: 1, segmentSpeeds: {} };
  writeFileSync(speedPath, writeSpeedDataAlways(cur.mainSpeed, cur.segmentSpeeds), 'utf8');

  // 8. MainVideo バックアップ→書込
  const bak = join(dir, 'src', 'MainVideo.original.bak.tsx');
  if (!existsSync(bak)) renameSync(mainVideoPath, bak);
  writeFileSync(mainVideoPath, injectedMain, 'utf8');

  // 9. Root 書込
  writeFileSync(rootPath, injectedRoot, 'utf8');

  // 10. marker
  writeFileSync(
    join(destDir, MARKER),
    JSON.stringify({ feature: 'speed', installedAt: 'editor', version: currentPackVersion('speed') }, null, 2),
    'utf8',
  );
  return { installed: true };
}
