import type { EditState } from '../../edit/editState';
import {
  setSceneTransition,
  clearSceneTransition,
  setSceneTransitionDuration,
  setSceneTransitionColor,
  setSceneTransitionDirection,
  applyTransitionToAllJoins,
} from '../../edit/transitionOps';
import { SCENE_COLORS, sceneDurationDefault } from '../../../core/transitionStyle';
import { isOverlapKind } from '../../../core/transitionEngine';
import type { SlideDirection } from '../../../core/types';
import type { Join } from '../../../core/joinEngine';
import type { InstallKind, InstallErrors } from '../../install';
import { InstallCtaButton } from './shared';

/** シーン転換の種別選択肢（つなぎ目用・全7種）。 */
const SCENE_KINDS_JOIN: { value: 'none' | 'fadeBlack' | 'fadeWhite' | 'fadeColor' | 'crossfade' | 'slide' | 'wipe'; label: string }[] = [
  { value: 'none', label: 'なし' },
  { value: 'fadeBlack', label: 'フェード（暗転）' },
  { value: 'fadeWhite', label: 'フェード（白転）' },
  { value: 'fadeColor', label: 'フェード（色指定）' },
  { value: 'crossfade', label: 'クロスフェード（重なり）' },
  { value: 'slide', label: 'スライド（重なり）' },
  { value: 'wipe', label: 'ワイプ（重なり）' },
];

/** シーン転換の種別選択肢（頭尾用・fade 3 種のみ）。 */
const SCENE_KINDS_EDGE: { value: 'none' | 'fadeBlack' | 'fadeWhite' | 'fadeColor'; label: string }[] = [
  { value: 'none', label: 'なし' },
  { value: 'fadeBlack', label: 'フェード（暗転）' },
  { value: 'fadeWhite', label: 'フェード（白転）' },
  { value: 'fadeColor', label: 'フェード（色指定）' },
];

/** スライド/ワイプの方向選択肢。 */
const SLIDE_DIRECTIONS: { value: SlideDirection; label: string }[] = [
  { value: 'left', label: '左から右へ（→）' },
  { value: 'right', label: '右から左へ（←）' },
  { value: 'up', label: '下から上へ（↑）' },
  { value: 'down', label: '上から下へ（↓）' },
];

interface JoinSettingsProps {
  at: 'head' | 'tail' | number;
  fps: number;
  sceneTransitions: import('../../../core/types').SceneTransition[];
  joins: Join[];
  state: EditState;
  onEdit: (next: EditState) => void;
  transitionInstalled: boolean;
  onInstall: (kind: InstallKind) => void;
  installing: InstallKind | null;
  installErrors: InstallErrors;
  /** 未保存の編集があるか（導入は再読込を伴うため未保存中は無効化する）。 */
  dirty: boolean;
}

/**
 * つなぎ目（または動画頭尾）のシーン転換設定 UI。
 * 効果プルダウン・方向セレクタ・長さスライダー・色スウォッチ・一括適用・導入 CTA を含む。
 * 頭尾（at==='head'|'tail'）はフェード 3 種のみ、つなぎ目（number）は全7種。
 */
export function JoinSettings({ at, fps, sceneTransitions, joins, state, onEdit, transitionInstalled, onInstall, installing, installErrors, dirty }: JoinSettingsProps) {
  const current = sceneTransitions.find((t) => t.at === at);
  const kind = current?.kind ?? 'none';
  const frames = current?.durationFrames ?? 15;
  const direction = current?.direction ?? 'left';
  const isEdge = at === 'head' || at === 'tail';
  const kindOptions = isEdge ? SCENE_KINDS_EDGE : SCENE_KINDS_JOIN;
  const showDirection = kind === 'slide' || kind === 'wipe';
  const showOverlapWarning = kind !== 'none' && isOverlapKind(kind);

  return (
    <div className="ins-pane" data-subpanel="join">
      <div className="ins-section">
        <div className="ins-label">
          <span>{isEdge ? (at === 'head' ? '動画の最初' : '動画の最後') : 'つなぎ目'}のシーン転換</span>
        </div>
        <select
          id="ins-scene-kind"
          className="hl-input"
          value={kind}
          onChange={(e) => {
            const v = e.target.value as typeof kindOptions[number]['value'];
            if (v === 'none') {
              onEdit(clearSceneTransition(state, at));
            } else {
              const defaultDur = isOverlapKind(v) ? sceneDurationDefault(fps) : frames;
              onEdit(setSceneTransition(state, at, v, { durationFrames: defaultDur }));
            }
          }}
        >
          {kindOptions.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </div>
      {showOverlapWarning && (
        <div className="ins-section">
          <p className="ins-note" style={{ color: 'var(--warn-fg)', fontSize: '0.8em' }}>
            重なりで尺が縮みます（字幕・効果音が追従します）
          </p>
        </div>
      )}
      {showDirection && (
        <div className="ins-section">
          <div className="ins-label"><span>方向</span></div>
          <select
            id="ins-scene-direction"
            className="hl-input"
            value={direction}
            onChange={(e) => onEdit(setSceneTransitionDirection(state, at, e.target.value as SlideDirection))}
          >
            {SLIDE_DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
      )}
      {kind !== 'none' && (
        <div className="ins-section">
          <div className="ins-label"><span>長さ {frames}fr</span></div>
          <input
            id="ins-scene-duration"
            type="range"
            min={2}
            max={60}
            step={1}
            value={frames}
            onChange={(e) => onEdit(setSceneTransitionDuration(state, at, Number(e.target.value)))}
          />
        </div>
      )}
      {kind === 'fadeColor' && (
        <div className="ins-section">
          <div className="ins-label"><span>色</span></div>
          <div className="swatch-row">
            {SCENE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={'swatch' + (current?.color === c ? ' active' : '')}
                style={{ background: c }}
                onClick={() => onEdit(setSceneTransitionColor(state, at, c))}
              />
            ))}
          </div>
        </div>
      )}
      {!isEdge && (
        <div className="ins-section">
          <button
            type="button"
            className="hl-btn"
            onClick={() => onEdit(applyTransitionToAllJoins(
              state,
              joins.map((j) => ({ atOriginal: j.atOriginal })),
              kind === 'none' ? 'fadeBlack' : kind,
              { durationFrames: frames, ...(showDirection ? { direction } : {}) },
            ))}
          >
            全カットに一括適用
          </button>
        </div>
      )}
      {!transitionInstalled && (
        <div className="ins-section">
          <InstallCtaButton
            kind="transition"
            label="シーン転換を導入（書き出しに反映）"
            className="ins-install-cta"
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            onInstall={onInstall}
          />
        </div>
      )}
    </div>
  );
}
