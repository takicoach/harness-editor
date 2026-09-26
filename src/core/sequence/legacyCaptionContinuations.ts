import {clipEnd,isMediaContent,type SequenceClip,type SequenceDocument} from './model';
import {compareTime,isRational,multiplyTime,rational,subtractTime} from './time';

/** Legacy migration splits one completed-timeline caption at source AV seams.
 * Its clocks need not be affine to source time across an old removed interval.
 * Give that explicitly shared continuation its own identity before allocating
 * separate source ledgers. Render IDs, source anchors and every clock stay put. */
export function normalizeLegacyCaptionContinuations(doc:SequenceDocument,selected:ReadonlySet<string>):void {
 if(!doc.legacy)return;
 const groups=new Map<string,SequenceClip[]>();
 for(const c of doc.clips)if(c.continuationGroupId){const items=groups.get(c.continuationGroupId)??[];items.push(c);groups.set(c.continuationGroupId,items);}
 const registered=new Set(doc.clips.flatMap(c=>c.speed?.captions?.flatMap(l=>[l.captionId,...l.parts.map(p=>p.reservedRenderId)])??[]));
 const used=new Set<string>();
 // A conservative reservation also includes pending archive IDs. No strings are
 // rewritten by this walk; only the selected, proven continuation slots below.
 const reserve=(value:unknown):void=>{if(typeof value==='string')used.add(value);else if(Array.isArray(value))value.forEach(reserve);else if(value&&typeof value==='object')Object.values(value).forEach(reserve);};reserve(doc);
 let serial=0;
 for(const [group,members] of groups){
  const first=members.find(c=>c.id===group);
  if(!first||members.length<2||first.content.kind!=='telop'||first.content.legacyId===undefined
   ||!members.some(c=>selected.has(c.id))||members.some(c=>registered.has(c.id)))continue;
  const legacyId=first.content.legacyId,firstAnchor=first.anchor;
  const sameClock=(a:SequenceClip['clock']|undefined,b:SequenceClip['clock']|undefined,c:SequenceClip)=>{
   if(!a||!b)return a===b;
   return compareTime(a.rate,b.rate)===0&&compareTime(a.duration,b.duration)===0&&compareTime(
    subtractTime(a.offset,multiplyTime(rational(first.startFrame),a.rate)),
    subtractTime(b.offset,multiplyTime(rational(c.startFrame),b.rate)))===0;
  };
  const firstProvider=firstAnchor?.kind==='source'?doc.clips.find(c=>c.id===firstAnchor.clipOccurrenceId):undefined;
  if(!firstProvider||!isMediaContent(firstProvider.content))continue;
  const assetId=firstProvider.content.assetId,stream=firstProvider.content.streamIndex,kind=firstProvider.content.kind;
  const ordered=[...members].sort((a,b)=>a.startFrame-b.startFrame);
  // Saved old subtitle witnesses identify the usage independently of a user's
  // effect-clock edits. Renaming an alias must not rewrite or equalize clocks.
  const policies=[...members.flatMap(c=>c.legacyCaptionContinuity?[c.legacyCaptionContinuity]:[]),...(doc.cutArchive?.entries.flatMap(e=>e.clips.flatMap(c=>c.legacyCaptionContinuity?[c.legacyCaptionContinuity]:[]))??[])].filter(p=>p.ownerClipId===group&&p.sourceFingerprint===doc.legacy!.sourceFingerprint);
  const witnessed=members.every(c=>c.anchor?.kind==='source'&&policies.some(p=>p.witnesses.some(w=>{
   const a=c.anchor;if(a?.kind!=='source')return false;const provider=doc.clips.find(x=>x.id===a.clipOccurrenceId);
   return (w.clipId===c.id||c.continuationGroupId===p.ownerClipId||c.legacyCaptionContinuity?.ownerClipId===p.ownerClipId)
    &&provider&&isMediaContent(provider.content)&&provider.content.assetId===w.assetId&&provider.content.streamIndex===w.streamIndex&&a.role===w.role
    &&compareTime(a.sourceStart,w.sourceStart)>=0&&compareTime(a.sourceEnd,w.sourceEnd)<=0;
  })));

  if(ordered.some((c,index)=>{
   const anchor=c.anchor;
   if(c.content.kind!=='telop'||c.content.legacyId!==legacyId||anchor?.kind!=='source'||anchor.role!==(firstAnchor?.kind==='source'?firstAnchor.role:undefined))return true;
   const provider=doc.clips.find(p=>p.id===anchor.clipOccurrenceId);
   return !provider||!isMediaContent(provider.content)||provider.content.kind!==kind||provider.content.assetId!==assetId||provider.content.streamIndex!==stream
    ||!witnessed&&(!sameClock(first.clock,c.clock,c)||!sameClock(first.visual?.keyframeClock,c.visual?.keyframeClock,c))
    ||index>0&&clipEnd(ordered[index-1]!)>c.startFrame;
  }))continue;
  // A group alias is not permission to rename a real object or edit-link ID.
  if([...doc.assets,...doc.tracks,...doc.transitions].some(v=>v.id===group)||doc.clips.some(c=>c.linkGroupId===group))continue;
  let replacement:string;do{replacement=`legacy-caption-continuation-${++serial}`;}while(used.has(replacement));used.add(replacement);
  for(const c of members)c.continuationGroupId=replacement;
 }
}

/** Closed metadata shared by visible clips and latent speed-ledger templates. */
export function isLegacyCaptionPolicy(value:unknown):boolean {
 const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
 const time=(v:unknown,positive=false)=>isRational(v)&&(positive?v.num>0:v.num>=0);
 const basis=(v:unknown)=>record(v)&&Object.keys(v).every(k=>['offset','slope','duration'].includes(k))&&time(v.offset)&&time(v.slope,true)&&time(v.duration,true);
 if(!record(value)||Object.keys(value).some(k=>!['version','sourceFingerprint','ownerClipId','witnesses'].includes(k))||value.version!==1
  ||typeof value.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceFingerprint)||!id(value.ownerClipId)||!Array.isArray(value.witnesses)||value.witnesses.length>10000)return false;
 return value.witnesses.every(w=>record(w)&&Object.keys(w).every(k=>['clipId','sourceStart','sourceEnd','assetId','streamIndex','role','clock','keyframeClock'].includes(k))
  &&id(w.clipId)&&id(w.assetId)&&Number.isSafeInteger(w.streamIndex)&&(w.streamIndex as number)>=0&&['speech','visual'].includes(w.role as string)
  &&isRational(w.sourceStart)&&w.sourceStart.num>=0&&isRational(w.sourceEnd)&&compareTime(w.sourceStart,w.sourceEnd)<0&&basis(w.clock)
  &&(w.keyframeClock===undefined||basis(w.keyframeClock)));
}
