import {DEFAULT_TEXT_APPEARANCE} from '../../core/sequence/model';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureFrameProvider } from '../../captureRuntime';
import { CaptureTelopLayer } from '../../capturePage/layers';
import { NativeText } from '../../preview/native/NativeText';
import type { SequenceAsset, SequenceClip, SequenceDocument } from '../../core/sequence/model';
import { activeTextAppearance, textComponentId, type TextContent } from '../../core/sequence/textStyle';
import { timeNumber } from '../../core/sequence/time';
import { NEW_TELOP_ANIMATION_IDS, TELOP_ANIMATION_IDS, TELOP_ANIMATION_LABELS, type TelopAnimationId } from '../../core/telopAnimation';
import type { TelopSegment } from '../../core/types';
import { CURRENT_BUILTIN_TELOP_PACK_VERSION, FREE_TEXT_ANIMATION_NOTICE, STALE_PACK_ANIMATION_NOTICE,
  supportsAnimation, textAnimationSupport, UNSUPPORTED_ANIMATION_REASON } from './telopAnimationSupport';
import { useTelopLoader, type TelopComponent } from './NativeTextStylePicker';
import { animationSampleMargin, fitTextBoxToStage, measureTextBox, type SampleFit } from './nativeSampleFit';
import { sampleLoopFrame, sampleLoopFrames, subscribeSampleLoop } from './animationSampleLoop';

export interface AnimationListProps {
  projectId: string;
  document: SequenceDocument;
  content: TextContent;
  clip: SequenceClip;
  assets: SequenceAsset[];
  disabled: boolean;
  onChoose(id: TelopAnimationId): Promise<boolean>;
  /** I-2 が中身を入れる。渡されないうちはボタンを出さない（押せない導線を置かない）。 */
  onEnableNewAnimations?(): void;
}

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 見本 1 枚。**画面に見えている間はカタログのようにループ再生し続ける**（押して初めて動く
 * ボタンは撤去した）。CSS keyframes は使わず、モジュール共通の 1 本の rAF ティッカー
 * （animationSampleLoop.ts）からフレームを受け取る。見えていないカードは購読しない。
 */
