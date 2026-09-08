import { useState } from 'react';
import { Icon } from '../Icon';
import { SettingsMenu } from './SettingsMenu';
import { useDropdown } from '../useDropdown';
import type { LayoutPreset } from '../layout/layoutPreset';
import type { WaveformPref } from '../layout/waveformPref';
import type { DuckingSettings } from '../../core/types';
import type { RenderState } from '../useRenderJob';
import { RenderProgressRing } from './RenderProgressRing';

/** ⚠ バッジの表示（見える文字と読み上げ名）。 */
export interface WarnBadgeView {
  /** バッジに表示する文言。 */
  label: string;
  /** aria-label／title に使う説明。 */
  aria: string;
}

/**
 * ⚠ バッジの表示を組み立てる（純関数・status-ia-4）。
 *
 * 検証の警告と部品の更新は性質が違うので、合算した記号（旧「⚠ 1」）にせず
 * 内訳から文を組む。どちらも 0 件ならバッジ自体を出さないため null。
 */
export function warnBadgeLabel(warnings: string[], stalePackCount = 0): WarnBadgeView | null {
  const warn = warnings.length;
  const stale = stalePackCount;
  if (warn + stale === 0) return null;
  if (stale === 0) return { label: `⚠ 警告 ${warn} 件`, aria: `検証の警告 ${warn} 件。押すと内容を表示` };
  if (warn === 0) return { label: `⚠ 更新 ${stale} 件`, aria: `部品の更新 ${stale} 件。押すと内容を表示` };
  return {
    label: `⚠ 警告 ${warn}・更新 ${stale}`,
    aria: `検証の警告 ${warn} 件、部品の更新 ${stale} 件。押すと内容を表示`,
  };
}

/**
 * 書き出し失敗の分類文言（純関数・status-ia-2）。
 * サーバ（renderJob.fail）と useRenderJob が付ける code から
 * 「何が起きたのか・次に何をすればよいか」を非エンジニア向けの 1 文で返す。
 * 未知の code は null（生の message だけを出す）。
 */
export function renderErrorHint(code: string): string | null {
  switch (code) {
    case 'npm-install-failed':
      return '書き出しの準備（必要な部品の取り込み）に失敗しました。ネットワークにつながっているか確認してください。';
    case 'render-no-output':
      return '書き出しは終わりましたが、動画ファイルができていませんでした。もう一度お試しください。';
    case 'rename-failed':
      return 'できあがった動画を保存できませんでした。保存先の空き容量を確認してください。';
    case 'render-failed':
      return '書き出しの途中で止まりました。もう一度お試しください。';
    case 'finalize-failed':
      return '仕上げ（画質の調整）の途中で止まりました。もう一度お試しください。';
    case 'spawn-failed':
      return '書き出しを始められませんでした。アプリを起動し直してからお試しください。';
    case 'network':
      return 'アプリとの通信が切れました。アプリが動いているか確認してください。';
    default:
      return null;
  }
}

/** 書き出し UI の表示に必要な情報（描画から分離した純データ）。 */
export type RenderView =
  | { kind: 'idle' }
  | { kind: 'running'; label: string; percent: number | null; showBar: boolean }
  | { kind: 'done'; warning?: string }
  | { kind: 'error'; message: string; hint: string | null };

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
      return { kind: 'error', message: state.error.message, hint: renderErrorHint(state.error.code) };
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
  const warnBadge = warnBadgeLabel(warnings, stalePacks.length);
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
        {warnBadge !== null && (
          <div className="dd tb-warn" ref={warnDd.rootRef}>
            <button
              type="button"
              ref={warnDd.triggerRef}
              className="tb-warn-badge"
              data-testid="toolbar-warn-badge"
              title={warnBadge.aria}
              aria-label={warnBadge.aria}
              aria-haspopup="menu"
              aria-expanded={warnDd.open}
              onClick={() => warnDd.setOpen(!warnDd.open)}
            >
              {warnBadge.label}
            </button>
            {warnDd.open && (
              <div className="dd-menu tb-warn-menu">
                {stalePacks.length > 0 && onPackUpgrade !== undefined && (
                  <>
                    <div className="dd-section">部品の更新（{stalePacks.length}件）</div>
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
                    <div className="dd-section">検証の警告（{warnings.length}件）</div>
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
          aria-label="元に戻す"
          data-testid="toolbar-undo"
          disabled={!active || !canUndo}
          onClick={onUndo}
        >
          <Icon name="undo" size={16} />
        </button>
        <button
          className="tb-icon-btn"
          title="やり直す（Ctrl/Cmd+Shift+Z）"
          aria-label="やり直す"
          data-testid="toolbar-redo"
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
        {/* status-ia-3: 書き出しの実行中・完了・失敗を包む live region。
            目を離していても読み上げ／AI エージェントへ状態変化が伝わる。
            失敗だけは割り込んで伝えたいので別ノード（assertive）に分ける。 */}
        <div
          className="tb-render"
          role="status"
          aria-live="polite"
          data-testid="render-status"
          data-state={renderView.kind}
          aria-label="書き出し"
        >
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
            // status-ia-2: 失敗理由はホバー専用にしない。理由を本文として出し、
            // 「もう一度書き出す」を × の隣に置いて押し直すだけで再挑戦できるようにする。
            <div className="tb-render-error" data-testid="render-error" role="alert" aria-live="assertive">
              <div className="tb-render-error-text">
                <span className="tb-render-label">書き出し失敗</span>
                <span className="tb-render-error-msg">{renderView.hint ?? renderView.message}</span>
                {/*
                  汎用文（hint）だけにすると、対処法を持つ code
                  （例 render-no-output の「node_modules/.remotion を削除して再実行」）が
                  ホバー専用に戻ってしまう。サーバの message も本文として併記する。
                */}
                {renderView.hint !== null && renderView.message !== '' && renderView.message !== renderView.hint && (
                  <span className="tb-render-error-detail">{renderView.message}</span>
                )}
              </div>
              <button
                className="btn btn-secondary btn-sm tb-render-retry"
                data-testid="render-retry"
                title="もう一度書き出す"
                onClick={onRenderStart}
              >
                もう一度書き出す
              </button>
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
