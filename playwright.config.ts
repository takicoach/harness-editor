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
  testDir: './tests',
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: 'npm run edit',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      SME_NO_OPEN: '1',
      SME_PORT: String(PORT),
      // 外部フォルダ走査の起点をテスト用ディレクトリだけに絞る（実ユーザーの Volumes を見せない）。
      SME_BROWSE_ROOTS: BROWSE_ROOT,
      // 新規作成のたびに実 npm install が走ると、並列実行中の他テストが CPU 飽和で
      // タイムアウトする（実プロジェクトの依存導入は e2e の対象外）。
      SME_NO_BACKGROUND_INSTALL: '1',
      // 初回チュートリアルの自動開始を殺す（各テストは新規コンテキスト＝localStorage 空のため、
      // これが無いと全テストの起動時にオーバーレイが出てしまう）。チュートリアル自体の e2e は
      // ⚙メニュー →「チュートリアル図鑑」→「もう一度最初から見る」経由で起動する（env と無関係に動く）。
      SME_TUTORIAL: '0',
      // 自動保存は既定 ON（4s 静止で発火）だが、既存の保存系 e2e は「保存」ボタン
      // クリックを操作対象にしており、自動保存が横から発火すると `.tb-save.enabled`
      // が消えて click が失敗しフレークする。e2e では既定 OFF にし、専用の
      // autosave e2e だけ localStorage で明示 ON にして検証する。
      SME_AUTO_SAVE: '0',
      // スモークはフィクスチャプロジェクトを使う。
      HARNESS_PROJECT_ROOT: resolve(import.meta.dirname, 'src/server/__fixtures__'),
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
  // claude-panel.spec.ts と smoke.spec.ts は default project 側にあり、どちらも AI タブを
  // 開くため AiTerminal が自動で /api/pty/ensure → WS 接続まで進み、この pty の
  // writer を奪いうる（ptyApi.ts の「書き込み接続は常に1本」設計により、後から繋いだ方が
  // 前の writer を takeover で追い出す）。つまり default project 側のテストが、実行中の
  // ai-tab-pty のテストの端末を takeover に落とす可能性は今回のレビューでも残っている
  // （this project 分離が断つのは claude/codex の「今動いているツール」取り違えのみ）。
  // 改修コストが実行時間に対して見合わないため今回は対応を見送り、この事実だけ書き残す
  // （smoke.spec.ts 全体を直列 project へ移すのは実行時間の代償が大きい）。
  projects: [
    {
      name: 'ai-tab-pty',
      testMatch: ['claude-terminal.spec.ts', 'ai-tool-switch.spec.ts'],
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
        'project-status-dashboard.spec.ts',
        'kanban-dnd.spec.ts',
        'trash.spec.ts',
        'home-bulk-trash.spec.ts',
      ],
    },
  ],
});
