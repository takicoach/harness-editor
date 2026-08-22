import { useState, useEffect } from 'react';
import { cutOrderingOf } from '../../../core/cutOrder';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { formatClock, frameToSec, parseSecField } from '../../../shared/format';
import type { EditorTelop, TelopStyle } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import {
  setTelopStyle,
  setTelopHighlight,
  setTelopTiming,
  setTelopPosition,
  setTelopScale,
  setTelopManual,
  applyTelopTemplateForScope,
  setAllTelopPositions,
  removeTelop,
  setTelopMotion,
  type TelopStyleScope,
} from '../../edit/telopSettingsOps';
import { MotionSettings } from './MotionSettings';
import { setTelopText } from '../../edit/textOps';
import type { InstallKind, InstallErrors } from '../../install';
import { TELOP_PACK } from '../../../server/telopPack/manifest';
import { resolveTemplate } from '../../../core/telopTemplate';
import type { TelopComponent } from '../../../preview/loadTelopComponent';
import { swatchSampleText } from '../../../core/telopSwatch';
import { TelopStyleGrid } from '../TelopStyleGrid';
import { TelopPositionFields } from './TelopPositionFields';
import { InstallCtaButton } from './shared';

/** スタイルの適用範囲トグル（選ぶ「前」に決める）。 */
const STYLE_SCOPES: { id: TelopStyleScope; label: string }[] = [
  { id: 'one', label: 'このテロップ' },
  { id: 'all', label: '全テロップ' },
];

const STYLES: { id: TelopStyle; label: string }[] = [
  { id: 'normal', label: '通常' },
  { id: 'emphasis', label: '強調' },
  { id: 'warning', label: 'ネガティブ' },
  { id: 'success', label: 'ポジティブ' },
];

interface SettingsTabProps {
  telop: EditorTelop;
  state: EditState;
  fps: number;
  telopPackInstalled: boolean;
  videoInsertInstalled: boolean;
  bgmInstalled: boolean;
  /** 導入中の機能種別（null なら非導入中）。 */
  installing: InstallKind | null;
  /** kind 別の導入エラー。 */
  installErrors: InstallErrors;
  dirty: boolean;
  telopComponent: TelopComponent | null;
  previewWidth: number;
  previewHeight: number;
  onInstall: (kind: InstallKind) => void;
  onEdit: (next: EditState) => void;
}

/**
 * テロップ（字幕・装飾の両方）の設定タブ。右ドックの「設定」タブで Inspector 経由で表示する。
 */
export function SettingsTab({ telop, state, fps, telopPackInstalled, videoInsertInstalled, bgmInstalled, installing, installErrors, dirty, telopComponent, previewWidth, previewHeight, onInstall, onEdit }: SettingsTabProps) {
  // 表示タイミングは再生（カット後）フレームでユーザーに見せる。
  const playbackStart = originalToPlayback(telop.originalStart, state.cutRegions, cutOrderingOf(state));
  const playbackEnd = originalToPlayback(telop.originalEnd, state.cutRegions, cutOrderingOf(state), 'end');
  // カット区間内へ落ちている端は近似値。null なら原本フレームをそのまま表示する。
  const shownStart = playbackStart ?? telop.originalStart;
  const shownEnd = playbackEnd ?? telop.originalEnd;
  // テロップの端がカット区間に落ちているとき playbackStart/End が null になる。
  // その場合は shownEnd が原本フレームのままなので commitTiming が誤射影するため入力を禁止する。
  const timingEditable = playbackStart !== null && playbackEnd !== null;
  const position = telop.position ?? { x: 0, y: 0 };
  const scale = telop.scale ?? 1;

  // タイミング入力は入力中の文字列を保持するローカル state を使い、
  // blur / Enter キーでのみ確定する（空→0 で即コミットされる問題を防ぐ）。
  // 入力値・表示は秒（小数点2桁）。コミット時に secToFrame で再生フレームへ戻す。
  const [startStr, setStartStr] = useState(frameToSec(shownStart, fps).toFixed(2));
  const [endStr, setEndStr] = useState(frameToSec(shownEnd, fps).toFixed(2));

  // スタイルの適用範囲。既定は「このテロップ」（意図しない一括書き換えを起こさない側）。
  // 別要素（効果音・画像など）を選んでこのタブが消えると既定へ戻る。
  const [styleScope, setStyleScope] = useState<TelopStyleScope>('one');

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
          <span>テロップ #{telop.id}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
          {formatClock(frameToSec(telop.originalStart, fps))} 〜 {formatClock(frameToSec(telop.originalEnd, fps))}
        </div>
      </div>

      {/* 飾りテロップは文字起こしリストに出ないため、本文編集はここで行う（字幕は TranscriptPanel で編集）。 */}
      {telop.manual === true && (
        <div className="ins-section">
          <div className="ins-label"><span>文字</span></div>
          <textarea
            className="tx-text-edit"
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
            {/* 適用範囲は「選ぶ前」に決める。選んだ後に別ボタンで全体適用する形だと、
                押し忘れて1枚だけ変わったことに気づけない。 */}
            <div className="seg ins-style-scope">
              {STYLE_SCOPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  data-scope={s.id}
                  className={styleScope === s.id ? 'active' : ''}
                  onClick={() => setStyleScope(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="ins-style-scope-hint">
              {styleScope === 'all'
                ? 'スタイルを選ぶと、すべてのテロップに適用されます（Cmd/Ctrl+Z で戻せます）'
                : 'スタイルを選ぶと、このテロップだけに適用されます'}
            </p>
            {telopComponent ? (
              <TelopStyleGrid
                telopComponent={telopComponent}
                previewWidth={previewWidth}
                previewHeight={previewHeight}
                fps={fps}
                sampleText={swatchSampleText(telop.text)}
                currentTemplate={resolveTemplate(telop.template, TELOP_PACK.length)}
                onSelect={(id) => onEdit(applyTelopTemplateForScope(state, telop.id, id, styleScope))}
              />
            ) : (
              <div className="ins-style-list">
                {TELOP_PACK.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={'ins-style-item' + (resolveTemplate(telop.template, TELOP_PACK.length) === e.id ? ' active' : '')}
                    onClick={() => onEdit(applyTelopTemplateForScope(state, telop.id, e.id, styleScope))}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>サブ動画機能</span></div>
        {!videoInsertInstalled ? (
          <div className="ins-pack-cta">
            <p>サブ動画（インサート動画）をプレビューに表示できます。</p>
            <InstallCtaButton
              kind="videoInsert"
              label="サブ動画機能を導入"
              className="ins-video-install"
              installing={installing}
              installErrors={installErrors}
              dirty={dirty}
              onInstall={onInstall}
            />
          </div>
        ) : (
          <p className="ins-pack-hint">サブ動画機能は導入済みです。</p>
        )}
      </div>

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

      {/* style / highlight は旧 Telop.tsx 用。パック導入後は Ren アダプタが読まない（描画に
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

      <div className="ins-section">
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
      </div>

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
