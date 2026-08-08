import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { currentPackVersion } from './packUpgrade';

const BGM_DIR = 'Bgm';
const PAYLOAD_SRC = join(import.meta.dirname, 'bgmPayload');
const MARKER = 'bgm-track.json';
const IMPORT_LINE = "import { BgmSequence } from './Bgm';";
const JSX_TAG = '<BgmSequence />';

/** プロジェクトに BGM 機能が導入済みか（marker で判定）。 */
export function isBgmInstalled(dir: string): boolean {
  return existsSync(join(dir, 'src', BGM_DIR, MARKER));
}

/**
 * MainVideo.tsx へ BgmSequence を組込む。
 * - 既存 `<BGM .../>` または `<BGM ...>...</BGM>` があれば JSX ごと `<BgmSequence />` に置換（行インデント保持）。
 * - 無ければ `<SESequence` の直前へ挿入（行インデント合わせ）。
 * - それも無ければ最後の `</AbsoluteFill>` の直前へ挿入。
 * - いずれも無ければ null（中断シグナル）。
 * import 行は最後の import 行の後へ追加。
 * 既に IMPORT_LINE / JSX_TAG があれば二重挿入しない（冪等）。
 */
function injectIntoMainVideo(source: string): string | null {
  let out = source;
  const hasImport = out.includes(IMPORT_LINE);
  const hasTag = out.includes('<BgmSequence');

  if (!hasTag) {
    // アンカー 1: 既存 <BGM ... /> または <BGM ...>...</BGM> を BgmSequence に置換。
    // セルフクローズ: <BGM ... /> （スペース有無問わず）
    // 開閉タグ: <BGM ...>...</BGM>
    // 後ろに英数字・$・_ が続かない <BGM ...> のみにマッチ（<BGMController/> 等を誤マッチしない）
    const bgmSelfClose = /<BGM(?![A-Za-z0-9$_])[^>]*\/>/;
    const bgmOpenClose = /<BGM(?![A-Za-z0-9$_])[^>]*>[\s\S]*?<\/BGM>/;

    const bgmSelfMatch = bgmSelfClose.exec(out);
    const bgmOpenMatch = bgmOpenClose.exec(out);

    // どちらかにマッチすれば最初に出現したほうを置換
    const bgmMatch = (bgmSelfMatch !== null && bgmOpenMatch !== null)
      ? (bgmSelfMatch.index <= bgmOpenMatch.index ? bgmSelfMatch : bgmOpenMatch)
      : (bgmSelfMatch ?? bgmOpenMatch);

    if (bgmMatch !== null && bgmMatch.index !== undefined) {
      // 行頭インデントを抽出
      const lineStart = out.lastIndexOf('\n', bgmMatch.index) + 1;
      const indent = out.slice(lineStart, bgmMatch.index);
      // マッチした JSX を <BgmSequence /> に置換（インデント保持）
      out =
        out.slice(0, lineStart) +
        indent + JSX_TAG +
        out.slice(bgmMatch.index + bgmMatch[0].length);
    } else {
      // アンカー 2: <SESequence の直前へ挿入。
      const seMatch = out.match(/<\s*SESequence/);
      if (seMatch !== null && seMatch.index !== undefined) {
        const lineStart = out.lastIndexOf('\n', seMatch.index) + 1;
        const indent = out.slice(lineStart, seMatch.index);
        out = out.slice(0, lineStart) + indent + JSX_TAG + '\n' + out.slice(lineStart);
      } else {
        // アンカー 3: 最後の </AbsoluteFill> の直前へ挿入。
        const absFillRe = /<\/AbsoluteFill>/g;
        let last: RegExpExecArray | null = null;
        let m: RegExpExecArray | null;
        while ((m = absFillRe.exec(out)) !== null) last = m;
        if (last === null || last.index === undefined) {
          return null; // アンカー無し → 中断
        }
        // </AbsoluteFill> 行頭のインデントを取得
        const lineStart = out.lastIndexOf('\n', last.index) + 1;
        const indent = out.slice(lineStart, last.index);
        out = out.slice(0, lineStart) + indent + JSX_TAG + '\n' + out.slice(lineStart);
      }
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
 * BGM 機能をプロジェクトへ導入する。
 * - ハーネス形式プロジェクト検証（src/videoConfig.ts）。冪等（marker）。
 * - src/Bgm/ を payload からコピー（存在しなければ）。bgmData.ts は既存なら保持。
 * - MainVideo.tsx をバックアップ→BgmSequence を組込（アンカー検出・失敗時中断）。
 * - marker を書く。
 */
export function installBgm(dir: string): { installed: boolean } {
  if (isBgmInstalled(dir)) return { installed: true };
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
      'MainVideo.tsx に組込位置（<BGM>・<SESequence>・</AbsoluteFill>）が見つかりませんでした。手動で <BgmSequence /> を追加してください。',
    );
  }

  // 2. 部品コピー。ファイル単位でコピーする。
  //    BGM→保存を install より先に行うと bgmData.ts だけが先に存在し destDir が
  //    できている場合がある。ディレクトリ存在＝導入済みと見なして丸ごとスキップすると、
  //    コンポーネント部品（BgmSequence.tsx / index.ts / types.ts）が欠落したまま
  //    marker と import だけ書かれ、プレビュー bundle と最終 render が壊れる（Codex P1）。
  //    そのため payload の各ファイルを個別にコピーし、ユーザーの保存済み bgmData.ts は
  //    payload のスタブで上書きしないで保持する。
  const destDir = join(dir, 'src', BGM_DIR);
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(PAYLOAD_SRC)) {
    const destPath = join(destDir, entry);
    // 既存の BGM データはユーザーの編集結果なので payload スタブで潰さない。
    if (entry === 'bgmData.ts' && existsSync(destPath)) continue;
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
    JSON.stringify({ feature: 'bgm-track', installedAt: 'editor', version: currentPackVersion('bgm') }, null, 2),
    'utf8',
  );
  return { installed: true };
}