// 舞台全体を縮小すると 64px の文字が数 px の滲みにしか見えない（灰色に見えていた原因）。
// スタイル一覧の見本（NativeTextStylePicker の StyleCell）と同じ方式で、実際に描画された
// 文字の位置を測ってカードいっぱいに拡大する。測定は「静止フレーム」でだけ行い、
// ループ中（frame が動く間）は測り直さない — 動いている文字を測ると切り出し範囲が暴れる。
function AnimationSample({ id, segment, fps, resolution, Telop, appearance, phaseMs }: {
  id: TelopAnimationId; segment: TelopSegment; fps: number;
  resolution: { width: number; height: number }; Telop?: TelopComponent;
  appearance: ReturnType<typeof activeTextAppearance>; phaseMs: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const drawing = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [fit, setFit] = useState<SampleFit>({ scale: 220 / resolution.width, x: 0, y: 0 });
  // 「静止した見本」（見えていない／動きを控える設定のとき）は退場フェードの手前で止める。
  // segment.endFrame - 1 は退場アニメの真っ最中（NativeText の exit フェード窓＝最終 fps*0.2
  // フレーム、新 8 種も同じ幅の telopExitOpacity）で、実測すると opacity が 1/6 まで落ちる。
  // 登場・退場どちらのフェード窓にも入らない中間フレームで止める。
  const still = Math.max(segment.startFrame, Math.min(segment.endFrame - 1,
    Math.round((segment.startFrame + segment.endFrame) / 2)));
  const [frame, setFrame] = useState(still);
  const [onScreen, setOnScreen] = useState(false);
  // 描画に効く入力だけを深く比較する（毎レンダー新しいオブジェクトが渡ってくるため）。
  const segmentKey = useMemo(() => JSON.stringify(segment), [segment]);
  // frame ごとに新しいオブジェクトを作ると CaptureFrameProvider の useMemo が毎回外れる。
  // 解像度・fps・尺が変わったときだけ作り直す。
  const videoConfig = useMemo(() => ({ ...resolution, fps, durationInFrames: segment.endFrame }),
    [resolution.width, resolution.height, fps, segment.endFrame]);

  useEffect(() => {
    const element = host.current; if (!element) return;
    setShadow(element.shadowRoot ?? element.attachShadow({ mode: 'open' }));
    // 舞台は width:100% + aspect-ratio なので、ウィンドウ幅やインスペクタ幅が変わると寸法が変わる。
    // StyleCell と同じく ResizeObserver で見張り、寸法が変わったら切り出しを測り直す。
    // jsdom（NativeInspector 系のテスト環境）には実装が無いことがあるため、無ければ監視しない。
    if (typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      setSize({ width, height });
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);

  // 見えているカードだけを動かす。IntersectionObserver が無い環境（jsdom の既定）は
  // 「見えている」とみなさず静止させる — 測れないものを動いていることにしない。
  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const watcher = new IntersectionObserver(entries => {
      setOnScreen(entries.some(entry => entry.isIntersecting));
    });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, []);

  const frames = segment.endFrame - segment.startFrame;
  useEffect(() => {
    if (!onScreen || reducedMotion()) { setFrame(still); return; }
    let origin: number | null = null;
    return subscribeSampleLoop(now => {
      if (origin === null) origin = now;
      const next = segment.startFrame + sampleLoopFrame(now - origin + phaseMs, fps, frames);
      // 同じフレームなら状態を変えない（17 枚が同時に回るので、無駄な再描画を出さない）。
      setFrame(current => (current === next ? current : next));
    });
  }, [onScreen, fps, frames, phaseMs, segment.startFrame, still]);

  useLayoutEffect(() => {
    const stage = host.current, container = drawing.current;
    if (!stage || !container || !shadow) return;
    const measure = () => {
      const stageSize = stage.getBoundingClientRect();
      if (!stageSize.width || !stageSize.height) return;
      const box = measureTextBox(container, resolution.width);
      // 測れないうちは舞台全体が収まる縮小に留める（クラッシュより「小さいが読める向き」で待つ）。
      setFit(box ? fitTextBoxToStage(box, stageSize, animationSampleMargin(id, box))
        : { scale: stageSize.width / resolution.width, x: 0, y: 0 });
    };
    measure();
    // jsdom（テスト環境）には document.fonts が無い。
    if (!window.document.fonts) return;
    window.document.fonts.addEventListener('loadingdone', measure);
    return () => window.document.fonts.removeEventListener('loadingdone', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frame は意図的に除外（再生中は測り直さない）
  }, [shadow, Telop, appearance, segmentKey, resolution.width, resolution.height, size.width, size.height, id]);

  const body = Telop
    ? <CaptureTelopLayer Telop={Telop} telops={[segment]} />
    : appearance ? <NativeText segment={segment} appearance={appearance} /> : null;
  return <div ref={host} className="native-animation-stage" aria-hidden="true"
    data-testid={`animation-sample-${id}`} data-sample-segment={segmentKey}
    data-native-sample-frame={frame}>
    {shadow && createPortal(
      <>
        <style>{':host{font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#000;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}*{box-sizing:border-box}'}</style>
        <div ref={drawing} style={{ position: 'absolute', width: resolution.width, height: resolution.height,
          transform: `translate(${fit.x}px,${fit.y}px) scale(${fit.scale})`, transformOrigin: 'top left', pointerEvents: 'none' }}>
          <CaptureFrameProvider frame={frame} videoConfig={videoConfig}>
            {body}
          </CaptureFrameProvider>
        </div>
      </>, shadow)}
  </div>;
}

export function NativeAnimationList(props: AnimationListProps) {
  const loader = useTelopLoader(props.projectId);
  const [Telop, setTelop] = useState<TelopComponent>();
  const appearance = activeTextAppearance(props.content);
  const assetId = appearance ? undefined : textComponentId(props.document, props.content);
  const asset = props.assets.find(item => item.id === assetId);
  const support = textAnimationSupport(props.document, props.content);
  const fps = Math.max(1, Math.round(timeNumber(props.document.fps)));
  const current = (props.content.data.animation ?? 'none') as TelopAnimationId;

  useEffect(() => {
    if (!asset) { setTelop(undefined); return; }
    let live = true;
    void loader.load(asset).then(value => { if (live) setTelop(() => value); }, () => { if (live) setTelop(undefined); });
    return () => { live = false; };
  }, [asset?.id, asset?.fingerprint, loader]);

  // 見本の尺は字幕の実尺ではなく固定 2.5 秒。実尺に合わせると 0.1 秒の字幕では入場も退場も
  // 見えないうちに終わる（利用者からの指摘。設計 I-1 の「尺だけ丸める」規定はこれで置き換え）。
  // 短尺での縮退は telopExitFrames が持つので、ここでは尺を決めるだけでよい。
  const sampleEnd = sampleLoopFrames(fps);
  const samples = useMemo(() => new Map(TELOP_ANIMATION_IDS.map(animation => [animation, {
    // 対象クリップの描画に効く入力をすべて保つ。id を落とすと fadeOnly の分岐が本番とずれる。
    id: props.content.legacyId ?? 1,
    text: props.content.data.text,
    template: props.content.data.template,
    style: props.content.data.style,
    position: props.content.data.position,
    scale: props.content.data.scale,
    startFrame: 0,
    endFrame: sampleEnd,
    animation,
  } as TelopSegment])),
  [props.content.legacyId, props.content.data.text, props.content.data.template, props.content.data.style,
    props.content.data.position, props.content.data.scale, sampleEnd]);

  return <section className="native-animation-list">
    <h3>アニメーション</h3>
    {appearance && <p className="native-animation-note-line">{FREE_TEXT_ANIMATION_NOTICE}</p>}
    {/* `'unknown'` も現行版ではないので、この条件で拾える（Task 9 の backfill が付ける値）。 */}
    {!appearance && asset?.textStyleCatalog?.source === 'builtin'
      && asset.textStyleCatalog.version !== CURRENT_BUILTIN_TELOP_PACK_VERSION &&
      <p className="native-animation-note-line" role="status">{STALE_PACK_ANIMATION_NOTICE}</p>}
    <div role="group" aria-label="アニメーション" className="native-animation-grid">
      {TELOP_ANIMATION_IDS.map((id, index) => {
        const label = TELOP_ANIMATION_LABELS[id], usable = supportsAnimation(support, id);
        return <div key={id} className="native-animation-item">
          <button type="button" className="native-animation-card" aria-pressed={current === id}
            disabled={props.disabled || (!usable && current !== id)}
            onClick={() => void props.onChoose(id)}>
            <span className="native-animation-name">{label.name}</span>
            <span className="native-animation-note">{label.description}</span>
          </button>
          {/* 位相をずらして並べる。全部が同時に入場すると一覧がちらついて読みにくい。 */}
          <AnimationSample id={id} segment={samples.get(id)!} fps={fps} resolution={props.document.resolution}
            Telop={appearance || !usable ? undefined : Telop} appearance={appearance ?? (!usable ? DEFAULT_TEXT_APPEARANCE : undefined)} phaseMs={index * 140} />
          {!usable && <p className="native-animation-note-line">標準書式での参考見本</p>}
          {!usable && <p className="native-animation-reason">{UNSUPPORTED_ANIMATION_REASON}</p>}
        </div>;
      })}
    </div>
    {NEW_TELOP_ANIMATION_IDS.some(id => !supportsAnimation(support, id)) && props.onEnableNewAnimations &&
      <button type="button" className="native-text-button" disabled={props.disabled}
        onClick={props.onEnableNewAnimations}>この案件の字幕で新しい動きを使えるようにする</button>}
  </section>;
}
