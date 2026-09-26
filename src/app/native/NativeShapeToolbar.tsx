import type {ShapeKind} from '../../core/types';

/** OSS `src/app/preview/ShapeToolbar.tsx:4-9` の 4 種に三角・分度器を足した並び。 */
export const SHAPE_TOOLS:ReadonlyArray<{kind:ShapeKind;label:string;d:string}>=[
  {kind:'arrow',label:'矢印',d:'M4 20L20 4M20 4h-7M20 4v7'},
  {kind:'line',label:'直線',d:'M4 20L20 4'},
  {kind:'rect',label:'四角',d:'M4 6h16v12H4z'},
  // T18/T19 Minor: ツールバーと「形」の選択肢で名前が割れていた（丸／楕円）。
  // プロパティ側の「楕円」に揃える（native-inspector-input-audit.ts が option の
  // 文字キー「楕」で選ぶため、そちらの名前が実質の正になっている）。
  {kind:'ellipse',label:'楕円',d:'M12 4a8 6 0 1 0 0 12 8 6 0 0 0 0-12z'},
  {kind:'triangle',label:'三角',d:'M12 5L20 19H4z'},
  {kind:'angle',label:'分度器',d:'M5 19h14M5 19L15 6M5 19a7 7 0 0 0 3-5'},
];

interface Props {active:ShapeKind|null;disabled:boolean;onPick(kind:ShapeKind|null):void;onPlaceDefault():void}

/** プレビュー左肩の描画ツール。種類を選ぶと描画モードに入り、同じ種類をもう一度押すと解除する。 */
export function NativeShapeToolbar({active,disabled,onPick,onPlaceDefault}:Props){
  return <div className="native-shape-toolbar" role="group" aria-label="図形を描く">
    <span className="native-shape-toolbar-label" aria-hidden="true">図形</span>
    {SHAPE_TOOLS.map(tool=><button key={tool.kind} type="button" className="native-toggle native-shape-tool" data-kind={tool.kind}
      title={`${tool.label}を描く（もう一度押すと解除）`} aria-label={tool.label} aria-pressed={active===tool.kind} disabled={disabled}
      onClick={()=>onPick(active===tool.kind?null:tool.kind)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tool.d}/></svg>
    </button>)}
    {active!==null&&<button type="button" className="btn-ghost native-shape-default" disabled={disabled} onClick={onPlaceDefault}>既定サイズで置く</button>}
  </div>;
}
