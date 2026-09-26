/**
 * ExportDialog — 書き出しプリセット選択ダイアログ。
 *
 * 書き出しボタン → 本ダイアログ → 「書き出し開始」で onStart(options)。
 * プリセット3択（ラベルは orientation で投稿先名を出し分け）＋折りたたみ詳細設定。
 * 前回の選択は localStorage（PRESET_STORAGE_KEY）に記憶する。
 */
import { useRef, useState } from 'react';
import { useDialogEscape } from '../useDialogEscape';
import { useFocusTrap } from '../useFocusTrap';
import type { FastCutIneligibleReason } from '../../shared/captureOverlays';
import { CAPTURE_ENGINE_MESSAGES } from '../../shared/captureEngineMessages';
import type { Orientation } from '../../core/types';
import {
  RENDER_PRESETS,
  matchPreset,
  presetLabel,
  resolutionLabel,
  renderOutputName,
  isValidRenderOutputName,
  type RenderOptions,
  type RenderPresetId,
  type RenderQuality,
  type RenderResolution,
} from '../../shared/renderPreset';

import {loadStoredRenderOptions,saveStoredRenderOptions} from '../../shared/renderPresetStorage';
export {PRESET_STORAGE_KEY,loadStoredRenderOptions} from '../../shared/renderPresetStorage';

export interface ExportDialogProps {
  orientation: Orientation;
  /** プロジェクトの解像度（出力サイズの表示用）。 */
  width: number;
  height: number;
  fps?: number;
  /**
   * 「書き出し開始」クリック時。第2引数は本ダイアログが受けた fastCut 予測をそのまま
   * 呼び出し元へ返す（サーバ実際との食い違い通知は呼び出し元＝useRenderJob が持つ）。
   */
  onStart: (options: RenderOptions, predictedFastCut: boolean) => void;
  onClose: () => void;
  /**
   * 「カットしただけ」の編集か。true なら Remotion を通さず ffmpeg で切って繋ぐ
   * 高速経路になる（4K で 10 時間超 → 数分）。判定の最終決定はサーバ側。
   */
  fastCut?: boolean;
  /**
   * テロップ・タイトル・画像のいずれかがあり、撮影（native capture）が要る編集か（M2d T2）。
   * false なら撮影エンジンの有無は無関係（従来表示のまま）。
   */
  needsCapture?: boolean;
  /**
   * 撮影エンジン（chrome-headless-shell）の状態（M2d T2・設計判断5）。
   * 未取得（undefined）の間は従来表示のまま。
   */
  captureEngine?: { ok: boolean; kind?: FastCutIneligibleReason; message?: string };
}

/**
 * 撮影エンジンが使えないときの復旧案内（kind ごとに出し分ける・修正9）。
 * kind 不明（未取得 undefined・古いサーバ・型崩れ）は最も多い原因＝未導入として
 * setup 再実行を案内する。文言の正本は shared/captureEngineMessages.ts
 * （M2d T2 修正2 M-3）。union 網羅は `case undefined:` を明示した上で、残りは
 * Record 側の `satisfies` が型で閉じる（M-2）。
 */
