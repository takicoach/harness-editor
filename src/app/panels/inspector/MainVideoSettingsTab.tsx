import type { EditState } from '../../edit/editState';
import { DEFAULT_MAIN_LAYOUT } from '../../../core/mainLayout';
import { setMainSpeed, setMainVideoScale, setMainVideoPosition, setMainVideoBackground, setMainVideoRotation, setMainVideoFlipH, setMainVideoFlipV, resetMainLayout } from '../../edit/mainVideoOps';
import { punchKeyframe, removeKeyframe, setKeyframeField, clearKeyframes } from '../../edit/layoutKeyframeOps';
import type { LayoutKeyframe } from '../../../core/layoutKeyframes';
import type { InstallKind, InstallErrors } from '../../install';
import { NumberField, InstallCtaButton, sliderToRate, rateToSlider } from './shared';

type Kept = { id: number; originalStart: number; playbackStart: number; playbackEnd: number };

/** メイン動画（全体）の速度・レイアウト・大域キーフレーム設定タブ。state.selection.kind === 'mainVideo' のときに表示。 */
export function MainVideoSettingsTab({
  state,
  onEdit,
  installing,
  installErrors,
  dirty,
  onInstall,
  getPlaybackFrame = () => 0,
  keptSegments = [],
  fps = 30,
}: {
  state: EditState;
  onEdit: (next: EditState) => void;
  installing: InstallKind | null;
  installErrors: InstallErrors;
  dirty: boolean;
  onInstall: (kind: InstallKind) => void;
  /** クリック時点の再生ヘッド位置（再生フレーム）を返す。キーフレームを打つ基点。
   *  値ではなく getter で受けることで、スクラブ/再生でヘッドが動いた後でも常に最新位置を掴む。 */
  getPlaybackFrame?: () => number;
  /** 残す区間（原本フレーム→再生フレームの写像用）。 */
  keptSegments?: Kept[];
  /** プロジェクトの fps（プリセットの既定長・秒表示に使用）。 */
  fps?: number;
}) {
  const rate = state.mainSpeed;
  const rateLabel = Number.isInteger(rate) ? `${rate}x` : `${rate.toFixed(2)}x`;
  const layout = state.mainLayout ?? DEFAULT_MAIN_LAYOUT;
  return (
    <div className="ins-pane" data-mainvideo>
      <h3 className="ins-title">メイン動画（全体）</h3>
      <div className="ins-section">
        <div className="ins-label">
          <span>再生速度 </span>
          <span className="ins-vi-speed-value">{rateLabel}</span>
        </div>
        <input
          id="ins-main-speed"
          type="range"
          min={0}
          max={1000}
          step={1}
          value={rateToSlider(rate)}
          onChange={(e) => onEdit(setMainSpeed(state, sliderToRate(Number(e.target.value))))}
        />
        <div className="ins-vi-speed-presets">
          {[0.25, 0.5, 1, 2, 4, 8, 16].map((p) => (
            <button
              key={p}
              type="button"
              className="tx-mini-btn ins-vi-speed-preset"
              data-rate={p}
              onClick={() => onEdit(setMainSpeed(state, p))}
            >
              {`${p}x`}
            </button>
          ))}
        </div>
        {rate <= 0.5 && (
          <p className="ins-vi-speed-warn" style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 0' }}>
            元動画の fps によってはカクつくことがあります。
          </p>
        )}
        <p className="ins-hint">速度を変えると完成尺（書き出しの長さ）も変わります。</p>
      </div>
      <div className="ins-section" data-mainlayout>
        <h3 className="ins-title">レイアウト（位置・大きさ）</h3>
        <div className="ins-label">
          <span>大きさ </span>
          <NumberField id="ins-main-scale-num" className="ins-ml-scale-value" value={layout.scale} min={0.1} max={5} step={0.01} decimals={2} suffix="x" onCommit={(n) => onEdit(setMainVideoScale(state, n))} />
        </div>
        <input
          id="ins-main-scale"
          type="range"
          min={0.1}
          max={5}
          step={0.05}
          value={layout.scale}
          onChange={(e) => onEdit(setMainVideoScale(state, Number(e.target.value)))}
        />
        <div className="ins-label">
          <span>左右 </span>
          <NumberField id="ins-main-pos-x-num" className="ins-ml-posx-value" value={layout.position.x} min={-1} max={1} step={0.01} decimals={2} onCommit={(n) => onEdit(setMainVideoPosition(state, n, layout.position.y))} />
        </div>
        <input
          id="ins-main-pos-x"
          type="range"
          min={-1}
          max={1}
          step={0.02}
          value={layout.position.x}
          onChange={(e) => onEdit(setMainVideoPosition(state, Number(e.target.value), layout.position.y))}
        />
        <div className="ins-label">
          <span>上下 </span>
          <NumberField id="ins-main-pos-y-num" className="ins-ml-posy-value" value={layout.position.y} min={-1} max={1} step={0.01} decimals={2} onCommit={(n) => onEdit(setMainVideoPosition(state, layout.position.x, n))} />
        </div>
        <input
          id="ins-main-pos-y"
          type="range"
          min={-1}
          max={1}
          step={0.02}
          value={layout.position.y}
          onChange={(e) => onEdit(setMainVideoPosition(state, layout.position.x, Number(e.target.value)))}
        />
        <div className="ins-label"><span>背景色（縮小時に見える部分）</span></div>
        <input
          id="ins-main-bg"
          type="color"
          value={layout.background}
          onChange={(e) => onEdit(setMainVideoBackground(state, e.target.value))}
        />
        <div className="ins-label">
          <span>回転 </span>
          <NumberField id="ins-main-rotation-num" className="ins-ml-rotation-value" value={layout.rotation ?? 0} min={-180} max={180} step={1} decimals={0} suffix="°" onCommit={(n) => onEdit(setMainVideoRotation(state, n))} />
        </div>
        <input
          id="ins-main-rotation"
          type="range"
          min={-180}
          max={180}
          step={1}
          value={layout.rotation ?? 0}
          onChange={(e) => onEdit(setMainVideoRotation(state, Number(e.target.value)))}
        />
        <div className="ins-vi-speed-presets">
          {[-90, 90, 180].map((d) => (
            <button
              key={d}
              type="button"
              className="tx-mini-btn"
              data-rotate={d}
              onClick={() => onEdit(setMainVideoRotation(state, d))}
            >
              {`${d > 0 ? '+' : ''}${d}°`}
            </button>
          ))}
        </div>
        <div className="ins-label"><span>反転</span></div>
        <div className="ins-vi-speed-presets">
          <button
            type="button"
            id="ins-main-fliph"
            className="tx-mini-btn"
            aria-pressed={!!layout.flipH}
            onClick={() => onEdit(setMainVideoFlipH(state, !layout.flipH))}
          >
            左右反転{layout.flipH ? '(ON)' : ''}
          </button>
          <button
            type="button"
            id="ins-main-flipv"
            className="tx-mini-btn"
            aria-pressed={!!layout.flipV}
            onClick={() => onEdit(setMainVideoFlipV(state, !layout.flipV))}
          >
            上下反転{layout.flipV ? '(ON)' : ''}
          </button>
        </div>
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            id="ins-main-layout-reset"
            className="tx-mini-btn"
            onClick={() => onEdit(resetMainLayout(state))}
          >
            全画面に戻す
          </button>
        </div>
        <p className="ins-hint">プレビュー上で動画を直接ドラッグ／角ハンドルで拡大縮小もできます。</p>
        <div className="ins-pack-cta" style={{ marginTop: 8 }}>
          <p>最終書き出し（remotion render）にレイアウトを反映するには「導入」が必要です。</p>
          <InstallCtaButton
            kind="mainLayout"
            label="レイアウトを書き出しに導入"
            id="ins-mainlayout-install"
            className="ins-speed-install"
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            onInstall={onInstall}
          />
          <p className="ins-pack-hint">導入後はレイアウトを変えても再導入は不要です（保存で反映）</p>
        </div>
      </div>
      <div className="ins-section" data-mainkeyframes>
        <h3 className="ins-title">アニメーション（キーフレーム）</h3>
        <button
          type="button"
          id="ins-kf-punch"
          className="tx-mini-btn"
          onClick={() => onEdit(punchKeyframe(state, getPlaybackFrame(), keptSegments))}
        >
          ◆ 現在位置にキーフレームを打つ
        </button>
        <p className="ins-hint">
          キーフレームは最初の◆〜最後の◆の間だけ効きます（範囲外は通常の見た目のまま）。
          パン・ズームのかんたん適用は、カット区間を選んで「アニメ（開始→終了）」からどうぞ。
        </p>
        {state.layoutKeyframes.length > 0 && (
          <div className="ins-kf-list" data-testid="ins-main-keyframes">
            {state.layoutKeyframes.map((kf: LayoutKeyframe, i: number) => (
              <div className="ins-kf-point" data-kf-index={i} key={i}>
                <div className="ins-kf-point-title">{(kf.originalFrame / fps).toFixed(2)}s</div>
                <div className="ins-kf-fields">
                  <div className="ins-label"><span>左右 </span>
                    <NumberField id={`ins-kf${i}-x`} value={kf.x} min={-1} max={1} step={0.01} decimals={2} onCommit={(n) => onEdit(setKeyframeField(state, i, 'x', n))} />
                  </div>
                  <div className="ins-label"><span>上下 </span>
                    <NumberField id={`ins-kf${i}-y`} value={kf.y} min={-1} max={1} step={0.01} decimals={2} onCommit={(n) => onEdit(setKeyframeField(state, i, 'y', n))} />
                  </div>
                  <div className="ins-label"><span>大きさ </span>
                    <NumberField id={`ins-kf${i}-scale`} value={kf.scale} min={0.1} max={8} step={0.01} decimals={2} suffix="x" onCommit={(n) => onEdit(setKeyframeField(state, i, 'scale', n))} />
                  </div>
                  <div className="ins-label"><span>回転 </span>
                    <NumberField id={`ins-kf${i}-rotation`} value={kf.rotation} min={-180} max={180} step={1} decimals={0} suffix="°" onCommit={(n) => onEdit(setKeyframeField(state, i, 'rotation', n))} />
                  </div>
                </div>
                <button
                  type="button"
                  className="tx-mini-btn"
                  data-kf-remove={i}
                  onClick={() => onEdit(removeKeyframe(state, i))}
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}
        {state.layoutKeyframes.length > 0 && (
          <button type="button" id="ins-kf-clear-all" className="tx-mini-btn" style={{ marginTop: 8 }} onClick={() => onEdit(clearKeyframes(state))}>
            全キーフレームを消す
          </button>
        )}
        <p className="ins-hint">2点以上でメイン動画がカット区間に関係なく滑らかにアニメします。プリセットは2点を自動で置きます。</p>
      </div>
      <div className="ins-section">
        <div className="ins-label"><span>書き出しへの導入</span></div>
        <div className="ins-pack-cta">
          <p>最終書き出し（remotion render）に速度を反映するには「導入」が必要です。</p>
          <InstallCtaButton
            kind="speed"
            label="メイン動画速度を書き出しに導入"
            id="ins-speed-install"
            className="ins-speed-install"
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            onInstall={onInstall}
          />
          <p className="ins-pack-hint">導入後は速度を変えても再導入は不要です（保存で反映）</p>
        </div>
      </div>
    </div>
  );
}
