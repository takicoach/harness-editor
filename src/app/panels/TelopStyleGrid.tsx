import {
  Component,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Thumbnail } from '@remotion/player';
import type { TelopComponent } from '../../preview/loadTelopComponent';
import { TELOP_PACK } from '../../server/telopPack/manifest';

// スウォッチ描画用の合成尺。中間フレームを描けばフェードイン/アウトを避けられる。
const SWATCH_DURATION = 60;
const SWATCH_FRAME = Math.floor(SWATCH_DURATION / 2);
// サンプル文字変更で30枚を同時再描画するカクつきを抑えるデバウンス。
const DEBOUNCE_MS = 250;

interface SwatchSegment {
  text: string;
  startFrame: number;
  endFrame: number;
  template: number;
}

interface SwatchProps extends Record<string, unknown> {
  telopComponent: TelopComponent;
  segment: SwatchSegment;
}

/** Thumbnail の component。inputProps を受けて本物アダプタを1スタイル描画する薄ラッパ。 */
const SwatchComposition: ComponentType<SwatchProps> = ({ telopComponent: Telop, segment }) => (
  <Telop segment={segment} />
);

/** 値が ms 変化しなくなってから反映するデバウンス。 */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** 一度でもビューポートに入ったら true を保持（アンマウントしない＝再描画コスト回避）。
 *  ref 型は構造的に受ける（React 型バージョン差で RefObject の null 許容が揺れるため）。 */
function useInView(ref: { current: Element | null }): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || inView) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: '120px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref, inView]);
  return inView;
}

/** 1スタイルの Thumbnail 描画失敗を握りつぶし、名前表示にフォールバックする境界。 */
class CellBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface SwatchCellProps {
  telopComponent: TelopComponent;
  templateId: number;
  name: string;
  sampleText: string;
  width: number;
  height: number;
  fps: number;
  active: boolean;
  onSelect: (id: number) => void;
}

const SwatchCell = memo(function SwatchCell({
  telopComponent,
  templateId,
  name,
  sampleText,
  width,
  height,
  fps,
  active,
  onSelect,
}: SwatchCellProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInView(ref);
  const segment: SwatchSegment = { text: sampleText, startFrame: 0, endFrame: SWATCH_DURATION, template: templateId };
  // 歪み防止：描画ボックスのアスペクトを実解像度に合わせる（CSS 変数で渡す）。
  const stageStyle = { ['--comp-aspect']: String(width / height) } as CSSProperties;
  const placeholder = <span className="ins-style-cell-ph">{name}</span>;
  return (
    <button
      ref={ref}
      type="button"
      className={'ins-style-cell' + (active ? ' active' : '')}
      onClick={() => onSelect(templateId)}
      title={name}
    >
      <span className="ins-style-cell-stage" style={stageStyle}>
        {inView ? (
          <CellBoundary fallback={placeholder}>
            <span className="swatch-fit">
              <Thumbnail
                component={SwatchComposition}
                inputProps={{ telopComponent, segment }}
                compositionWidth={width}
                compositionHeight={height}
                durationInFrames={SWATCH_DURATION}
                fps={fps}
                frameToDisplay={SWATCH_FRAME}
                style={{ width: '100%', height: '100%' }}
              />
            </span>
          </CellBoundary>
        ) : (
          placeholder
        )}
      </span>
      <span className="ins-style-cell-cap">{name}</span>
    </button>
  );
});

interface TelopStyleGridProps {
  /** プロジェクト導入済みの本物アダプタ。 */
  telopComponent: TelopComponent;
  previewWidth: number;
  previewHeight: number;
  fps: number;
  /** 既に swatchSampleText 適用済みの表示文字列。 */
  sampleText: string;
  /** resolveTemplate 済みの現在のテンプレ番号（1..TELOP_PACK.length）。 */
  currentTemplate: number;
  onSelect: (id: number) => void;
}

export function TelopStyleGrid({
  telopComponent,
  previewWidth,
  previewHeight,
  fps,
  sampleText,
  currentTemplate,
  onSelect,
}: TelopStyleGridProps) {
  const debouncedText = useDebouncedValue(sampleText, DEBOUNCE_MS);
  // onSelect の同一性が毎描画で変わっても SwatchCell の memo を効かせるため ref 経由で安定化。
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const stableSelect = useCallback((id: number) => onSelectRef.current(id), []);
  return (
    <div className="ins-style-grid">
      {TELOP_PACK.map((e) => (
        <SwatchCell
          key={e.id}
          telopComponent={telopComponent}
          templateId={e.id}
          name={e.name}
          sampleText={debouncedText}
          width={previewWidth}
          height={previewHeight}
          fps={fps}
          active={currentTemplate === e.id}
          onSelect={stableSelect}
        />
      ))}
    </div>
  );
}
