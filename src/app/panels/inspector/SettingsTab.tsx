import { AssetTimingSection, useAssetTimingDisplay } from './AssetTimingSection';
import { useState, useEffect } from 'react';
import { cutOrderingOf } from '../../../core/cutOrder';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { formatClock, frameToSec, parseSecField } from '../../../shared/format';
import type { EditorTelop, TelopStyle } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import {
  setTelopTemplate,
  setTelopStyle,
  setTelopHighlight,
  setTelopTiming,
  setTelopPosition,
  setTelopScale,
  setTelopManual,
  setAllTelopTemplates,
  setAllTelopPositions,
  removeTelop,
  setTelopMotion,
} from '../../edit/telopSettingsOps';
import { MotionSettings } from './MotionSettings';
import { setTelopText } from '../../edit/textOps';
import type { InstallKind, InstallErrors } from '../../install';
import { TELOP_PACK } from '../../../server/telopPack/manifest';
import { resolveTemplate } from '../../../core/telopTemplate';
import type { NativeTelopRevision } from '../../../preview/nativeTelopCache';
import { swatchSampleText } from '../../../core/telopSwatch';
import { TelopStyleGrid } from '../TelopStyleGrid';
import { TelopPositionFields } from './TelopPositionFields';
import { TELOP_KEYFRAMES_UNSUPPORTED } from '../../../shared/motionKeys';
import { InstallCtaButton } from './shared';

const STYLES: { id: TelopStyle; label: string }[] = [
  { id: 'normal', label: '通常' },
  { id: 'emphasis', label: '強調' },
  { id: 'warning', label: 'ネガティブ' },
  { id: 'success', label: 'ポジティブ' },
];

interface SettingsTabProps {
  projectId: string;
  telop: EditorTelop;
  state: EditState;
  fps: number;
  telopPackInstalled: boolean;
  /** テロップのキーフレームが書き出しへ反映されるか（未指定＝対応済み扱い）。 */
  keyframesSupported?: boolean;
  bgmInstalled: boolean;
  /** 導入中の機能種別（null なら非導入中）。 */
  installing: InstallKind | null;
  /** kind 別の導入エラー。 */
  installErrors: InstallErrors;
  dirty: boolean;
  componentRevision: NativeTelopRevision | null;
  previewWidth: number;
  previewHeight: number;
  onInstall: (kind: InstallKind) => void;
  onEdit: (next: EditState) => void;
}

/** 見出しに出すテロップ名の最大文字数（status-ia-9）。 */
const TELOP_TITLE_MAX = 14;

/**
 * インスペクタ見出しのテロップ名（純関数・status-ia-9）。
 *
 * 内部 id（旧「テロップ #100」）は利用者にとって手がかりにならない。本文の先頭を出し、
 * 本文が空のテロップだけ「（文字なしのテロップ）」にする。
 */
