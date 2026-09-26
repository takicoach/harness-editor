import {
  Component,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { TelopComponent } from '../../preview/loadTelopComponent';
import { acquireNativeTelop, cachedNativeTelop, type NativeTelopRevision } from '../../preview/nativeTelopCache';
import { NativeTelopSwatch } from './NativeTelopSwatch';
import { TELOP_PACK } from '../../server/telopPack/manifest';

// サンプル文字変更で全スタイルを同時再描画するカクつきを抑えるデバウンス。
const DEBOUNCE_MS = 250;

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

/** 1スタイルの描画失敗を名前表示へ戻す境界。 */
class CellBoundary extends Component<{ fallback: ReactNode; children: ReactNode; component: TelopComponent }, { failed: boolean; component: TelopComponent }> {
  state = { failed: false, component: this.props.component };
  static getDerivedStateFromProps(props: { component: TelopComponent }, state: { component: TelopComponent }) {
    return props.component === state.component ? null : { failed: false, component: props.component };
  }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface SwatchCellProps {
  telopComponent?: TelopComponent;
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
        {inView && telopComponent ? (
          <CellBoundary fallback={placeholder} component={telopComponent}>
            <span className="swatch-fit">
              <NativeTelopSwatch Telop={telopComponent} text={sampleText} template={templateId} width={width} height={height} fps={fps} />
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
  projectId: string;
  /** Stable across ordinary edits, replaced after successful project reload. */
  componentRevision: NativeTelopRevision;
  previewWidth: number;
  previewHeight: number;
  fps: number;
  /** 既に swatchSampleText 適用済みの表示文字列。 */
  sampleText: string;
  /** resolveTemplate 済みの現在のテンプレ番号（1..30）。 */
  currentTemplate: number;
  onSelect: (id: number) => void;
}

export function TelopStyleGrid({
  projectId,
  componentRevision,
  previewWidth,
  previewHeight,
  fps,
  sampleText,
  currentTemplate,
  onSelect,
}: TelopStyleGridProps) {
  const [loaded, setLoaded] = useState<{ projectId: string; source: NativeTelopRevision; component?: TelopComponent; error?: string }>();
  useEffect(() => {
    const lease = acquireNativeTelop(projectId, componentRevision);
    let live = true;
    void lease.promise.then(component => {
      if (live) setLoaded({ projectId, source: componentRevision, component });
    }, error => {
      if (live) setLoaded({ projectId, source: componentRevision, error: error instanceof Error ? error.message : 'スタイルの見本を読み込めませんでした' });
    });
    return () => { live = false; lease.release(); };
  }, [projectId, componentRevision]);
  const current = loaded?.projectId === projectId && loaded.source === componentRevision ? loaded : undefined;
  const component = cachedNativeTelop(projectId, componentRevision) ?? current?.component;
  const debouncedText = useDebouncedValue(sampleText, DEBOUNCE_MS);
  // onSelect の同一性が毎描画で変わっても SwatchCell の memo を効かせるため ref 経由で安定化。
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const stableSelect = useCallback((id: number) => onSelectRef.current(id), []);
  return (
    <>
    {current?.error && <p role="alert">スタイルの見本を表示できません。名前から選択できます。{current.error}</p>}
    <div className="ins-style-grid">
      {TELOP_PACK.map((e) => (
        <SwatchCell
          key={e.id}
          telopComponent={component}
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
    </>
  );
}
