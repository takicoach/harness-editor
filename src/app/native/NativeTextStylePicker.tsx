import {Component,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {CaptureFrameProvider,setStaticFileResolver} from '../../captureRuntime';
import {CaptureTelopLayer} from '../../capturePage/layers';
import {swatchSampleText} from '../../core/telopSwatch';
import {activeTextAppearance,textComponentId,type TextContent} from '../../core/sequence/textStyle';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {timeNumber} from '../../core/sequence/time';
import {pickTelopExport,type TelopComponent} from '../../preview/loadTelopComponent';
import {sequenceAssetUrl} from '../../preview/native/sceneRenderer';
import {useDialogEscape} from '../useDialogEscape';
import {useFocusTrap} from '../useFocusTrap';
import {applyLegacyCaptionFont} from '../../preview/legacyCaptionFont';
import {TaskProgress} from '../components/TaskProgress';
import {fitTextBoxToStage, measureTextBox} from './nativeSampleFit';

export type Entry={id:number;name:string};
class PreviewBoundary extends Component<{children:ReactNode;onError():void},{failed:boolean}> {
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(){this.props.onError();}
  render(){return this.state.failed?null:this.props.children;}
}
export function StyleCell({entry,Telop,document:doc,text,legacyId,selected,disabled,onSelect,legacyFontFallback}:{entry:Entry;Telop?:TelopComponent;document:SequenceDocument;text:string;legacyId:number;selected:boolean;disabled:boolean;onSelect():void;legacyFontFallback:boolean}) {
  const host=useRef<HTMLDivElement>(null),drawing=useRef<HTMLDivElement>(null),[shadow,setShadow]=useState<ShadowRoot|null>(null),[size,setSize]=useState({width:0,height:0}),[fit,setFit]=useState({x:0,y:0,scale:0}),[visible,setVisible]=useState(false),[failed,setFailed]=useState(false);
  useLayoutEffect(()=>{if(legacyFontFallback&&drawing.current)return applyLegacyCaptionFont(drawing.current);});
  useLayoutEffect(()=>{const element=host.current;if(!element)return;setShadow(element.shadowRoot??element.attachShadow({mode:'open'}));
    const resize=new ResizeObserver(()=>{const {width,height}=element.getBoundingClientRect();setSize({width,height});});resize.observe(element);
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'120px'});observer.observe(element);
    return()=>{resize.disconnect();observer.disconnect();};
  },[]);
  useLayoutEffect(()=>{
    const element=drawing.current;if(!element||!size.width)return;
    const measure=()=>{
      // Fit actual text at any authored position, leaving room for outlines and shadows.
      const box=measureTextBox(element,doc.resolution.width);
      if(!box)return;
      setFit(fitTextBoxToStage(box,size));
    };
    measure();window.document.fonts.addEventListener('loadingdone',measure);return()=>window.document.fonts.removeEventListener('loadingdone',measure);
  },[shadow,visible,Telop,size.width,size.height,doc.resolution.width,text]);
  const scale=fit.scale||size.width/doc.resolution.width;
  return <button className="native-style-card" aria-label={entry.name} aria-pressed={selected} disabled={disabled||!Telop||failed} onClick={onSelect}>
    <div ref={host} className="native-style-stage" aria-hidden="true">
      {shadow&&visible&&Telop&&createPortal(<PreviewBoundary onError={()=>setFailed(true)}><>
        <style>{':host{font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#000;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}*{box-sizing:border-box}'}</style>
          <div ref={drawing} data-native-style-preview={entry.id} style={{position:'absolute',width:doc.resolution.width,height:doc.resolution.height,transform:`translate(${fit.x}px,${fit.y}px) scale(${scale})`,transformOrigin:'top left',pointerEvents:'none'}}>
            <CaptureFrameProvider frame={30} videoConfig={{...doc.resolution,fps:timeNumber(doc.fps),durationInFrames:60}}>
              <CaptureTelopLayer Telop={Telop} telops={[{id:legacyId,text,startFrame:0,endFrame:60,template:entry.id,animation:'none'}]}/>
            </CaptureFrameProvider>
          </div>
      </></PreviewBoundary>,shadow)}
    </div><span>{failed?'表示できません':entry.name}</span>
  </button>;
}
/** Headless list of style swatches for one component asset. The caller supplies the heading. */
export function StyleCells({asset,entries,load,document:doc,content,disabled,onSelect,extra}:{asset:SequenceAsset;entries:Entry[];load(asset:SequenceAsset):Promise<TelopComponent>;document:SequenceDocument;content:TextContent;disabled:boolean;onSelect(assetId:string,template:number):void;extra?(entry:Entry):ReactNode}) {
  const [Telop,setTelop]=useState<TelopComponent>(),[error,setError]=useState('');
  useEffect(()=>{let live=true;void load(asset).then(value=>{if(live)setTelop(()=>value);},error=>{if(live)setError(String(error.message??error));});return()=>{live=false;};},[asset.id,asset.fingerprint,load]);
  return <>
    {!Telop&&!error&&<TaskProgress compact label="スタイルを準備しています"/>}
    {error&&<p role="alert" className="native-export-error">{error}</p>}
    <div className="native-style-grid">{entries.map(entry=><div key={entry.id} className="native-style-item">
      <StyleCell entry={entry} Telop={Telop} document={doc} text={swatchSampleText(content.data.text)} legacyId={content.legacyId??1}
        legacyFontFallback={asset.textStyleCatalog?.source!=='builtin'} disabled={disabled}
        selected={!activeTextAppearance(content)&&textComponentId(doc,content)===asset.id&&(content.data.template??1)===entry.id}
        onSelect={()=>onSelect(asset.id,entry.id)}/>
      {extra?.(entry)}
    </div>)}</div>
  </>;
}
/** Loads and caches frozen telop components for a project; disposes fetches/blobs on unmount. */
export type { TelopComponent };
export function useTelopLoader(projectId:string) {
  const loader=useMemo(()=>{
    let abort=new AbortController();const cache=new Map<string,Promise<TelopComponent>>();
    return {dispose:()=>{abort.abort();cache.clear();},load:(asset:SequenceAsset)=>{
      // React replays effects in development; a disposed controller cannot serve the next mount.
      if(abort.signal.aborted)abort=new AbortController();
      const key=`${asset.id}:${asset.fingerprint}`;let promise=cache.get(key);
      if(!promise){promise=(async()=>{
        const response=await fetch(sequenceAssetUrl(projectId,asset.id,true),{signal:abort.signal});if(!response.ok)throw new Error('保存したスタイルを読み込めません');
        const url=URL.createObjectURL(new Blob([await response.text()],{type:'text/javascript'}));
        try {
          const mod=await import(/* @vite-ignore */ url);
          if(asset.textStyleCatalog?.source==='builtin') {
            const declared=mod.NATIVE_TEXT_STYLE_CATALOG;
            if(declared?.source!=='builtin'||!Array.isArray(declared.entries)||declared.entries.length!==asset.textStyleCatalog.entries.length
              ||declared.entries.some((entry:Entry,index:number)=>entry.id!==asset.textStyleCatalog!.entries[index]?.id||entry.name!==asset.textStyleCatalog!.entries[index]?.name))throw new Error('スタイル一覧と保存した部品が一致しません');
          }
          return pickTelopExport(mod);
        }finally{URL.revokeObjectURL(url);}
      })();cache.set(key,promise);}return promise;
    }};
  },[projectId]);
  useEffect(()=>()=>loader.dispose(),[loader]);
  return loader;
}
export function NativeTextStylePicker({projectId,document:doc,content,disabled,onChoose,onFree,onClose}:{projectId:string;document:SequenceDocument;content:TextContent;disabled:boolean;onChoose(assetId:string,template:number):Promise<boolean>;onFree():Promise<boolean>;onClose():void}) {
  const root=useRef<HTMLDivElement>(null),[query,setQuery]=useState(''),[applying,setApplying]=useState(false),[error,setError]=useState('');
  const loader=useTelopLoader(projectId);
  useLayoutEffect(()=>{setStaticFileResolver(name=>{const asset=doc.rendering?.staticFiles?.[decodeURIComponent(name).replace(/^\/+/, '')];if(!asset)throw new Error('保存されていないスタイル素材です');return sequenceAssetUrl(projectId,asset);});},[projectId,doc.rendering?.staticFiles]);
  useDialogEscape(onClose,!applying);useFocusTrap(root);
  const choose=async(work:()=>Promise<boolean>)=>{setApplying(true);setError('');try{if(await work())onClose();else setError('スタイルを反映できませんでした。もう一度選んでください。');}finally{setApplying(false);}};
  const groups=doc.assets.flatMap(asset=>{
    if(asset.kind!=='component')return [];
    if(asset.textStyleCatalog)return [{asset,entries:asset.textStyleCatalog.entries}];
    if(asset.id===textComponentId(doc,content))return [{asset,entries:[{id:content.data.template??1,name:'現在のスタイル'}]}];
    return [];
  });
  return createPortal(<div className="native-style-overlay"><div ref={root} className="native-style-dialog" role="dialog" aria-modal="true" aria-labelledby="native-style-title">
    <header><div><h2 id="native-style-title">文字のスタイル</h2><p>見本を選ぶと、選択中の文字へ適用します。</p></div><button disabled={applying} onClick={onClose} aria-label="スタイル一覧を閉じる">閉じる</button></header>
    <div className="native-style-tools"><input autoFocus aria-label="スタイルを検索" placeholder="スタイルを検索" value={query} onChange={event=>setQuery(event.target.value)}/><button disabled={disabled||applying} onClick={()=>void choose(onFree)}>自由な書式で編集</button></div>
    {error&&<p role="alert" className="native-export-error">{error}</p>}
    <div className="native-style-results">{!groups.some(group=>group.entries.some(entry=>entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())))&&<p>一致するスタイルがありません。</p>}
      {groups.map(({asset,entries})=>{
        const filtered=entries.filter(entry=>entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        if(!filtered.length)return null;
        return <section key={asset.id} className="native-style-group"><h3>{asset.textStyleCatalog?.source==='builtin'?'テロップスタイル':'この案件のスタイル'}</h3>
          <StyleCells asset={asset} entries={filtered} load={loader.load} document={doc} content={content} disabled={disabled||applying}
            onSelect={(assetId,template)=>void choose(()=>onChoose(assetId,template))}/>
        </section>;
      })}
    </div>
  </div></div>,window.document.querySelector('.native-workspace')??window.document.body);
}
