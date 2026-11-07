// プレビューの復号と書き出しの撮影が、この PC のどこで止まるかを切り分ける診断（編集データには触らない）。
// 使い方: エディタのフォルダーで node scripts/windows-media-probe.mjs → 結果を tools/media-probe.json に書く。
// 調べること: ①通常の Chrome の映像復号（復号の方式×低遅延×フレームを持ち続けるか） ②書き出し用 Chrome の撮影（画面の大きさ×GPU の起動オプション）。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const STALL_MS = 10_000, FRAMES = 60;

/** ページの中で動かす: H.264 High を作り、アプリと同じ送り方（1 枚送って、出力か空きを待つ）で復号する。 */
async function decodeMatrix({ stallMs, frames }) {
  const width = 1280, height = 720, codec = 'avc1.64001f', chunks = [];
  let description;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data }); if (meta?.decoderConfig?.description) description = meta.decoderConfig.description; },
    error: (error) => { throw error; },
  });
  encoder.configure({ codec, width, height, framerate: 25, bitrate: 2_000_000, avc: { format: 'avc' }, latencyMode: 'realtime' });
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
  for (let i = 0; i < frames; i++) {
    context.fillStyle = `hsl(${i * 6} 80% 50%)`; context.fillRect(0, 0, width, height);
    const frame = new VideoFrame(canvas, { timestamp: i * 40_000 });
    encoder.encode(frame, { keyFrame: i % 25 === 0 }); frame.close();
  }
  await encoder.flush(); encoder.close();
  const results = [];
  for (const hardwareAcceleration of ['no-preference', 'prefer-hardware', 'prefer-software'])
    for (const optimizeForLatency of [true, false])
      for (const hold of [0, 17, 60]) {
        const config = { codec, codedWidth: width, codedHeight: height, description, hardwareAcceleration, optimizeForLatency };
        const row = { hardwareAcceleration, optimizeForLatency, hold, supported: false, output: 0, stalledAt: null, firstOutputMs: null, error: null };
        results.push(row);
        try { row.supported = (await VideoDecoder.isConfigSupported(config)).supported === true; } catch (error) { row.error = String(error); }
        if (!row.supported) continue;
        const held = [], started = performance.now();
        let wake = () => {}, failed;
        const decoder = new VideoDecoder({
          output: (frame) => {
            row.output++; row.firstOutputMs ??= Math.round(performance.now() - started);
            held.push(frame); while (held.length > hold) held.shift().close();
            wake();
          },
          error: (error) => { failed = error; wake(); },
        });
        decoder.addEventListener('dequeue', () => wake());
        decoder.configure(config);
        try {
          for (const [index, chunk] of chunks.entries()) {
            decoder.decode(new EncodedVideoChunk(chunk));
            const before = row.output;
            const moved = await new Promise((resolve) => {
              const timer = setTimeout(() => resolve(false), stallMs);
              wake = () => { if (failed || row.output > before || decoder.decodeQueueSize === 0) { clearTimeout(timer); resolve(true); } };
              wake();
            });
            if (failed) throw failed;
            if (!moved) { row.stalledAt = index; break; }
          }
        } catch (error) { row.error = String(error); }
        for (const frame of held) frame.close();
        try { decoder.close(); } catch { /* 閉じ済み */ }
      }
  return results;
}

async function probeDecode(result) {
  let browser;
  try {
    // 普段のプレビューと同じ GPU の状態を見るので、窓を出して調べる（PROBE_HEADLESS=1 は窓を出さない試し用）。
    browser = await chromium.launch({ channel: 'chrome', headless: process.env.PROBE_HEADLESS === '1' });
    const page = await browser.newPage();
    // WebCodecs は安全な接続のページでしか使えないので、通信しない https のページを用意する。
    await page.route('https://media-probe.invalid/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>probe</title>' }));
    await page.goto('https://media-probe.invalid/');
    result.decode = { chrome: browser.version(), rows: await page.evaluate(decodeMatrix, { stallMs: STALL_MS, frames: FRAMES }) };
    const info = (await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo')).gpu;
    result.decode.gpu = { devices: info.devices, featureStatus: info.featureStatus, videoDecoding: info.videoDecoding };
  } catch (error) { result.decode = { error: String(error) }; } finally { await browser?.close().catch(() => {}); }
}

function exportChrome() {
  const root = join('tools', 'chrome-for-testing');
  if (!existsSync(root)) return null;
  for (const version of readdirSync(root))
    for (const parts of [['chrome-win64', 'chrome.exe'], ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'], ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'], ['chrome-linux64', 'chrome']]) {
      const bin = join(root, version, ...parts);
      if (existsSync(bin)) return bin;
    }
  return null;
}

async function probeCapture(result) {
  const executablePath = exportChrome();
  result.capture = { executablePath, rows: [] };
  const targets = executablePath ? [{ executablePath }] : [];
  targets.push({ channel: 'chrome' });
  for (const target of targets)
    for (const args of [[], ['--disable-gpu'], ['--use-angle=swiftshader']])
      for (const size of [2, 1280]) {
        const row = { target: target.channel ?? 'export-chrome', args, size, ok: false, error: null };
        result.capture.rows.push(row);
        let browser;
        try {
          browser = await chromium.launch({ ...target, headless: true, args, timeout: 30_000 });
          const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
          page.setDefaultTimeout(10_000);
          await page.setContent('<body style="margin:0;background:rgb(23,91,177)"></body>');
          row.ok = (await page.screenshot({ type: 'png', timeout: 10_000 })).length > 0;
        } catch (error) { row.error = String(error).split('\n')[0].slice(0, 200); } finally { await browser?.close().catch(() => {}); }
      }
}

const result = { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model };
await probeDecode(result);
await probeCapture(result);
mkdirSync('tools', { recursive: true });
writeFileSync(join('tools', 'media-probe.json'), `${JSON.stringify(result, null, 1)}\n`);
const stalled = (result.decode.rows ?? []).filter((row) => row.stalledAt !== null || row.error);
console.log(`復号: ${result.decode.error ?? `${result.decode.rows.length} 通り中 ${stalled.length} 通りが停止・失敗`}`);
console.log(`撮影: ${result.capture.rows.length} 通り中 ${result.capture.rows.filter((row) => !row.ok).length} 通りが失敗`);
console.log('結果: tools/media-probe.json（このファイルをそのまま送ってください）');
