import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { smeServer } from './src/server/plugin';
import { smeAi } from './src/server/aiPlugin';

// SME_NO_OPEN=1 のときはブラウザを自動で開かない（Playwright 実行時に使用）。
// SME_PORT で待ち受けポートを変えられる（既定 2109）。編集中のエディタを止めずに
// e2e を別ポートで走らせるための逃げ道。通常運用では設定しない。
export default defineConfig({
  resolve: { alias: { '@harness/frame-runtime': fileURLToPath(new URL('./src/captureRuntime/index.ts', import.meta.url)) } },
  // smeAi() は smeServer() より前に置く（smeServer が未知の /api/* を 404 で終端するため）。
  plugins: [react(), smeAi(), smeServer()],
  optimizeDeps: {
    // 既定は全 .html を走査してエントリを探す。`archive/` 配下の退役 worktree（367 個）まで
    // 拾って依存の事前バンドルを繰り返し、プレビューの部品読み込みが 504 Outdated Optimize Dep
    // で一時失敗する（followup review 2026-09-18）。実際のエントリ 2 枚だけに絞る。
    entries: ['index.html', 'native-render.html'],
  },
  // MCP 接続 URL を安定させるためポートを 2109 に固定する（2026-07-10 に 5173 から変更）。
  // watch.ignored: フィクスチャ（e2e のプロジェクトルート）と同梱テンプレートは
  // エディタ本体のソースではないため HMR 対象から外す。新規プロジェクト作成が
  // ここへ .ts をコピーした際に full-reload が全ページへ飛ぶのを防ぐ。
  server: {
    // ローカル専用ツールのため loopback に固定する（LAN へ露出させない）。
    host: '127.0.0.1',
    port: Number(process.env.SME_PORT ?? 2109),
    strictPort: true,
    open: process.env.SME_NO_OPEN !== '1',
    watch: {
      ignored: [
        '**/src/server/__fixtures__/**',
        '**/project-template/**',
        // AI ツールの実行時生成物。ここへの書き込みで dev サーバーが full reload しないように。
        '**/.claude-runtime/**',
        // 旧 codex 隔離 home の置き場（開発機に残っている場合の保険。無害なので残す）。
        // 現行の隔離 home は ~/.supermovie/codex-home/ 配下＝エディタフォルダの外にあり、
        // そもそも Vite の監視対象（このプロジェクトの src ツリー）に入らないため無関係。
        '**/.codex-runtime/**',
        // 退役 worktree の保管庫。中身は編集対象でも依存走査の対象でもない（2026-09-18）。
        '**/archive/**',
      ],
    },
  },
});
