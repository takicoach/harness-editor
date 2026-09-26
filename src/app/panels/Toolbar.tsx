import { useState } from 'react';
import { Icon } from '../Icon';
import { CircularProgress } from './CircularProgress';
import { SettingsMenu } from './SettingsMenu';
import { useDropdown } from '../useDropdown';
import type { LayoutPreset } from '../layout/layoutPreset';
import type { WorkspaceMode } from '../layout/layoutPreset';
import { WorkspaceModeSwitcher } from './WorkspaceModeSwitcher';
import type { WaveformPref } from '../layout/waveformPref';
import type { DuckingSettings } from '../../core/types';
import type { RenderCaptureEstimate, RenderState } from '../useRenderJob';
import type { PackUpgradeNotice } from '../usePackStatus';

/** ⚠ バッジの表示（見える文字と読み上げ名）。 */
export interface WarnBadgeView {
  /** バッジに表示する文言。 */
  label: string;
  /** aria-label／title に使う説明。 */
  aria: string;
  /** 警告ではない知らせ（控えがあるだけ）のときに付く。既定は警告色のまま。 */
  tone?: 'info';
}

/**
 * ⚠ バッジの表示を組み立てる（純関数・status-ia-4）。
 *
 * 検証の警告と部品の更新は性質が違うので、合算した記号（旧「⚠ 1」）にせず
 * 内訳から文を組む。どちらも 0 件ならバッジ自体を出さないため null。
 */
export function warnBadgeLabel(warnings: string[], stalePackCount = 0, revertable = false): WarnBadgeView | null {
  const warn = warnings.length;
  const stale = stalePackCount;
  // 控えだけがある状態（更新が成功して stale が空になった直後）でもバッジを出す。出さないと
  // メニューを開く入口が消え、「更新前に戻す」に**到達できない**（事前検査 B の B10-2）。
  if (warn + stale === 0) {
    // 控えがあるだけの状態は**警告ではない**ので、⚠ も警告色も付けない（レビュー I3）。
    // 入口としてのバッジは残す（消すと「更新前に戻す」へ到達できない・B10-2）。
    return revertable
      ? { label: '更新前に戻せます', aria: '更新前の控えがあります。押すと内容を表示', tone: 'info' }
      : null;
  }
  if (stale === 0) return { label: `⚠ 警告 ${warn} 件`, aria: `検証の警告 ${warn} 件。押すと内容を表示` };
  if (warn === 0) return { label: `⚠ 更新 ${stale} 件`, aria: `部品の更新 ${stale} 件。押すと内容を表示` };
  return {
    label: `⚠ 警告 ${warn}・更新 ${stale}`,
    aria: `検証の警告 ${warn} 件、部品の更新 ${stale} 件。押すと内容を表示`,
  };
}

/**
 * 書き出し失敗の分類文言（純関数・status-ia-2）。
 * 独自書き出しサーバと useRenderJob が付ける code から
 * 「何が起きたのか・次に何をすればよいか」を非エンジニア向けの 1 文で返す。
 * 未知の code は null（生の message だけを出す）。
 */
