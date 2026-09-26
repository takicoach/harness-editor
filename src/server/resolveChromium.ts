import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * 撮影エンジン（chrome-headless-shell）実行ファイルを解決する（M2d T1・resolveFfmpeg.ts と同型）。
 *
 * 解決順:
 *   (a) 環境変数 HARNESS_CHROMIUM（非空なら**その存在を検査**してから返す。
 *       不在なら黙って次の経路に落ちず 'env-path-missing' で fail する）
 *   (b) エディタルート直下 `tools/chrome-headless-shell/<CHROME_HEADLESS_SHELL_VERSION>/
 *       chrome-headless-shell-<platform>/chrome-headless-shell[.exe]`（setup スクリプトが
 *       版固定・SHA-256 固定で配置する配布用実体。platform 名は Chrome for Testing の慣例に
 *       合わせる。I-3: 版セグメントを含めることで、版を上げた時に旧実体を黙って使い続ける
 *       事故を防ぐ）。対応外の OS/CPU 構成ではこの経路自体を**スキップ**する（I-2）
 *   (c) playwright-core の既定キャッシュ（開発機用）。**`chromium.executablePath()` の返り値を
 *       そのまま使わない**（C-1）— それはフル Chrome for Testing
 *       （`…/ms-playwright/chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/…`）
 *       であり、配布実体の chrome-headless-shell とは別物。返り値からキャッシュ根
 *       （`ms-playwright` ディレクトリ）を導出し、
 *       `chromium_headless_shell-<CHROME_HEADLESS_SHELL_REVISION>/
 *        chrome-headless-shell-<folder>/chrome-headless-shell[.exe]` を組んで検査する
 *   全滅は 'chromium-missing'（ただし (b) を tools 非対応でスキップしていた場合は
 *   'unsupported-platform'）。
 *
 * これにより、どの経路で解決しても返り値 `bin` は必ず chrome-headless-shell 実体を指す
 * （＝開発機と配布先で同じ実行ファイルを起動する）。
 *
 * Chrome for Testing chrome-headless-shell の版（設計判断2・3・T4 setup スクリプトも参照する
 * 正本定数）。node_modules/playwright-core/browsers.json の chromium-headless-shell エントリと
 * toolchainPins.test.ts で機械的に一致検査する。
 */
export const CHROME_HEADLESS_SHELL_VERSION = '148.0.7778.96';
export const CHROME_HEADLESS_SHELL_REVISION = '1223';

/** テスト時に差し替え可能な依存インターフェース。 */
export interface ResolveChromiumDeps {
  /** 環境変数（既定 process.env）。 */
  env: NodeJS.ProcessEnv;
  /** 実行プラットフォーム（既定 process.platform）。 */
  platform: NodeJS.Platform;
  /** 実行 CPU アーキテクチャ（既定 process.arch）。 */
  arch: string;
  /** エディタルート（既定 process.cwd()。resolveFfmpeg と同じ既定）。 */
  editorRoot: string;
  /**
   * パスが「実在しかつ通常ファイル」かを調べる（既定は statSync().isFile()）。
   * M-2: existsSync だけではディレクトリを実行ファイルとして採用してしまう
   * （`HARNESS_CHROMIUM=/path/to/dir` が通ってしまい、起動時まで失敗が遅延する）。
   */
  exists: (path: string) => boolean;
  /**
   * playwright-core 既定キャッシュの実行ファイルパスを返す（開発機用）。
   * playwright-core が不在、または chromium.executablePath() が throw する場合は null。
   * 既定実装は遅延 require（本モジュール自体は playwright-core 不在でも import 可能に保つ）。
   * **返り値はフル Chrome for Testing のパス**であり、そのまま bin にはしない（C-1）。
   */
  defaultCachePath: () => string | null;
}

/** 成功時の結果。source は解決経路（受講生向けメッセージ・診断ログに使う）。 */
export interface ResolveChromiumOk {
  ok: true;
  bin: string;
  source: 'env' | 'tools' | 'playwright-cache';
}

export type ResolveChromiumFailKind = 'env-path-missing' | 'unsupported-platform' | 'chromium-missing';

export interface ResolveChromiumError {
  ok: false;
  kind: ResolveChromiumFailKind;
  message: string;
}

export type ResolveChromiumResult = ResolveChromiumOk | ResolveChromiumError;

/**
 * `tools/` に配置する配布用実体の platform 慣例名（darwin/win32 × arch → mac-arm64 /
 * mac-x64 / win64）。配布対象外（linux 等）は未登録＝ (b) をスキップする。
 */
const TOOLS_PLATFORM_FOLDER: Record<string, string> = {
  'darwin:arm64': 'mac-arm64',
  'darwin:x64': 'mac-x64',
  'win32:x64': 'win64',
};

/**
 * playwright-core キャッシュ内の chrome-headless-shell フォルダ名。
 * 配布対象外の linux も**開発機としては**撮影できるため、こちらには含める（I-2）。
 */
const CACHE_PLATFORM_FOLDER: Record<string, string> = {
  ...TOOLS_PLATFORM_FOLDER,
  'linux:x64': 'linux64',
  'linux:arm64': 'linux-arm64',
};

/**
 * 配布物（Chrome for Testing の zip）の platform 名を返す。配布対象外は null。
 *
 * I-5: setup スクリプト（bash / batch）はこの表を持たない。
 * `scripts/chromium-health.ts --print-download-platform` の出力を使い、
 * ダウンロード URL と SHA-256 の選択に使う（CPU 判定の正本はここ 1 つ）。
 * `TOOLS_PLATFORM_FOLDER` と同じ表を使うのは偶然ではなく、`tools/` の配置名が
 * Chrome for Testing の platform 名の慣例そのものだから（両者がずれると
 * 展開したフォルダ名と配置先が食い違う）。
 */
