# Harness Editor — アーキテクチャ地図

このファイルは、コードを読む人・AI エージェントが最短で目的の場所へたどり着くための地図です。
利用者向けの説明は [README](README.md) と [はじめてガイド](docs/はじめてガイド.md) を参照してください。

## 1. なにをするソフトか

AI（Claude Code / Codex）が大まかに編集した動画プロジェクトの「仕上げの微修正」を、
ブラウザの1画面（プレビュー＋タイムライン＋インスペクタ）で行うローカル専用エディタです。

設計の中心は1つだけ:

> **編集内容はすべて、プロジェクト内のテキストファイル（`.ts` データファイル）が正本。**
> エディタはそれを読み書きする GUI であり、AI はターミナルから同じファイルを直接編集できる。

このため、人の GUI 操作と AI のファイル編集が同じデータの上で共存します。

## 2. 実行の形

```
ブラウザ (React SPA)
   │ HTTP /api/*・SSE /api/events・MCP /mcp
Vite dev サーバ (port 2109・127.0.0.1 固定)
   ├─ smeAi()     … AI タブ用エンドポイント（src/server/aiPlugin.ts）
   └─ smeServer() … 本体 API（src/server/plugin.ts）
        │ 読み書き
   プロジェクトフォルダ群（HARNESS_PROJECT_ROOT 配下・1動画=1フォルダ）
```

- `npm start`（= `vite`）だけで UI とサーバの両方が立ち上がります。ビルド配布はせず、
  常に dev サーバとして動かす構成です（`start.command` / `start.bat` はそのラッパー）。
- ポートは 2109 固定（`SME_PORT` で変更可・e2e の隔離実行用）。ローカル以外の
  Host/Origin は `src/server/localGuard.ts` が拒否します。
- 環境変数: `HARNESS_PROJECT_ROOT`（プロジェクト置き場）・`HARNESS_FFMPEG`（Windows の
  ffmpeg パス）・`HARNESS_MAX_UPLOAD_BYTES`（取り込み上限）。コード内の `SME_*` 系は
  旧版からの互換用内部名で、動作は同じです。

## 3. プロジェクトフォルダ（データの正本）

1動画 = 1フォルダ。エディタが読み書きする主なファイル:

| ファイル | 内容 |
|---|---|
| `src/cutData.ts` | 残す区間の順序付きリスト（配列順＝再生順）。**非破壊**: 元動画は変更しない |
| `src/telopData.ts` | テロップ（文字起こし行・飾りテロップ）。位置は正規化座標 |
| `src/seData.ts` / `src/bgmData.ts` | 効果音・BGM の配置 |
| `src/insertImageData.ts` / `src/insertVideoData.ts` / `src/insertShapeData.ts` | 挿入画像・サブ動画・図形 |
| `src/videoConfig.ts` | fps・解像度・テンプレート設定 |
| `.sme/status.json` | ホーム画面のステータス表示（[仕様](docs/status-file-spec.md)） |
| （置き場直下）`.sme-inbox.json` | AI タブの指示の受け箱（永続化）。**各プロジェクトではなく `HARNESS_PROJECT_ROOT` 直下に1つ・全動画共通** |

`.ts` データファイルは `node:vm` で評価して読みます（`src/core/dataModule.ts`）。
このためデータの読解はサーバ側のみで行い、ブラウザには JSON として渡します。

## 4. ソースの区分け（どこを見るか）

| ディレクトリ | 責務 |
|---|---|
| `src/core/` | 純ロジック（UI 非依存・テスト密度最高）。データファイルの解析/直列化（`*Data.ts`）、カット・BGM・画像などの計算エンジン（`*Engine.ts`）、座標・フレーム計算 |
| `src/app/` | React SPA。`App.tsx` がホーム/編集画面を分岐 |
| `src/app/edit/` | 編集状態。`editState.ts`（EditState と選択状態）＋操作関数群（`cutOps.ts` `telopSettingsOps.ts` `shapeOps.ts` など）。**スナップショット方式の Undo**（`history.ts`・Cmd/Ctrl+Z） |
| `src/app/timeline/` | タイムライン描画と操作（トラック各種・ドラッグ `useTimelineDrag`・スナップ・端の自動横スクロール `timelineScroll.ts`） |
| `src/app/preview/` | プレビュー上の選択枠・ドラッグ。**実測方式**: 描画された DOM を測って枠を出す（`measureBox.ts` `useMeasuredBox.ts` `PreviewOverlay.tsx`） |
| `src/app/panels/` | 右ドックのパネル群（インスペクタ・じまく一覧・素材・AI タブ `ClaudePanel.tsx` / `AiTerminal.tsx`・書き出し） |
| `src/app/help/` `src/app/tutorial/` | ヘルプ百科（`helpTopics.ts`）と初回チュートリアル |
| `src/preview/` | Remotion 合成（`EditorComposition.tsx`）。プレビューと最終書き出しの両方で使う。プロジェクト側テンプレート部品の動的ロード（`load*Component.ts`） |
| `src/server/` | Vite プラグインとして動く本体 API。取り込み（`createProject` `streamUpload`）・保存・書き出し（`renderJob` `renderApi` `fastCut*`）・音声処理（denoise / normalize）・焼き込み（`install*.ts`）・AI ブリッジ（下記） |
| `src/server/mcp/` | エディタを外部ツールへ公開する MCP サーバ（`/mcp`・ツール定義は `tools.ts`） |
| `src/learning/` | 編集差分からルールを蒸留する学習コード（CLI: `npm run learn`）。人の修正を診断して次回の自動編集の質を上げる仕組み |
| `src/shapePayload/` | 図形（矢印・囲みなど）の描画部品。焼き込み時にプロジェクトへコピーされる |
| `src/shared/` | ブラウザ/サーバ共用の小物（型・フォーマッタ・AI 待機文言 `agentPrompts.ts`） |
| `project-template/` | 新規プロジェクト作成時に複製される Remotion プロジェクトの雛形（テロップ・タイトル・効果音などの部品を含む） |
| `tests/` | Playwright e2e（フィクスチャプロジェクトで dev サーバを起動して UI を叩く） |
| `scripts/` | ドキュメント用 GIF / スクリーンショットの自動収録（`npm run docs:gifs`） |

