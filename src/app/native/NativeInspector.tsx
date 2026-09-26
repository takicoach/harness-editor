import {NativeInspectorSection} from './NativeInspectorSection';
import {NativeColorWheels} from './NativeColorWheels';
import {applyColorWheelChange} from '../panels/inspector/ColorWheelControls';
import {NativeGlobalSpeedSettings,NativeClipSpeedSettings} from './NativeSpeedSettings';
import { Children,forwardRef,Fragment,isValidElement,useCallback,useEffect,useImperativeHandle,useRef,useState,type ReactNode } from 'react';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import { defaultColorGrade, normalizeColorWheels, type ColorGradeField } from '../../core/colorGrade';
import { clipEnd, DEFAULT_TEXT_APPEARANCE, type TextAppearance, type ClipVisual, type SequenceClip, type SequenceDocument } from '../../core/sequence/model';
import type { NativeCommand } from './api';
import { ColorField,NumberField,TextField,SelectField,CheckField,InspectorDraftContext } from './NativeInspectorFields';
import {NativeFontField} from './NativeFontField';
import {FONTS,fontStack} from '../../core/fonts';
import {InspectorIntentQueue,InspectorRevisionGuard,type ChangeContent,type ChangeVisual} from './inspectorIntents';
import { NativeVisualSettings,visualSettingsHasContent } from './NativeVisualSettings';
import {activeTextAppearance,textComponentId,withTextMode} from '../../core/sequence/textStyle';
import {NEW_TELOP_ANIMATION_IDS,TELOP_ANIMATION_IDS,TELOP_ANIMATION_LABELS,type TelopAnimationId} from '../../core/telopAnimation';
import {supportsAnimation,telopClipsLosingAnimation,textAnimationSupport,UNSUPPORTED_ANIMATION_REASON,assetAnimationSupport} from './telopAnimationSupport';
import {NativeAnimationGuard,type AnimationGuardRequest} from './NativeAnimationGuard';
import {NativeTextStyleList} from './NativeTextStyleList';
import {NativeAnimationList} from './NativeAnimationList';
import type {TelopTemplateUpdateHandle} from './NativeTelopTemplateUpdate';
import {textStylePreparation} from './textStylePreparation';
import {NativeKeyframeSettings} from './NativeKeyframeSettings';
import {NativeMotionTiming} from './NativeMotionTiming';
import {nativeCommandErrorMessage} from './api';
import {keyframeTimelineTime} from '../../core/sequence/visualTransform';
import {timeNumber} from '../../core/sequence/time';
import {NativeSceneFadeSettings} from './NativeSceneFadeSettings';
import {NativeTransitionSettings} from './NativeTransitionSettings';
import {sceneFadeTargetKey,type SceneFadeTarget} from '../../core/sequence/sceneFadeEdits';
import {NativeDuckingSettings} from './NativeDuckingSettings';
import {NativeAudioFixSettings} from './NativeAudioFixSettings';
import {inspectorHeading,inspectorSections,inspectorSelectionKind,inspectorGroups,defaultGroupOpen,INSPECTOR_GROUP_LABEL,type InspectorGroupId} from './inspectorSections';
import {summarizeGroup} from './inspectorSummary';
import {fadeFrames,fadeSeconds} from './audioFade';
import {NativePositionPresets} from './NativePositionPresets';

/** 未設定の title の既定書体。capturePage/layers.tsx の CaptureTitleClip 既定 family と同じ値。 */
const DEFAULT_TITLE_FONT_FAMILY=FONTS.find(font=>font.id==='noto-sans-jp')!.family;

/**
 * telop の appearance.fontFamily に保存する値を組み立てる。NativeFontField は生 family
 * しか onCommit に渡さないので、ここで一覧の書体ならフォールバック込みのスタックへ変換する
 * （NativeText.tsx が appearance.fontFamily を CSS へそのまま渡すため、生 family のままだと
 * 未読み込み環境でブラウザ既定にむき出しで縮退する）。一覧に無い自由入力はそのまま通す。
 */
function telopFontFamilyValue(family:string):string {
  const font=FONTS.find(f=>f.family===family);
  return font?fontStack(font):family;
}

export interface NativeInspectorHandle {flush():Promise<boolean>;blurDraft():void}
interface Props {onPreviewVisual?(clipId:string,visual:ClipVisual|null):void;projectId:string;document:SequenceDocument;readDocument():SequenceDocument|null;frame:number;onSeek(frame:number):void;selected:string[];disabled:boolean;externalBusy?:boolean;bypassLut:boolean;onBypass(value:boolean):void;onCommand(command:NativeCommand):Promise<boolean>;onUploadLut():void;onDraftChange?(dirty:boolean):void;onPrepareTextStyles():Promise<boolean>;showSceneFades?:boolean;sceneFadeSwitching?:boolean;sceneFadeTarget?:SceneFadeTarget;onSceneFadeTargetChange?(target:SceneFadeTarget):Promise<boolean>;transitionJoinKey?:string;onTransitionJoin?(joinKey:string):Promise<boolean>;exporting?:boolean;onRegisterAssets?(assetIds:string[]):Promise<boolean>;onNotice?(message:string):void;
  /** F14: 群の開閉を viewState に記憶するとき。省略時は自前の state で持つ（単体テスト）。 */
  groupOpen?:Record<string,boolean>;onGroupOpen?(key:string,open:boolean):void}