export function engineRecoveryGuidance(kind: FastCutIneligibleReason | undefined): string {
  switch (kind) {
    case undefined:
    case 'chromium-missing':
      return CAPTURE_ENGINE_MESSAGES['chromium-missing'].dialog;
    case 'env-path-missing':
      return CAPTURE_ENGINE_MESSAGES['env-path-missing'].dialog;
    case 'unsupported-platform':
      return CAPTURE_ENGINE_MESSAGES['unsupported-platform'].dialog;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

const QUALITY_LABELS: Record<RenderQuality, string> = {
  high: '高画質',
  standard: '標準',
  light: '軽量',
};

export function ExportDialog({
  orientation,
  width,
  height,
  fps,
  onStart,
  onClose,
  fastCut = false,
  needsCapture = false,
  captureEngine,
}: ExportDialogProps) {
  const [options, setOptions] = useState<RenderOptions>(() => loadStoredRenderOptions());
  const [outputName, setOutputName] = useState(() => renderOutputName(options));
  const validOutputName = isValidRenderOutputName(outputName);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // status-ia-12: 閉じ方をヘルプ・作成モーダルと揃える（Escape で閉じる）。
  useDialogEscape(onClose);
  const activePreset = matchPreset(options);
  // 撮影が要る編集で、撮影エンジンが未導入と分かっている時だけ「高速で書き出せる見込み」を
  // 「通常の書き出しになる」理由表示へ差し替える（M2d T2・設計判断5）。captureEngine が
  // 未取得（undefined）の間は誤って理由表示に倒さず従来表示を保つ。
  const showEngineNote = fastCut && needsCapture && captureEngine?.ok === false;

  const choose = (next: RenderOptions): void => {
    if (outputName === renderOutputName(options)) setOutputName(renderOutputName(next));
    setOptions(next);
  };

  const start = (): void => {
    if (!validOutputName) return;
    saveStoredRenderOptions(options);
    // M-4（M-6 の撤回）: 予測は**編集内容の事実**なのでそのまま渡す。
    // 一度は「ダイアログが説明済みなら false」としたが、ダイアログは開始と同時に閉じるので、
    // 抑止すると開始後に理由を読める場所が無くなる。開始後の説明は帯に任せる
    // （帯は CAPTURE_ENGINE_MESSAGES[reason].band ＝ ダイアログより短い理由別の文言）。
    onStart({ ...options, outputName }, fastCut);
  };

  // aria-modal を名乗る以上、Tab はこの中だけを巡回させる（サイクル 3 残 Minor）。
  const exportDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(exportDialogRef);
  return (
    <div className="export-overlay" onClick={onClose}>
      <div
        ref={exportDialogRef}
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="書き出し設定"
        data-testid="export-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="export-head">書き出し</div>
        <p className="export-output-summary">
          出力形式：MP4（H.264 / AAC）<br />
          {resolutionLabel(width, height, options.resolution)}{fps !== undefined ? ` · ${fps} fps` : ''}
          <br />保存先：out/{outputName}
        </p>
        <label className="export-filename">
          <span>ファイル名</span>
          <input value={outputName} onChange={e => setOutputName(e.target.value)}
            aria-invalid={!validOutputName} aria-describedby="export-filename-help" spellCheck={false} />
        </label>
        <p id="export-filename-help" className="export-filename-help" role={validOutputName ? undefined : 'alert'}>
          {validOutputName ? '同名の動画は上書きしません。別の名前で保存できます。' : 'パスを含めず、末尾が .mp4 のファイル名を入力してください（120文字以内）。'}
        </p>
        {showEngineNote ? (
          <div className="export-engine-note" role="note">
            テロップ・タイトル・画像の描画エンジンが使えないため、通常の書き出し（時間がかかります）になります。
            {engineRecoveryGuidance(captureEngine?.kind)}
            （通常の書き出しは初回に描画部品のダウンロードが走ることがあります）
            {captureEngine?.message !== undefined && captureEngine.message !== '' && (
              <div className="export-engine-detail">{captureEngine.message}</div>
            )}
          </div>
        ) : fastCut && (
          <div className="export-fast-note" role="note">
            この編集は<strong>高速で書き出せる見込みです</strong>
            （原本を切って繋ぎ、音とテロップ・タイトル・図形・画像・場面転換・サブ動画を重ねるだけ・
            画質はほぼそのまま。素材によっては通常の書き出しに切り替わります）。
            速度やレイアウトの変更を足すと通常の書き出しに戻ります。
          </div>
        )}
        <div className="export-presets">
          {(Object.keys(RENDER_PRESETS) as RenderPresetId[]).map((id) => (
            <label key={id} className={`export-preset${activePreset === id ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="export-preset"
                checked={activePreset === id}
                onChange={() => choose(RENDER_PRESETS[id])}
              />
              <span className="export-preset-label">{presetLabel(id, orientation)}</span>
              <span className="export-preset-meta">
                {resolutionLabel(width, height, RENDER_PRESETS[id].resolution)}
              </span>
            </label>
          ))}
          {activePreset === null && (
            <div className="export-custom-note">カスタム設定（詳細設定の組み合わせ）</div>
          )}
        </div>

        <button
          type="button"
          className="export-details-toggle"
          onClick={() => setDetailsOpen((v) => !v)}
        >
          {detailsOpen ? '詳細設定を閉じる' : '詳細設定'}
        </button>
        {detailsOpen && (
          <div className="export-details">
            <label className="export-detail-row">
              <span>解像度</span>
              <select
                value={options.resolution}
                onChange={(e) => choose({ ...options, resolution: e.target.value as RenderResolution })}
              >
                <option value="full">そのまま（{resolutionLabel(width, height, 'full')}）</option>
                {Math.min(width, height) > 1080 && (
                  <option value="1080p">1080p（{resolutionLabel(width, height, '1080p')}）</option>
                )}
                <option value="720p">720p（{resolutionLabel(width, height, '720p')}・軽量）</option>
              </select>
            </label>
            <label className="export-detail-row">
              <span>画質</span>
              <select
                value={options.quality}
                onChange={(e) => choose({ ...options, quality: e.target.value as RenderQuality })}
              >
                {(Object.keys(QUALITY_LABELS) as RenderQuality[]).map((q) => (
                  <option key={q} value={q}>{QUALITY_LABELS[q]}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="export-actions">
          {/* 初期フォーカスはキャンセル（誤って Enter で書き出しを始めない）。 */}
          <button type="button" className="export-cancel" autoFocus onClick={onClose}>キャンセル</button>
          <button type="button" className="export-start" onClick={start} disabled={!validOutputName} data-testid="export-start">
            書き出し開始
          </button>
        </div>
      </div>
    </div>
  );
}
