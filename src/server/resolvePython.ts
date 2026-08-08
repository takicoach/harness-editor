import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * transcribe.py を動かす Python 実行ファイルを解決する。
 *
 * 背景: 以前は spawn が `python3` 固定だった。Homebrew 等の更新で `python3` の
 * 実体が whisper 未導入の新バージョンに変わると、別の Python（PATH 上の別マイナー
 * バージョン or プロジェクト venv）に入った mlx-whisper / openai-whisper が見えず
 * 「Whisper が見つかりません」になる。
 *
 * 解決順:
 *   1. 環境変数 HARNESS_PYTHON（旧 SUPERMOVIE_PYTHON も有効。検証せず尊重・配布先/CI の明示指定用）
 *   2. リポジトリ直下の machine-local 設定ファイル `.supermovie-python`（gitignore 済み・
 *      1 行目に Python 実行ファイルの絶対パス。例: 既存プロジェクト venv を指す）
 *   3. PATH 候補（python3 + サポート各マイナー + python）を **実 import** で probe し、
 *      whisper backend を import できる最初のもの
 *   4. どれも無ければ `python3`（従来どおりエラーを surface させ案内メッセージを出す）
 */

/**
 * probe する PATH 候補。`python3` がダメでも各マイナーを試す。
 * Codex 指摘: バージョンを省くと「そのバージョンにだけ whisper がある」ケースを取りこぼす
 * ため、サポート範囲（3.10〜3.14）を明示列挙する。
 */
const PATH_CANDIDATES = [
  'python3',
  'python3.14',
  'python3.13',
  'python3.12',
  'python3.11',
  'python3.10',
  'python',
] as const;

/**
 * platform に応じた probe 候補。Windows は `python3` が無い（または Microsoft Store の
 * スタブ）環境が多いため、標準の `py` ランチャーを末尾に足す。
 */
export function pathCandidates(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'win32' ? [...PATH_CANDIDATES, 'py'] : PATH_CANDIDATES;
}

/** リポジトリ直下の machine-local 設定ファイル名（gitignore 済み）。 */
const CONFIG_FILE = '.supermovie-python';

/**
 * scripts/transcribe.py が要求する最小 Python バージョン。
 * スクリプトは `str | None` 等の PEP 604 注記を使うため 3.10+ が必須。
 */
const MIN_PYTHON = '(3, 10)';

/**
 * 候補が「3.10 以上」かつ「whisper backend を実際に import できる」かを確認する Python ソース。
 * Codex 指摘 1: `find_spec` は壊れた/中途半端なインストールでも true を返すため、
 * scripts/transcribe.py の detect_backend と同じく **実 import** で判定する。
 * Codex 指摘 2: whisper が入っていても 3.9 以下だとスクリプト自体が構文エラーで落ちるため、
 * バージョンが古い候補は不可とする（例: whisper 入りのシステム Python 3.9）。
 * import 失敗（種類問わず）/ 旧バージョンはその候補を不可として次へ進ませる。
 */
const PROBE_SRC = [
  'import sys',
  `if sys.version_info < ${MIN_PYTHON}:`,
  '    sys.exit(1)',
  'try:',
  '    import mlx_whisper',
  'except Exception:',
  '    try:',
  '        import whisper',
  '    except Exception:',
  '        sys.exit(1)',
].join('\n');

/** `<bin> -c <PROBE_SRC>` を実行し、whisper backend を import できるか返す。 */
export function pythonHasWhisper(bin: string): boolean {
  try {
    // 成功側は mlx 本体ロードで時間がかかりうるため余裕を持った timeout。
    // 失敗側（ModuleNotFoundError）は即時。
    execFileSync(bin, ['-c', PROBE_SRC], { stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false; // bin が無い / import 失敗（whisper 無し・壊れ）
  }
}

/** 既定の設定ファイルパス（src/server/ から見て 2 階層上のリポジトリ直下）。 */
function defaultConfigPath(): string {
  return resolve(import.meta.dirname, '..', '..', CONFIG_FILE);
}

/** `.supermovie-python` の 1 行目（trim 済み）を返す。不在・空・読込失敗は null。 */
export function readPythonConfig(path = defaultConfigPath()): string | null {
  try {
    if (!existsSync(path)) return null;
    const first = readFileSync(path, 'utf8').split('\n')[0]?.trim();
    return first ? first : null;
  } catch {
    return null;
  }
}

export interface ResolvePythonDeps {
  /** 環境変数（既定 process.env）。 */
  env: NodeJS.ProcessEnv;
  /** bin が whisper backend を import できるか（既定 pythonHasWhisper、テストで差し替え可能）。 */
  hasWhisper: (bin: string) => boolean;
  /** 設定ファイルの内容を返す（既定 readPythonConfig、テストで差し替え可能）。 */
  readConfig: () => string | null;
  /** 実行プラットフォーム（既定 process.platform）。probe 候補の選択に使う。 */
  platform: NodeJS.Platform;
}

/** 使用する Python 実行ファイルを返す（解決順はファイル冒頭コメント参照）。 */
export function resolvePythonBin(deps: Partial<ResolvePythonDeps> = {}): string {
  const env = deps.env ?? process.env;
  const hasWhisper = deps.hasWhisper ?? pythonHasWhisper;
  const readConfig = deps.readConfig ?? (() => readPythonConfig());
  const platform = deps.platform ?? process.platform;

  const override = env.HARNESS_PYTHON?.trim() || env.SUPERMOVIE_PYTHON?.trim();
  if (override) return override;

  const configured = readConfig();
  if (configured) return configured;

  for (const bin of pathCandidates(platform)) {
    if (hasWhisper(bin)) return bin;
  }
  return 'python3';
}
