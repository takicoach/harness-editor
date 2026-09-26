import type { ClipVisual, SequenceClip } from '../../core/sequence/model';
import type { ElementAnim, ImageType, ShapeKind, ShapeThickness } from '../../core/types';
import type { Motion, MotionState } from '../../core/motion';
import { ColorField, NumberField,SelectField } from './NativeInspectorFields';
import type {ChangeContent,ChangeVisual} from './inspectorIntents';
import {visualPositionPolicy} from '../../core/sequence/visualPositionPolicy';
import {NativePositionField} from './NativePositionField';
import {NativePositionPresets} from './NativePositionPresets';
import {SHAPE_COLORS} from '../../core/shapeStyle';
import {angleDegrees} from '../../core/shapeGeometry';
import {shapeKindChange} from './shapeHandles';

const presets: [Motion['preset'], string][] = [['zoomIn','ズームイン'],['zoomOut','ズームアウト'],['panLeft','左へ移動'],['panRight','右へ移動'],['fadeIn','フェードイン'],['custom','開始と終了を指定'],['keyframes','途中の動きを指定']];
const animations: [ElementAnim['kind'], string][] = [['none','なし'],['fade','フェード'],['zoom','ズーム'],['pop','ポップ'],['slideIn','スライド']];
/**
 * その part に描く節があるか。`NativeVisualSettings` は要素としては常に truthy なので、
 * 呼び手（調整タブの群）が「中身が空なら見出しを出さない」を判断できるようにここへ出す（M-5）。
 * 条件は下の描画と同じ順で並べる。増やしたら NativeVisualSettings.test.tsx の一致検査が落ちる。
 */
export function visualSettingsHasContent(part:'look'|'place'|'motion'|'all',clip:SequenceClip):boolean {
  const kind=clip.content.kind;
  if(kind==='audio'||kind==='scene-fade')return false;
  const show=(p:'look'|'place'|'motion')=>part==='all'||part===p;
  if(show('look')&&(kind==='shape'||kind==='image'))return true;
  if(show('place')&&(kind==='telop'||kind==='title'||kind==='shape'))return true;
  return show('motion');
}

