import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { formatClock } from '../../shared/format';
import { buildWordChips } from '../../core/wordChips';
import { originalToPlayback, playbackToOriginal } from '../../core/cutEngine';
import { cutOrderingOf } from '../../core/cutOrder';
import {
  TRANSCRIPT_FOLLOW_STORAGE_KEY,
  resolveInitialFollowEnabled,
  followedTelopId,
  shouldAutoFollow,
  MANUAL_SCROLL_PAUSE_MS,
} from '../../core/transcriptFollow';
import type { EditorTelop, Transcript, WordChip } from '../../core/types';
import type { PlaybackModel } from '../../preview/playbackModel';
import { playerToPlayback } from '../../preview/speedBridge';
import type { EditState } from '../edit/editState';
import { chipCutState } from '../edit/wordCutState';
import { setTelopText } from '../edit/textOps';
import {
  toggleWordCut,
  toggleSegmentCut,
  splitTelopWithText,
  splitTelopAt,
  mergeTelopWithNext,
} from '../edit/cutOps';
import { newlineSplitPlan } from '../../core/segmentOps';
import { Icon } from '../Icon';
import { TranscribeBanner } from './TranscribeBanner';
import { DenoiseBanner } from './DenoiseBanner';
import { NormalizeBanner } from './NormalizeBanner';
import { PreviewProxyBanner } from './PreviewProxyBanner';
import { HeavyJobConfirmDialog } from './HeavyJobConfirmDialog';
import { usePreviewProxy } from '../usePreviewProxy';
import { rangesOverlap } from '../../core/frameRange';
import { partitionTelops } from '../../core/decorationTelop';
import { useDenoise, type DenoiseStrength } from '../useDenoise';
import { useNormalize, type NormalizeStrength } from '../useNormalize';

interface TranscriptPanelProps {
  state: EditState;
  transcript: Transcript;
  fps: number;
  /**
   * transcript と動画ファイルが同じ時間軸を共有しているか。false の場合は
   * 単語チップが意味を成さないため、チップ生成を抑止して注意バナーを出す。
   */
  transcriptAligned: boolean;
  /** カット確認モード（プレビューがカット未適用）。行クリックのシーク変換に使う。 */
  cutsBypassed: boolean;
  /** /api/transcribe を呼ぶときに使う。 */
  projectId: string;
  /** TranscribeBanner で再読込が要求されたときの callback。 */
  onReloadRequested: () => void;
  /** 編集操作（履歴へ積む）。 */
  onEdit: (next: EditState) => void;
  /** 選択変更（履歴へ積まない）。 */
  onSelect: (next: EditState) => void;
  /** 再生ヘッドをこの再生フレームへ移動する。 */
  onSeek: (playbackFrame: number) => void;
  /** 双方向ハイライト中の原本フレーム区間（null なら無し）。 */
  highlightRange: { start: number; end: number } | null;
  /** チップ hover でハイライト区間を更新する（離脱で null）。 */
  onHighlightRange: (range: { start: number; end: number } | null) => void;
  /**
   * プロジェクト読込時点でノイズ除去が適用済みか（denoise.json marker）。
   * 省略時は false。
   */
  denoiseApplied?: boolean;
  /**
   * 外付けからリンクで取り込んだ動画か（.sme/videoLink.json がある）。
   * true の間は音量調整・ノイズ除去を使わせない（原本をプロジェクト内へ複製し、
   * symlink を通常ファイルへ置き換えてしまうため。サーバ側でも 409 で拒否する）。
   */
  linkedVideo?: boolean;
  /** 再生ヘッド追従スクロール用の @remotion/player 参照。 */
  playerRef: RefObject<PlayerRef>;
  /** プレイヤーフレーム⇔再生フレーム変換に使う速度モデル（未読込時は null）。 */
  model: Pick<PlaybackModel, 'speedSegments' | 'playbackOverlaps' | 'mainSpeed'> | null;
  /**
   * プレビュー再読み込み（C-4）のたびに増える key。playerRef は安定な ref オブジェクトの
   * ため、C-4 の Player 再マウントで playerRef.current が新インスタンスに変わっても
   * playerRef 自体への依存だけでは購読 effect が再実行されない。この key を購読 effect の
   * 依存配列に加え、Player 再マウント後も新インスタンスへ再購読させる。
   */
  previewReloadKey?: number;
}

