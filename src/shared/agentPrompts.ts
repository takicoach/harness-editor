/**
 * 待機役エージェントへ渡すプロンプト。クライアント（コピー用 UI）とサーバ
 * （待機開始ボタンの pty 投入）が共用するため src/shared/ に置く。
 * 文言を変えたら、利用者向けの手引き（docs/AI接続マニュアル.md の待機文言）も合わせて直す。
 */

/** Human and AI edits must use the same open editor authority after native migration. */
export const EDITOR_REQUEST_WORKFLOW =
  'まず editor_projects と editor_read で指示の projectId に一致する編集画面と現在版を確認する。' +
  '接続先を省略して別案件を編集しない。documentFormat が sequence-v2 の案件では、' +
  'project.v2.json や旧編集ファイルを直接書き換えず、editor_read で得た ID・版・変更前本文・reference を使い、' +
  'カットや素材調整には section で clips・assets・tracks・cuts・transcripts を読み、changes は空配列、' +
  'sequence は documentId と型付き commands にして渡す。続きの取得には初回の revision を指定し、' +
  '同じ素材でも使用箇所を ID で区別する。字幕本文だけの修正は既存の changes も使える。' +
  'editor_validate、editor_apply の順で編集を依頼し、返った runId を editor_runs で確認する。' +
  '未保存・人の入力中・競合時は現在状態を確認し直す。結果不明の操作を新しい operationId で再実行しない。' +
  'saved を確認した場合だけ完了とし、利用可能な操作で実現できない依頼や編集画面が未接続の場合は、' +
  '理由を伝えて failed とする。旧形式であることを確認できた案件だけ、従来どおり projectDir 配下の編集ファイルを扱う。';

/** 全体待機・並列版（既定）。 */
export const AGENT_LOOP_PROMPT =
  'sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら、その場では編集せず' +
  'バックグラウンドの subagent に委譲して、すぐ次の get_next_instruction を呼びに戻る。' +
  'subagent には次の編集手順と、元の指示 ID・projectId を渡す。' + EDITOR_REQUEST_WORKFLOW +
  '完了したら report_instruction_status を元の指示 ID に対して done（失敗なら failed）で一言返答する。' +
  'empty が返ったら再度呼んで待ち続ける。';

/** 動画専属（その動画の projectId を埋め込む）。 */
export function dedicatedLoopPrompt(projectId: string): string {
  return (
    `sme-editor の get_next_instruction を projectId: ${JSON.stringify(projectId)} で呼んで編集指示を待つ。` +
    '指示が返ったら次の手順で編集する。' + EDITOR_REQUEST_WORKFLOW + '完了したら report_instruction_status を ' +
    'done / failed で一言返答する。empty が返ったら再度呼んで待ち続ける。'
  );
}

/**
 * 直列版（codex 等、subagent へのバックグラウンド委譲を前提にできないツール向け）。
 * AGENT_LOOP_PROMPT は「バックグラウンドの subagent に委譲して並列で回す」前提の文面で
 * Claude Code の運用に寄っているため、指示を1件ずつ自分で片付けて次を取りに戻る形にする。
 */
export const SERIAL_LOOP_PROMPT =
  'sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら次の手順で編集する。' +
  EDITOR_REQUEST_WORKFLOW + '完了したら ' +
  'report_instruction_status を done（失敗なら failed）で一言返答し、すぐ次の ' +
  'get_next_instruction を呼びに戻る。empty が返ったら再度呼んで待ち続ける。';
