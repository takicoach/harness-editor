import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { currentPackVersion } from './packUpgrade';
import { cutDataImport } from './cutDataImport';

const TRANSITION_DIR = 'Transition';
const PAYLOAD_SRC = join(import.meta.dirname, '..', 'server', 'transitionPayload');
const MARKER = 'transition.json';

/** 注入する import 行群 */
const IMPORT_STATIC_FILE = "import { staticFile } from 'remotion';";
const IMPORT_VIDEO_FILE = "import { VIDEO_FILE } from './videoConfig';";
/** CutPlayer 置換あり：CutPlayerWithTransitions も含む統合 import */
const IMPORT_TRANSITION_FULL =
  "import { CutPlayerWithTransitions, SceneOverlaySequence, transitionData } from './Transition';";
/** CutPlayer 置換なし：SceneOverlaySequence + transitionData のみ */
const IMPORT_TRANSITION_SOL =
  "import { SceneOverlaySequence, transitionData } from './Transition';";
/** Plan 2 の旧 import 行（置換対象） */
const IMPORT_TRANSITION_LEGACY = "import { SceneOverlaySequence } from './Transition';";

/** props 付き SceneOverlaySequence タグ */
const JSX_SOL_PROPS = '<SceneOverlaySequence cutData={cutData} transitions={transitionData} />';
/** 旧 props なし SceneOverlaySequence タグ（置換対象） */
const JSX_SOL_LEGACY = '<SceneOverlaySequence />';

/** props 付き CutPlayerWithTransitions タグ */
const JSX_CPW =
  '<CutPlayerWithTransitions cutData={cutData} transitions={transitionData} videoSrc={staticFile(VIDEO_FILE)} />';

/** 速度導入済みベース（差替対象）。 */
const SPEED_PLAYER_RE = /<SpeedPlayer\b[\s\S]*?\/>/;
/** 生ベース動画（OffthreadVideo|Video, VIDEO_FILE 含有）の差替対象ブロック。 */
const RAW_VIDEO_RE = /<(?:OffthreadVideo|Video)\b[\s\S]*?\/>/g;
/** 速度導入で入る SpeedPlayer import（swap 時に除去する）。 */
const IMPORT_SPEED_PLAYER = "import { SpeedPlayer } from './Speed';";
/** props 付き CutPlayerWithTransitions タグ（mainSpeed 引継ぎ版）。 */
const JSX_CPW_WITH_SPEED =
  '<CutPlayerWithTransitions cutData={cutData} transitions={transitionData} mainSpeed={MAIN_SPEED} videoSrc={staticFile(VIDEO_FILE)} />';

/** プロジェクトにシーン転換機能が導入済みか（marker で判定）。 */
export function isTransitionInstalled(dir: string): boolean {
  return existsSync(join(dir, 'src', TRANSITION_DIR, MARKER));
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
  if (last === null) return source; // import 行なし（異常系）
  const lastLine = last[0];
  if (lastLine === undefined) return source;
  const after = last.index + lastLine.length;
  return source.slice(0, after) + '\n' + line + source.slice(after);
}

/**
 * MainVideo.tsx へ CutPlayerWithTransitions 置換＋SceneOverlaySequence を組込む。
 *
 * 処理順:
 * 1. <CutPlayer /> → <CutPlayerWithTransitions .../> 置換（正規表現 `/<CutPlayer\s*\/>/`）。
 *    <CutPlayer が無ければ置換スキップ（fade のみ動作）。置換した場合のみ関連 import を足す。
 *    既に <CutPlayerWithTransitions があれば冪等スキップ。
 * 2. <SceneOverlaySequence> の処理:
 *    a. props なし `<SceneOverlaySequence />` が既にあれば props 付きへ置換。
 *    b. 既に `<SceneOverlaySequence cutData=` があれば二重挿入しない（冪等）。
 *    c. 上記どちらでもなければ、最後の </AbsoluteFill> 直前へ新規挿入。
 * 3. import 追加（各々、既に存在しなければ）。
 *    旧 `import { SceneOverlaySequence } from './Transition';` があれば統合 import 行へ置換。
 *
 * アンカー（</AbsoluteFill>）が無ければ null を返す（中断シグナル）。
 */
