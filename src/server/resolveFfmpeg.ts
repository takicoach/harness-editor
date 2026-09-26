import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * ffmpeg 実行ファイルを解決する。
 *
 * 解決順:
 *   1. 環境変数 HARNESS_FFMPEG（旧 SUPERMOVIE_FFMPEG も可・検証せず尊重・明示指定用）
 *   2. PATH 上の 'ffmpeg'（macOS/Linux は which、Windows は where で確認）
 *   3. 一般的な絶対パス候補（macOS Homebrew / Linux パッケージ / Windows の winget・scoop・chocolatey 等）
 *      と、最後にエディタルート直下 `tools/`（setup スクリプトが置く静的ビルド）
 *   4. どれも見つからなければ { ok: false, code: 'ffmpeg-not-found' } を返す
 */

/** テスト時に差し替え可能な依存インターフェース。 */
export interface ResolveFfmpegDeps {
  /**
   * 名前またはパスが実行可能かを調べる。
   * 実行可能なら解決済みパスを返し、見つからなければ null を返す。
   */
  which: (nameOrPath: string) => string | null;
  /** 環境変数（既定 process.env）。 */
  env: NodeJS.ProcessEnv;
  /** 実行プラットフォーム（既定 process.platform）。絶対パス候補の選択に使う。 */
  platform: NodeJS.Platform;
}

/** 成功時の結果。 */
export interface ResolveFfmpegOk {
  ok: true;
  bin: string;
}

/** 未検出時の結果。 */
export interface ResolveFfmpegError {
  ok: false;
  code: 'ffmpeg-not-found';
  message: string;
}

export type ResolveFfmpegResult = ResolveFfmpegOk | ResolveFfmpegError;

/**
 * 一般的な絶対パス候補。
 * PATH になくても直接指定で見つかるケース（Homebrew・パッケージマネージャ等）に対応。
 *
 * 末尾はエディタルート直下の `tools/`（Win は `tools\`）＝ setup スクリプトが
 * パッケージマネージャを使えない環境で静的ビルドを置く先。システム導入を優先させるため最後に置く。
 * editorRoot の既定は `process.cwd()`（vite は package.json のあるエディタルートで起動する。
 * `aiPlugin.ts` の editorDir と同じ前提）。
 */
export function commonFfmpegPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  editorRoot: string = process.cwd(),
): readonly string[] {
  if (platform === 'win32') {
    const home = env.USERPROFILE ?? homedir();
    const localAppData = env.LOCALAPPDATA ?? `${home}\\AppData\\Local`;
    const programData = env.ProgramData ?? 'C:\\ProgramData';
    // Windows の区切りは join（POSIX 上の実行では '/' になる）ではなく明示的に '\' で組む
    const editorDir = editorRoot.replace(/[\\/]+$/, '');
    return [
      'C:\\ffmpeg\\bin\\ffmpeg.exe', // 公式ビルド zip の定番展開先
      `${localAppData}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`, // winget
      `${home}\\scoop\\shims\\ffmpeg.exe`, // scoop
      `${programData}\\chocolatey\\bin\\ffmpeg.exe`, // chocolatey
      `${editorDir}\\tools\\ffmpeg.exe`, // setup.bat が置く静的ビルド
    ];
  }
  return [
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/opt/local/bin/ffmpeg', // MacPorts
    join(homedir(), '.local', 'bin', 'ffmpeg'),
    join(homedir(), 'bin', 'ffmpeg'),
    join(editorRoot, 'tools', 'ffmpeg'), // setup.command が置く静的ビルド
  ];
}

/**
 * ffmpeg のパスから同ディレクトリの ffprobe を導出する。
 * "ffmpeg" → "ffprobe"、"/opt/homebrew/bin/ffmpeg" → 同ディレクトリの ffprobe、
 * "C:\...\ffmpeg.exe" → 同ディレクトリの ffprobe.exe（末尾 .exe を保つ）。
 * "ffmpeg7"（版数つきの実行ファイル名）→ "ffprobe7"（M-4）。
 * ffmpeg で終わらないパス（ラッパースクリプト等）は PATH 上の 'ffprobe' へフォールバック。
 */
