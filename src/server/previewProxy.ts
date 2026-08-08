import { existsSync, renameSync, statSync } from 'node:fs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { join } from 'node:path';
import { versionToken } from './fileFingerprint';

/**
 * 元動画ファイル名から、プレビュー用プロキシのファイル名（`<base>.preview.mp4`）を作る純関数。
 * プロキシは常に mp4（H.264）想定なので拡張子は .preview.mp4 に統一する。
 * 例: 'main.mp4' → 'main.preview.mp4'、'clip.MOV' → 'clip.preview.mp4'。
 */
export function previewProxyName(file: string): string {
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  return `${base}.preview.mp4`;
}

/**
 * プレビューで配信すべき動画の絶対パスを返す。
 * `public/<base>.preview.mp4`（H.264 軽量プロキシ）が存在すればそれを優先し、無ければ
 * 元動画へフォールバックする。重い HEVC を直接ブラウザでデコードするとメモリを大量に
 * 食う（縦 1080×1920・60fps の HEVC はソフトデコードに落ちやすい）ため、軽量プロキシで
 * プレビュー負荷を下げる。最終書き出しは MainVideo.tsx が元動画を使うため影響しない。
 * `exists` は依存注入でテスト容易化（既定は fs.existsSync）。
 */
export function resolvePreviewVideoPath(
  publicDir: string,
  file: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const proxy = join(publicDir, previewProxyName(file));
  if (exists(proxy)) return proxy;
  return join(publicDir, file);
}

/**
 * /api/video が配信すべきパスを「クライアントが持つ版トークン（?v=）」を考慮して決める。
 *
 * 背景: プロキシ生成の完了と同時に配信実体を切り替えると、開きっぱなしの <video>
 * （URL は原本版の ?v= のまま）が未バッファ領域へシークした瞬間、原本前提の
 * demuxer にプロキシのバイト列が返ってデコードが壊れる。そこで requestedVersion が
 * 「原本の現在のトークン」と一致する間は原本を返し続け、再読込で ?v= が
 * プロキシ版へ変わってから初めてプロキシを配信する（レビュー I-1 対応）。
 * requestedVersion が無い・どの実体とも一致しない場合は従来どおりプロキシ優先。
 */
export function resolveVideoPathForVersion(
  publicDir: string,
  file: string,
  requestedVersion: string | null,
  deps: {
    exists: (p: string) => boolean;
    stat: (p: string) => { size: number; mtimeMs: number };
  } = { exists: existsSync, stat: statSync },
): string {
  const resolved = resolvePreviewVideoPath(publicDir, file, deps.exists);
  const original = join(publicDir, file);
  if (requestedVersion !== null && resolved !== original && deps.exists(original)) {
    try {
      const st = deps.stat(original);
      if (versionToken(st.size, st.mtimeMs) === requestedVersion) return original;
    } catch {
      /* stat 失敗はプロキシ優先へフォールバック */
    }
  }
  return resolved;
}

/**
 * プレビュープロキシの音声を現在の main 動画へ同期する ffmpeg 引数。
 * preview の映像（H.264 軽量）はコピーし、音声を main から取り直して aac で入れ直す。
 * 出力順: -y -i <preview> -i <main> -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest <output>
 */
export function buildPreviewSyncArgs({
  previewIn,
  mainIn,
  output,
}: {
  previewIn: string;
  mainIn: string;
  output: string;
}): string[] {
  return [
    '-y',
    '-i', previewIn,
    '-i', mainIn,
    '-map', '0:v',
    '-map', '1:a',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    output,
  ];
}

/** syncPreviewProxyAudio の依存（テスト差し替え用）。 */
export interface SyncPreviewDeps {
  exists: (p: string) => boolean;
  spawnSync: (cmd: string, args: string[]) => { status: number | null };
  rename: (src: string, dest: string) => void;
}

const defaultSyncPreviewDeps: SyncPreviewDeps = {
  exists: existsSync,
  spawnSync: (cmd, args) => nodeSpawnSync(cmd, args, { stdio: 'ignore' }),
  rename: renameSync,
};

/**
 * main 動画を書き換えた後（音量正規化・ノイズ除去・復元など）に呼ぶ。
 * プレビュープロキシ（`<base>.preview.mp4`）が存在すれば、その音声を現在の main の音声へ
 * 同期する（映像は軽量プロキシのままコピー）。これによりエディタのプレビュー音が本体と一致する。
 * プロキシが無ければ何もしない。ffmpeg 失敗時は preview を元のまま残す（無害）。
 * 一時出力は同一ディレクトリ内のドット始まりファイルに書き、同一FS で rename する（EXDEV 回避）。
 */
export function syncPreviewProxyAudio(
  videoDir: string,
  videoFile: string,
  ffmpegBin: string,
  deps: SyncPreviewDeps = defaultSyncPreviewDeps,
): void {
  const preview = join(videoDir, previewProxyName(videoFile));
  if (!deps.exists(preview)) return;
  const main = join(videoDir, videoFile);
  const tmp = join(videoDir, `.${previewProxyName(videoFile)}.sync.tmp.mp4`);
  const result = deps.spawnSync(ffmpegBin, buildPreviewSyncArgs({ previewIn: preview, mainIn: main, output: tmp }));
  if (result.status !== 0) return;
  deps.rename(tmp, preview);
}