export function chromiumDownloadPlatform(platform: NodeJS.Platform, arch: string): string | null {
  return TOOLS_PLATFORM_FOLDER[`${platform}:${arch}`] ?? null;
}

/** playwright キャッシュ根の直下に並ぶブラウザディレクトリ名（chromium-1223 / chromium_headless_shell-1223）。 */
const CACHE_BROWSER_DIR_RE = /^chromium(?:_headless_shell)?-\d+$/;

function shellExeName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
}

/**
 * `tools/` 配下の版固定 chrome-headless-shell 実行ファイルパスを組み立てる。
 * 対応外の OS/CPU 構成は null（setup/health スクリプトも同じ規約を参照する）。
 *
 * I-3: `<CHROME_HEADLESS_SHELL_VERSION>` セグメントを挟む。T4 の setup スクリプトは
 * この関数の出力に従って配置する。
 *
 * Windows は resolveFfmpeg.commonFfmpegPaths と同じ理由で `join`（POSIX 実行では '/' に
 * なる）を使わず、バックスラッシュで手組みする。
 */
export function chromeHeadlessShellToolsPath(
  editorRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const folder = TOOLS_PLATFORM_FOLDER[`${platform}:${arch}`];
  if (!folder) return null;
  if (platform === 'win32') {
    const editorDir = editorRoot.replace(/[\\/]+$/, '');
    return [
      editorDir,
      'tools',
      'chrome-headless-shell',
      CHROME_HEADLESS_SHELL_VERSION,
      `chrome-headless-shell-${folder}`,
      'chrome-headless-shell.exe',
    ].join('\\');
  }
  return join(
    editorRoot,
    'tools',
    'chrome-headless-shell',
    CHROME_HEADLESS_SHELL_VERSION,
    `chrome-headless-shell-${folder}`,
    'chrome-headless-shell',
  );
}

/**
 * playwright-core の `chromium.executablePath()`（フル Chrome for Testing）から、
 * 同じキャッシュ根にある chrome-headless-shell の実行ファイルパスを導出する（C-1・案A）。
 *
 * 例: `~/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/…`
 *  → `~/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`
 *
 * キャッシュ根を特定できない（`chromium-<rev>` セグメントが無い）場合や、
 * chrome-headless-shell のフォルダ名が未登録の OS/CPU 構成では null。
 */
export function headlessShellFromCachePath(
  executablePath: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const folder = CACHE_PLATFORM_FOLDER[`${platform}:${arch}`];
  if (!folder) return null;
  const segments = executablePath.split(/[\\/]/);
  const index = segments.findIndex((segment) => CACHE_BROWSER_DIR_RE.test(segment));
  if (index <= 0) return null;
  const separator = executablePath.includes('\\') ? '\\' : '/';
  return [
    ...segments.slice(0, index),
    `chromium_headless_shell-${CHROME_HEADLESS_SHELL_REVISION}`,
    `chrome-headless-shell-${folder}`,
    shellExeName(platform),
  ].join(separator);
}

/** playwright-core の既定キャッシュパス（遅延 require・不在/throw は null）。 */
function defaultPlaywrightCachePath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pw = require('playwright-core') as { chromium: { executablePath(): string } };
    return pw.chromium.executablePath();
  } catch {
    return null;
  }
}

/** 実在しかつ通常ファイルであることを調べる既定実装（M-2）。 */
function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 撮影エンジン実行ファイルのパスを解決して返す。 */
export function resolveChromiumBin(deps: Partial<ResolveChromiumDeps> = {}): ResolveChromiumResult {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const editorRoot = deps.editorRoot ?? process.cwd();
  const exists = deps.exists ?? isExistingFile;
  const defaultCachePath = deps.defaultCachePath ?? defaultPlaywrightCachePath;

  // (a) 環境変数 HARNESS_CHROMIUM（明示指定用・非空なら存在検査してから返す）
  const override = env.HARNESS_CHROMIUM?.trim();
  if (override) {
    if (exists(override)) {
      return { ok: true, bin: override, source: 'env' };
    }
    return {
      ok: false,
      kind: 'env-path-missing',
      message: `環境変数 HARNESS_CHROMIUM に指定されたパスが見つかりません: ${override}`,
    };
  }

  // (b) エディタルート直下 tools/（配布用・版固定）。
  // I-2: 対応外の OS/CPU では**この経路だけスキップ**する（(c) の開発機キャッシュを先取りしない）。
  const toolsPath = chromeHeadlessShellToolsPath(editorRoot, platform, arch);
  if (toolsPath !== null && exists(toolsPath)) {
    return { ok: true, bin: toolsPath, source: 'tools' };
  }

  // (c) playwright-core 既定キャッシュ（開発機用）。
  // C-1: executablePath() の返り値（フル Chrome）ではなく、そこから導出した headless shell を検査する。
  const cachedFullChrome = defaultCachePath();
  if (cachedFullChrome !== null) {
    const cachedShell = headlessShellFromCachePath(cachedFullChrome, platform, arch);
    if (cachedShell !== null && exists(cachedShell)) {
      return { ok: true, bin: cachedShell, source: 'playwright-cache' };
    }
  }

  if (toolsPath === null) {
    return {
      ok: false,
      kind: 'unsupported-platform',
      message: `未対応の OS/CPU 構成です（${platform}/${arch}）。撮影エンジンを自動導入できません。`,
    };
  }
  return {
    ok: false,
    kind: 'chromium-missing',
    message: '撮影エンジン（Chromium）が見つかりませんでした。setup をもう一度実行してください。',
  };
}
