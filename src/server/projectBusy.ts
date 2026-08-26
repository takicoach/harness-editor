// src/server/projectBusy.ts
/**
 * プロジェクト単位の「実行中の重い処理」照会。
 *
 * プロジェクト削除はディレクトリごと rename する破壊的操作なので、書き出し・文字起こし・
 * ノイズ除去・音量正規化・プレビュープロキシ生成が走っている最中に実行すると、
 * 途中のプロセスが消えたパスへ書き続ける（tombstone 内に中間ファイルが生えたり、
 * ffmpeg が失敗して原因不明のエラーになる）。削除前にここで照会して 409 を返す。
 *
 * 各ジョブ登録簿は projectId をキーに現在のジョブを返す点だけが共通なので、
 * 必要最小限のインターフェース（get(projectId) → { phase } | undefined）で受ける。
 * AI 指示の受け箱（instructionInbox）は登録簿ではないが、「そのプロジェクトを
 * いま書き換えている最中か」という意味は同じなので、同形のアダプタにして渡す。
 */

/** ジョブが終了している phase 名（各 Manager の Phase 型の終端値の和集合）。 */
const TERMINAL_PHASES = new Set(['done', 'failed', 'cancelled', 'completed']);

export interface JobLookup {
  get(projectId: string): { phase: string } | undefined;
}

/**
 * 種別名 → 登録簿。固定フィールドではなく Record で受ける:
 * 呼び出し側（plugin.ts）はジョブ登録簿の正本 `jobRegistries.ts` に AI 指示の受け箱
 * アダプタを重ねて渡すため、種別の集合はここでは固定しない。
 */
export type BusyRegistries = Record<string, JobLookup>;

/** projectId に対して実行中のジョブ種別名を返す（空配列なら削除して良い）。 */
export function findBusyJobs(projectId: string, registries: BusyRegistries): string[] {
  const busy: string[] = [];
  for (const [name, reg] of Object.entries(registries)) {
    const job = reg.get(projectId);
    if (job !== undefined && !TERMINAL_PHASES.has(job.phase)) busy.push(name);
  }
  return busy;
}