/** EditorTelop の原本区間が現在カット済み（区間まるごとがカット内）か。 */
function segmentIsCut(telop: EditorTelop, regions: { start: number; end: number }[]): boolean {
  for (const r of regions) {
    if (telop.originalStart >= r.start && telop.originalEnd <= r.end) return true;
  }
  return false;
}

/** リンク取り込みの動画で音声加工を止める理由（ボタンの title に出す）。 */
const LINKED_VIDEO_REASON =
  '外付けからリンクで取り込んだ動画では使えません（元動画をプロジェクト内に複製してしまうため）';

export function TranscriptPanel({
  state,
  transcript,
  fps,
  transcriptAligned,
  cutsBypassed,
  projectId,
  onReloadRequested,
  onEdit,
  onSelect,
  onSeek,
  highlightRange,
  onHighlightRange,
  denoiseApplied = false,
  linkedVideo = false,
  playerRef,
  model,
  previewReloadKey = 0,
}: TranscriptPanelProps) {
  // ノイズ除去 UI の状態
  const [denoiseStrength, setDenoiseStrength] = useState<DenoiseStrength>('mid');
  const {
    state: denoiseState,
    start: startDenoise,
    restore: restoreDenoise,
    heavyJobConfirm: denoiseHeavyJobConfirm,
  } = useDenoise(projectId, denoiseApplied);

  // 音量正規化 UI の状態
  const [normalizeStrength, setNormalizeStrength] = useState<NormalizeStrength>('standard');
  const {
    state: normalizeState,
    start: startNormalize,
    restore: restoreNormalize,
    heavyJobConfirm: normalizeHeavyJobConfirm,
  } = useNormalize(projectId);

  // プレビュー軽量化（preview proxy）の状態
  const {
    state: previewProxyState,
    dismissed: previewProxyDismissed,
    start: startPreviewProxy,
    cancel: cancelPreviewProxy,
    dismiss: dismissPreviewProxy,
    heavyJobConfirm: previewProxyHeavyJobConfirm,
  } = usePreviewProxy(projectId);

  const selectedTelopId =
    state.selection?.kind === 'telop' ? state.selection.id : null;

  // 選択行への参照。selectedTelopId が変わるたびに scrollIntoView({ block: 'nearest' }) して
  // タイムライン等・別経路での選択でも一覧側の表示を追従させる。
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedTelopId]);

  // 文字起こしリストは字幕（飾りでない）テロップのみ。飾りは専用セクションで管理する。
  const subtitleTelops = useMemo(() => partitionTelops(state.telops).subtitles, [state.telops]);

  // ===== 再生ヘッド追従スクロール（C-1） =====
  // トグル状態。既定 ON・localStorage 永続。
  const [followEnabled, setFollowEnabled] = useState<boolean>(() => {
    try {
      return resolveInitialFollowEnabled(localStorage.getItem(TRANSCRIPT_FOLLOW_STORAGE_KEY));
    } catch {
      // private mode 等で localStorage 不可。既定 ON で継続。
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(TRANSCRIPT_FOLLOW_STORAGE_KEY, String(followEnabled));
    } catch {
      // 永続できなくてもトグル自体は有効にする。
    }
  }, [followEnabled]);

  // 各行 DOM への参照（id→要素）。追従スクロール先を選択行と独立に探せるようにする。
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement | null>(null);
  // 再生中かどうか（Timeline の追従スクロールと同じ ref 購読パターン）。
  const isPlayingRef = useRef(false);
  // 手動スクロール検知後、この時刻までは自動追従を一時停止する。
  const pausedUntilRef = useRef(0);
  // scrollIntoView 自身が発火する scroll イベントを手動スクロールと誤検知しないためのフラグ。
  const autoScrollingRef = useRef(false);
  const lastFollowedIdRef = useRef<number | null>(null);

  // play/pause 購読。
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onPlay = (): void => {
      isPlayingRef.current = true;
    };
    const onPause = (): void => {
      isPlayingRef.current = false;
    };
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onPause);
    return () => {
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onPause);
    };
    // previewReloadKey: C-4 のプレビュー再読み込みで playerRef.current が新インスタンスへ
    // 差し替わったとき、playerRef オブジェクト自体は不変のため再購読させる目的で依存に含める。
  }, [playerRef, previewReloadKey]);

  // 一覧の手動スクロールを検知し、一時的に自動追従を止める（触らない）。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (autoScrollingRef.current) return;
      pausedUntilRef.current = Date.now() + MANUAL_SCROLL_PAUSE_MS;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 再生ヘッド追従本体。frameupdate ごとに現在の原本フレームを求め、
  // 対応するテロップ行へ scrollIntoView する（再生中のみ・手動スクロール尊重）。
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const speedView = model ?? { speedSegments: null, playbackOverlaps: [], mainSpeed: 1 };
    const onFrame = (e: { detail: { frame: number } }): void => {
      if (
        !shouldAutoFollow({
          enabled: followEnabled,
          isPlaying: isPlayingRef.current,
          now: Date.now(),
          pausedUntil: pausedUntilRef.current,
        })
      ) {
        return;
      }
      const playback = playerToPlayback(e.detail.frame, speedView);
      const orig = playbackToOriginal(playback, state.cutRegions, cutOrderingOf(state));
      const id = followedTelopId(subtitleTelops, orig);
      if (id === null || id === lastFollowedIdRef.current) return;
      const row = rowRefs.current.get(id);
      if (!row) return;
      lastFollowedIdRef.current = id;
      autoScrollingRef.current = true;
      row.scrollIntoView({ block: 'nearest' });
      requestAnimationFrame(() => {
        autoScrollingRef.current = false;
      });
    };
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
    // previewReloadKey: playerRef と同じ理由（C-4 再マウント後の再購読）で依存に含める。
  }, [playerRef, model, followEnabled, state.cutRegions, subtitleTelops, previewReloadKey]);

  // リロード直後の初期スクロール。プレイヤーが用意でき次第、現ヘッド位置の行へ1回だけ寄せる
  // （毎回先頭から探し直す不便の解消）。previewReloadKey が変わったら（C-4 の再読み込み）
  // 新しい Player インスタンスに対して初期スクロールをやり直せるようリセットする。
  const initializedRef = useRef(false);
  useEffect(() => {
    initializedRef.current = false;
  }, [previewReloadKey]);
  useEffect(() => {
    if (initializedRef.current) return;
    const player = playerRef.current;
    if (!player) return;
    const row0 = (() => {
      const speedView = model ?? { speedSegments: null, playbackOverlaps: [], mainSpeed: 1 };
      const frame = player.getCurrentFrame();
      const playback = playerToPlayback(frame, speedView);
      const orig = playbackToOriginal(playback, state.cutRegions, cutOrderingOf(state));
      const id = followedTelopId(subtitleTelops, orig);
      return id !== null ? rowRefs.current.get(id) : undefined;
    })();
    if (!row0) return;
    initializedRef.current = true;
    row0.scrollIntoView({ block: 'nearest' });
  });

  // 各テロップの単語チップは transcript から派生。telops が変わったら作り直す。
  // transcript が動画と整合していない場合（焼き込み済みプロジェクト等）は
  // チップが無意味になるので空のままにする。
  const chipsByTelopId = useMemo(() => {
    const map = new Map<number, WordChip[]>();
    if (!transcriptAligned) return map;
    for (const t of subtitleTelops) {
      map.set(
        t.id,
        buildWordChips(
          { originalStart: t.originalStart, originalEnd: t.originalEnd },
          transcript.words,
          fps,
        ),
      );
    }
    return map;
  }, [subtitleTelops, transcript.words, fps, transcriptAligned]);

  return (
    <div className="tx">
      {/* ヘッダーは1行のみ。タブ名（文字起こし）と同じ見出しの繰り返しや、
          機能未実装のタブ列（旧 編集/検索/統計）は置かない（UIレビュー エディタ3）。 */}
      <div className="tx-head">
        <h2>
          じまく一覧
          <span className="count">{subtitleTelops.length} 件</span>
        </h2>
        <button
          type="button"
          className={'tl-snap-toggle' + (followEnabled ? ' on' : '')}
          title={
            followEnabled
              ? '再生ヘッド追従: オン（再生中に自動スクロール・クリックでオフ）'
              : '再生ヘッド追従: オフ（クリックでオン）'
          }
          aria-pressed={followEnabled}
          onClick={() => setFollowEnabled((v) => !v)}
        >
          追従
        </button>
        <span className="tx-head-hint">行をクリックで選択・語をタップでカット</span>
      </div>
      {!transcriptAligned ? (
        <TranscribeBanner projectId={projectId} onReloadRequested={onReloadRequested} />
      ) : null}
      <PreviewProxyBanner
        state={previewProxyState}
        dismissed={previewProxyDismissed}
        onStart={() => void startPreviewProxy()}
        onCancel={() => void cancelPreviewProxy()}
        onDismiss={dismissPreviewProxy}
        onReloadRequested={onReloadRequested}
      />
      {denoiseHeavyJobConfirm.pendingConfirm ? (
        <HeavyJobConfirmDialog
          running={denoiseHeavyJobConfirm.pendingConfirm.running}
          onConfirm={denoiseHeavyJobConfirm.confirm}
          onDismiss={denoiseHeavyJobConfirm.dismiss}
        />
      ) : null}
      {normalizeHeavyJobConfirm.pendingConfirm ? (
        <HeavyJobConfirmDialog
          running={normalizeHeavyJobConfirm.pendingConfirm.running}
          onConfirm={normalizeHeavyJobConfirm.confirm}
          onDismiss={normalizeHeavyJobConfirm.dismiss}
        />
      ) : null}
      {previewProxyHeavyJobConfirm.pendingConfirm ? (
        <HeavyJobConfirmDialog
          running={previewProxyHeavyJobConfirm.pendingConfirm.running}
          onConfirm={previewProxyHeavyJobConfirm.confirm}
          onDismiss={previewProxyHeavyJobConfirm.dismiss}
        />
      ) : null}

      <details className="tx-audio-group">
        <summary>
          <span>音声</span>
          <span className="tx-audio-badges">
            {denoiseState.applied ? <span className="ins-pack-hint">ノイズ除去 適用済み</span> : null}
            {normalizeState.applied ? <span className="ins-pack-hint">音量 適用済み</span> : null}
          </span>
        </summary>
      {/* ノイズ除去パネル（音声パネル） */}
      <div className="ins-section">
        <div className="ins-label">
          <span>ノイズ除去</span>
          {denoiseState.applied ? (
            <span className="ins-pack-hint">適用済み</span>
          ) : null}
        </div>
        <div className="seg" role="group" aria-label="ノイズ除去の強さ">
          {(['weak', 'mid', 'strong'] as const).map((s) => (
            <button
              key={s}
              className={denoiseStrength === s ? 'active' : ''}
              onClick={() => setDenoiseStrength(s)}
              disabled={denoiseState.status === 'running'}
              aria-pressed={denoiseStrength === s}
            >
              {s === 'weak' ? '弱' : s === 'mid' ? '中' : '強'}
            </button>
          ))}
        </div>
        <div className="tx-row-tools">
          <button
            className="tx-mini-btn"
            disabled={denoiseState.status === 'running' || linkedVideo}
            title={linkedVideo ? LINKED_VIDEO_REASON : undefined}
            onClick={() => void startDenoise(denoiseStrength)}
          >
            ノイズ除去を実行
          </button>
          {denoiseState.applied ? (
            <button
              className="tx-mini-btn"
              disabled={denoiseState.status === 'running' || linkedVideo}
              title={linkedVideo ? LINKED_VIDEO_REASON : undefined}
              onClick={() => void restoreDenoise()}
            >
              元に戻す
            </button>
          ) : null}
        </div>
        {denoiseState.status !== 'idle' ? (
          <DenoiseBanner
            state={denoiseState}
            onReloadRequested={onReloadRequested}
            onCancel={() => void fetch(`/api/denoise?id=${encodeURIComponent(projectId)}`, { method: 'DELETE' })}
          />
        ) : null}
      </div>
      {/* 音量正規化パネル（音声パネル・denoise の隣） */}
      <div className="ins-section">
        <div className="ins-label">
          <span>音量を整える</span>
          {normalizeState.applied ? <span className="ins-pack-hint">適用済み</span> : null}
        </div>
        <div className="seg" role="group" aria-label="音量の目標">
          {(['loud', 'standard', 'quiet'] as const).map((s) => (
            <button
              key={s}
              className={normalizeStrength === s ? 'active' : ''}
              onClick={() => setNormalizeStrength(s)}
              disabled={normalizeState.status === 'running'}
              aria-pressed={normalizeStrength === s}
            >
              {s === 'loud' ? 'しっかり' : s === 'standard' ? '標準' : '控えめ'}
            </button>
          ))}
        </div>
        <div className="tx-row-tools">
          <button
            className="tx-mini-btn"
            disabled={normalizeState.status === 'running' || linkedVideo}
            title={linkedVideo ? LINKED_VIDEO_REASON : undefined}
            onClick={() => void startNormalize(normalizeStrength)}
          >
            音量を整える
          </button>
          {normalizeState.applied ? (
            <button
              className="tx-mini-btn"
              disabled={normalizeState.status === 'running' || linkedVideo}
              title={linkedVideo ? LINKED_VIDEO_REASON : undefined}
              onClick={() => void restoreNormalize()}
            >
              元に戻す
            </button>
          ) : null}
        </div>
        {normalizeState.status !== 'idle' ? (
          <NormalizeBanner
            state={normalizeState}
            onReloadRequested={onReloadRequested}
            onCancel={() => void fetch(`/api/normalize?id=${encodeURIComponent(projectId)}`, { method: 'DELETE' })}
          />
        ) : null}
      </div>
      </details>
      <div className="tx-list" ref={listRef} onMouseLeave={() => onHighlightRange(null)}>
        {subtitleTelops.map((t, index) => {
          const selected = selectedTelopId === t.id;
          const cut = segmentIsCut(t, state.cutRegions);
          const chips = chipsByTelopId.get(t.id) ?? [];
          const hasNext = index < subtitleTelops.length - 1;
          return (
            <div
              key={t.id}
              ref={(el) => {
                if (selected) selectedRowRef.current = el;
                if (el) rowRefs.current.set(t.id, el);
                else rowRefs.current.delete(t.id);
              }}
              className={'tx-row' + (selected ? ' selected' : '') + (cut ? ' cut' : '')}
              onClick={() => {
                onSelect({ ...state, selection: { kind: 'telop', id: t.id } });
                const pb = originalToPlayback(
                  t.originalStart,
                  cutsBypassed ? [] : state.cutRegions,
                  cutsBypassed ? undefined : cutOrderingOf(state),
                );
                if (pb !== null) onSeek(pb);
              }}
            >
              <div className="tx-time">
                {formatClock(fps > 0 ? t.originalStart / fps : 0)}
              </div>
              <div className="tx-body">
                {selected ? (
                  <>
                    {chips.length > 0 && (
                      <div className="tx-chip-caption">
                        語をタップするとその部分を動画からカット（もう一度タップで解除）
                      </div>
                    )}
                    {chips.length > 0 ? (
                      chips.map((chip, i) => {
                        const isCut = chipCutState(chip, state.cutRegions);
                        const highlighted =
                          highlightRange !== null &&
                          rangesOverlap(
                            chip.originalStart,
                            chip.originalEnd,
                            highlightRange.start,
                            highlightRange.end,
                          );
                        return (
                          <span
                            key={i}
                            className={
                              'tx-chip' + (isCut ? ' cut' : '') + (highlighted ? ' hl' : '')
                            }
                            title={isCut ? 'クリックでカット解除' : 'クリックでこの単語をカット'}
                            onMouseEnter={() =>
                              onHighlightRange({
                                start: chip.originalStart,
                                end: chip.originalEnd,
                              })
                            }
                            onMouseLeave={() => onHighlightRange(null)}
                            onClick={(e) => {
                              e.stopPropagation();
                              onEdit(toggleWordCut(state, chip));
                            }}
                          >
                            {chip.text}
                          </span>
                        );
                      })
                    ) : (
                      <span className="tx-text" style={{ color: 'var(--fg-3)' }}>
                        単語タイミング無し（行削除のみ可）
                      </span>
                    )}
                    <textarea
                      className="tx-text-edit"
                      value={t.text}
                      rows={2}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onEdit(setTelopText(state, t.id, e.target.value))}
                    />
                    <div className="tx-row-tools">
                      <button
                        className="tx-mini-btn"
                        title="改行があれば改行位置で、無ければ中央で 2 つに分割"
                        onClick={(e) => {
                          e.stopPropagation();
                          // 改行入り本文は「改行位置で割りたい」の意思表示とみなす。
                          const plan = newlineSplitPlan(t.text, chips, t.originalStart, t.originalEnd);
                          if (plan) {
                            onEdit(splitTelopAt(state, t.id, plan.atFrame, plan.leftText, plan.rightText));
                            return;
                          }
                          const mid = Math.floor((t.originalStart + t.originalEnd) / 2);
                          onEdit(splitTelopWithText(state, t.id, mid, chips));
                        }}
                      >
                        分割
                      </button>
                      <button
                        className="tx-mini-btn"
                        title="次のテロップと結合"
                        disabled={!hasNext}
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(mergeTelopWithNext(state, t.id));
                        }}
                      >
                        次と結合
                      </button>
                    </div>
                  </>
                ) : (
                  <span className="tx-text">{t.text}</span>
                )}
              </div>
              <button
                className="tx-row-act"
                title={cut ? 'カットを解除' : 'このテロップ区間を削除（カット）'}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(toggleSegmentCut(state, t.id));
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
