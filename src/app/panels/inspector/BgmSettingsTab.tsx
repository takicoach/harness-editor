import { AssetTimingSection, useAssetTimingDisplay } from './AssetTimingSection';
import { useState, useEffect } from 'react';
import { cutOrderingOf } from '../../../core/cutOrder';
import { useAudition } from '../../audio/useAudition';
import { assetPathFor, assetUrl } from '../materialList';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { formatClock, frameToSec, parseSecField } from '../../../shared/format';
import type { EditorBgmClip } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import { resizeBgm, setBgmVolume, setBgmFadeIn, setBgmFadeOut, setBgmFile, removeBgm } from '../../edit/bgmOps';
import { useWaveformSamples } from '../../audio/useWaveformSamples';
import { Waveform } from '../../timeline/Waveform';
import type { InstallKind, InstallErrors } from '../../install';
import { InstallCtaButton, VOLUME_PRESETS } from './shared';

/** 音量プリセット（小/中/大・SE/BGM 共通）。 */
interface BgmSettingsTabProps {
  bgm: EditorBgmClip;
  state: EditState;
  fps: number;
  bgmLibrary: string[];
  projectId: string;
  assetVersions?: Record<string, string>;
  installing: InstallKind | null;
  installErrors: InstallErrors;
  bgmInstalled: boolean;
  dirty: boolean;
  onInstall: (kind: InstallKind) => void;
  onEdit: (next: EditState) => void;
}

/** BGM 選択時のインスペクタ本体（ファイル差替・区間・音量・フェード・波形・削除）。
 *  VideoInsertSettingsTab のミラー（イン点同期は BGM には不要なので省略）。 */
