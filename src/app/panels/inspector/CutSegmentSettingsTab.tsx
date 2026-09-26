import type { EditState } from '../../edit/editState';
import { DEFAULT_MAIN_LAYOUT } from '../../../core/mainLayout';
import { setSegmentSpeed, clearSegmentSpeed } from '../../edit/segmentSpeedOps';
import {
  setSegmentScale, setSegmentPosition, setSegmentRotation, setSegmentFlipH, setSegmentFlipV, clearSegmentLayout,
  setSegmentMotion,
} from '../../edit/segmentLayoutOps';
import { resolveSegmentLayout } from '../../../core/segmentLayout';
import { NumberField, sliderToRate, rateToSlider } from './shared';
import { MotionSettings } from './MotionSettings';
import { mainClipTrimBounds, trimMainClip } from '../../edit/mainClipOps';
import { FrameRangeFields } from '../FrameRangeFields';

/** カット区間（個別）の速度設定タブ。selection.kind === 'cutSegment' のとき表示。 */
export function CutSegmentSettingsTab({
  state,
  segmentId,
  fps = 30,
  onEdit,
}: {
  state: EditState;
  segmentId: number;
  fps?: number;
  onEdit: (next: EditState) => void;
}) {
  const override = state.segmentSpeeds[segmentId];
  const trim = mainClipTrimBounds(state, segmentId);
  const effective = override ?? state.mainSpeed;
  const label = override === undefined
    ? `全体に従う（${Number.isInteger(state.mainSpeed) ? `${state.mainSpeed}x` : `${state.mainSpeed.toFixed(2)}x`}）`
    : (Number.isInteger(override) ? `${override}x` : `${override.toFixed(2)}x`);
  return (
    <div className="ins-pane" data-cutsegment>
      {trim && <div className="ins-section">
        <h3 className="ins-title">カット範囲の微調整</h3>
        <p className="ins-hint">このクリップに使う原素材の範囲です。前後のカット済み部分も戻せます。</p>
        <FrameRangeFields key={segmentId} start={trim.clip.originalStart} end={trim.clip.originalEnd}
          fps={fps} min={trim.min} max={trim.max} onCommit={(start, end) => onEdit(trimMainClip(state, segmentId, start, end))} />
      </div>}
      <h3 className="ins-title">この区間の速度</h3>
      <div className="ins-section">
        <div className="ins-label">
          <span>再生速度 </span>
          <span className="ins-vi-speed-value">{label}</span>
        </div>
        <input
          id="ins-segment-speed"
          type="range"
          min={0}
          max={1000}
          step={1}
          value={rateToSlider(effective)}
          onChange={(e) => onEdit(setSegmentSpeed(state, segmentId, sliderToRate(Number(e.target.value))))}
        />
        <div className="ins-vi-speed-presets">
          {[0.25, 0.5, 1, 2, 4, 8, 16].map((p) => (
            <button
              key={p}
              type="button"
              className="tx-mini-btn ins-vi-speed-preset"
              data-rate={p}
              onClick={() => onEdit(setSegmentSpeed(state, segmentId, p))}
            >
              {`${p}x`}
            </button>
          ))}
        </div>
        {override !== undefined && (
          <button
            id="ins-segment-speed-reset"
            type="button"
            className="tx-mini-btn"
            onClick={() => onEdit(clearSegmentSpeed(state, segmentId))}
          >
            全体に従うへ戻す
          </button>
        )}
        <p className="ins-hint">この区間だけ速度を変えられます（全体速度より優先）。書き出しへの反映は「導入」が必要です。</p>
      </div>
      <div className="ins-section" data-segment-layout>
        <h3 className="ins-title">この区間のレイアウト</h3>
        {(() => {
          const base = state.mainLayout ?? DEFAULT_MAIN_LAYOUT;
          const hasOverride = segmentId in state.segmentLayouts;
          const eff = resolveSegmentLayout(base, state.segmentLayouts, segmentId);
          return (
            <>
              {!hasOverride && <p className="ins-hint">全体に従っています。値を変えるとこの区間だけ個別設定になります。</p>}
              <div className="ins-label"><span>大きさ </span><NumberField id="ins-seg-scale-num" className="ins-seg-scale-value" value={eff.scale} min={0.1} max={5} step={0.01} decimals={2} suffix="x" onCommit={(n) => onEdit(setSegmentScale(state, segmentId, n))} /></div>
              <input id="ins-seg-scale" type="range" min={0.1} max={5} step={0.05} value={eff.scale}
                onChange={(e) => onEdit(setSegmentScale(state, segmentId, Number(e.target.value)))} />
              <div className="ins-label"><span>左右 </span><NumberField id="ins-seg-pos-x-num" className="ins-seg-posx-value" value={eff.position.x} min={-1} max={1} step={0.01} decimals={2} onCommit={(n) => onEdit(setSegmentPosition(state, segmentId, n, eff.position.y))} /></div>
              <input id="ins-seg-pos-x" type="range" min={-1} max={1} step={0.02} value={eff.position.x}
                onChange={(e) => onEdit(setSegmentPosition(state, segmentId, Number(e.target.value), eff.position.y))} />
              <div className="ins-label"><span>上下 </span><NumberField id="ins-seg-pos-y-num" className="ins-seg-posy-value" value={eff.position.y} min={-1} max={1} step={0.01} decimals={2} onCommit={(n) => onEdit(setSegmentPosition(state, segmentId, eff.position.x, n))} /></div>
              <input id="ins-seg-pos-y" type="range" min={-1} max={1} step={0.02} value={eff.position.y}
                onChange={(e) => onEdit(setSegmentPosition(state, segmentId, eff.position.x, Number(e.target.value)))} />
              <div className="ins-label"><span>回転 </span><NumberField id="ins-seg-rotation-num" className="ins-seg-rotation-value" value={eff.rotation ?? 0} min={-180} max={180} step={1} decimals={0} suffix="°" onCommit={(n) => onEdit(setSegmentRotation(state, segmentId, n))} /></div>
              <input id="ins-seg-rotation" type="range" min={-180} max={180} step={1} value={eff.rotation ?? 0}
                onChange={(e) => onEdit(setSegmentRotation(state, segmentId, Number(e.target.value)))} />
              <div className="ins-vi-speed-presets">
                {[-90, 90, 180].map((d) => (
                  <button key={d} type="button" className="tx-mini-btn" data-rotate={d}
                    onClick={() => onEdit(setSegmentRotation(state, segmentId, d))}>{`${d > 0 ? '+' : ''}${d}°`}</button>
                ))}
              </div>
              <div className="ins-label"><span>反転</span></div>
              <div className="ins-vi-speed-presets">
                <button type="button" id="ins-seg-fliph" className="tx-mini-btn" aria-pressed={!!eff.flipH}
                  onClick={() => onEdit(setSegmentFlipH(state, segmentId, !eff.flipH))}>左右反転{eff.flipH ? '(ON)' : ''}</button>
                <button type="button" id="ins-seg-flipv" className="tx-mini-btn" aria-pressed={!!eff.flipV}
                  onClick={() => onEdit(setSegmentFlipV(state, segmentId, !eff.flipV))}>上下反転{eff.flipV ? '(ON)' : ''}</button>
              </div>
              <MotionSettings
                idPrefix="ins-seg"
                motion={state.segmentLayouts[segmentId]?.motion}
                withRotation
                withOpacity={false}
                withKeyframes={false}
                onChange={(m) => onEdit(setSegmentMotion(state, segmentId, m))}
              />
              {hasOverride && (
                <button id="ins-seg-layout-reset" type="button" className="tx-mini-btn" style={{ marginTop: 8 }}
                  onClick={() => onEdit(clearSegmentLayout(state, segmentId))}>全体に従うへ戻す</button>
              )}
              <p className="ins-hint">この区間だけ位置・大きさ・回転・反転・アニメを変えられます。書き出しに反映するには、メイン動画を選んで「レイアウトを書き出しに導入」を一度押してください（以後はカットや速度を変えても再導入は不要です）。</p>
            </>
          );
        })()}
      </div>
      {/* 自由な時点のキーフレームはメイン動画設定へ。旧位置を探す人向けの道しるべ。 */}
      <p className="ins-hint" data-testid="ins-seg-moved-hint">
        任意の時点にキーフレームを打つ自由アニメは、タイムライン左端の「動画」ラベルをクリック →「メイン動画設定」にあります。
        場面の切り替え（シーン転換）はタイムラインのつなぎ目にある ◇ マークをクリックすると設定できます。
      </p>
    </div>
  );
}