export function telopHeadingLabel(text: string, max = TELOP_TITLE_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return '（文字なしのテロップ）';
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** テロップ見出しの時計表示（純関数・status-ia-8）。 */
export interface TelopClockCaption {
  /** 再生（カット後）基準の「開始 〜 終了」。入力欄と同じ基準。確定できないなら null。 */
  playback: string | null;
  /** 原本（カット前）基準。再生基準と同じなら null（併記しない）。 */
  original: string | null;
  /** 再生上の時刻を出せない理由（出せるときは null）。 */
  note: string | null;
}

/**
 * 見出しの時計を再生（カット後）基準に統一し、ずれているときだけ原本を併記する（status-ia-8）。
 *
 * 従来は見出しが原本基準・入力欄が再生基準で、カットを増やすほど同じパネル内で
 * 数字が食い違っていた。基準を書かずに 2 つの時刻を並べない。
 */
export function telopClockCaption(
  shownStart: number,
  shownEnd: number,
  originalStart: number,
  originalEnd: number,
  fps: number,
  /**
   * 両端とも再生フレームへ射影できたか（= playbackStart/End が共に非 null）。
   * false のとき shownStart / shownEnd には原本フレームが混ざるので、
   * 再生基準として出さない（開始 > 終了の逆転した範囲や、断りの無い原本時刻が出る）。
   */
  timingResolved = true,
): TelopClockCaption {
  const original = `${formatClock(frameToSec(originalStart, fps))} 〜 ${formatClock(frameToSec(originalEnd, fps))}`;
  if (!timingResolved) {
    return {
      playback: null,
      original,
      note: 'カット区間にかかっているため再生上の時刻は確定できません',
    };
  }
  const playback = `${formatClock(frameToSec(shownStart, fps))} 〜 ${formatClock(frameToSec(shownEnd, fps))}`;
  return { playback, original: original === playback ? null : original, note: null };
}

/**
 * テロップ（字幕・装飾の両方）の設定タブ。右ドックの「設定」タブで Inspector 経由で表示する。
 */
export function SettingsTab({ projectId, telop, state, fps, telopPackInstalled, keyframesSupported = true, bgmInstalled, installing, installErrors, dirty, componentRevision, previewWidth, previewHeight, onInstall, onEdit }: SettingsTabProps) {
  const timing = useAssetTimingDisplay();
  // 表示タイミングは再生（カット後）フレームでユーザーに見せる。
  const playbackStart = originalToPlayback(telop.originalStart, state.cutRegions, cutOrderingOf(state));
  const playbackEnd = originalToPlayback(telop.originalEnd, state.cutRegions, cutOrderingOf(state), 'end');
  // カット区間内へ落ちている端は近似値。null なら原本フレームをそのまま表示する。
  const shownStart = playbackStart ?? telop.originalStart;
  const shownEnd = playbackEnd ?? telop.originalEnd;
  // テロップの端がカット区間に落ちているとき playbackStart/End が null になる。
  // その場合は shownEnd が原本フレームのままなので commitTiming が誤射影するため入力を禁止する。
  const timingEditable = playbackStart !== null && playbackEnd !== null;
  // 見出しの時計も入力欄と同じ再生（カット後）基準にする（status-ia-8）。
  const clock = timing ? { playback: timing.label, original: null, note: null } : telopClockCaption(shownStart, shownEnd, telop.originalStart, telop.originalEnd, fps, timingEditable);
  const position = telop.position ?? { x: 0, y: 0 };
  const scale = telop.scale ?? 1;

  // タイミング入力は入力中の文字列を保持するローカル state を使い、
  // blur / Enter キーでのみ確定する（空→0 で即コミットされる問題を防ぐ）。
  // 入力値・表示は秒（小数点2桁）。コミット時に secToFrame で再生フレームへ戻す。
  const [startStr, setStartStr] = useState(frameToSec(shownStart, fps).toFixed(2));
  const [endStr, setEndStr] = useState(frameToSec(shownEnd, fps).toFixed(2));

  // 外部要因（テロップ選択変更・Undo/Redo・カット変更による再射影）で
  // shownStart / shownEnd が変わったらローカル state を同期する。
  useEffect(() => { setStartStr(frameToSec(shownStart, fps).toFixed(2)); }, [shownStart, fps]);
  useEffect(() => { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); }, [shownEnd, fps]);

  /** 再生フレーム入力 → 原本フレームへ逆射影して timing を更新する。 */
  function commitTiming(nextStart: number, nextEnd: number): void {
    const origStart = playbackToOriginal(nextStart, state.cutRegions, cutOrderingOf(state));
    const origEnd = playbackToOriginal(nextEnd, state.cutRegions, cutOrderingOf(state), 'end');
    onEdit(setTelopTiming(state, telop.id, origStart, origEnd));
  }

  return (
    <>
      <div className="ins-section">
        <div className="ins-label">
          <span title={telop.text}>{telopHeadingLabel(telop.text)}</span>
        </div>
        <div className="ins-telop-clock" data-testid="telop-clock">
          {clock.playback !== null && <div className="ins-telop-clock-main">{clock.playback}</div>}
          {clock.original !== null && (
            <div className={clock.playback === null ? 'ins-telop-clock-main' : 'ins-telop-clock-sub'}>
              カット前: {clock.original}
            </div>
          )}
          {clock.note !== null && <div className="ins-telop-clock-sub">{clock.note}</div>}
        </div>
      </div>

      {/* 飾りテロップは文字起こしリストに出ないため、本文編集はここで行う（字幕は TranscriptPanel で編集）。 */}
      {telop.manual === true && (
        <div className="ins-section">
          <div className="ins-label"><span>文字</span></div>
          <textarea
            className="tx-text-edit"
            data-testid="ins-telop-text"
            value={telop.text}
            rows={2}
            onChange={(e) => onEdit(setTelopText(state, telop.id, e.target.value))}
          />
        </div>
      )}

      <div className="ins-section">
        <label className="ins-check">
          <input
            id="ins-telop-manual"
            type="checkbox"
            checked={telop.manual === true}
            onChange={(e) => onEdit(setTelopManual(state, telop.id, e.target.checked))}
          />
          <span>
            {telop.manual === true
              ? '字幕に変換（字幕セクションへ移動）'
              : '飾りテロップに変換（テロップセクションへ移動）'}
          </span>
        </label>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>テロップスタイル</span></div>
        {!telopPackInstalled ? (
          <div className="ins-pack-cta">
            <p>{TELOP_PACK.length}種のテロップスタイルから選べます。</p>
            <InstallCtaButton
              kind="telopPack"
              label={`テロップ${TELOP_PACK.length}スタイルを導入`}
              className="ins-telop-pack-install"
              installing={installing}
              installErrors={installErrors}
              dirty={dirty}
              onInstall={onInstall}
            />
          </div>
        ) : (
          <>
            {componentRevision ? (
              <TelopStyleGrid
                key={projectId}
                projectId={projectId}
                componentRevision={componentRevision}
                previewWidth={previewWidth}
                previewHeight={previewHeight}
                fps={fps}
                sampleText={swatchSampleText(telop.text)}
                currentTemplate={resolveTemplate(telop.template, TELOP_PACK.length)}
                onSelect={(id) => onEdit(setTelopTemplate(state, telop.id, id))}
              />
            ) : (
              <div className="ins-style-list">
                {TELOP_PACK.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={'ins-style-item' + (resolveTemplate(telop.template, TELOP_PACK.length) === e.id ? ' active' : '')}
                    onClick={() => onEdit(setTelopTemplate(state, telop.id, e.id))}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="ins-style-apply-all"
              onClick={() => onEdit(setAllTelopTemplates(state, resolveTemplate(telop.template, TELOP_PACK.length)))}
            >
              このスタイルを全体に適用
            </button>
          </>
        )}
      </div>

      {/* サブ動画機能の導入 CTA は選択非依存の常設ゾーンへ移設済み（B-3 R-5）。
          テロップ非関連の機能をテロップ設定タブ内に閉じ込めない。Inspector.tsx を参照。 */}

      <div className="ins-section">
        <div className="ins-label"><span>BGM 機能</span></div>
        {!bgmInstalled ? (
          <div className="ins-pack-cta">
            <p>BGM をプレビューと最終書き出しに追加できます。</p>
            <InstallCtaButton
              kind="bgm"
              label="BGM 機能を導入"
              className="ins-bgm-install"
              installing={installing}
              installErrors={installErrors}
              dirty={dirty}
              onInstall={onInstall}
            />
          </div>
        ) : (
          <p className="ins-pack-hint">BGM 機能は導入済みです。</p>
        )}
      </div>

      {/* style / highlight は旧 Telop.tsx 用。パック導入後はスタイルアダプタが読まない（描画に
          影響しない no-op 編集になる）ため、未導入時のみ表示する。 */}
      {!telopPackInstalled && (
        <>
          <div className="ins-section">
            <div className="ins-label"><span>スタイル</span></div>
            <div className="seg">
              {STYLES.map((s) => (
                <button
                  key={s.id}
                  className={(telop.style ?? 'normal') === s.id ? 'active' : ''}
                  onClick={() => onEdit(setTelopStyle(state, telop.id, s.id))}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ins-section">
            <div className="ins-label"><span>ハイライト語</span></div>
            <div className="hl-row">
              <input
                className="hl-input"
                type="text"
                placeholder="強調する語（空で解除）"
                value={telop.highlight ?? ''}
                onChange={(e) => onEdit(setTelopHighlight(state, telop.id, e.target.value))}
              />
            </div>
          </div>
        </>
      )}

<AssetTimingSection>
        <div className="ins-label"><span>表示する時間（秒）</span></div>
        {!timingEditable && (
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 6px' }}>
            このテロップはカット区間にかかっているため、表示タイミングはここでは編集できません
          </p>
        )}
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-start">開始</label>
            <input
              id="ins-start"
              type="number"
              step={0.1}
              value={startStr}
              disabled={!timingEditable}
              onChange={(e) => setStartStr(e.target.value)}
              onBlur={() => {
                if (!timingEditable) return;
                const frame = parseSecField(startStr, shownStart, fps);
                if (frame === null) setStartStr(frameToSec(shownStart, fps).toFixed(2));
                else commitTiming(frame, shownEnd);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !timingEditable) return;
                const frame = parseSecField(startStr, shownStart, fps);
                if (frame === null) setStartStr(frameToSec(shownStart, fps).toFixed(2));
                else commitTiming(frame, shownEnd);
              }}
            />
          </div>
          <div className="num-field">
            <label htmlFor="ins-end">終了</label>
            <input
              id="ins-end"
              type="number"
              step={0.1}
              value={endStr}
              disabled={!timingEditable}
              onChange={(e) => setEndStr(e.target.value)}
              onBlur={() => {
                if (!timingEditable) return;
                const frame = parseSecField(endStr, shownEnd, fps);
                if (frame === null) setEndStr(frameToSec(shownEnd, fps).toFixed(2));
                else commitTiming(shownStart, frame);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !timingEditable) return;
                const frame = parseSecField(endStr, shownEnd, fps);
                if (frame === null) setEndStr(frameToSec(shownEnd, fps).toFixed(2));
                else commitTiming(shownStart, frame);
              }}
            />
          </div>
        </div>
      </AssetTimingSection>

      <div className="ins-section">
        <div className="ins-label">
          <span>位置・大きさ</span>
          <span style={{ color: 'var(--fg-3)', textTransform: 'none' }}>
            プレビュー上で直接ドラッグ
          </span>
        </div>
        <TelopPositionFields
          idPrefix="ins"
          position={position}
          scale={scale}
          commitMode="change"
          onPosition={(x, y) => onEdit(setTelopPosition(state, telop.id, x, y))}
          onScale={(v) => onEdit(setTelopScale(state, telop.id, v))}
        />
        <button
          type="button"
          className="ins-pos-apply-all"
          onClick={() => onEdit(setAllTelopPositions(state, position, scale))}
        >
          この位置・大きさを全体に適用
        </button>
      </div>

      <MotionSettings
        idPrefix="ins-telop"
        motion={telop.motion}
        base={{ x: position?.x ?? 0, y: position?.y ?? 0, scale, opacity: 1, rotation: 0 }}
        keyframeSupport={{ supported: keyframesSupported, message: TELOP_KEYFRAMES_UNSUPPORTED }}
        durationFrames={timing ? timing.end - timing.start : telop.originalEnd - telop.originalStart}
        fps={fps}
        onChange={(m) => onEdit(setTelopMotion(state, telop.id, m))}
      />

      {/* 飾りテロップの削除（配列から除去）。字幕の「削除」は動画区間カットで別物のため、
          ここでは飾りテロップのときだけ削除ボタンを出す。 */}
      {telop.manual === true && (
        <div className="ins-section">
          <button className="tx-mini-btn" onClick={() => onEdit(removeTelop(state, telop.id))}>
            この飾りテロップを削除
          </button>
        </div>
      )}
    </>
  );
}