export function BgmSettingsTab({ bgm, state, fps, bgmLibrary, projectId, assetVersions, installing, installErrors, bgmInstalled, dirty, onInstall, onEdit }: BgmSettingsTabProps) {
  const timing = useAssetTimingDisplay();
  const audition = useAudition();
  const playbackStart = originalToPlayback(bgm.originalStart, state.cutRegions, cutOrderingOf(state));
  const playbackEnd = originalToPlayback(bgm.originalEnd, state.cutRegions, cutOrderingOf(state), 'end');
  const shownStart = playbackStart ?? bgm.originalStart;
  const shownEnd = playbackEnd ?? bgm.originalEnd;
  const editable = playbackStart !== null && playbackEnd !== null;
  const fileOptions = bgmLibrary.includes(bgm.file)
    ? bgmLibrary
    : [bgm.file, ...bgmLibrary];

  const [startStr, setStartStr] = useState(frameToSec(shownStart, fps).toFixed(2));
  const [endStr, setEndStr] = useState(frameToSec(shownEnd, fps).toFixed(2));
  const [fadeInStr, setFadeInStr] = useState(frameToSec(bgm.fadeInFrames, fps).toFixed(2));
  const [fadeOutStr, setFadeOutStr] = useState(frameToSec(bgm.fadeOutFrames, fps).toFixed(2));
  useEffect(() => { setStartStr(frameToSec(shownStart, fps).toFixed(2)); }, [shownStart, fps]);
  useEffect(() => { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); }, [shownEnd, fps]);
  useEffect(() => { setFadeInStr(frameToSec(bgm.fadeInFrames, fps).toFixed(2)); }, [bgm.fadeInFrames, fps]);
  useEffect(() => { setFadeOutStr(frameToSec(bgm.fadeOutFrames, fps).toFixed(2)); }, [bgm.fadeOutFrames, fps]);

  // BGM ファイルは BGM/ ディレクトリに置かれるため asset URL を組み立てる。
  const waveformUrl = projectId !== '' && bgm.file !== ''
    ? assetUrl(projectId, assetPathFor('bgm', bgm.file), assetVersions)
    : null;
  // 読み込み中と失敗の分離（X-2(b)）。注記は failed=true のときだけ出す。
  const { samples: waveformSamples, failed: waveformFailed } = useWaveformSamples(waveformUrl);

  function commitStart(): void {
    const frame = parseSecField(startStr, shownStart, fps);
    if (frame === null) { setStartStr(frameToSec(shownStart, fps).toFixed(2)); return; }
    onEdit(resizeBgm(state, bgm.id, playbackToOriginal(frame, state.cutRegions, cutOrderingOf(state)), bgm.originalEnd));
  }
  function commitEnd(): void {
    const frame = parseSecField(endStr, shownEnd, fps);
    if (frame === null) { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); return; }
    onEdit(resizeBgm(state, bgm.id, bgm.originalStart, playbackToOriginal(frame, state.cutRegions, cutOrderingOf(state))));
  }
  function commitFadeIn(): void {
    const frame = parseSecField(fadeInStr, bgm.fadeInFrames, fps);
    if (frame === null) { setFadeInStr(frameToSec(bgm.fadeInFrames, fps).toFixed(2)); return; }
    onEdit(setBgmFadeIn(state, bgm.id, frame));
  }
  function commitFadeOut(): void {
    const frame = parseSecField(fadeOutStr, bgm.fadeOutFrames, fps);
    if (frame === null) { setFadeOutStr(frameToSec(bgm.fadeOutFrames, fps).toFixed(2)); return; }
    onEdit(setBgmFadeOut(state, bgm.id, frame));
  }

  return (
    <>
      {!bgmInstalled && (
        <div className="ins-section">
          <div className="ins-label"><span>BGM 機能</span></div>
          <div className="ins-pack-cta">
            <p>BGM の編集データを準備するには「BGM 機能を導入」を押してください。</p>
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
        </div>
      )}

      <div className="ins-section">
        <div className="ins-label"><span>BGM #{bgm.id}</span></div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
          {timing?.label ?? `${formatClock(frameToSec(bgm.originalStart, fps))} — ${formatClock(frameToSec(bgm.originalEnd, fps))}`}
        </div>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>BGM ファイル</span></div>
        <select
          className="hl-input"
          value={bgm.file}
          onChange={(e) => onEdit(setBgmFile(state, bgm.id, e.target.value))}
        >
          {fileOptions.map((f) => (<option key={f} value={f}>{f}</option>))}
        </select>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>音量 {Math.round(bgm.volume * 100)}%</span></div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={bgm.volume}
          onChange={(e) => onEdit(setBgmVolume(state, bgm.id, Number(e.target.value)))}
        />
        <div className="ins-volume-presets">
          {VOLUME_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="ins-volume-preset"
              onClick={() => onEdit(setBgmVolume(state, bgm.id, p.value))}
            >
              {p.label}
            </button>
          ))}
        </div>
        {waveformUrl && (
          <button
            type="button"
            className={'tx-mini-btn' + (audition.playingPath === waveformUrl ? ' playing' : '')}
            style={{ marginTop: 8 }}
            onClick={() => audition.toggle(waveformUrl, bgm.volume)}
          >
            {audition.playingPath === waveformUrl ? '停止' : '試聴'}
          </button>
        )}
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>フェード（秒）</span></div>
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-bgm-fade-in">フェードイン</label>
            <input
              id="ins-bgm-fade-in"
              type="number"
              step={0.1}
              min={0}
              value={fadeInStr}
              onChange={(e) => setFadeInStr(e.target.value)}
              onBlur={() => commitFadeIn()}
              onKeyDown={(e) => { if (e.key === 'Enter') commitFadeIn(); }}
            />
          </div>
          <div className="num-field">
            <label htmlFor="ins-bgm-fade-out">フェードアウト</label>
            <input
              id="ins-bgm-fade-out"
              type="number"
              step={0.1}
              min={0}
              value={fadeOutStr}
              onChange={(e) => setFadeOutStr(e.target.value)}
              onBlur={() => commitFadeOut()}
              onKeyDown={(e) => { if (e.key === 'Enter') commitFadeOut(); }}
            />
          </div>
        </div>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>波形（表示のみ）</span></div>
        <Waveform
          samples={waveformSamples}
          width={240}
          height={48}
        />
        {waveformFailed && (
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 0' }}>
            波形なし（音声なし／取得失敗）
          </p>
        )}
      </div>

<AssetTimingSection>
        <div className="ins-label"><span>表示する時間（秒）</span></div>
        {!editable && (
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 6px' }}>
            この BGM はカット区間内にあります。ここでは編集できません。
            このまま保存するとカット端へ寄せて出力されます（位置は復元できません）。
          </p>
        )}
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-bgm-start">開始</label>
            <input
              id="ins-bgm-start"
              type="number"
              step={0.1}
              value={startStr}
              disabled={!editable}
              onChange={(e) => setStartStr(e.target.value)}
              onBlur={() => editable && commitStart()}
              onKeyDown={(e) => { if (e.key === 'Enter' && editable) commitStart(); }}
            />
          </div>
          <div className="num-field">
            <label htmlFor="ins-bgm-end">終了</label>
            <input
              id="ins-bgm-end"
              type="number"
              step={0.1}
              value={endStr}
              disabled={!editable}
              onChange={(e) => setEndStr(e.target.value)}
              onBlur={() => editable && commitEnd()}
              onKeyDown={(e) => { if (e.key === 'Enter' && editable) commitEnd(); }}
            />
          </div>
        </div>
      </AssetTimingSection>

      <div className="ins-section">
        <button className="tx-mini-btn ins-bgm-remove" onClick={() => onEdit(removeBgm(state, bgm.id))}>
          この BGM を削除
        </button>
      </div>
    </>
  );
}