export function renderErrorHint(code: string): string | null {
  switch (code) {
    case 'server-stopped':
      return 'アプリが停止したため、書き出しを中断しました。内容を確認して、新しく書き出してください。';
    case 'output-changed':
      return '保存後の動画が変更または削除されています。保存先を確認し、必要なら書き出し直してください。';
    case 'storage-error':
      return '書き出しの記録を保存できませんでした。保存先の空き容量と書き込み権限を確認してください。';
    case 'cleanup-failed':
      return '一時ファイルの片付けで問題が起きました。保存先の動画を確認してから、アプリを起動し直してください。';
    case 'cancelled':
      return '書き出しを中止しました。必要なら、もう一度書き出してください。';
    case 'native-render-failed':
      return '書き出しの途中で止まりました。素材が開けることを確認して、もう一度お試しください。';
    case 'capture-failed':
      return 'テロップなどの描画中に止まりました。もう一度お試しください。';
    case 'npm-install-failed':
      return '書き出しの準備（必要な部品の取り込み）に失敗しました。ネットワークにつながっているか確認してください。';
    case 'render-prepare-failed':
      return '書き出し用の素材を準備できませんでした。素材が開けることと保存先の空き容量を確認して、もう一度お試しください。';
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
    case 'unknown':
      // useRenderJob が「error はあるが code が来なかった」ときに付ける code。
      // 生の message だけだと何をすればいいか分からないので、次の一手だけは言う。
      return '書き出しに失敗しました。もう一度お試しください。直らない場合はアプリを起動し直してください。';
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
export function renderPhaseLabel(
  phase: string,
  percent: number | null,
  capture?: RenderCaptureEstimate,
): string {
  // 仕上げ工程（スーパーサンプリング縮小）は percent が 100 のまま続くため phase 優先。
  if (phase === 'finalizing') return '仕上げ中…';
  // 撮影段（M2c）は ffmpeg の進捗がまだ無い。前ジョブの percent が残っていても phase を優先する。
  // 見積り（capture）が判明済みなら枚数・所要時間の目安を添える（I-3）。未着の間は従来どおり。
  if (phase === 'capturing') {
    if (capture === undefined) return 'テロップなどを描画中…';
    const minutes = Math.max(1, Math.round(capture.estimatedMs / 60_000));
    // 枚数の分母は撮影 run 総数 capturedTotal（C-1）。distinctFrames（一意シグネチャ数）は
    // run 総数と一致しないことがあり、分母に使うと「n が N を超える / N に届かない」が出る。
    // 撮影済み枚数が判明していれば「n/N枚・残り約M分」（M2d T3）。未着の間は従来文言のまま。
    if (capture.capturedFrames !== undefined) {
      // M-1: 残り0枚なのに「残り約1分」は嘘に見える（最低1分に丸めているため）。
      const rest =
        capture.capturedFrames >= capture.capturedTotal ? 'まもなく完了' : `残り約${minutes}分`;
      return `テロップなどを描画中…（${capture.capturedFrames}/${capture.capturedTotal}枚・${rest}）`;
    }
    return `テロップなどを描画中…（約${minutes}分・${capture.capturedTotal}枚）`;
  }
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

/**
 * RenderState を表示用の RenderView に変換する（純関数）。
 *
 * running の warning は**この帯では描かない**（H-3: ツールバーから浮かせると右ドックの
 * タブ帯を覆うため、書き出し中の通知は ExportNotices がバナー枠で描く）。
 * かつては view にだけ透過させていたが、H-3 で Toolbar が描かなくなった時点で
 * **誰も読まないフィールド**になった。読まれない値を view に載せておくと
 * 「ここに出ている＝表示される」と誤読させるので落とす（E-2）。
 * 表示の担当は ExportNotices（RenderState.warning を直接読む）で、状態は落ちない。
 * done の warning は帯が実際に描く（⚠ 完了（要確認））のでそのまま残す。
 */
export function describeRenderView(state: RenderState): RenderView {
  switch (state.status) {
    case 'idle':
      return { kind: 'idle' };
    case 'running':
      return {
        kind: 'running',
        label: renderPhaseLabel(state.phase, state.percent, state.capture),
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
  /** 同じ編集状態を共有する主作業モード。 */
  workspaceMode?: WorkspaceMode;
  onWorkspaceModeChange?: (mode: WorkspaceMode) => void;
  /** 未保存分を保護して案件一覧へ戻る。 */
  onGoHome?: () => void;
  onPreferences?: () => void;
  onAgentActivity?: () => void;
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
  // 書き出し中の通知（高速書き出しの退避 / 互換経路への切替）は**ツールバーが持たない**。
  // ツールバー直下のバナー枠に置く ExportNotices が持つ（H-3。理由はそちらの説明を参照）。
  /** 書き出し開始（自動保存 → render）。 */
  onRenderStart: () => void;
  /** 実行中ジョブのキャンセル。 */
  onRenderCancel: () => void;
  /** 書き出し済みファイルを Finder で表示。 */
  onRenderReveal: () => void;
  /** done/error 表示を閉じる（reset）。 */
  onRenderDismiss: () => void;
  /** 検証の警告一覧（0件ならバッジ非描画）。 */
  warnings: string[];
  /** 古い同梱部品の一覧（⚠ バッジに合算して通知を一本化する）。 */
  stalePacks?: string[];
  /** 部品の全更新を実行（成功なら true）。 */
  onPackUpgrade?: () => Promise<boolean>;
  /** 更新成功後の後始末（プロジェクト再読込など）。復元の成功後にも使う。 */
  onPackUpgraded?: () => void;
  /** 更新の前に出す説明（描画が変わるパックだけ）。 */
  packNotices?: PackUpgradeNotice[];
  /** 更新前の控えがあるか（「更新前に戻す」の表示条件）。 */
  packRevertable?: boolean;
  /** 更新前の控えへ戻す（成功なら true）。 */
  onPackRevert?: () => Promise<boolean>;
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
  workspaceMode = 'review',
  onWorkspaceModeChange,
  onGoHome,
  onPreferences,
  onAgentActivity,
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
  onRenderDismiss,
  warnings,
  stalePacks = [],
  onPackUpgrade,
  onPackUpgraded,
  packNotices = [],
  packRevertable = false,
  onPackRevert,
  onShowTutorial,
}: ToolbarProps) {
  const saveBtn = describeSaveButton(active, dirty, saving);
  const renderView = describeRenderView(renderState);
  const warnDd = useDropdown();
  const warnBadge = warnBadgeLabel(warnings, stalePacks.length, packRevertable && onPackRevert !== undefined);
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
        <button
          type="button"
          className="tb-proj tb-project-home"
          onClick={onGoHome}
          disabled={onGoHome === undefined}
          title="案件一覧へ戻る"
          aria-label="案件一覧へ戻る"
          data-testid="toolbar-projects"
        >
          <Icon name="folder" size={16} />
          <div className="tb-proj-meta">
            <small>← 案件一覧</small>
            <strong>{projectName ?? '—'}</strong>
          </div>
        </button>
      </div>
      {onWorkspaceModeChange !== undefined && (
        <WorkspaceModeSwitcher value={workspaceMode} onChange={onWorkspaceModeChange} />
      )}
      <div className="tb-r">
        {warnBadge !== null && (
          <div className="dd tb-warn" ref={warnDd.rootRef}>
            <button
              type="button"
              ref={warnDd.triggerRef}
              className={warnBadge.tone === 'info' ? 'tb-warn-badge tb-info-badge' : 'tb-warn-badge'}
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
                      {/* 事前説明。span+button の行を崩さないよう、同じ role="status" の中で行を折り返す。 */}
                      {packNotices.map((notice) => (
                        <p key={notice.id} className="tb-pack-note">
                          {notice.note}
                          {notice.gainingCount !== null
                            && `これまで選んでも効かなかった動きが ${notice.gainingCount}件の字幕で動き始めます。`}
                          {notice.gainingCount === null && '対象の字幕数はこの案件では数えられません。'}
                        </p>
                      ))}
                    </div>
                    {dirty && (
                      <div className="tb-pack-hint">編集を保存すると更新できます（更新時に読み込み直すため）</div>
                    )}
                  </>
                )}
                {/* 「更新前に戻す」は stale ブロックの**外**。中に置くと更新成功の瞬間に stale が
                    空になってブロックごと消え、「戻す」が一度も見えない（事前検査 B の B10-2）。
                    表示条件は控えの有無（revertable）で、更新前には出ない。 */}
                {packRevertable && onPackRevert !== undefined && (
                  <>
                    <div className="dd-section">更新前の控え</div>
                    <div className="tb-pack-upgrade" role="status">
                      <span>更新前の控えがあります</span>
                      {/* 何が戻り、何が戻らないかを押す前に出す（レビュー C1）。戻すのは更新が
                          持ち込んだファイルだけで、利用者が後から足したものには触れない。 */}
                      <p className="tb-pack-note">更新の後に足した自分のファイルは残ります。</p>
                      <button
                        className="pack-upgrade-btn pack-revert-btn"
                        // 復元も同じ実ファイルを書き戻すので、「更新する」と同じ dirty ガードを付ける
                        // （事前検査 B の F10-5）。
                        disabled={packBusy || dirty}
                        onClick={async () => {
                          setPackBusy(true);
                          const ok = await onPackRevert();
                          setPackBusy(false);
                          // 復元後も「更新する」と同じ後始末（状態の取り直しと読み込み直し）。
                          if (ok) onPackUpgraded?.();
                        }}
                      >
                        {packBusy ? '戻しています…' : '更新前に戻す'}
                      </button>
                    </div>
                    {dirty && (
                      <div className="tb-pack-hint">編集を保存すると戻せます（戻すときに読み込み直すため）</div>
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
          data-testid="toolbar-save"
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
              data-testid="toolbar-export"
              disabled={!active}
              title="動画を書き出す（自動保存してからレンダリング）"
              onClick={onRenderStart}
            >
              書き出し
            </button>
          )}
          {renderView.kind === 'running' && (
            <div className="tb-render-running" title={renderView.label}>
              <div className="tb-render-progress">
                {/* 円形リング＋リング内％。横バーは幅不足でラベルの％が切れるため置換（試写FB 2026-08-17）。 */}
                <CircularProgress
                  percent={renderView.showBar && renderView.percent !== null ? renderView.percent : null}
                />
                <span className="tb-render-label">{renderView.label}
                  {renderState.status === 'running' && renderState.outputFile && <small className="tb-render-file">{renderState.outputFile}</small>}
                </span>
              </div>
              {/* 通知（退避・互換経路）はここに浮かせない。ツールバー直下のバナー枠
                  （ExportNotices）が持つ——浮かせると右ドックのタブ帯を覆う（H-3）。 */}
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
                {renderState.status === 'done' && renderState.outputFile && <small className="tb-render-file">{renderState.outputFile}</small>}
              </span>
              <button className="tb-render-reveal" title="Finderで表示" onClick={onRenderReveal}>
                Finderで表示
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
        {onPreferences && <button type="button" className="btn btn-secondary btn-sm" data-testid="toolbar-preferences"
          disabled={!active} onClick={onPreferences}>編集の好み</button>}
        {onAgentActivity && <button type="button" className="btn btn-secondary btn-sm" data-testid="toolbar-agent-activity"
          onClick={onAgentActivity}>AIの作業</button>}
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
