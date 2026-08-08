# エディタ画面 → Claude Code 編集ブリッジ：常駐手順

エディタを開いている間、画面の「Claude に指示」パネルから編集を出せるようにする。

## 1. 一度だけ：MCP 接続を登録

エディタを起動した状態（ポート 2109）で、このプロジェクトのフォルダで:

```bash
claude mcp add --transport http sme-editor http://localhost:2109/mcp
```

## 2. 毎回：対話 Claude Code を常駐させる

このフォルダで通常の対話セッション（`claude`）を開き、モードを選んで `/loop` を回す。

**A. 全体待機（推奨・並列）** — 1 セッションが全プロジェクトを担当。指示ごとにバックグラウンド subagent へ委譲して並行処理する:

```
/loop sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら、その場では編集せずバックグラウンドの subagent に委譲して、すぐ次の get_next_instruction を呼びに戻る。subagent には「projectDir 配下を編集して実現し、作業中は .sme/status.json の activity を書き、完了したら report_instruction_status を done（失敗なら failed）で一言返答する」ことを指示する。empty が返ったら再度呼んで待ち続ける。
```

**B. 動画専属** — `get_next_instruction` に `projectId` を渡すとそのプロジェクトの指示だけを受け取る（AI タブの接続ガイドに ID 入り文言が出る）:

```
/loop sme-editor の get_next_instruction を projectId: "<この動画のID>" で呼んで編集指示を待つ。指示が返ったら projectDir 配下のファイルを編集して実現し、完了したら report_instruction_status を done / failed で一言返答する。empty が返ったら再度呼んで待ち続ける。
```

配送の意味論（サーバ側で保証）: 同一プロジェクトの指示は同時に 1 件しか配送されない（直列）。専属がいるプロジェクトは専属が優先され、専属の活動が約3分途絶えると未配送分を全体待機が引き継ぐ。全体待機の同時配送数は `SME_MAX_PARALLEL_INSTRUCTIONS`（既定 3）。受け箱は `<HARNESS_PROJECT_ROOT>/.sme-inbox.json` に永続化され、再起動時に pending は復元・processing だったものは「結果不明」の failed になる。処理中のまま止まった指示は AI タブの打ち切りボタン（10 分無応答で表示）で解放する。旧文言（引数なし）も従来通り動くが直列のまま。

## 課金・コスト安全（重要）

- **`ANTHROPIC_API_KEY` を環境にセットしない**こと（あるとサブスクではなく API 課金になる）。
- **`claude -p`（ヘッドレス）では回さない**こと（プログラム的利用＝従量課金側）。対話セッション＋`/loop` のみ。
- `get_next_instruction` はサーバ側で最大 ~120 秒ブロックして待つため、待機中はトークンを消費しない。
- 作業が終わったら `/loop` を止め、放置しない。
（同じ内容を README のAI タブ節にも記載している。原本の設計書は公開リポジトリには同梱していない。）

## 飾りテロップ（文字起こし非依存の装飾テロップ）

「左上にずっと出るドリル名」など文字起こしに紐づかないテロップは、`telopData.ts` 上で
次の規約のテロップとして表現する（エディタはこれを「飾りテロップ」専用セクションで管理し、
文字起こしリストには出さない）:

- `manual: true`（必須。飾り＝文字起こし非依存の唯一の判定基準）
- `position: { x, y }`（正規化座標 x:左-1〜右+1 / y:下0〜上-1。左上は x 負・y 負、目安 `{ x: -0.55, y: -0.85 }`）
- `startFrame` / `endFrame`（表示区間。「ずっと/常時」なら 0〜再生総フレーム、指定があればその区間、いずれも無ければヘッド相当から 5 秒）
- `text` はそのまま表示文字列

例: 「左上にずっと出るドリル名、文字は『ゆる素振り』」→ `manual: true` ＋ `position: { x: -0.55, y: -0.85 }` ＋ 0〜末尾 ＋ `text: 'ゆる素振り'`。