function injectIntoMainVideo(source: string, cutImport: string): string | null {
  let out = source;

  // staticFile import の要否は「置換前の source」で判定する。
  // 置換後の out では JSX に staticFile(VIDEO_FILE) が入るため out.includes('staticFile') が
  // 常に true になり import 行が永久に追加されない（C-1: staticFile 未 import の MainVideo で
  // remotion render が ReferenceError になる green-but-wrong）。remotion からの既存 import に
  // staticFile が含まれているか（マージ済みか別行か）を正規表現で確認する。
  const hasStaticFileImport = /import\s*\{[^}]*\bstaticFile\b[^}]*\}\s*from\s*['"]remotion['"]/.test(source);

  // ── 1. ベース動画プレイヤーの置換（CutPlayer または SpeedPlayer）─────────────
  const cutPlayerRe = /<CutPlayer\s*\/>/;
  const hasCutPlayerWithTransitions = out.includes('<CutPlayerWithTransitions');
  const hasCutPlayer = cutPlayerRe.test(out);
  const hasSpeedPlayer = SPEED_PLAYER_RE.test(out);
  const didReplaceCutPlayer = hasCutPlayer && !hasCutPlayerWithTransitions;
  // 速度導入済み（<SpeedPlayer .../>）を統合プレイヤー（mainSpeed 引継ぎ）へ swap する。
  const didReplaceSpeedPlayer = !didReplaceCutPlayer && hasSpeedPlayer && !hasCutPlayerWithTransitions;

  // 生ベース動画（VIDEO_FILE 含有の <Video>/<OffthreadVideo>）を探す（CutPlayer/SpeedPlayer 非該当時）。
  let rawVideoBlock: string | null = null;
  if (!didReplaceCutPlayer && !didReplaceSpeedPlayer && !hasCutPlayerWithTransitions) {
    let mm: RegExpExecArray | null;
    RAW_VIDEO_RE.lastIndex = 0;
    while ((mm = RAW_VIDEO_RE.exec(out)) !== null) {
      if (mm[0].includes('VIDEO_FILE')) {
        rawVideoBlock = mm[0];
        break;
      }
    }
  }
  const didReplaceRawVideo = rawVideoBlock !== null;
  const didReplaceBase = didReplaceCutPlayer || didReplaceSpeedPlayer || didReplaceRawVideo;

  if (didReplaceCutPlayer) {
    out = out.replace(cutPlayerRe, JSX_CPW);
  } else if (didReplaceSpeedPlayer) {
    out = out.replace(SPEED_PLAYER_RE, JSX_CPW_WITH_SPEED);
    // SpeedPlayer import を行ごと除去（未使用化・リテラル置換）。
    if (out.includes(IMPORT_SPEED_PLAYER + '\n')) {
      out = out.replace(IMPORT_SPEED_PLAYER + '\n', '');
    } else {
      out = out.replace(IMPORT_SPEED_PLAYER, '');
    }
  } else if (didReplaceRawVideo && rawVideoBlock !== null) {
    out = out.replace(rawVideoBlock, JSX_CPW);
  }

  // ── 2. SceneOverlaySequence の処理 ─────────────────────────────────────────
  const hasPropsSOL = out.includes('<SceneOverlaySequence cutData=');
  const hasLegacySOL = out.includes(JSX_SOL_LEGACY);

  if (hasPropsSOL) {
    // 既に props 付きがある → 冪等（何もしない）
  } else if (hasLegacySOL) {
    // Plan 2 の props なし版 → props 付きへ置換
    out = out.replace(JSX_SOL_LEGACY, JSX_SOL_PROPS);
  } else {
    // 新規挿入: 最後の </AbsoluteFill> 直前
    const closeTag = '</AbsoluteFill>';
    const lastIdx = out.lastIndexOf(closeTag);
    if (lastIdx === -1) {
      return null; // アンカー無し → 中断
    }
    const lineStart = out.lastIndexOf('\n', lastIdx) + 1;
    const indent = out.slice(lineStart, lastIdx);
    out = out.slice(0, lineStart) + indent + JSX_SOL_PROPS + '\n' + out.slice(lineStart);
  }

  // ── 3. import 追加 ─────────────────────────────────────────────────────────
  // CutPlayer 置換の有無に応じて Transition import 行を選択する。
  const importTransitionTarget = didReplaceBase ? IMPORT_TRANSITION_FULL : IMPORT_TRANSITION_SOL;

  // 旧 Plan 2 の `import { SceneOverlaySequence } from './Transition';` があれば
  // 新しい import 行へ置換する。
  if (out.includes(IMPORT_TRANSITION_LEGACY)) {
    out = out.replace(IMPORT_TRANSITION_LEGACY, importTransitionTarget);
  } else if (!out.includes(importTransitionTarget)) {
    // 既に目的の import がなければ追加。
    // ただし CutPlayer 置換あり・既に IMPORT_TRANSITION_SOL があれば FULL へ置換する。
    if (didReplaceBase && out.includes(IMPORT_TRANSITION_SOL)) {
      out = out.replace(IMPORT_TRANSITION_SOL, IMPORT_TRANSITION_FULL);
    } else {
      // 最後の import 行が無い場合は null（異常 MainVideo）
      if (!/^import /m.test(out)) return null;
      out = addImportLine(out, importTransitionTarget);
    }
  }

  // CutPlayer または生ベース動画を CutPlayerWithTransitions へ置換した場合に追加 import を足す。
  if (didReplaceCutPlayer || didReplaceRawVideo) {
    // staticFile: 置換前の source に staticFile import が無いときだけ別行で追加する
    // （out で判定すると置換で入った staticFile(VIDEO_FILE) に常に一致してしまう＝C-1）。
    if (!hasStaticFileImport) {
      out = addImportLine(out, IMPORT_STATIC_FILE);
    }
    out = addImportLine(out, `import { cutData } from '${cutImport}';`);
    out = addImportLine(out, IMPORT_VIDEO_FILE);
  }

  // メイン動画レイアウトが frame 対応（区間ごと/大域KF）で導入済みなら、overlap 系トランジション中の
  // 書き出しをプレビュー（EditorComposition の hasOverlap→base）と一致させるため
  // transitions={transitionData} を MainLayout ラッパーへ渡す（payload 側で overlap 系を検出し base 降格）。
  // transitionData は上の Transition import に必ず含まれる。
  // `layoutKeyframes={LAYOUT_KEYFRAMES}>`（結線前の frameAware ラッパー閉じ）を狙い撃ちで置換するため自然に冪等
  // （結線後はこの文字列が消える）。CPW タグ自身も transitions={transitionData} を持つので広域 includes では判定しない。
  if (out.includes('layoutKeyframes={LAYOUT_KEYFRAMES}>')) {
    out = out.replace(
      'layoutKeyframes={LAYOUT_KEYFRAMES}>',
      'layoutKeyframes={LAYOUT_KEYFRAMES} transitions={transitionData}>',
    );
  }

  return out;
}