export const NativeInspector=forwardRef<NativeInspectorHandle,Props>(function NativeInspector({ onPreviewVisual,projectId,document: doc,readDocument,frame,onSeek, selected, disabled,externalBusy=false, bypassLut, onBypass, onCommand:dispatch, onUploadLut,onDraftChange,onPrepareTextStyles,showSceneFades=false,sceneFadeSwitching=false,sceneFadeTarget={kind:'head'},onSceneFadeTargetChange=async()=>false,transitionJoinKey,onTransitionJoin=async()=>false,exporting=false,onRegisterAssets=async()=>false,onNotice=()=>undefined,groupOpen,onGroupOpen },ref) {
  const element=useRef<HTMLElement>(null),[ownedPending,setOwnedPending]=useState(0),[draft,setDraft]=useState(false),[error,setError]=useState('');
  const [localOpen,setLocalOpen]=useState<Record<string,boolean>>({});
  const openMap=groupOpen??localOpen;
  const setGroupOpen=onGroupOpen??((key:string,open:boolean)=>setLocalOpen(current=>current[key]===open?current:{...current,[key]:open}));
  const latest=useRef({projectId,readDocument,dispatch,externalBusy});latest.current={projectId,readDocument,dispatch,externalBusy};
  // I-2e: NativeAnimationList の「この案件の字幕で新しい動きを使えるようにする」から
  // テロップ部品更新の導線（NativeTextStyleList 内の NativeTelopTemplateUpdate）を開く。
  const telopTemplateUpdate=useRef<TelopTemplateUpdateHandle>(null);
  const [queue]=useState(()=>new InspectorIntentQueue(setOwnedPending,cause=>setError(nativeCommandErrorMessage(cause))));
  const [revisions]=useState(()=>new InspectorRevisionGuard());
  const drafts=useRef(new Set<string>());
  const reportDraft=useCallback((id:string,dirty:boolean)=>{if(dirty)drafts.current.add(id);else drafts.current.delete(id);setDraft(drafts.current.size>0);},[]);
  useEffect(()=>{onDraftChange?.(draft||ownedPending>0);},[draft,ownedPending,onDraftChange]);
  // T16: 各欄が使えるかの条件は 1 か所で持つ（同じ式を欄ごとに書き写すと片方だけ直り得る）。
  // 自分が出した編集の確定待ち（ownedPending>0）のあいだは、外からの disabled では閉じない。
  const fieldsDisabled=externalBusy||(disabled&&ownedPending===0);
  const blur=()=>{
    const active=window.document.activeElement;if(active instanceof HTMLElement&&element.current?.contains(active))active.blur();
  };
  const flush=async()=>{
    do{
      blur();
      // A field reports its commit synchronously. If blur cannot reach a draft,
      // finish the queued work and fail this transition rather than spin forever.
      const unreachableDraft=drafts.current.size>0;
      if(!await queue.flush())return false;
      if(unreachableDraft){setError('入力を確定できませんでした。編集中の欄を確認して、もう一度操作してください。');return false;}
      // Inputs remain editable during owned saves. Include any new draft made
      // while awaiting the previous commit before allowing save/view changes.
    }while(drafts.current.size>0||queue.pending>0);
    return true;
  };
  // Registration is synchronous, including button actions after their input's blur.
  const enqueue=(work:(current:SequenceDocument)=>Promise<boolean>,reportFailure=true)=>{
    const displayed={id:doc.id,revision:doc.revision},origin=projectId;
    return queue.enqueue(async()=>{
      const bindings=latest.current,current=bindings.readDocument();
      if(!current||bindings.projectId!==origin||bindings.externalBusy)throw new Error('別の処理中のため変更できません。内容を確認して、もう一度入力してください。');
      revisions.before(displayed,current);
      const before={id:current.id,revision:current.revision},ok=await work(current);
      if(ok){const after=bindings.readDocument();if(!after)throw new Error('編集対象が閉じられました。');revisions.accepted(before,after);}
      return ok;
    },reportFailure);
  };
  useImperativeHandle(ref,()=>({flush,blurDraft:blur}));
  const clip = doc.clips.find(c => c.id === selected[0]), [colorCopy, setColorCopy] = useState<Pick<ClipVisual, 'colorGrade' | 'lut'> | null>(null);
  const [guard,setGuard]=useState<AnimationGuardRequest|null>(null);
  useEffect(()=>{setGuard(null);},[clip?.id]);
  const kind=inspectorSelectionKind(doc,selected),sections=new Set(inspectorSections(kind));
  const currentClip=(document:SequenceDocument)=>{const current=document.clips.find(item=>item.id===clip?.id);if(!current)throw new Error('編集対象のクリップが見つかりません。');return current;};
  const command=(build:(current:SequenceClip,document:SequenceDocument)=>NativeCommand,reportFailure=true)=>enqueue(current=>latest.current.dispatch(build(currentClip(current),current)),reportFailure);
  const update=(change:(current:SequenceClip)=>void,reportFailure=true)=>command(current=>{const changed=structuredClone(current);change(changed);return {type:'update-clip',clipId:current.id,patch:{name:changed.name,content:changed.content,visual:changed.visual}};},reportFailure);
  const changeContent:ChangeContent=(kind,change)=>update(current=>{if(current.content.kind!==kind)throw new Error('クリップの種類が変わりました。');change(current.content as Parameters<typeof change>[0]);});
  const visual: ClipVisual = clip?.visual ?? { layout: structuredClone(DEFAULT_MAIN_LAYOUT), opacity: 1, keyframes: [] };
  const colorOwnerKey=JSON.stringify([projectId,doc.id,selected]);
  const colorOwner=useRef(colorOwnerKey);colorOwner.current=colorOwnerKey;
  useEffect(()=>{colorOwner.current=colorOwnerKey;return ()=>{colorOwner.current='';};},[]);
  const colorCurrent=()=>{
    const current=latest.current.readDocument();
    if(colorOwner.current!==colorOwnerKey||latest.current.externalBusy||!current)return false;
    try{revisions.before({id:doc.id,revision:doc.revision},current);return true;}catch{return false;}
  };
  const layout = visual.layout;
  const changeVisual:ChangeVisual=change=>update(current=>{current.visual??={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]};change(current.visual);});
  const transform = (patch: Partial<ClipVisual['layout']>) => changeVisual(current=>Object.assign(current.layout,patch));
  const text = clip?.content.kind === 'telop' || clip?.content.kind === 'title' ? clip.content : null;
  const typography = (patch: Partial<TextAppearance>) => changeContent('telop',current=>{current.appearance={...(current.appearance??DEFAULT_TEXT_APPEARANCE),...patch};});
  const luts = doc.assets.filter(a => a.kind === 'lut');
  const speedEdit=(build:(current:SequenceDocument)=>NativeCommand)=>enqueue(current=>latest.current.dispatch(build(current)));
  const speedAction=async(build:(current:SequenceDocument)=>NativeCommand)=>await flush()?speedEdit(build):false;
  const fadeTarget:SceneFadeTarget=clip?.content.kind==='scene-fade'?{kind:'clip',clipId:clip.id}:sceneFadeTarget;
  const telopContent=text?.kind==='telop'?text:undefined;
  const currentSupport=telopContent?textAnimationSupport(doc,telopContent):null;
  const currentAnimation=(telopContent?.data.animation??'none') as TelopAnimationId;
  /** 移る先の能力集合で今の動きが描けないときだけ 2 択を出し、描けるならそのまま実行する。 */
  const guardThen=(next:ReturnType<typeof assetAnimationSupport>,detail:string,run:(clearAnimation:boolean)=>void)=>{
    if(currentAnimation==='none'||supportsAnimation(next,currentAnimation)){run(false);return;}
    setGuard({title:'動きが使えない組み合わせ',
      detail:`${detail}${UNSUPPORTED_ANIMATION_REASON}「${TELOP_ANIMATION_LABELS[currentAnimation].name}」をどうしますか。`,
      keepLabel:'動きを保持して変更を中止',clearLabel:'動きを解除して変更',
      onKeep:()=>{},onClear:()=>run(true)});
  };
  const groups=inspectorGroups(kind);
  const isOpen=(group:InspectorGroupId)=>openMap[`${kind}:${group}`]??defaultGroupOpen(kind,group);
  /**
   * 群の枠。コンポーネントにせず関数にする（毎描画で remount して入力欄の下書きを失わないため）。
   * group で data-group を付ける（仕上げフィルタ対策）。
   *
   * M-2': 中身の有無は `visualSettingsHasContent` など**描画条件の写し**で判定している箇所がある。
   * `visual` に依存する分岐を足すなら `NativeVisualSettings.test.tsx` の fixture（いまは keyframes 空・
   * opacity 1 の 1 形だけ）も増やすこと。増やさないと写しが黙って外れ、空の見出しが戻る。
   */
  const group=(id:InspectorGroupId,children:ReactNode)=>{
    if(!groups.includes(id))return null;
    // M-5: 複数選択では中身が条件で全部落ちることがある（テロップ 2 件の「見た目」）。空の見出しは出さない。
    // 渡されるのは <>…</> なので、断片の中身を数える（`Children.toArray` は null/false を落とす）。
    const inner=isValidElement(children)&&children.type===Fragment?(children.props as {children?:ReactNode}).children:children;
    if(Children.toArray(inner).length===0)return null;
    return <NativeInspectorSection key={id} group setting={id} label={INSPECTOR_GROUP_LABEL[id]} summary={summarizeGroup(id,doc,clip??null)} open={isOpen(id)} onOpenChange={open=>setGroupOpen(`${kind}:${id}`,open)} beforeClose={flush}>{children}</NativeInspectorSection>;
  };
  /**
   * M-9: 「すべて畳む」は実際に描いた群が 2 つ以上のときだけ出す。`ref`/`state`/`effect` の 1 拍遅れ
   * （旧: layout effect でカウントを取り込む）をやめ、`group()` の戻りをここで先に組んでから
   * ヘッダーと本体の両方がその同じ値を使う（二重の正本を避ける・ちらつきも出ない）。
   */
  const contentSection=clip&&group('content',<>
        {sections.has('text-body')&&text?.kind==='telop'&&<section data-setting="captions"><h3>文字</h3>
          <TextField value={text.data.text} onCommit={value => update(current=>{if(current.content.kind!=='telop')throw new Error('文字クリップが変わりました。');current.name=value||'テキスト';current.content.data.text=value;})} />
          {/* I-3: ピッカーはポータルで fieldset の外に出るので、無効化の条件（fieldsDisabled）を明示で渡す。 */}
          {sections.has('text-style-list')&&<NativeTextStyleList ref={telopTemplateUpdate} projectId={projectId} document={doc} content={text}
            assets={doc.assets.filter(asset=>asset.kind==='component'&&asset.textStyleCatalog)}
            hidden={doc.textStylePrefs?.hidden??{}} disabled={fieldsDisabled}
            preparation={textStylePreparation(doc)} onPrepare={onPrepareTextStyles}
            applyAllCount={doc.clips.filter(c=>c.content.kind==='telop'&&c.trackId===clip.trackId).length}
            applyAllTrackName={doc.tracks.find(track=>track.id===clip.trackId)?.name??clip.trackId}
            onChoose={(assetId,styleId)=>new Promise<boolean>(resolve=>guardThen(
              // 移る先は (assetId, styleId) の組で決まる。styleId を渡さないとカタログ単位（35 種すべてが
              // charByChar を名乗る集合）へ落ち、「選べるのに動かない」字幕がそのまま作られる（B6-1）。
              assetAnimationSupport(doc.assets.find(asset=>asset.id===assetId),styleId),'選んだスタイルの部品に切り替えます。',
              clearAnimation=>void changeContent('telop',current=>{Object.assign(current,withTextMode(current,'component'));
                current.componentAssetId=assetId;current.data.template=styleId;
                if(clearAnimation)current.data.animation='none';}).then(resolve)))}
            onApplyAll={(assetId,styleId)=>new Promise<boolean>(resolve=>{
              const target=doc.assets.find(asset=>asset.id===assetId);
              const losing=telopClipsLosingAnimation({...doc,clips:doc.clips.filter(c=>c.trackId===clip.trackId)},target,styleId);
              if(!losing.length){void enqueue(async()=>latest.current.dispatch({type:'apply-text-style-all',assetId,styleId,trackId:clip.trackId})).then(resolve);return;}
              setGuard({title:'動きが使えない組み合わせ',
                detail:`同じトラックの文字 ${doc.clips.filter(c=>c.content.kind==='telop'&&c.trackId===clip.trackId).length}件に適用します。そのうち ${losing.length}件の動きを解除します。${UNSUPPORTED_ANIMATION_REASON}`,
                keepLabel:'動きを保持して変更を中止',clearLabel:`動きを解除して ${losing.length}件を変更`,
                onKeep:()=>resolve(false),
                onClear:()=>void enqueue(async()=>latest.current.dispatch({type:'apply-text-style-all',assetId,styleId,trackId:clip.trackId,clearUnsupportedAnimations:true})).then(resolve)});
            })}
            onHiddenChange={(assetId,hidden)=>enqueue(async()=>latest.current.dispatch({type:'set-text-style-hidden',assetId,hidden}))}
            onRegisterAsset={asset=>enqueue(async()=>latest.current.dispatch({type:'register-assets',assets:[asset]}))}
            onReplaceAsset={(fromAssetId,toAssetId)=>enqueue(async()=>latest.current.dispatch({type:'replace-text-style-asset',fromAssetId,toAssetId}))}/>}
          {telopContent&&<NativeInspectorSection setting="animation-list" label="動きのカタログ" initiallyOpen={false} beforeClose={flush}
            summary={TELOP_ANIMATION_LABELS[currentAnimation]?.name??'なし'}>
            <NativeAnimationList projectId={projectId} document={doc} content={telopContent} clip={clip}
              assets={doc.assets.filter(asset=>asset.textStyleCatalog)} disabled={disabled}
              onChoose={id=>changeContent('telop',current=>{current.data.animation=id;})}
              onEnableNewAnimations={()=>telopTemplateUpdate.current?.open()}/>
          </NativeInspectorSection>}
          <SelectField label="アニメーション" value={currentAnimation} onCommit={value => changeContent('telop',current=>{current.data.animation=value as typeof current.data.animation;})}>
            <optgroup label="基本">
              {TELOP_ANIMATION_IDS.filter(id=>!NEW_TELOP_ANIMATION_IDS.includes(id as never)).map(id=>
                <option key={id} value={id} disabled={id!==currentAnimation&&!supportsAnimation(currentSupport,id)}>{TELOP_ANIMATION_LABELS[id].name}</option>)}
            </optgroup>
            <optgroup label="新しい動き">
              {NEW_TELOP_ANIMATION_IDS.map(id=>
                <option key={id} value={id} disabled={id!==currentAnimation&&!supportsAnimation(currentSupport,id)}>{TELOP_ANIMATION_LABELS[id].name}</option>)}
            </optgroup>
          </SelectField>
        </section>}
        {sections.has('title-body')&&text?.kind==='title'&&<section data-setting="captions"><h3>タイトル</h3>
          <TextField value={text.data.text} onCommit={value => update(current=>{if(current.content.kind!=='title')throw new Error('文字クリップが変わりました。');current.name=value||'テキスト';current.content.data.text=value;})} />
        </section>}
      </>);
  const lookSection=clip&&group('look',<>
        {sections.has('text-mode')&&text?.kind==='telop'&&<section data-setting="captions"><h3>文字の見た目</h3>
          {activeTextAppearance(text) && text.appearance ? <>
            {sections.has('font')&&<NativeFontField value={text.appearance.fontFamily} disabled={fieldsDisabled}
              onCommit={fontFamily=>void typography({fontFamily:telopFontFamilyValue(fontFamily)})}/>}
            <NumberField label="文字サイズ（px）" value={text.appearance.fontSize} min={1} max={1000} onCommit={fontSize => typography({ fontSize })} />
            <NumberField label="太さ" value={text.appearance.fontWeight} min={100} max={900} step={100} onCommit={fontWeight => typography({ fontWeight:Math.round(fontWeight) })} />
            <ColorField label="文字色" value={text.appearance.color} onCommit={color=>typography({color})}/>
            <NumberField label="縁取り（px）" value={text.appearance.strokeWidth} min={0} max={40} onCommit={strokeWidth => typography({ strokeWidth })} />
            <ColorField label="縁取りの色" value={text.appearance.strokeColor} onCommit={strokeColor=>typography({strokeColor})}/>
            <NumberField label="行間" value={text.appearance.lineHeight} min={.5} max={5} step={.1} onCommit={lineHeight => typography({lineHeight})} />
            <NumberField label="字間（px）" value={text.appearance.letterSpacing} min={-100} max={100} step={.5} onCommit={letterSpacing => typography({letterSpacing})} />
            <SelectField label="文字揃え" value={text.appearance.align} onCommit={value=>typography({align:value as TextAppearance['align']})}><option value="left">左</option><option value="center">中央</option><option value="right">右</option></SelectField>
            <CheckField label="背景を付ける" value={text.appearance.background !== 'transparent'} onCommit={value=>typography({background:value?'#000000':'transparent'})}/>
            {text.appearance.background !== 'transparent' && <ColorField label="背景色" value={text.appearance.background} onCommit={background=>typography({background})}/>}
            {textComponentId(doc,text)&&<button onClick={()=>guardThen(
              // template は据え置きだが、描くのは text.data.template のスタイル。カタログ単位へ落とすと過小警告（F6-1）。
              assetAnimationSupport(doc.assets.find(asset=>asset.id===textComponentId(doc,text)),text.data.template??1),'スタイルの部品に切り替えます。',
              clearAnimation=>void changeContent('telop',current=>{Object.assign(current,withTextMode(current,'component'));
                if(clearAnimation)current.data.animation='none';}))}>スタイルを使う</button>}
          </> : <><NumberField label="スタイル番号" value={text.data.template ?? 1} min={1} onCommit={value => changeContent('telop',current=>{current.data.template=Math.round(value);})} />
            <button className="native-text-button" onClick={() => changeContent('telop',current=>Object.assign(current,withTextMode(current,'free')))}>自由な書式に切り替える</button></>}
        </section>}
        {sections.has('title-body')&&text?.kind==='title'&&<section data-setting="captions"><h3>文字の見た目</h3>
          {sections.has('font')&&<NativeFontField value={text.style.fontFamily??DEFAULT_TITLE_FONT_FAMILY} disabled={fieldsDisabled}
            onCommit={fontFamily=>void changeContent('title',current=>{current.style.fontFamily=fontFamily;})}/>}
          <NumberField label="文字サイズ" value={text.style.fontSize} min={8} max={300} onCommit={value => changeContent('title',current=>{current.style.fontSize=value;})} />
        </section>}
        {visualSettingsHasContent('look',clip)&&<NativeVisualSettings part="look" clip={clip} visual={visual} onContent={changeContent} onVisual={changeVisual} resolution={doc.resolution}/>}
        {clip.content.kind === 'video' && <section data-setting="color"><h3>カラー</h3><p className="native-subtle">スライダーで見た目を整え、数値で微調整できます。</p>
          {([['brightness', '明るさ'], ['contrast', 'コントラスト'], ['saturation', '彩度'], ['temperature', '色温度']] as [ColorGradeField, string][]).map(([field, label]) =>
            <NumberField key={field} label={label} value={(visual.colorGrade ?? defaultColorGrade())[field]} min={-100} max={100}
              onCommit={value => changeVisual(current=>{current.colorGrade??=defaultColorGrade();current.colorGrade[field]=value;})} />)}
          <NativeColorWheels key={JSON.stringify([projectId,doc.id,clip.id])} ownerKey={colorOwnerKey} revision={doc.revision} clipId={clip.id} visual={visual}
            disabled={fieldsDisabled} isCurrent={colorCurrent} onPreview={onPreviewVisual}
            onCommit={(name,_value,change)=>update(current=>{if(!colorCurrent())throw new Error('色の編集対象が変わりました。もう一度操作してください。');current.visual??={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]};current.visual.colorGrade??=defaultColorGrade();const wheels=normalizeColorWheels(current.visual.colorGrade.wheels);current.visual.colorGrade.wheels={...wheels,[name]:applyColorWheelChange(wheels[name],change)};})}/>
          <SelectField label="LUT" value={visual.lut?.assetId ?? ''} onCommit={value=>changeVisual(current=>{if(value)current.lut={assetId:value,intensity:current.lut?.intensity??1};else delete current.lut;})}><option value="">適用なし</option>{luts.map(lut => <option key={lut.id} value={lut.id}>{lut.name}</option>)}</SelectField>
          <button className="native-text-button" onClick={onUploadLut}>.cubeファイルを読み込む</button>
          {visual.lut && <><NumberField label="LUTの強度（%）" value={visual.lut.intensity * 100} min={0} max={100} onCommit={value => changeVisual(current=>{if(!current.lut)throw new Error('LUTが変わりました。');current.lut.intensity=value/100;})} />
            <label className="native-check"><input type="checkbox" checked={bypassLut} onChange={event => onBypass(event.target.checked)} />LUT適用前と比較</label></>}
          <div className="native-property-actions"><button onClick={() => {blur();void enqueue(async document=>{const current=currentClip(document).visual;setColorCopy(structuredClone({colorGrade:current?.colorGrade,lut:current?.lut}));return true;});}}>設定をコピー</button>
            <button disabled={!colorCopy} onClick={() => {
              if (!colorCopy) return;
              void command((_,document)=>({ type: 'batch', commands: document.clips.filter(c => selected.includes(c.id) && c.content.kind === 'video').map(c => ({ type: 'update-clip', clipId: c.id,
                patch: { visual: { ...(c.visual ?? {layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]}), ...structuredClone(colorCopy) } } })) }));
            }}>貼り付け</button></div>
        </section>}
        {clip.content.kind==='audio'&&<section data-setting="audio"><h3>音声</h3>
          <NumberField label="音量（dB）" value={clip.content.settings.gainDb} min={-60} max={12} step={.5} onCommit={value => changeContent('audio',current=>{current.settings.gainDb=value;})} />
          <CheckField label="ミュート" value={clip.content.settings.muted} onCommit={muted=>changeContent('audio',current=>{current.settings.muted=muted;})}/>
        </section>}
      </>);
  const placeSection=clip&&group('place',<>
        {(clip.content.kind === 'video' || clip.content.kind === 'image') && <section data-setting="layout"><h3>位置とサイズ</h3>
          {visual.keyframes.length>0&&<p className="native-subtle">位置キーの値が優先されます。範囲外を「元の配置」にすると、点の外ではこの設定が使われます。</p>}
          {clip.content.kind==='image'&&<NativePositionPresets preset="layer" disabled={disabled} current={{x:layout.position.x,y:layout.position.y}}
            onPick={position=>void changeVisual(current=>{current.layout.position.x=position.x;current.layout.position.y=position.y;})}/>}
          <NumberField label="横位置（%）" value={layout.position.x * 100} min={-100} max={100} onCommit={value => changeVisual(current=>{current.layout.position.x=value/100;})} />
          <NumberField label="縦位置（%）" value={layout.position.y * 100} min={-100} max={100} onCommit={value => changeVisual(current=>{current.layout.position.y=value/100;})} />
          <NumberField label="スケール（%）" value={layout.scale * 100} min={10} max={500} onCommit={value => transform({ scale: value / 100 })} />
          <NumberField label="回転（°）" value={layout.rotation} min={-180} max={180} onCommit={value => transform({ rotation: value })} />
          <NumberField label="不透明度（%）" value={visual.opacity * 100} min={0} max={100} onCommit={value => changeVisual(current=>{current.opacity=value/100;})} />
          {clip.content.kind === 'video' && <CheckField label="左右反転" value={layout.flipH} onCommit={flipH=>transform({flipH})}/>}
        </section>}
        {sections.has('text-body')&&text?.kind==='telop'&&<section data-setting="captions"><h3>文字の配置</h3>
          <p className="native-subtle">ここは文字自体の元の位置と大きさです。プレビューの直接操作は「レイヤーの基本配置」または現在の位置キーへ反映されます。</p>
          <NumberField label="大きさ（%）" value={(text.data.scale ?? 1) * 100} min={10} max={500} onCommit={value => changeContent('telop',current=>{current.data.scale=value/100;})} />
          {sections.has('position-3x3')&&<NativePositionPresets preset="caption" disabled={disabled}
            current={{x:text.data.position?.x??0,y:text.data.position?.y??0}}
            onPick={position=>void changeContent('telop',current=>{current.data.position={x:position.x,y:position.y};})}/>}
          <NumberField label="文字の横位置" value={(text.data.position?.x ?? 0) * 100} min={-100} max={100} onCommit={value => changeContent('telop',current=>{current.data.position={x:value/100,y:current.data.position?.y??0};})} />
          <NumberField label="文字の縦位置" value={(text.data.position?.y ?? 0) * 100} min={-100} max={100} onCommit={value => changeContent('telop',current=>{current.data.position={x:current.data.position?.x??0,y:value/100};})} />
        </section>}
        {sections.has('title-body')&&text?.kind==='title'&&<section data-setting="captions"><h3>文字の配置</h3>
          <NumberField label="左位置" value={text.style.left} onCommit={value => changeContent('title',current=>{current.style.left=value;})} />
          <NumberField label="上位置" value={text.style.top} onCommit={value => changeContent('title',current=>{current.style.top=value;})} />
        </section>}
        {visualSettingsHasContent('place',clip)&&<NativeVisualSettings part="place" clip={clip} visual={visual} onContent={changeContent} onVisual={changeVisual} resolution={doc.resolution}/>}
      </>);
  const motionSection=clip&&group('motion',<>
        {visualSettingsHasContent('motion',clip)&&<NativeVisualSettings part="motion" clip={clip} visual={visual} onContent={changeContent} onVisual={changeVisual} resolution={doc.resolution}/>}
        <NativeKeyframeSettings clip={clip} frame={frame} fps={doc.fps}
          timing={<NativeMotionTiming key={clip.id} clip={clip} fps={doc.fps} onEdit={build=>command(build)} onAction={build=>{blur();return command(build);}}/>}
          onFieldAction={change=>update(current=>{current.visual=change(current);})}
          onAction={change=>{blur();return update(current=>{current.visual=change(current);},false);}}
          onSeek={key=>{blur();void enqueue(async document=>{const current=currentClip(document);const at=timeNumber(keyframeTimelineTime(current,key));if(at>=current.startFrame&&at<clipEnd(current))onSeek(Math.min(clipEnd(current)-1,Math.round(at)));return true;});}}/>
        {clip.content.kind==='audio'&&<section data-setting="audio"><h3>フェード</h3>
          <NumberField label="フェードイン（秒）" value={fadeSeconds(clip.content.settings.fadeInFrames,doc.fps)} min={0} max={fadeSeconds(clip.durationFrames,doc.fps)} step={.1} onCommit={value=>changeContent('audio',current=>{current.settings.fadeInFrames=fadeFrames(value,doc.fps);})}/>
          <NumberField label="フェードアウト（秒）" value={fadeSeconds(clip.content.settings.fadeOutFrames,doc.fps)} min={0} max={fadeSeconds(clip.durationFrames,doc.fps)} step={.1} onCommit={value=>changeContent('audio',current=>{current.settings.fadeOutFrames=fadeFrames(value,doc.fps);})}/>
        </section>}
      </>);
  const timeSection=clip&&group('time',<>
        <NativeClipSpeedSettings document={doc} clip={clip} onEdit={speedEdit} onAction={speedAction}/>
        <section data-setting="timing"><h3>タイミング</h3><NumberField label="開始（fr）" value={clip.startFrame} min={0} onCommit={value => command(current=>({ type: 'move', clipIds: [current.id], deltaFrames: Math.round(value) - current.startFrame }))} />
          <NumberField label="長さ（fr）" value={clip.durationFrames} min={1} onCommit={value => command(current=>({ type: 'trim', clipId: current.id, edge: 'end', frame: current.startFrame + Math.round(value) }))} />
          <p className="native-subtle">{clip.startFrame} → {clipEnd(clip)} フレーム</p>
          {clip.linkGroupId && <button onClick={() => void command(current=>({ type: 'unlink', clipIds: [current.id] }))}>映像と音声の連動を解除</button>}
        </section>
      </>);
  const projectSection=group('project',<>
      {sections.has('project-ducking')&&<NativeDuckingSettings document={doc} disabled={fieldsDisabled} onEdit={build=>enqueue(current=>latest.current.dispatch(build(current)))}/>}
      {sections.has('project-audio-fix')&&<NativeAudioFixSettings projectId={projectId} document={doc} readDocument={readDocument}
        disabled={fieldsDisabled} exporting={exporting}
        onEdit={build=>enqueue(current=>latest.current.dispatch(build(current)))} onNotice={onNotice}
        onRegister={async assetIds=>{
          // 素材の登録は revision を 1 つ進める。続く参照切替は「表示中より 1 つ先」の文書へ当たるので、
          // この自分の前進を履歴（chain）へ記録してから戻す。記録しないと表示ずれとして弾かれる。
          const before=latest.current.readDocument();if(!before)return false;
          if(!await onRegisterAssets(assetIds))return false;
          const after=latest.current.readDocument();if(!after)return false;
          try{revisions.accepted({id:before.id,revision:before.revision},{id:after.id,revision:after.revision});}catch{return false;}
          return true;
        }}/>}
      {sections.has('project-speed')&&<InspectorDraftContext.Provider value={reportDraft}><NativeGlobalSpeedSettings key={doc.id} document={doc} selected={selected} disabled={fieldsDisabled} onEdit={speedEdit} onAction={speedAction}/></InspectorDraftContext.Provider>}
      {(showSceneFades||sections.has('project-transitions')||clip?.content.kind==='scene-fade')&&<InspectorDraftContext.Provider value={reportDraft}><NativeSceneFadeSettings key={sceneFadeTargetKey(fadeTarget)} document={doc} target={fadeTarget} disabled={sceneFadeSwitching||fieldsDisabled} onTarget={onSceneFadeTargetChange} onEdit={build=>enqueue(current=>latest.current.dispatch(build(current)))}/></InspectorDraftContext.Provider>}
      {(showSceneFades||sections.has('project-transitions')||clip?.content.kind==='scene-fade')&&transitionJoinKey!==undefined&&<InspectorDraftContext.Provider value={reportDraft}><NativeTransitionSettings key={transitionJoinKey}
        document={doc} joinKey={transitionJoinKey} disabled={sceneFadeSwitching||fieldsDisabled}
        onJoin={onTransitionJoin} onEdit={build=>enqueue(current=>latest.current.dispatch(build(current)))}/></InspectorDraftContext.Provider>}
    </>);
  const drawnGroups=[contentSection,lookSection,placeSection,motionSection,timeSection,projectSection].filter(Boolean).length;
  return <aside ref={element} className="native-inspector" aria-label="プロパティ" onKeyDown={event=>{if(event.target instanceof HTMLElement&&event.target.closest('button')&&(event.key===' '||event.key==='Enter'))event.stopPropagation();}}>
    <div className="native-panel-heading"><span>{inspectorHeading(kind,clip?.name)}</span><span>{selected.length>1?`${selected.length}件選択`:''}</span>
      {drawnGroups>1&&<button type="button" className="btn-ghost native-inspector-foldall" disabled={fieldsDisabled} onClick={()=>{
        // 個別の畳みと同じく、入力の確定（flush）が通ってからまとめて閉じる。拒否・通信待ちなら何もしない（Codex 指摘 3）。
        const any=groups.some(isOpen);
        void (any?flush():Promise.resolve(true)).then(ok=>{if(ok)groups.forEach(g=>setGroupOpen(`${kind}:${g}`,!any));});
      }}>{groups.some(isOpen)?'すべて畳む':'すべて開く'}</button>}
    </div>
    {error&&<p className="native-subtle" role="alert">{error} <button onClick={()=>setError('')}>閉じる</button></p>}
    {!clip&&<div className="native-inspector-empty" role="note"><strong>クリップを選ぶと</strong><p className="native-subtle">その種類の項目（内容・見た目・配置・動き・時間）がここに出ます。</p></div>}
    {clip&&<InspectorDraftContext.Provider value={reportDraft}><fieldset key={clip.id} disabled={fieldsDisabled}>
      {contentSection}
      {lookSection}
      {placeSection}
      {motionSection}
      {timeSection}
      {/* 確認ダイアログは群の外（fieldset 直下）に置く。畳んだ群の中だと hidden に隠れて出せない。 */}
      <NativeAnimationGuard request={guard} onDismiss={()=>setGuard(null)}/>
    </fieldset></InspectorDraftContext.Provider>}
    {projectSection}
  </aside>;
});
