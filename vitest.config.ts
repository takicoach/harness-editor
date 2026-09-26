import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * **重い e2e** は既定の `npm test` から外す（M3 B-5・T5 レビュー I-4）。
 *
 * `transitionCorpus.e2e.test.ts` は実 ffmpeg で 87 ケース（延べ 5 千フレーム超）を焼いて
 * 復号・比較するため単体で 5〜6 分かかる。これを既定の並行実行に混ぜると、
 * 5 秒タイムアウトのテストや時間予算のあるテストを資源競合で押し出し、
 * **「1 回目は数件赤・2 回目は全緑」というリトライ緑**が常態化する（T5 実測）。
 *
 * 分離の規約:
 *   - `npm test`        … 重い e2e を**含まない**（既定・開発中の回転を守る）
 *   - `npm run test:heavy` … 重い e2e **だけ**を直列（`--fileParallelism=false`）で回す
 *   - `npm run test:gate`  … 上の 2 つを**どちらも直列で**回す（出荷前の全量ゲート）
 * 環境変数 `HARNESS_TEST_HEAVY=1` がその切り替え。
 */
export const HEAVY_TESTS = [
  'src/server/transitionCorpus.e2e.test.ts',
  // M4 T5 受入 A: 101 ケース（延べ 8 千フレーム超）を実 ffmpeg で焼いて復号・比較する。
  // 単体で 10 分前後かかるので上と同じ理由で分離する。
  'src/server/videoInsertCorpus.e2e.test.ts',
  // F-2 カラー補正: 外部固定参照、現installerの実DOM、native移行/preview/MP4を検査。
  // 実Chromium描画を含むため heavy に維持。Remotion package は実行しない。
  'src/server/colorGradePixels.e2e.test.ts',
  /**
   * M5-0a T5: **指紋版 e2e（併走）**。上の 2 本と同じ native を焼き直し（キャッシュしない）、
   * commit 済みの指紋（`golden/fingerprints/`）とだけ突き合わせる。合計 192 ケース
   * （m3 88 / m4 101 / m5 3）を実 ffmpeg で焼くので同じ理由でここに置く。
   * **旧 e2e 2 本は不変**（撤去は M5c）。
   */
  'src/server/transitionCorpusFp.e2e.test.ts',
  'src/server/videoInsertCorpusFp.e2e.test.ts',
];

const heavy = process.env['HARNESS_TEST_HEAVY'] === '1';

export default defineConfig({
  resolve: { alias: { '@harness/frame-runtime': fileURLToPath(new URL('./src/captureRuntime/index.ts', import.meta.url)) } },
  test: {
    environment: 'node',
    // Node 26 の組み込み localStorage（undefined）が jsdom の Storage を覆い隠すのを直す。
    setupFiles: ['src/testSetup.ts'],
    include: heavy ? HEAVY_TESTS : ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    exclude: heavy ? [...configDefaults.exclude] : [...configDefaults.exclude, ...HEAVY_TESTS],
  },
});
