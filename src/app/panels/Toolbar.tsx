import { useState } from 'react';
import { Icon } from '../Icon';
import { SettingsMenu } from './SettingsMenu';
import { useDropdown } from '../useDropdown';
import type { LayoutPreset } from '../layout/layoutPreset';
import type { WaveformPref } from '../layout/waveformPref';
import type { DuckingSettings } from '../../core/types';
import type { RenderState } from '../useRenderJob';
import { RenderProgressRing } from './RenderProgressRing';

/**
 * ⚠ バッジのラベルを組み立てる（純関数）。検証の警告と部品更新の合算件数。
 * 0件なら非描画のため null。
 */
export function warnBadgeLabel(warnings: string[], stalePackCount = 0): string | null {
  const count = warnings.length + stalePackCount;
  if (count === 0) return null;
  return `⚠ ${count}`;
}

/** 書き出し UI の表示に必要な情報（描画から分離した純データ）。 */
export type RenderView =
  | { kind: 'idle' }
  | { kind: 'running'; label: string; percent: number | null; showBar: boolean }
  | { kind: 'done'; warning?: string }
  | { kind: 'error'; message: string };

/**
 * running 状態の表示ラベルを組み立てる（純関数）。
 * percent があれば「書き出し中 N%」（四捨五入）を優先。
 * ただし四捨五入で 100% 以上になった場合は、ffmpeg の最終エンコード中なので
 * 「100%なのに終わらない」と見えないよう「仕上げ中…」に切り替える。
 * percent が null のときは phase 文言にフォールバック。
 */
export function renderPhaseLabel(phase: string, percent: number | null): string {
  // 仕上げ工程（スーパーサンプリング縮小）は percent が 100 のまま続くため phase 優先。
  if (phase === 'finalizing') return '仕上げ中…';
  if (percent !== null) {
    const rounded = Math.round(percent);
    // フレーム 100% 到達後は ffmpeg の最終エンコード中。「100%なのに終わらない」
    // と見えないよう文言を切り替える。
    if (rounded >= 100) return '仕上げ中…';
    return `書き出し中 ${rounded}%`;
  }
  switch (phase) {
    case 'preparing':
      return '準備中（初回は数分かかります）';
    case 'bundling':
      return 'バンドル中…';
    default:
      // rendering（percent 未確定）や未知 phase はここに落ちる。
      return '書き出し中…';
  }
}

/**
 * リングの右に置く説明文（純関数）。
 * % はリング中央が担当するのでここには入れない（同じ数字を 2 度出さない）。
 * それ以外の phase 文言は renderPhaseLabel と同じ判断に揃える。
 */
export function renderRingLabel(phase: string, percent: number | null): string {
  if (phase === 'finalizing') return '仕上げ中…';
  if (percent !== null) {
    return Math.round(percent) >= 100 ? '仕上げ中…' : '書き出し中';
  }
  switch (phase) {
    case 'preparing':
      return '準備中（初回は数分かかります）';
    case 'bundling':
      return 'バンドル中…';
    default:
      return '書き出し中…';
  }
}

/**
 * running のときの phase 名（それ以外は空文字）。
 * RenderView は phase を落としているが、リングのラベルは phase 依存で出し分ける。
 * RenderView へ phase を足すと既存の形状契約（describeRenderView のテスト）が動くため、
 * 表示側で state から引き直す。
 */
export function renderPhaseOf(state: RenderState): string {
  return state.status === 'running' ? state.phase : '';
}

/** 保存ボタン（状態統合済み）の表示に必要な情報（純データ）。 */
export interface SaveButtonView {
  /** ボタンに表示する文言。 */
  label: string;
  /** ボタンを無効化するか。 */
  disabled: boolean;
  /** ベースクラス（tb-save tb-unsaved）に足す追加クラス（'dirty' 'enabled'）。 */
  className: string;
}

/**
 * 保存ボタンの表示を組み立てる（純関数）。
 * 「保存」操作と「保存済み/未保存」状態表示を1つのボタンへ統合する:
 * dirty 時は活性化して「保存 (⌘S)」、保存済み時は無効化して「保存済み ✓」。
 * 保存中・読取専用（編集セッション無し）は常に無効化する。
 */
export function describeSaveButton(active: boolean, dirty: boolean, saving: boolean): SaveButtonView {
  const enabled = active && dirty && !saving;
  const label = !active ? '読取専用' : saving ? '保存中…' : dirty ? '保存 (⌘S)' : '保存済み ✓';
  const classes = [active && dirty ? 'dirty' : '', enabled ? 'enabled' : ''].filter(Boolean).join(' ');
  return { label, disabled: !enabled, className: classes };
}

/** RenderState を表示用の RenderView に変換する（純関数）。 */
export function describeRenderView(state: RenderState): RenderView {
  switch (state.status) {
    case 'idle':
      return { kind: 'idle' };
    case 'running':
      return {
        kind: 'running',
        label: renderPhaseLabel(state.phase, state.percent),
        percent: state.percent,
        showBar: state.percent !== null,
      };
    case 'done':
      return state.warning === undefined ? { kind: 'done' } : { kind: 'done', warning: state.warning };
    case 'error':
      return { kind: 'error', message: state.error.message };
  }
}

