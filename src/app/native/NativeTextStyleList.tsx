import {forwardRef,useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {activeTextAppearance,textComponentId,type TextContent} from '../../core/sequence/textStyle';
import {StyleCells,useTelopLoader} from './NativeTextStylePicker';
import {currentStyleEntry} from './textStyleCurrent';
import {INSTALLED_TEXT_STYLE_PACKS} from './installedTextStylePacks';
import type {InstalledTextStylePackInfo} from '../../core/sequence/installedTextStylePack';
import {NativeSegmented} from './NativeSegmented';
import type {TextStylePreparation} from './textStylePreparation';
import {NativeTelopAdd} from './NativeTelopAdd';
import {NativeTelopTemplateUpdate,type TelopTemplateUpdateHandle} from './NativeTelopTemplateUpdate';
import {NativeTelopPackUpdate} from './NativeTelopPackUpdate';
import {isEscape} from './keyboard';

/** テロップカタログ（本体 15＋拡張 77 の見本）。外部リンクは定数で 1 箇所に置く。 */
export const TEXT_STYLE_CATALOG_URL='https://telop-catalog.pages.dev/';

const GROUP_LABEL={builtin:'テロップスタイル',project:'この案件のスタイル',installed:'追加したパック'} as const;

export interface TextStyleListProps {
  projectId:string;document:SequenceDocument;content:TextContent;
  assets:SequenceAsset[];                       // component かつ textStyleCatalog を持つもの
  hidden:Record<string,number[]>;
  disabled:boolean;
  preparation:TextStylePreparation;
  onPrepare():Promise<boolean>;
  applyAllCount:number;                         // 選択中トラックの telop クリップ数
  applyAllTrackName?:string;
  onChoose(assetId:string,styleId:number):Promise<boolean>;
  onApplyAll(assetId:string,styleId:number):Promise<boolean>;
  onHiddenChange(assetId:string,hidden:number[]):Promise<boolean>;
  onRegisterAsset(asset:SequenceAsset):Promise<boolean>;
  onReplaceAsset(fromAssetId:string,toAssetId:string):Promise<boolean>;
  /** 同梱の追加パック。既定はビルド時に集めた一覧（テストで差し替える）。 */
  installedPacks?:readonly InstalledTextStylePackInfo[];
}

function currentAssetId(props:TextStyleListProps):string|undefined {
  return textComponentId(props.document,props.content)??props.assets[0]?.id;
}

export const NativeTextStyleList=forwardRef<TelopTemplateUpdateHandle,TextStyleListProps>(function NativeTextStyleList(props,ref) {
  const [query,setQuery]=useState(''),[showHidden,setShowHidden]=useState(false),[confirming,setConfirming]=useState<{assetId:string;styleId:number}|null>(null);
  const [preparing,setPreparing]=useState(false);
  const autoPrepared=useRef<string|null>(null);
  useEffect(()=>{
    if(props.preparation!=='needs-builtin'||props.disabled)return;
    const key=`${props.projectId}:${props.document.id}`;
    if(autoPrepared.current===key)return;
    autoPrepared.current=key;
    setPreparing(true);
    void props.onPrepare().catch(()=>false).finally(()=>setPreparing(false));
  },[props.preparation,props.disabled,props.projectId,props.document.id,props.onPrepare]);
  // F15: 112 枚のカードは常設せず、「現在の 1 行」から開くポップオーバーの中だけで描く。
  const [open,setOpen]=useState(false),[pickedAsset,setPickedAsset]=useState<string|undefined>(undefined);
  const picker=useRef<HTMLDivElement>(null),anchor=useRef<HTMLButtonElement>(null);
  const [pickerBox,setPickerBox]=useState<{top:number;right:number;width:number;maxHeight:number}|null>(null);
  // 閉じるときは「既定は現在の資産」へ戻す（次に開いたとき、前回見ていたタブが残らないように）。
  // T10: 閉じる経路は 2 つ。dismiss は「選び直したタブ」も捨てる（次に開いた時に前回のタブが残らない）。
  // close は起点へフォーカスを返す版（Esc・選択の確定）。外側クリックでフォーカスを奪わないよう使い分ける。
  const dismiss=useCallback(()=>{setOpen(false);setPickedAsset(undefined);},[]);
  const close=useCallback(()=>{dismiss();anchor.current?.focus();},[dismiss]);
  useEffect(()=>{
    if(!open)return;
    // 起点ボタンはポータルの外側なので、ここで閉じると click が開き直してしまう。起点は除外し、
    // 閉じる操作は onClick のトグルに任せる（Codex レビュー: 起点の再クリックで閉じる）。
    const down=(event:PointerEvent)=>{if(event.target instanceof Node&&!picker.current?.contains(event.target)&&!anchor.current?.contains(event.target))dismiss();};
    document.addEventListener('pointerdown',down);return()=>document.removeEventListener('pointerdown',down);
  },[open,dismiss]);
  useEffect(()=>{
    if(!open)return;
    // 「変更…」を押した直後はフォーカスが起点ボタン（ポータルの外）にあり、ポータルの onKeyDown へ
    // Esc が届かない。document で拾う。編集ショートカットへ流さないため止めるので capture で先に取る。
    // I-8: 日本語変換中の Esc は変換の取り消し。capture で奪うとピッカーごと閉じてしまうので見送る。
    const key=(event:KeyboardEvent)=>{if(!isEscape(event))return;event.stopPropagation();close();};
    document.addEventListener('keydown',key,true);return()=>document.removeEventListener('keydown',key,true);
  },[open,close]);
  // 右カラム 296px の中では 1 列にしかならず overflow:hidden にも切られるので、ワークスペース要素へ出して固定配置する。
  // I-3: ポータル先を document.body にすると <fieldset disabled>・下書き確定の捕捉ハンドラ・操作音の外に出る。
  // `.native-workspace` は transform/contain/filter/perspective を持たないので fixed の基準にはならない
  // （2026-09-22 に getComputedStyle で実測）。
  // 高さを画面内へ定めてから top を戻す。字幕行が下の方にあるとき、一括適用ボタンが
  // 画面外へ落ちて押せなくなる（fixed なのでスクロールでは追いつけない）。
  const measure=useCallback(()=>{
    const node=anchor.current;if(!node)return;
    const r=node.getBoundingClientRect();
    const maxHeight=Math.min(560,Math.max(260,window.innerHeight-24));
    const next={top:Math.max(12,Math.min(r.bottom+6,window.innerHeight-12-maxHeight)),
      right:Math.max(12,window.innerWidth-r.right),width:Math.min(640,window.innerWidth-24),maxHeight};
    // 同値なら差し替えない（新しいオブジェクトを入れるだけで 112 枚が再描画される・M-6）。
    setPickerBox(previous=>previous&&previous.top===next.top&&previous.right===next.right&&previous.width===next.width&&previous.maxHeight===next.maxHeight?previous:next);
  },[]);
  useLayoutEffect(()=>{if(open)measure();},[open,measure]);
  // I-4: 開いたら検索欄へフォーカスする（メニュー類の共通要件「開いたら最初の項目へ」）。
  // ポータルは measure() で pickerBox が決まってから描かれるので、その後の層で当てる。
  // 既に中にフォーカスがあるときは触らない（開いている間の再計測で奪い返さないため）。
  useLayoutEffect(()=>{
    if(!open)return;
    const node=picker.current;if(!node||node.contains(document.activeElement))return;
    node.querySelector<HTMLInputElement>('input')?.focus();
  },[open,pickerBox]);
  useEffect(()=>{
    if(!open)return;
    // fixed なので、窓の大きさが変わってもインスペクタが縦スクロールしても起点はずれる。開いている間だけ追う
    // （祖先のスクロールは bubble しないので document の capture で拾う）。
    // 自分（一覧のスクロール）では測り直さない。起点は動いていない（M-6）。
    const again=(event?:Event)=>{if(event?.target instanceof Node&&picker.current?.contains(event.target))return;measure();};
    window.addEventListener('resize',again);document.addEventListener('scroll',again,true);
    return()=>{window.removeEventListener('resize',again);document.removeEventListener('scroll',again,true);};
  },[open,measure]);
  // 別のクリップを選んだら、タブの選び直しは捨てて現在の資産に戻す。
  const componentId=textComponentId(props.document,props.content);
  useEffect(()=>{setPickedAsset(undefined);},[componentId]);
  const loader=useTelopLoader(props.projectId);
  const needle=query.toLocaleLowerCase();
  const packs=props.installedPacks??INSTALLED_TEXT_STYLE_PACKS;
  const packOf=(asset:SequenceAsset)=>packs.find(pack=>pack.packId===asset.textStyleCatalog?.packId);
  // 同じ packId が並ぶときだけ、後発の版に「（版 x）」を足す。先頭は基準として無印のまま。
  const seenPack=new Map<string,number>();
  const prepare=async()=>{setPreparing(true);try{return await props.onPrepare();}finally{setPreparing(false);}};
  if(props.preparation==='needs-builtin'){
    const waiting=!props.disabled&&(preparing||autoPrepared.current!==`${props.projectId}:${props.document.id}`);
    return <div className="native-style-inline" role="region" aria-label="文字のスタイル">
      <p className="native-subtle">{waiting?'テロップスタイル3種を準備しています…':props.disabled?'テロップスタイルはまだありません。':'テロップスタイルを準備できませんでした。'}</p>
      {!waiting&&<button type="button" className="native-text-button" disabled={props.disabled} onClick={()=>void prepare()}>テロップスタイルを用意する</button>}
    </div>;
  }
  // Codex P2: 取り込み字幕（preparation:'needs-project'）は currentAssetId がそのコンポーネント ID を
  // 返すが、props.assets にはカタログ持ちの資産しか無い。currentStyleEntry と同じ規則
  // （`assets.find(...)??assets[0]`）で利用可能なカタログへフォールバックしないと、タブも節も出ず空になる。
  const wantedAsset=pickedAsset??currentAssetId(props);
  const picked=wantedAsset!==undefined&&props.assets.some(asset=>asset.id===wantedAsset)?wantedAsset:props.assets[0]?.id;
  // 空状態は「今見ているタブ」で判定する（全資産の合計だと、他のタブに残っていて出ない）。
  const pickedCatalogAsset=props.assets.find(asset=>asset.id===picked);
  const pickedDisplayableEntries=pickedCatalogAsset
    ?(()=>{const off=new Set(props.hidden[pickedCatalogAsset.id]??[]);
      return pickedCatalogAsset.textStyleCatalog!.entries.filter(entry=>entry.name.toLocaleLowerCase().includes(needle)&&(showHidden||!off.has(entry.id))).length;})()
    :0;
  const current=currentStyleEntry(props.assets,props.content,currentAssetId(props));
  const builtin=props.assets.find(asset=>asset.textStyleCatalog?.source==='builtin');
  const freeForm=!!activeTextAppearance(props.content);   // 自由書式（スタイル未使用）のとき 1 行は「自由書式」と出す（textStyle.ts:4）
  const sourceTabs=props.assets.map(asset=>{
    const off=new Set(props.hidden[asset.id]??[]);
    const count=asset.textStyleCatalog!.entries.filter(entry=>entry.name.toLocaleLowerCase().includes(needle)&&(showHidden||!off.has(entry.id))).length;
    return {value:asset.id,label:`${packOf(asset)?.tabLabel??GROUP_LABEL[asset.textStyleCatalog!.source]} ${count}`};
  });
  return <div className="native-style-inline" role="region" aria-label="文字のスタイル">
    {packs.filter(pack=>!props.assets.some(asset=>asset.textStyleCatalog?.packId===pack.packId)).map(pack=>
      <button key={pack.packId} type="button" className="native-text-button" disabled={props.disabled||preparing} onClick={()=>void prepare()}>{`${pack.name}${pack.count}種を追加`}</button>)}
    {props.preparation==='needs-project'&&
      <button type="button" className="native-text-button" disabled={props.disabled||preparing} onClick={()=>void prepare()}>この案件のスタイルを読み込む</button>}
    <div className="native-style-current">
      {current?<><span className="native-style-current-name"><strong>{freeForm?'自由書式（スタイル未使用）':current.entry.name}</strong><span className="native-subtle">{packOf(current.asset)?.groupLabel??GROUP_LABEL[current.asset.textStyleCatalog!.source]} · {current.asset.textStyleCatalog!.entries.length}件中</span></span>
        <button ref={anchor} type="button" className="btn-secondary" aria-expanded={open} aria-haspopup="dialog" disabled={props.disabled} onClick={()=>{if(open)dismiss();else setOpen(true);}}>変更…</button></>
      :<span className="native-subtle">スタイルがまだありません</span>}
    </div>
    {builtin&&<section className="native-style-inline-cards" aria-label={`標準テロップスタイル${builtin.textStyleCatalog!.entries.length}種`}>
      <StyleCells asset={builtin} entries={builtin.textStyleCatalog!.entries.filter(entry=>!(props.hidden[builtin.id]??[]).includes(entry.id))}
        load={loader.load} document={props.document} content={props.content} disabled={props.disabled}
        onSelect={(assetId,styleId)=>void props.onChoose(assetId,styleId)}/>
    </section>}
    {/* Esc は上の document capture が先に取るので、ここに onKeyDown の分岐は置かない（届かない・T10）。 */}
    {open&&pickerBox&&createPortal(<div className="native-style-picker" role="dialog" aria-label="スタイルを選ぶ" ref={picker} style={{position:'fixed',top:pickerBox.top,right:pickerBox.right,width:pickerBox.width,maxHeight:pickerBox.maxHeight}}>
      <div className="native-style-tools">
        <input aria-label="スタイルを検索" placeholder="スタイルを検索" value={query} onChange={event=>setQuery(event.target.value)}/>
        <label className="native-check"><input type="checkbox" checked={showHidden} onChange={event=>setShowHidden(event.target.checked)}/>オフも表示</label>
        <a className="native-text-button" href={TEXT_STYLE_CATALOG_URL} target="_blank" rel="noreferrer">カタログを見る</a>
      </div>
      {sourceTabs.length>1&&<NativeSegmented label="スタイルの出どころ" items={sourceTabs} value={picked??props.assets[0]!.id} onChange={setPickedAsset}/>}
      <div className="native-style-picker-grid">
        {props.assets.map(asset=>{
          const catalog=asset.textStyleCatalog!,off=new Set(props.hidden[asset.id]??[]);
          const entries=catalog.entries.filter(entry=>entry.name.toLocaleLowerCase().includes(needle)&&(showHidden||!off.has(entry.id)));
          if(!entries.length)return null;
          const packId=catalog.packId??asset.id,seen=seenPack.get(packId)??0;
          const suffix=seen>0?`（版 ${catalog.version}）`:'';
          seenPack.set(packId,seen+1);
          // 版の連番は全資産を数えたうえで決める（見出しの「（版 x）」がタブ切替で消えないように）。
          if(asset.id!==picked)return null;
          return <section key={asset.id} className="native-style-group">
            <h3>{packOf(asset)?.name??GROUP_LABEL[catalog.source]}{suffix} {entries.length}件</h3>
            <StyleCells asset={asset} entries={entries} load={loader.load} document={props.document} content={props.content} disabled={props.disabled}
              onSelect={(assetId,styleId)=>void props.onChoose(assetId,styleId).then(ok=>{if(ok!==false)close();})}
              extra={entry=><button type="button" className="native-style-visibility" disabled={props.disabled}
                aria-label={`${entry.name}を${off.has(entry.id)?'使う':'使わない'}`}
                onClick={()=>void props.onHiddenChange(asset.id,off.has(entry.id)?[...off].filter(id=>id!==entry.id):[...off,entry.id])}>
                {off.has(entry.id)?'使う':'使わない'}</button>}/>
          </section>;
        })}
      </div>
      {needle&&!pickedDisplayableEntries&&<p className="native-style-empty">一致するスタイルがありません。</p>}
      <button type="button" className="native-text-button" disabled={props.disabled}
        onClick={()=>{const id=currentAssetId(props);if(id){setConfirming({assetId:id,styleId:props.content.data.template??1});close();}}}>
        このスタイルを同じトラックに適用</button>
    </div>,anchor.current?.closest('.native-workspace')??document.body)}
    {confirming&&<div role="alertdialog" aria-label="全体に適用の確認" className="native-style-confirm">
      <p>「{props.applyAllTrackName??'選択中のトラック'}」の文字 {props.applyAllCount}件に適用します。他のトラックのタイトル・字幕の文字サイズや装飾は変更しません。元に戻すは 1 回で効きます。</p>
      <button type="button" onClick={()=>{const target=confirming;setConfirming(null);void props.onApplyAll(target.assetId,target.styleId);}}>{props.applyAllCount}件に適用する</button>
      <button type="button" onClick={()=>setConfirming(null)}>やめる</button>
    </div>}
    <NativeTelopTemplateUpdate ref={ref} projectId={props.projectId} document={props.document} disabled={props.disabled}
      expectedRevision={props.document.revision}
      onRegisterAsset={props.onRegisterAsset} onReplaceAsset={props.onReplaceAsset}/>
    <NativeTelopPackUpdate projectId={props.projectId} document={props.document} disabled={props.disabled}
      onRegisterAsset={props.onRegisterAsset} onReplaceAsset={props.onReplaceAsset}/>
    <NativeTelopAdd projectId={props.projectId} disabled={props.disabled} onRegister={props.onRegisterAsset}/>
  </div>;
});
