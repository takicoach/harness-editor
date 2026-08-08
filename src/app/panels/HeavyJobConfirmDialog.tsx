/**
 * HeavyJobConfirmDialog — 重ジョブ（render/transcribe/denoise/normalize/preview-proxy）の
 * 開始 API が HTTP 409 confirmation-required を返したときに出す負荷確認ダイアログ。
 * ExportDialog.tsx のオーバーレイ＋ダイアログ構造を踏襲する。
 * 文言は docs/specs/2026-07-23-parallel-ai-instructions-design.md §4.4 の逐語。
 */
export interface HeavyJobConfirmDialogProps {
  /** 現在実行中の重ジョブ数。 */
  running: number;
  /** 「それでも実行」— force=1 付きで再送する。 */
  onConfirm: () => void;
  /** 「やめておく」— 中止する（再送しない）。 */
  onDismiss: () => void;
}

export function HeavyJobConfirmDialog({ running, onConfirm, onDismiss }: HeavyJobConfirmDialogProps) {
  return (
    <div className="hjc-overlay" onClick={onDismiss}>
      <div
        className="hjc-dialog"
        role="dialog"
        aria-label="負荷確認"
        data-testid="heavy-job-confirm-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="hjc-text">
          {`現在${running}本の重い処理が実行中です。これ以上同時に実行すると、メモリ/CPU 不足でパソコン全体が極端に遅くなる恐れがあります。`}
        </p>
        <div className="hjc-actions">
          <button type="button" className="hjc-dismiss" onClick={onDismiss}>
            やめておく
          </button>
          <button type="button" className="hjc-confirm" onClick={onConfirm}>
            それでも実行
          </button>
        </div>
      </div>
    </div>
  );
}