/**
 * 導入先 package.json の dependencies に @remotion/transitions を追記する。
 * 追記した場合は needsInstall=true（ユーザーが npm install 必要）。
 * package.json が無い・既に存在する場合は needsInstall=false。
 */
function ensureRemotionTransitionsDep(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return false;
  }
  if (typeof pkg !== 'object' || pkg === null) return false;
  const record = pkg as Record<string, unknown>;
  const deps = record['dependencies'];
  if (typeof deps === 'object' && deps !== null) {
    const depsRecord = deps as Record<string, unknown>;
    if (depsRecord['@remotion/transitions'] !== undefined) return false;
    depsRecord['@remotion/transitions'] = '4.0.462';
  } else {
    record['dependencies'] = { '@remotion/transitions': '4.0.462' };
  }
  writeFileSync(pkgPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return true;
}

/**
 * シーン転換機能をプロジェクトへ導入する。
 * - ハーネス形式プロジェクト検証（src/videoConfig.ts）。冪等（marker）。
 * - src/Transition/ を payload からコピー（存在しなければ）。
 * - MainVideo.tsx をバックアップ→CutPlayerWithTransitions 置換＋SceneOverlaySequence 組込（失敗時中断）。
 * - marker を書く。
 * - 既存の transitionData.ts はスキップ保持（ユーザーの編集結果を上書きしない）。
 * - package.json に @remotion/transitions を追記（無ければ）→ needsInstall で通知。
 */
export function installTransition(dir: string): { installed: boolean; needsInstall: boolean } {
  if (isTransitionInstalled(dir)) return { installed: true, needsInstall: false };
  if (!existsSync(join(dir, 'src', 'videoConfig.ts'))) {
    throw new HttpError(400, 'ハーネス形式のプロジェクトではないため導入できません（src/videoConfig.ts が見つかりません）');
  }
  const mainVideoPath = join(dir, 'src', 'MainVideo.tsx');
  if (!existsSync(mainVideoPath)) {
    throw new HttpError(400, 'src/MainVideo.tsx が見つからないため導入できません');
  }

  // 1. MainVideo の組込結果を「書込前」に確定（失敗なら何も変更しない）。
  const mainSrc = readFileSync(mainVideoPath, 'utf8');
  const cutImport = cutDataImport(dir) ?? './cutData';
  const injected = injectIntoMainVideo(mainSrc, cutImport);
  if (injected === null) {
    throw new HttpError(
      400,
      'MainVideo.tsx に組込位置（</AbsoluteFill>）が見つかりませんでした。手動で <SceneOverlaySequence cutData={cutData} transitions={transitionData} /> を追加してください。',
    );
  }

  // 2. 部品コピー。ファイル単位でコピーする。
  const destDir = join(dir, 'src', TRANSITION_DIR);
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(PAYLOAD_SRC)) {
    // テスト等の非出荷ファイルはユーザーの Remotion プロジェクトへ同梱しない
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    const destPath = join(destDir, entry);
    // 既存のシーン転換データはユーザーの編集結果なので payload スタブで潰さない。
    if (entry === 'transitionData.ts' && existsSync(destPath)) continue;
    cpSync(join(PAYLOAD_SRC, entry), destPath, { recursive: true });
  }

  // 3. MainVideo バックアップ→書込。
  const bakPath = join(dir, 'src', 'MainVideo.original.bak.tsx');
  if (!existsSync(bakPath)) {
    renameSync(mainVideoPath, bakPath);
  }
  writeFileSync(mainVideoPath, injected, 'utf8');

  // 4. package.json に @remotion/transitions を追記。
  const needsInstall = ensureRemotionTransitionsDep(dir);

  // 5. marker。
  writeFileSync(
    join(destDir, MARKER),
    JSON.stringify({ feature: 'transition', installedAt: 'editor', version: currentPackVersion('transition') }, null, 2),
    'utf8',
  );
  return { installed: true, needsInstall };
}
