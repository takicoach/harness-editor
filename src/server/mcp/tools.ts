import type { InstructionInbox } from '../instructionInbox';
import type { InstructionContext, InstructionStatus } from '../../shared/types';

/** get_next_instruction の返り値。 */
export type NextInstructionResult =
  | { empty: true }
  | {
      empty: false;
      id: string;
      text: string;
      projectId: string;
      projectDir: string;
      context: InstructionContext;
    };

/**
 * 最古の pending をロングポーリングで取得する。
 * waitMs はサーバ側ブロック上限（5 分のプロンプトキャッシュ TTL 未満に保つ）。
 * 待機中はモデル推論が走らないためトークン消費はゼロ。
 * projectId 指定時はそのプロジェクトの pending だけを対象にする（動画専属モード）。
 * 未指定なら従来通り全体から取得する（後方互換）。
 */
export async function getNextInstruction(
  inbox: InstructionInbox,
  waitMs: number,
  projectId?: string,
  signal?: AbortSignal,
): Promise<NextInstructionResult> {
  const rec = await inbox.takeOrWait(waitMs, projectId, signal);
  if (rec === null) return { empty: true };
  return {
    empty: false,
    id: rec.id,
    text: rec.text,
    projectId: rec.projectId,
    projectDir: rec.projectDir,
    context: rec.context,
  };
}

/** report_instruction_status の入力。 */
export interface ReportStatusArgs {
  id: string;
  status: Extract<InstructionStatus, 'done' | 'failed'>;
  reply: string;
}

/** Claude からの状態報告を受け箱へ反映する。 */
export function reportInstructionStatus(
  inbox: InstructionInbox,
  args: ReportStatusArgs,
): { ok: boolean } {
  const updated = inbox.updateStatus(args.id, args.status, args.reply);
  return { ok: updated !== null };
}