export function NativeVisualSettings({clip,visual,onContent,onVisual,resolution,part='all'}:{clip:SequenceClip;visual:ClipVisual;onContent:ChangeContent;onVisual:ChangeVisual;resolution:{width:number;height:number};
  /** F14: 調整タブの群ごとに必要な節だけを描く。既定（'all'）は全部（単体テスト・旧呼び出し）。 */
  part?:'look'|'place'|'motion'|'all'}) {
  const show=(p:'look'|'place'|'motion')=>part==='all'||part===p;
  const content=clip.content;
  const positionPolicy=visualPositionPolicy(clip);
  if(content.kind==='audio'||content.kind==='scene-fade')return null;
  // Legacy text motion uses the text's own anchor. Keep it there across edits and cuts.
  const motion=content.kind==='telop'?content.data.motion:visual.motion;
  const setMotion=(change:(current:Motion|undefined,anchor:Required<MotionState>)=>Motion|undefined)=>content.kind==='telop'
    ? onContent('telop',current=>{current.data.motion=change(current.data.motion,{x:current.data.position?.x??0,y:current.data.position?.y??0,scale:current.data.scale??1,opacity:1,rotation:0});})
    : onVisual(current=>{current.motion=change(current.motion,{x:current.layout.position.x,y:current.layout.position.y,scale:current.layout.scale,opacity:current.opacity,rotation:current.layout.rotation});});
  const editMotion=(change:(current:Motion)=>void)=>setMotion(current=>{if(!current||current.preset!==motion?.preset||current.keys?.length!==motion?.keys?.length)throw new Error('動きの設定が変わりました。');change(current);return current;});
  const base=content.kind==='telop'
    ? {x:content.data.position?.x??0,y:content.data.position?.y??0,scale:content.data.scale??1,opacity:1,rotation:0}
    : {x:visual.layout.position.x,y:visual.layout.position.y,scale:visual.layout.scale,opacity:visual.opacity,rotation:visual.layout.rotation};
  const stateFields=(state:MotionState,change:(axis:keyof MotionState,value:number)=>Promise<boolean>,prefix:string)=><>
    {(['x','y','scale','opacity','rotation'] as const).filter(axis=>content.kind!=='telop'||axis!=='rotation').map(axis=>{
      const label={x:'横位置（%）',y:'縦位置（%）',scale:'スケール（%）',opacity:'不透明度（%）',rotation:'回転（°）'}[axis],factor=axis==='rotation'?1:100;
      if((axis==='x'||axis==='y')&&content.kind!=='telop'&&positionPolicy==='finite')return <NativePositionField key={axis} label={`${prefix} ${axis==='x'?'横位置':'縦位置'}`} value={state[axis]??base[axis]} policy={positionPolicy} onCommit={value=>change(axis,value)}/>;
      return <NumberField key={axis} label={`${prefix} ${label}`} value={(state[axis]??base[axis])*factor} min={axis==='scale'?5:axis==='opacity'?0:axis==='rotation'?-360:-150} max={axis==='scale'?800:axis==='opacity'?100:axis==='rotation'?360:150} onCommit={value=>change(axis,value/factor)}/>;
    })}
  </>;
  return <>
    {show('look')&&content.kind==='shape'&&<section><h3>図形</h3>
      <SelectField label="形" value={content.data.kind} onCommit={value=>onContent('shape',current=>{
        // Object.assign は消えたキーを落とさないため、angle 以外へ変えたら x3,y3 を明示的に捨てる。
        Object.assign(current.data,shapeKindChange(current.data,value as ShapeKind));
        if(value!=='angle'){delete (current.data as {x3?:number}).x3;delete (current.data as {y3?:number}).y3;}
      })}>{([['arrow','矢印'],['line','直線'],['rect','四角'],['ellipse','楕円'],['triangle','三角'],['angle','分度器']] as const).map(([value,label])=><option key={value} value={value}>{label}</option>)}</SelectField>
      <div className="native-shape-colors" role="group" aria-label="図形の色">
        {SHAPE_COLORS.map(color=><button key={color} type="button" className="native-shape-color" aria-label={`線の色 ${color}`}
          aria-pressed={content.data.color.toLowerCase()===color.toLowerCase()} style={{background:color}}
          onClick={()=>void onContent('shape',current=>{current.data.color=color;})}/>)}
      </div>
      <ColorField label="線の色" value={content.data.color} onCommit={color=>onContent('shape',current=>{current.data.color=color;})}/>
      <SelectField label="線の太さ" value={content.data.thickness} onCommit={value=>onContent('shape',current=>{current.data.thickness=value as ShapeThickness;})}><option value="thin">細い</option><option value="medium">標準</option><option value="thick">太い</option></SelectField>
      {(['x1','y1','x2','y2'] as const).map(axis=><NumberField key={axis} label={`${{x1:'始点 横',y1:'始点 縦',x2:'終点 横',y2:'終点 縦'}[axis]}（%）`} value={content.data[axis]*100} min={0} max={100} onCommit={value=>onContent('shape',current=>{current.data[axis]=value/100;})}/>)}
      {content.data.kind==='angle'&&<>
        {(['x3','y3'] as const).map(axis=><NumberField key={axis} label={`${axis==='x3'?'端点B 横':'端点B 縦'}（%）`} value={(content.data[axis]??0)*100} min={0} max={100}
          onCommit={value=>onContent('shape',current=>{current.data[axis]=value/100;})}/>)}
        <p className="native-subtle">角度：{angleDegrees(
          {x:content.data.x1*resolution.width,y:content.data.y1*resolution.height},
          {x:content.data.x2*resolution.width,y:content.data.y2*resolution.height},
          {x:(content.data.x3??0)*resolution.width,y:(content.data.y3??0)*resolution.height},
        ).toFixed(1)}°</p>
      </>}
      <NumberField label="線の不透明度（%）" value={(content.data.opacity??1)*100} min={0} max={100} onCommit={value=>onContent('shape',current=>{current.data.opacity=value/100;})}/>
    </section>}
    {show('look')&&content.kind==='image'&&<section><h3>画像</h3><SelectField label="見せ方" value={content.style??'plain'} onCommit={value=>onContent('image',current=>{current.style=value as ImageType;})}><option value="plain">そのまま</option><option value="photo">写真</option><option value="infographic">図解</option><option value="overlay">重ねる</option></SelectField></section>}
    {show('place')&&(content.kind==='telop'||content.kind==='title'||content.kind==='shape')&&<section><h3>レイヤーの基本配置</h3>
      <p className="native-subtle">文字や図形の元の形を保ち、レイヤー全体を移動・拡縮します。</p>
      {visual.keyframes.length>0&&<p className="native-subtle">この欄は基本配置です。位置キーが有効な再生位置では、直接操作は現在のキーを変更します。数値は「位置キーフレーム」の点の欄で調整してください。範囲外を「元の配置」にすると、点の外では基本配置が使われます。</p>}
      {/* T17: 使える／使えないは NativeInspector の囲い（fieldset disabled）が決める。 */}
      <NativePositionPresets preset="layer" current={{x:visual.layout.position.x,y:visual.layout.position.y}}
        onPick={position=>void onVisual(current=>{current.layout.position.x=position.x;current.layout.position.y=position.y;})}/>
      <NativePositionField label="レイヤーの横位置" value={visual.layout.position.x} policy={positionPolicy} onCommit={value=>onVisual(current=>{current.layout.position.x=value;})}/>
      <NativePositionField label="レイヤーの縦位置" value={visual.layout.position.y} policy={positionPolicy} onCommit={value=>onVisual(current=>{current.layout.position.y=value;})}/>
      <NumberField label="レイヤーのスケール（%）" value={visual.layout.scale*100} min={Math.min(5,visual.layout.scale*100)} max={Math.max(800,visual.layout.scale*100)} onCommit={value=>onVisual(current=>{current.layout.scale=value/100;})}/>
      <NumberField label="レイヤーの不透明度（%）" value={visual.opacity*100} min={0} max={100} onCommit={value=>onVisual(current=>{current.opacity=value/100;})}/>
      <NumberField label="レイヤーの回転（°）" value={visual.layout.rotation} min={Math.min(-360,visual.layout.rotation)} max={Math.max(360,visual.layout.rotation)} onCommit={rotation=>onVisual(current=>{current.layout.rotation=rotation;})}/>
    </section>}
    {show('motion')&&<section><h3>動き</h3>
      {visual.keyframes.length>0&&<p className="native-subtle">位置キーフレームは下の欄で調整できます。</p>}
      <fieldset disabled={visual.keyframes.length>0&&content.kind!=='telop'}>
        <SelectField label="動き方" value={motion?.preset??''} onCommit={value=>setMotion((_,anchor)=>value?{preset:value as Motion['preset'],...(value==='keyframes'?{keys:[{t:0,...anchor},{t:1,...anchor}]}:{})}:undefined)}><option value="">なし</option>{presets.map(([value,label])=><option key={value} value={value}>{label}</option>)}</SelectField>
        {motion&&motion.preset!=='custom'&&motion.preset!=='keyframes'&&<NumberField label="動きの強さ（%）" value={(motion.intensity??.5)*100} min={0} max={100} onCommit={value=>editMotion(current=>{current.intensity=value/100;})}/>}
        {motion?.preset==='custom'&&(['from','to'] as const).map(edge=><details key={edge}><summary>{edge==='from'?'開始時':'終了時'}</summary>{stateFields(motion[edge]??{},(axis,value)=>editMotion(current=>{current[edge]??={};current[edge]![axis]=value;}),edge==='from'?'開始':'終了')}</details>)}
        {!!motion?.keys?.length&&<p className="native-subtle">途中の指定が動き方より優先されます。時刻はカット前の表示期間に対する割合です。</p>}
        {motion?.keys?.map((key,index)=><details key={index}><summary>ポイント {index+1}（{Math.round(key.t*100)}%）</summary>
          <NumberField label={`ポイント ${index+1} 時刻（%）`} value={key.t*100} min={(motion.keys?.[index-1]?.t??0)*100} max={(motion.keys?.[index+1]?.t??1)*100} onCommit={value=>editMotion(current=>{if(!current.keys?.[index])throw new Error('動きのポイントが変わりました。');current.keys[index]!.t=value/100;})}/>
          {stateFields(key,(axis,value)=>editMotion(current=>{if(!current.keys?.[index])throw new Error('動きのポイントが変わりました。');current.keys[index]![axis]=value;}),`ポイント ${index+1}`)}
          <button onClick={()=>editMotion(current=>{current.keys=current.keys?.filter((_,i)=>i!==index);})}>ポイントを削除</button>
        </details>)}
        {motion?.preset==='keyframes'&&<button onClick={()=>setMotion((current,anchor)=>{if(!current)throw new Error('動きの設定が変わりました。');const keys=[...(current.keys??[])];let t=.5,gap=-1;const boundaries=[0,...keys.map(key=>key.t),1];for(let i=1;i<boundaries.length;i++){const left=boundaries[i-1]!,right=boundaries[i]!;if(right-left>gap){gap=right-left;t=(right+left)/2;}}return {...current,keys:[...keys,{t,...anchor}].sort((a,b)=>a.t-b.t)};})}>ポイントを追加</button>}
      </fieldset>
    </section>}
    {show('motion')&&<section><h3>登場と退場</h3>{(['enter','exit'] as const).map(edge=>{
      const label=edge==='enter'?'登場':'退場',anim=visual[edge];
      return <div key={edge}><SelectField label={label} value={anim?.kind??''} onCommit={value=>onVisual(current=>{current[edge]=value?{kind:value as ElementAnim['kind'],frames:current[edge]?.frames||8}:undefined;})}><option value="">元の設定</option>{animations.map(([value,text])=><option key={value} value={value}>{text}</option>)}</SelectField>
        {anim&&anim.kind!=='none'&&<NumberField label={`${label}の長さ（fr）`} value={anim.frames} min={1} onCommit={frames=>onVisual(current=>{if(!current[edge])throw new Error('登場・退場の設定が変わりました。');current[edge]!.frames=Math.round(frames);})}/>}
        {anim?.kind==='slideIn'&&<SelectField label={`${label}の方向`} value={anim.direction??'left'} onCommit={value=>onVisual(current=>{if(current[edge]?.kind!=='slideIn')throw new Error('登場・退場の設定が変わりました。');current[edge]!.direction=value as ElementAnim['direction'];})}>{([['left','左'],['right','右'],['up','上'],['down','下']] as const).map(([value,text])=><option key={value} value={value}>{text}</option>)}</SelectField>}
      </div>;
    })}</section>}
  </>;
}
