import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// リンク取り込み e2e の走査起点。サーバ起動時に存在しないと起点一覧から落ちるため、
// 設定読み込み時に作っておく（中身の動画は spec の beforeAll が用意する）。
const BROWSE_ROOT = resolve(import.meta.dirname, 'tests/.browse-root');
mkdirSync(BROWSE_ROOT, { recursive: true });

// 既定は 2109。SME_PORT を指定すると別ポートで起動する（作業中のエディタを止めずに走らせる用）。
const PORT = Number(process.env.SME_PORT ?? 2109);

export default defineConfig({
  // 異常終了した worker が残した使い捨てプロジェクトを、実行開始前に掃除する
  // （残骸は後続ランのホーム一覧を汚染する。tests/globalSetup.ts の説明を参照）。
  globalSetup: './tests/globalSetup.ts',
  // ランがリポジトリを汚していないかを実行後に検査する（scripts/check-worktree-dirt.mjs）。
  // npm script だけに結線していると素の `npx playwright test --config ...` で走らないため、
  // 設定側に置いてどの起動経路でも必ず走らせる（E-2）。
  globalTeardown: './tests/globalTeardown.ts',
  testDir: './tests',
  timeout: 60_000,
  // trace は**設定に固定しない**。`retain-on-failure` は全テストで trace を記録して成功時に
  // 捨てるだけで、成功ランにも実コストがかかる（実測: フルスイート 2.2m → 2.6〜3.4m の
  // 20〜50% 増。遅くなったランでのみ間欠赤が出た）。原因を追う時だけ CLI で足す:
  //   npx playwright test --config playwright.isolated.config.ts --trace on
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: 'npm run edit',
    // サーバ側の [sme] ログを playwright の出力へ流す。既定（'ignore'）だと
    // watcher / SSE の挙動が失敗時にまったく読めず、間欠赤の原因究明ができない。
    stdout: 'pipe',
    stderr: 'pipe',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      SME_NO_OPEN: '1',
      SME_PORT: String(PORT),
      // 外部フォルダ走査の起点をテスト用ディレクトリだけに絞る（実ユーザーの Volumes を見せない）。
      SME_BROWSE_ROOTS: BROWSE_ROOT,
      // 初回チュートリアルの自動開始を殺す（各テストは新規コンテキスト＝localStorage 空のため、
      // これが無いと全テストの起動時にオーバーレイが出てしまう）。チュートリアル自体の e2e は
      // ⚙メニュー →「チュートリアル図鑑」→「もう一度最初から見る」経由で起動する（env と無関係に動く）。
      SME_TUTORIAL: '0',
      // SSE の projects チャネルが「何を・いつ送ったか」を残す（既定 OFF の診断ログ）。
      // ライブ更新が出ない間欠赤で、サーバ送信側の事実が無いと原因を割れないため。
      SME_DEBUG_EVENTS: '1',
      // 自動保存は既定 ON（4s 静止で発火）だが、既存の保存系 e2e は「保存」ボタン
      // クリックを操作対象にしており、自動保存が横から発火すると `.tb-save.enabled`
      // が消えて click が失敗しフレークする。e2e では既定 OFF にし、専用の
      // autosave e2e だけ localStorage で明示 ON にして検証する。
      SME_AUTO_SAVE: '0',
      // スモークはフィクスチャプロジェクトを使う。
      SME_PROJECT_ROOT: resolve(import.meta.dirname, 'src/server/__fixtures__'),
      SME_TRANSCRIBE_MOCK: '1',
      // 8s: 「実行中にキャンセル」テストが mock 完了前に確実にキャンセルできる窓を確保
      // （3s だと CI 負荷時にセットアップ遅延で完了に追い越されて flaky だった）。
      // 「完了し反映できる」テストは完了待ち timeout を 15s にして余裕を持たせる。
      SME_TRANSCRIBE_MOCK_DELAY_MS: '8000',
      SME_DENOISE_MOCK: '1',
      // 3s: denoise 完了テストが mock 完了を確実に待てる窓。
      // キャンセルテストはこれより前にキャンセルするため 3s で十分。
      SME_DENOISE_MOCK_DELAY_MS: '3000',
      SME_NORMALIZE_MOCK: '1',
      // 3s: normalize 完了テストが mock 完了を確実に待てる窓。
      SME_NORMALIZE_MOCK_DELAY_MS: '3000',
      // 学習ループ e2e 用のグローバルストアを一時ディレクトリへ隔離する
      // （未設定だと実ユーザーの ~/.supermovie-learning を汚す）。spec 側が前後で掃除する。
      SUPERMOVIE_LEARNING_HOME: resolve(import.meta.dirname, 'tests/.learning-home'),
      // 保存先の解決は HARNESS_LEARNING_HOME が先。開発者のシェルに設定があっても実際の学習フォルダへ書かないよう同じ場所へ固定する。
      HARNESS_LEARNING_HOME: resolve(import.meta.dirname, 'tests/.learning-home'),
      SME_RENDER_MOCK: '1',
      // 4s: 進捗ステップは delay/4=1s 刻み（25%→50%→75%→100%）。
      // スモークは 1s 時点の進捗％を確実に観測でき、キャンセルテストも
      // 完了（4s）前に十分な窓でキャンセルできる。
      SME_RENDER_MOCK_DELAY_MS: '4000',
      // 埋め込みターミナル: 実 claude / codex の代わりに偽物を spawn する。
      // aiToolBin.ts のゲートにより tests/fixtures/ 配下のパスのみ有効（本番では無効）。
      SME_CLAUDE_BIN: resolve(import.meta.dirname, 'tests/fixtures/fake-claude.mjs'),
      SME_CODEX_BIN: resolve(import.meta.dirname, 'tests/fixtures/fake-codex.mjs'),
    },
  },
  // pty はエディタ全体で1本の server 側シングルトン。claude-terminal.spec.ts は「今動いて
  // いるのは常に claude」という前提のアサーションを持ち、ai-tool-switch.spec.ts は実際に
  // codex へ切り替える（実測: SME_CODEX_BIN 導入前は両ファイルとも既定 claude のままだった
  // ため気づかれなかったが、切替が実在すると既定の並列 worker で両ファイルが同時に走った
  // 瞬間に claude-terminal.spec.ts が FAKE-CLAUDE を観測できず落ちる）。この2ファイルだけ
  // 専用 project に切り出し workers:1 で固定し、同じ worker で直列に走らせて衝突を断つ。
  //
  // ただし workers:1 が止めるのは ai-tab-pty project 内の並列だけ。default project
  // （testIgnore の対象外＝残り全ファイル）は独立した worker 群でこれと同時に走り続ける。
  // AI タブを開く spec（AiTerminal マウント→/api/pty/ensure→WS 接続）が default project に
  // 残っていると、この pty の writer を奪いうる（ptyApi.ts の「書き込み接続は常に1本」設計
  // により、後から繋いだ方が前の writer を takeover で追い出す）ため、claude-terminal.spec.ts
  // の C-1 回帰テスト（再起動直後のキー入力エコー）がフルスイート時のみフレークする実測が
  // あった（2026-09: AAA G-1）。claude-panel.spec.ts は AI タブを開く小さいファイルなので
  // ai-tab-pty project へ移設して解消した。smoke.spec.ts は AI タブを開く箇所が1つの
  // assertion（右ドック幅・埋め込みターミナル可視）だけだったため、その assertion を
  // claude-panel.spec.ts 側へ移設し、smoke.spec.ts 側からは AI タブを開く操作自体を除去した
  // （smoke.spec.ts 全体を直列 project へ移すのは実行時間の代償が大きいため見送り、
  // 代わりに「AI タブを開く」という行為そのものを default project から無くす方針にした）。
  projects: [
    {
      name: 'ai-tab-pty',
      // claude-panel.spec.ts も AI タブ（AiTerminal マウント→pty/ensure→WS 接続）を開くため
      // ここに同居させる。pty/writer は server 側グローバルシングルトンで、default project
      // （複数 worker 並列）に置いたままだと claude-terminal.spec.ts と writer を奪い合い
      // C-1 回帰テストがフルスイート時のみフレークしていた（実測）。
      // visual-audit-ai.spec.ts（G-4 の AI タブ撮影）も AI タブを開くため同居させる。
      testMatch: [
        'claude-terminal.spec.ts',
        'ai-tool-switch.spec.ts',
        'claude-panel.spec.ts',
        'visual-audit-ai.spec.ts',
      ],
      workers: 1,
    },
    // project-status-dashboard.spec.ts と kanban-dnd.spec.ts は共有フィクスチャ
    // sample-project/.sme/status.json を書いて消す。ファイル内 mode:'serial' が守るのは
    // ファイル内の順序だけで、default project は複数 worker が**ファイル単位で並列**に走るため、
    // 2ファイルが同時に走ると片方の afterEach の削除がもう片方の poll を壊す（実測でフレーク）。
    // 同じ worker に固定して直列化する。
    // trash.spec.ts も同じ理由でここに入れる: フィクスチャ root 直下に使い捨て
    // プロジェクトを作って消す（＝ホーム一覧の件数が動く）ため、カードを数える
    // project-status-dashboard / kanban-dnd と同時に走らせられない。
    // なお sample-project 自体は触らない — default project 側の複数 spec が
    // afterEach で `git clean -fdx <sample-project>` を掛けており、workers:1 では
    // その並列を止められないため（実測: フルスイート時のみ 2 回連続で赤）。
    {
      name: 'project-status',
      // home-bulk-trash.spec.ts も同じ理由（使い捨てプロジェクトを作って消す＝件数が動く）。
      testMatch: [
        'project-status-dashboard.spec.ts',
        'kanban-dnd.spec.ts',
        'trash.spec.ts',
        'home-bulk-trash.spec.ts',
      ],
      workers: 1,
    },
    {
      name: 'default',
      testIgnore: [
        'claude-terminal.spec.ts',
        'ai-tool-switch.spec.ts',
        'claude-panel.spec.ts',
        'visual-audit-ai.spec.ts',
        'project-status-dashboard.spec.ts',
        'kanban-dnd.spec.ts',
        'trash.spec.ts',
        'home-bulk-trash.spec.ts',
      ],
    },
  ],
});