## 5. AI ブリッジ（AI タブの仕組み）

```
AI タブの入力欄 → 指示の受け箱（instructionInbox・.sme-inbox.json に永続化）
                     ↓ get_next_instruction（MCP ツール・最大 ~120 秒ロングポーリング）
埋め込みターミナルの Claude / Codex（ptySession が起動・接続設定は自動）
                     ↓ プロジェクトのファイルを直接編集 → report_instruction_status
ファイル変更を projectsWatch が検知 → SSE でブラウザへ → 画面に反映
```

- 埋め込みターミナルは `src/server/ptySession.ts` / `ptyApi.ts`。起動時に従量課金系の
  環境変数（`ANTHROPIC_API_KEY` 等）を自動で外す課金保護つき（`claudeTerminalOptions.ts`）。
- Codex 用にはログイン情報だけを引き継ぐ隔離 `CODEX_HOME` を用意する（`codexHome.ts`。
  エディタフォルダの外に置くことで、フォルダごと ZIP 配布しても認証情報が混入しない）。
- 配送の意味論（同一プロジェクト直列・専属優先・引き継ぎ）は
  [docs/claude-bridge-loop.md](docs/claude-bridge-loop.md) を参照。

## 6. 書き出し（レンダリング）

- 最終書き出しは Remotion（`remotion render`）。`src/server/renderJob.ts` がジョブ管理・`renderApi.ts` が API と経路選択、
  進捗は SSE で UI へ。カットのみの高速書き出し経路（`fastCutPlan` / `fastCutRender`＝ffmpeg
  直結）も持つ。
- 「焼き込み」（`install*.ts`）は、エディタ内だけで表現している編集（BGM・図形・サブ動画・
  速度・トランジション等）をプロジェクト側の Remotion コードへ反映させる処理。バックアップ
  を取り、失敗時はゼロ副作用でロールバックする方針。

## 7. 壊してはいけない契約（凍結）

1. **座標変換の一致**: プレビュー操作（`pointerToPosition`）・描画（`telopTransform` /
   `telopVCoeff`）・書き出しの座標式は互いに一致していることがテストで固定されている。
   片方だけ変えると「画面と完成品でテロップ位置がズレる」。`src/core/` と
   `src/app/preview/overlayGeometry.ts` の該当テストが赤くなったら、式ではなくテストの
   意図を先に読むこと。
2. **非破壊カット**: `cutData.ts` は「残す区間」のリスト。元動画・元 transcript を書き換える
   実装を入れない。
3. **データファイル互換**: 既存プロジェクトの `.ts` データファイルを読めなくする変更
   （必須キー追加・形式変更）は不可。新キーは省略可能にして後方互換を保つ。
4. **選択枠は実測が正**: プレビューの選択枠は描画結果の実測（`data-sme-box-source="measured"`）
   が基準。幾何計算はフォールバック。e2e が measured であることを検査する。
5. **ローカル専用**: サーバは 127.0.0.1 固定・Host/Origin 検査つき。外部公開を前提にした
   変更（認証の追加より先にバインドを広げる等）はしない。

## 8. テストの走らせ方

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest（core/app/server の単体・統合）
npm run test:e2e    # Playwright（フィクスチャで dev サーバを起動）
```

- e2e は既定ポートを使うため、実エディタ起動中は
  `npx playwright test --config playwright.isolated.config.ts`（隔離ポート）を使う。
- UI 文言を変えたら `src/app/help/helpTopics.ts` とチュートリアル・e2e の文言参照も追随させる。

## 9. ライセンス境界

- 本体は MIT（[LICENSE](LICENSE)）。取り込んだ第三者コードの帰属は
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記載（この表記は削除しない）。
- Remotion は独自ライセンス（README の「ライセンス」節を参照）。