interface ToolbarProps {
  projectName: string | null;
  /** ホーム（プロジェクト未選択）表示か。true なら編集用の操作群を出さない。 */
  home?: boolean;
  /** 編集セッションが無いとき（プロジェクト未選択）は null。 */
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  saving: boolean;
  /** 編集セッションが有効か（プロジェクトが開かれているか）。 */
  active: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  /** 現在のテーマ（アイコン表示の出し分け用）。 */
  theme: 'dark' | 'light';
  /** テーマ切替ハンドラ。 */
  onToggleTheme: () => void;
  /** 現在のレイアウトプリセット。 */
  layout: LayoutPreset;
  /** レイアウト切替ハンドラ。 */
  onLayoutChange: (v: LayoutPreset) => void;
  /** ダッキングのグローバル設定。 */
  ducking: DuckingSettings;
  /** ダッキング設定変更ハンドラ。 */
  onDuckingChange: (v: DuckingSettings) => void;
  /** 波形の高さ設定（standard/large）。未指定時は UI 非表示。 */
  waveformPref?: WaveformPref;
  /** 波形の高さ設定の変更ハンドラ。未指定時は UI 非表示。 */
  onWaveformPrefChange?: (v: WaveformPref) => void;
  /** 自動保存トグル（既定 ON）。未指定時は UI 非表示。 */
  autoSaveEnabled?: boolean;
  /** 自動保存トグルの変更ハンドラ。未指定時は UI 非表示。 */
  onAutoSaveEnabledChange?: (v: boolean) => void;
  /** 書き出しジョブの状態（useRenderJob）。 */
  renderState: RenderState;
  /** 書き出し開始（自動保存 → render）。 */
  onRenderStart: () => void;
  /** 実行中ジョブのキャンセル。 */
  onRenderCancel: () => void;
  /** 書き出し済みファイルを Finder で表示。 */
  onRenderReveal: () => void;
  /** reveal が失敗したときの表示文（null なら表示しない）。黙って握り潰さないための口。 */
  renderRevealError?: string | null;
  /** done/error 表示を閉じる（reset）。 */
  onRenderDismiss: () => void;
  /** 検証の警告一覧（0件ならバッジ非描画）。 */
  warnings: string[];
  /** 古い同梱部品の一覧（⚠ バッジに合算して通知を一本化する）。 */
  stalePacks?: string[];
  /** 部品の全更新を実行（成功なら true）。 */
  onPackUpgrade?: () => Promise<boolean>;
  /** 更新成功後の後始末（プロジェクト再読込など）。 */
  onPackUpgraded?: () => void;
  /** チュートリアル図鑑を開く。ホームは？ボタン、エディタは⚙メニューから。 */
  onShowTutorial?: () => void;
}

