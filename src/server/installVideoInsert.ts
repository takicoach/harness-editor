import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { currentPackVersion } from './packUpgrade';

const INSERT_VIDEO_DIR = 'InsertVideo';
const PAYLOAD_SRC = join(import.meta.dirname, 'videoInsertPayload');
const MARKER = 'insert-video.json';
const IMPORT_LINE = "import { VideoInsertSequence } from './InsertVideo';";
const JSX_TAG = '<VideoInsertSequence />';

/** プロジェクトにサブ動画機能が導入済みか（marker で判定）。 */
export function isVideoInsertInstalled(dir: string): boolean {
  return existsSync(join(dir, 'src', INSERT_VIDEO_DIR, MARKER));
}

/**
 * MainVideo.tsx へ VideoInsertSequence を組込む（テロップ要素の直前＝画像の後・テロップの前）。
 * - import 行を import 群の末尾（最後の import 行の後）へ追加。
 * - JSX は最初のテロップ系要素（`<Telop` を含むタグ。例 `<TelopPlayer`）の直前へ。
 *   見つからなければ `<CutPlayer` 要素の直後へ。どちらも無ければ null（中断シグナル）。
 * 既に IMPORT_LINE / JSX_TAG があれば二重挿入しない（冪等）。
 */
function injectIntoMainVideo(source: string): string | null {
  let out = source;
  const hasImport = out.includes(IMPORT_LINE);
  const hasTag = out.includes('<VideoInsertSequence');

  if (!hasTag) {
    // JSX 挿入位置を決める。
    const telopMatch = out.match(/<\s*[A-Za-z]*Telop[A-Za-z]*/);
    if (telopMatch && telopMatch.index !== undefined) {
      // テロップ要素の行頭まで戻す
      const lineStart = out.lastIndexOf('\n', telopMatch.index) + 1;
      const indent = out.slice(lineStart, telopMatch.index);
      out = out.slice(0, lineStart) + indent + JSX_TAG + '\n' + out.slice(lineStart);
    } else {
      // フォールバック: セルフクローズの <CutPlayer ... /> のみ対応（標準ハーネスひな形）。
      const cutMatch = out.match(/<\s*CutPlayer[^>]*\/>/);
      if (!cutMatch || cutMatch.index === undefined) {
        return null; // アンカー無し → 中断
      }
      const matched = cutMatch[0];
      // matched は常に defined。noUncheckedIndexedAccess の型を満たすためのガード。
      if (matched === undefined) return null;
      // CutPlayer 行の実インデントを抽出して同じ列に挿入する（テロップ経路と対称）。
      const cutLineStart = out.lastIndexOf('\n', cutMatch.index) + 1;
      const cutIndent = out.slice(cutLineStart, cutMatch.index);
      const after = cutMatch.index + matched.length;
      out = out.slice(0, after) + '\n' + cutIndent + JSX_TAG + out.slice(after);
    }
  }

  if (!hasImport) {
    // 最後の import 行の後へ import を足す。
    const importRe = /^import .*$/gm;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(out)) !== null) last = m;
    if (last === null) {
      return null; // import が無い異常な MainVideo → 中断
    }
    const lastLine = last[0];
    if (lastLine === undefined) return null;
    const after = last.index + lastLine.length;
    out = out.slice(0, after) + '\n' + IMPORT_LINE + out.slice(after);
  }
  return out;
}

/**
 * サブ動画機能をプロジェクトへ導入する。
 * - ハーネス形式プロジェクト検証（src/videoConfig.ts）。冪等（marker）。
 * - src/InsertVideo/ を payload からコピー（存在しなければ）。
 * - MainVideo.tsx をバックアップ→VideoInsertSequence を 1 行組込（アンカー検出・失敗時中断）。
 * - marker を書く。
 */
export function installVideoInsert(dir: string): { installed: boolean } {
  if (isVideoInsertInstalled(dir)) return { installed: true };
  if (!existsSync(join(dir, 'src', 'videoConfig.ts'))) {
    throw new HttpError(400, 'ハーネス形式のプロジェクトではないため導入できません（src/videoConfig.ts が見つかりません）');
  }
  const mainVideoPath = join(dir, 'src', 'MainVideo.tsx');
  if (!existsSync(mainVideoPath)) {
    throw new HttpError(400, 'src/MainVideo.tsx が見つからないため導入できません');
  }

  // 1. MainVideo の組込結果を「書込前」に確定（失敗なら何も変更しない）。
  const mainSrc = readFileSync(mainVideoPath, 'utf8');
  const injected = injectIntoMainVideo(mainSrc);
  if (injected === null) {
    throw new HttpError(
      400,
      'MainVideo.tsx に組込位置（<TelopPlayer> か <CutPlayer>）が見つかりませんでした。手動で <VideoInsertSequence /> を追加してください。',
    );
  }

  // 2. 部品コピー。ファイル単位でコピーする。
  //    ＋サブ動画→保存を install より先に行うと insertVideoData.ts だけが先に存在し destDir が
  //    できている。ディレクトリ存在＝導入済みと見なして丸ごとスキップすると、コンポーネント
  //    部品（InsertVideo.tsx / index.ts / types.ts / VideoInsertSequence.tsx）が欠落したまま
  //    marker と import だけ書かれ、プレビュー bundle と最終 render が壊れる（marker は「導入済み」と表示）。
  //    そのため payload の各ファイルを個別にコピーし、ユーザーの保存済み insertVideoData.ts は
  //    payload のスタブで上書きしないで保持する。
  const destDir = join(dir, 'src', INSERT_VIDEO_DIR);
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(PAYLOAD_SRC)) {
    const destPath = join(destDir, entry);
    // payload 同梱の開発専用テスト（*.test.tsx 等）はユーザープロジェクトへ配らない
    // （vitest 依存を持ち込み、ユーザーの tsc/ビルドを壊しうるため）。
    if (entry.includes('.test.')) continue;
    // 既存のサブ動画データはユーザーの編集結果なので payload スタブで潰さない。
    if (entry === 'insertVideoData.ts' && existsSync(destPath)) continue;
    cpSync(join(PAYLOAD_SRC, entry), destPath, { recursive: true });
  }

  // 3. MainVideo バックアップ→書込。
  const bakPath = join(dir, 'src', 'MainVideo.original.bak.tsx');
  if (!existsSync(bakPath)) {
    renameSync(mainVideoPath, bakPath);
  }
  writeFileSync(mainVideoPath, injected, 'utf8');

  // 4. marker。
  writeFileSync(
    join(destDir, MARKER),
    JSON.stringify({ feature: 'insert-video', installedAt: 'editor', version: currentPackVersion('videoInsert') }, null, 2),
    'utf8',
  );
  return { installed: true };
}
