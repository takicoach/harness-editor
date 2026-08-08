/**
 * ExportDialog — 書き出しプリセット選択ダイアログ。
 *
 * 書き出しボタン → 本ダイアログ → 「書き出し開始」で onStart(options)。
 * プリセット3択（ラベルは orientation で投稿先名を出し分け）＋折りたたみ詳細設定。
 * 前回の選択は localStorage（PRESET_STORAGE_KEY）に記憶する。
 */
import { useState } from 'react';
import type { Orientation } from '../../core/types';
import {
  RENDER_PRESETS,
  DEFAULT_RENDER_OPTIONS,
  parseRenderOptions,
  matchPreset,
  presetLabel,
  resolutionLabel,
  type RenderOptions,
  type RenderPresetId,
  type RenderQuality,
  type RenderResolution,
} from '../../shared/renderPreset';

export const PRESET_STORAGE_KEY = 'sme:render-preset';

/** localStorage から前回の選択を読む（無効値は既定へフォールバック）。 */
export function loadStoredRenderOptions(storage: Pick<Storage, 'getItem'>): RenderOptions {
  try {
    const raw = storage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return DEFAULT_RENDER_OPTIONS;
    return parseRenderOptions(JSON.parse(raw)) ?? DEFAULT_RENDER_OPTIONS;
  } catch {
    return DEFAULT_RENDER_OPTIONS;
  }
}

export interface ExportDialogProps {
  orientation: Orientation;
  /** プロジェクトの解像度（出力サイズの表示用）。 */
  width: number;
  height: number;
  onStart: (options: RenderOptions) => void;
  onClose: () => void;
  /**
   * 「カットしただけ」の編集か。true なら Remotion を通さず ffmpeg で切って繋ぐ
   * 高速経路になる（4K で 10 時間超 → 数分）。判定の最終決定はサーバ側。
   */
  fastCut?: boolean;
}

const QUALITY_LABELS: Record<RenderQuality, string> = {
  high: '高画質',
  standard: '標準',
  light: '軽量',
};

export function ExportDialog({ orientation, width, height, onStart, onClose, fastCut = false }: ExportDialogProps) {
  const [options, setOptions] = useState<RenderOptions>(() => loadStoredRenderOptions(localStorage));
  const [detailsOpen, setDetailsOpen] = useState(false);
  const activePreset = matchPreset(options);

  const choose = (next: RenderOptions): void => {
    setOptions(next);
  };

  const start = (): void => {
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(options));
    } catch { /* 記憶できなくても書き出しは続行 */ }
    onStart(options);
  };

  return (
    <div className="export-overlay" onClick={onClose}>
      <div
        className="export-dialog"
        role="dialog"
        aria-label="書き出し設定"
        data-testid="export-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="export-head">書き出し</div>
        {fastCut && (
          <div className="export-fast-note" role="note">
            テロップや効果音が入っていないので、<strong>高速で書き出します</strong>
            （原本を切って繋ぐだけ・画質はほぼそのまま）。テロップ等を足すと通常の書き出しに戻ります。
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
          <button type="button" className="export-cancel" onClick={onClose}>キャンセル</button>
          <button type="button" className="export-start" onClick={start} data-testid="export-start">
            書き出し開始
          </button>
        </div>
      </div>
    </div>
  );
}