export function ffprobeFromFfmpeg(ffmpegBin: string): string {
  const pattern = /ffmpeg(\d+)?(\.exe)?$/i;
  return pattern.test(ffmpegBin) ? ffmpegBin.replace(pattern, 'ffprobe$1$2') : 'ffprobe';
}

/**
 * ffprobe 実行ファイルのパスを解決する（M-4）。
 *
 * `resolveFfmpegBin` の結果から `ffprobeFromFfmpeg` で導く**唯一の入口**。
 * 呼び出し側で `bin.replace(/ffmpeg$/, 'ffprobe')` を手写しすると、`ffmpeg.exe` や
 * `ffmpeg7` で置換が効かず ffmpeg 自身を ffprobe として実行してしまう。
 * ffmpeg が見つからない場合は**同じ失敗をそのまま返す**（無言で 'ffprobe' を返さない）。
 *
 * **導けるのはパスまで**（C-7 M-6・doc の言い過ぎを訂正）: ffmpeg の隣に ffprobe が
 * 実在するかどうかまでは見ていない（`ffprobeFromFfmpeg` は名前の置換だけで、
 * 置換先が見つからなければ `'ffprobe'` を返して PATH 解決に委ねる）。
 * 実在検査は呼び出し側（実行して失敗する）が担う。
 */
export function resolveFfprobeBin(deps: Partial<ResolveFfmpegDeps> = {}): ResolveFfmpegResult {
  const ffmpeg = resolveFfmpegBin(deps);
  return ffmpeg.ok ? { ok: true, bin: ffprobeFromFfmpeg(ffmpeg.bin) } : ffmpeg;
}

/**
 * 名前 or 絶対パスが実行可能かを調べる。
 * テスト時は deps.which で差し替える。
 */
export function defaultWhich(nameOrPath: string): string | null {
  // 絶対パスの場合は existsSync で確認（POSIX の "/..." に加え Windows の "C:\..." 形式も判定）
  if (isAbsolute(nameOrPath) || /^[A-Za-z]:[\\/]/.test(nameOrPath)) {
    return existsSync(nameOrPath) ? nameOrPath : null;
  }
  // PATH 上のコマンドを確認（Windows に which は無いので where を使う）
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(lookup, [nameOrPath], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    // where は複数ヒットを行区切りで返すことがあるため先頭を採用
    const bin = result.trim().split(/\r?\n/)[0]?.trim() ?? '';
    return bin || null;
  } catch {
    return null;
  }
}

/** ffmpeg 実行ファイルのパスを解決して返す。 */
export function resolveFfmpegBin(deps: Partial<ResolveFfmpegDeps> = {}): ResolveFfmpegResult {
  const which = deps.which ?? defaultWhich;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;

  // 1. 環境変数 HARNESS_FFMPEG（旧名 SUPERMOVIE_FFMPEG も後方互換で受け付ける）
  const override = env.HARNESS_FFMPEG?.trim() || env.SUPERMOVIE_FFMPEG?.trim();
  if (override) {
    return { ok: true, bin: override };
  }

  // 2. PATH 上の ffmpeg
  const fromPath = which('ffmpeg');
  if (fromPath) {
    return { ok: true, bin: 'ffmpeg' };
  }

  // 3. 一般的な絶対パス候補
  for (const candidate of commonFfmpegPaths(platform, env)) {
    const found = which(candidate);
    if (found) {
      return { ok: true, bin: candidate };
    }
  }

  // 4. 未検出
  return {
    ok: false,
    code: 'ffmpeg-not-found',
    message:
      'ffmpeg が見つかりませんでした。' +
      'ffmpeg をインストールするか、環境変数 HARNESS_FFMPEG に実行ファイルのパスを設定してください。',
  };
}
