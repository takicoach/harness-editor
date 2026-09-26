/**
 * 撮影エンジン（chrome-headless-shell）の health check（M2d T4・設計判断6）。
 *
 * setup スクリプト（setup.command / setup.bat）の末尾から呼ばれ、「置いた実体が
 * 本当に起動して画を描けるか」を実起動で確かめる。start 時には走らせない
 * （起動を重くしない）。
 *
 * 実行:
 *   node --import tsx scripts/chromium-health.ts
 *     resolveChromiumBin() → playwright-core で起動 → about:blank → 1×1 screenshot → close。
 *     成功: stdout に `OK <bin> <source>` / exit 0
 *     失敗: stderr に `<kind>: <message>` / exit 1
 *     環境変数 HARNESS_CHROMIUM を尊重する（= setup は本番名へ移す前の一時パスを
 *     渡して検査できる）。
 *
 *   node --import tsx scripts/chromium-health.ts --print-tools-path
 *     配布用実体の**配置先ディレクトリ**（`tools/chrome-headless-shell/<版>/
 *     chrome-headless-shell-<platform>`）を stdout に出す。
 *     setup スクリプトはこの出力を配置先に使う＝パス規約を bash / batch 側へ
 *     二重化しない（規約の正本は resolveChromium.ts の chromeHeadlessShellToolsPath）。
 *     対応外の OS/CPU 構成は stderr に案内を出して exit 1（setup は案内だけ出して続行する）。
 *
 *   node --import tsx scripts/chromium-health.ts --print-download-platform
 *     配布物（Chrome for Testing の zip）の platform 名（mac-arm64 / mac-x64 / win64）を
 *     stdout に出す（I-5）。setup スクリプトはこの出力でダウンロード URL と SHA-256 を
 *     選ぶ＝ CPU 判定（`uname -m` / `PROCESSOR_ARCHITECTURE`）を bash / batch 側へ
 *     二重化しない（正本は resolveChromium.ts の chromiumDownloadPlatform）。
 *     対応外の OS/CPU 構成は stderr に `unsupported-platform:` を出して exit 1。
 */
import { dirname } from 'node:path';
import {
  chromeHeadlessShellToolsPath,
  chromiumDownloadPlatform,
  resolveChromiumBin,
} from '../src/server/resolveChromium';

/** M-9: 起動が固まったまま setup が無限に待ち続けないよう、上限を設けて打ち切る。 */
const HEALTH_TIMEOUT_MS = 120_000;

function unsupportedPlatform(): number {
  process.stderr.write(`unsupported-platform: 未対応の OS/CPU 構成です（${process.platform}/${process.arch}）。\n`);
  return 1;
}

function printToolsPath(): number {
  const bin = chromeHeadlessShellToolsPath(process.cwd(), process.platform, process.arch);
  if (bin === null) {
    return unsupportedPlatform();
  }
  process.stdout.write(`${dirname(bin)}\n`);
  return 0;
}

function printDownloadPlatform(): number {
  const platform = chromiumDownloadPlatform(process.platform, process.arch);
  if (platform === null) {
    return unsupportedPlatform();
  }
  process.stdout.write(`${platform}\n`);
  return 0;
}

async function checkHealth(): Promise<number> {
  const resolved = resolveChromiumBin();
  if (!resolved.ok) {
    process.stderr.write(`${resolved.kind}: ${resolved.message}\n`);
    return 1;
  }
  // captureDriver と同じ経路で起動する（判定と実処理を別実体にしない）。
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: resolved.bin });
  try {
    const page = await browser.newPage({ viewport: { width: 1, height: 1 }, deviceScaleFactor: 1 });
    await page.goto('about:blank');
    await page.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
  process.stdout.write(`OK ${resolved.bin} ${resolved.source}\n`);
  return 0;
}

/**
 * M-9: 起動・撮影が固まったまま返ってこない場合の打ち切り。
 *
 * M-5: タイマーを unref してはいけない。unref すると「health の Promise が
 * 永遠に解決しないのに、イベントループには他に何も残っていない」場合に、
 * 打ち切りを待たずプロセスがそのまま終了してしまう（exitCode は未設定＝0＝成功扱い）。
 * ＝ 一番危ない固まり方で番犬が黙る。unref せずに保持し、勝負がついたら
 * 呼び出し側の finally で必ず clearTimeout する（正常系でも待たされない）。
 */
function startWatchdog(): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>(() => {
    timer = setTimeout(() => {
      process.stderr.write(`launch-timeout: ${HEALTH_TIMEOUT_MS / 1000} 秒たっても起動が終わりませんでした。\n`);
      // 起動しかけの Chromium が生きているとイベントループが空にならず、exitCode を
      // 立てるだけでは終われない。打ち切りなので強制終了で抜ける。
      process.exit(1);
    }, HEALTH_TIMEOUT_MS);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function main(): Promise<number> {
  if (process.argv.includes('--print-tools-path')) {
    return printToolsPath();
  }
  if (process.argv.includes('--print-download-platform')) {
    return printDownloadPlatform();
  }
  const watchdog = startWatchdog();
  try {
    return await Promise.race([checkHealth(), watchdog.promise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`launch-failed: ${message}\n`);
    return 1;
  } finally {
    watchdog.cancel();
  }
}

process.exitCode = await main();
