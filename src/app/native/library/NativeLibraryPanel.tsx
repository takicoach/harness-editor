import {useMemo,useState} from 'react';
import {NativeSegmented} from '../NativeSegmented';
import {libraryFileUrl,type LibraryListing} from './libraryApi';

type Filter='all'|'template'|'se'|'bgm'|'image';
const FILTERS=[
  {value:'all',label:'すべて'},{value:'template',label:'モーション'},{value:'se',label:'効果音'},{value:'bgm',label:'BGM'},{value:'image',label:'画像'},
] as const;
interface Card{key:string;kind:Exclude<Filter,'all'>;name:string;use:string;desc:string;number?:number;durationSec?:number;hasPreview:boolean}
export interface NativeLibraryPanelProps{
  listing:LibraryListing|null;loading:boolean;playingKey:string|null;
  disabled?:boolean;busyKeys?:readonly string[];
  onAudition(key:string):void;onPlace(key:string):void;onReload():void;
}
const seconds=(value:number)=>`${value.toFixed(1)}秒`;

/** 素材置場の一覧。絞り込み・検索・カード格子。配置と試聴は親が行う。 */
export function NativeLibraryPanel({listing,loading,playingKey,disabled=false,busyKeys=[],onAudition,onPlace,onReload}:NativeLibraryPanelProps){
  const [filter,setFilter]=useState<Filter>('all'),[query,setQuery]=useState('');
  const ok=listing?.ok?listing:null;
  const cards=useMemo<Card[]>(()=>{
    if(!ok)return [];
    return [
      ...ok.catalog.templates.map(t=>({key:t.key,kind:'template' as const,name:t.name,use:t.use,desc:'',number:t.template,durationSec:t.durationSec,hasPreview:!!t.preview})),
      ...ok.catalog.media.map(m=>({key:m.key,kind:m.kind,name:m.name,use:'',desc:m.desc,durationSec:m.durationSec,hasPreview:!!m.preview})),
    ];
  },[ok]);
  const missing=useMemo(()=>new Set(ok?.missing??[]),[ok]);
  const needle=query.trim().toLowerCase();
  const shown=cards.filter(c=>(filter==='all'||c.kind===filter)&&(!needle||[c.name,c.use,c.desc].some(text=>text.toLowerCase().includes(needle))));
  return <div className="native-lib">
    <NativeSegmented<Filter> className="native-lib-filter native-seg-grow" role="radiogroup" label="素材置場の種類" items={FILTERS} value={filter} onChange={setFilter}/>
    <div className="native-lib-tools">
      <input type="search" role="searchbox" aria-label="素材置場を検索" placeholder="名前・説明で検索" value={query} onChange={event=>setQuery(event.target.value)}/>
      <button type="button" className="btn-ghost" onClick={onReload} disabled={loading}>再読み込み</button>
    </div>
    {loading&&<p className="native-library-hint" role="status">素材置場を読み込んでいます…</p>}
    {listing&&!listing.ok&&<div className="native-lib-problem" role="alert">
      <p>素材置場を開けません。{listing.reason}</p>{listing.directory&&<p className="native-lib-path">場所: {listing.directory}</p>}
    </div>}
    {ok&&!shown.length&&!loading&&<p className="native-library-hint">{cards.length?'条件に合う素材がありません。':'素材置場はまだ空です。'}</p>}
    {ok&&<div className="native-lib-grid">
      {shown.map(card=>{
        const gone=missing.has(card.key),placing=busyKeys.includes(card.key),playing=playingKey===card.key;
        const audible=card.kind==='se'||card.kind==='bgm';
        return <div key={card.key} className="native-lib-card" data-library-key={card.key} data-kind={card.kind} data-missing={gone?'true':undefined} data-busy={placing?'true':undefined} title={card.use||card.desc||undefined}>
          <button type="button" className="native-lib-place" draggable={!gone} onDragStart={event=>{if(gone){event.preventDefault();return;}event.dataTransfer.setData('application/x-harness-library-item',card.key);}} disabled={gone||disabled||placing} aria-label={`${card.name}を再生位置に置く`} onClick={()=>onPlace(card.key)}>
            {(card.kind==='template'||card.kind==='image')&&(card.hasPreview
              ?<img className="native-lib-thumb" src={libraryFileUrl(card.key,'preview')} alt="" loading="lazy" draggable={false}/>
              :<span className="native-lib-thumb native-lib-thumb-empty" aria-hidden="true"/>)}
            {audible&&<span className="native-lib-kind" aria-hidden="true">{card.kind==='se'?'SE':'BGM'}</span>}
            <span className="native-lib-name"><strong>{card.number!==undefined&&<em>{card.number}</em>}{card.name}</strong>
              {gone?<small className="native-lib-gone">見つかりません</small>:placing?<small>配置中…</small>:card.durationSec!==undefined&&<small>{seconds(card.durationSec)}</small>}</span>
          </button>
          {audible&&<button type="button" className="native-asset-audition native-lib-audition" aria-label={`${card.name}を試聴`} aria-pressed={playing} disabled={gone} onClick={()=>onAudition(card.key)}>{playing?'停止':'試聴'}</button>}
        </div>;
      })}
    </div>}
  </div>;
}