export function Toolbar({
  projectName,
  home = false,
  canUndo,
  canRedo,
  dirty,
  saving,
  active,
  onUndo,
  onRedo,
  onSave,
  theme,
  onToggleTheme,
  layout,
  onLayoutChange,
  ducking,
  onDuckingChange,
  waveformPref,
  onWaveformPrefChange,
  autoSaveEnabled,
  onAutoSaveEnabledChange,
  renderState,
  onRenderStart,
  onRenderCancel,
  onRenderReveal,
  renderRevealError = null,
  onRenderDismiss,
  warnings,
  stalePacks = [],
  onPackUpgrade,
  onPackUpgraded,
  onShowTutorial,
}: ToolbarProps) {
  const saveBtn = describeSaveButton(active, dirty, saving);
  const renderView = describeRenderView(renderState);
  const warnDd = useDropdown();
  const warnLabel = warnBadgeLabel(warnings, stalePacks.length);
  // 部品更新の実行中フラグ（旧 PackUpgradeBanner の busy を引き継ぎ）。
  const [packBusy, setPackBusy] = useState(false);

  // ホームでは編集用の操作群（undo/redo・保存・書き出し・警告）を出さない。
  // 最初の画面が「押せない灰色ボタンの列」で始まらないようにする（UIレビュー ホーム2）。
  if (home) {
    return (
      <div className="tb">
        <div className="tb-l">
          <div className="tb-proj tb-brand">
            <Icon name="folder" size={16} />
            <strong>Harness Editor</strong>
          </div>
        </div>
        <div className="tb-r">
          {onShowTutorial !== undefined && (
            <button
              className="tb-icon-btn tb-tutorial-btn"
              title="チュートリアル図鑑を見る"
              aria-label="チュートリアル図鑑を見る"
              onClick={onShowTutorial}
            >
              ？
            </button>
          )}
          <button
            className="tb-icon-btn"
            title={theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
            aria-label={theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
            onClick={onToggleTheme}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tb">
      <div className="tb-l">
        <div className="tb-proj">
          <Icon name="folder" size={16} />
          <div className="tb-proj-meta">
            <small>プロジェクト</small>
            <strong>{projectName ?? '—'}</strong>
          </div>
        </div>
      </div>
      <div className="tb-r">
        {warnLabel !== null && (
          <div className="dd tb-warn" ref={warnDd.rootRef}>
            <button
              type="button"
              ref={warnDd.triggerRef}
              className="tb-warn-badge"
              title="検証の警告を表示"
              aria-haspopup="menu"
              aria-expanded={warnDd.open}
              onClick={() => warnDd.setOpen(!warnDd.open)}
            >
              {warnLabel}
            </button>
            {warnDd.open && (
              <div className="dd-menu tb-warn-menu">
                {stalePacks.length > 0 && onPackUpgrade !== undefined && (
                  <>
                    <div className="dd-section">部品の更新</div>
                    <div className="tb-pack-upgrade" role="status">
                      <span>部品の更新があります（{stalePacks.length}件）</span>
                      <button
                        className="pack-upgrade-btn"
                        disabled={packBusy || dirty}
                        onClick={async () => {
                          setPackBusy(true);
                          const ok = await onPackUpgrade();
                          setPackBusy(false);
                          if (ok) onPackUpgraded?.();
                        }}
                      >
                        {packBusy ? '更新中…' : '更新する'}
                      </button>
                    </div>
                    {dirty && (
                      <div className="tb-pack-hint">編集を保存すると更新できます（更新時に読み込み直すため）</div>
                    )}
                  </>
                )}
                {warnings.length > 0 && (
                  <>
                    <div className="dd-section">検証の警告</div>
                    <ul className="tb-warn-list">
                      {warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <button
          className="tb-icon-btn"
          title="元に戻す（Ctrl/Cmd+Z）"
          disabled={!active || !canUndo}
          onClick={onUndo}
        >
          <Icon name="undo" size={16} />
        </button>
        <button
          className="tb-icon-btn"
          title="やり直す（Ctrl/Cmd+Shift+Z）"
          disabled={!active || !canRedo}
          onClick={onRedo}
        >
          <Icon name="redo" size={16} />
        </button>
        <div className="tb-divider" />
        <button
          className={'tb-save tb-unsaved' + (saveBtn.className ? ` ${saveBtn.className}` : '')}
          disabled={saveBtn.disabled}
          title="保存（Ctrl/Cmd+S）"
          onClick={onSave}
        >
          <span className="dot" />
          <Icon name="save" size={14} />
          <span>{saveBtn.label}</span>
        </button>
        <div className="tb-divider" />
        <div className="tb-render" role="group" aria-label="書き出し">
          {renderView.kind === 'idle' && (
            <button
              className="tb-render-btn"
              disabled={!active}
              title="動画を書き出す（自動保存してからレンダリング）"
              onClick={onRenderStart}
            >
              書き出し
            </button>
          )}
          {renderView.kind === 'running' && (
            <div className="tb-render-running" title={renderView.label}>
              {/* 進捗はリング（中央に %）。ラベルはリングの右で省略せず折り返す。 */}
              <RenderProgressRing
                percent={renderView.showBar ? renderView.percent : null}
                label={renderRingLabel(renderPhaseOf(renderState), renderView.percent)}
              />
              <button
                className="tb-render-x"
                title="書き出しをキャンセル"
                aria-label="書き出しをキャンセル"
                onClick={onRenderCancel}
              >
                ×
              </button>
            </div>
          )}
          {renderView.kind === 'done' && (
            <div className="tb-render-done">
              <span
                className={'tb-render-label' + (renderView.warning === undefined ? '' : ' warn')}
                title={renderView.warning}
              >
                {renderView.warning === undefined ? '✅ 完了' : '⚠ 完了（要確認）'}
              </span>
              <button className="tb-render-reveal" title="Finderで表示" onClick={onRenderReveal}>
                Finderで表示
              </button>
              {renderRevealError !== null && (
                /* .tb-render-label は nowrap+ellipsis。ここに載せると今回直したのと同じ
                   文字切れが再発するため、折り返す専用クラスを使う。 */
                <span className="tb-render-note sme-error">{renderRevealError}</span>
              )}
              <button
                className="tb-render-x"
                title="閉じる"
                aria-label="閉じる"
                onClick={onRenderDismiss}
              >
                ×
              </button>
            </div>
          )}
          {renderView.kind === 'error' && (
            <div className="tb-render-error">
              <span className="tb-render-label" title={renderView.message}>
                書き出し失敗
              </span>
              <button
                className="tb-render-x"
                title="閉じる"
                aria-label="閉じる"
                onClick={onRenderDismiss}
              >
                ×
              </button>
            </div>
          )}
        </div>
        <div className="tb-divider" />
        <SettingsMenu
          active={active}
          theme={theme}
          onToggleTheme={onToggleTheme}
          layout={layout}
          onLayoutChange={onLayoutChange}
          ducking={ducking}
          onDuckingChange={onDuckingChange}
          waveformPref={waveformPref}
          onWaveformPrefChange={onWaveformPrefChange}
          autoSaveEnabled={autoSaveEnabled}
          onAutoSaveEnabledChange={onAutoSaveEnabledChange}
          onShowTutorial={onShowTutorial}
        />
      </div>
    </div>
  );
}
