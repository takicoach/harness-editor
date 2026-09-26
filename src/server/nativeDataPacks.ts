import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { assertFiniteNumbers, evalDataModule } from '../core/dataModule';
import { parseVideoConfigStatic } from '../core/videoConfig';
import { HttpError } from './http';

export type NativeDataPackId = 'bgm' | 'videoInsert' | 'speed' | 'transition' | 'mainLayout' | 'shape';
interface Definition { directory: string; marker: string; data: string; defaults: Record<string,string>; types?: string }
const DATA_TYPES: Partial<Record<NativeDataPackId,string>> = {
  "bgm": "export interface DuckEnvelope {\n  regions: Array<{ start: number; end: number }>;\n  gain: number;\n  attackFrames: number;\n  releaseFrames: number;\n}\n\nexport interface BgmClip {\n  id: number;\n  file: string;\n  startFrame: number;\n  endFrame: number;\n  volume: number;\n  fadeInFrames: number;\n  fadeOutFrames: number;\n  ducking?: DuckEnvelope;\n}\n",
  "videoInsert": "/** 挿入要素の出入りアニメ種別。 */\nexport type ElementAnimKind = 'none' | 'fade' | 'zoom' | 'pop' | 'slideIn';\n\n/** スライド/ワイプの方向（要素は slideIn で使用）。 */\nexport type SlideDirection = 'left' | 'right' | 'up' | 'down';\n\n/** 挿入要素の出入りアニメ 1 つぶん。frames はアニメ長（フレーム）。 */\nexport interface ElementAnim {\n  kind: ElementAnimKind;\n  frames: number;\n  /** slideIn のときの入ってくる方向（未指定＝left）。 */\n  direction?: SlideDirection;\n}\n\n/** サブ動画インサート（SuperMovie Editor が生成）。 */\nexport interface VideoInsert {\n  id: number;\n  startFrame: number;\n  endFrame: number;\n  file: string;\n  sourceInFrame: number;\n  position?: { x: number; y: number };\n  scale?: number;\n  /** エディタプレビュー用の解決済み URL（最終 render では未指定→staticFile へ）。 */\n  videoUrl?: string;\n  /** 登場アニメ（未指定＝なし＝従来挙動）。 */\n  enter?: ElementAnim;\n  /** 退場アニメ（未指定＝なし＝従来挙動）。 */\n  exit?: ElementAnim;\n  /** 再生速度（倍率・未指定＝1.0）。0.1〜16。D_source = (endFrame-startFrame)×playbackRate を保つ。 */\n  playbackRate?: number;\n}\n",
  "transition": "export type SceneTransitionKind =\n  | 'fadeBlack' | 'fadeWhite' | 'fadeColor' | 'crossfade' | 'slide' | 'wipe';\nexport type SlideDirection = 'left' | 'right' | 'up' | 'down';\nexport interface SceneTransition {\n  id: number;\n  at: 'head' | 'tail' | number;\n  kind: SceneTransitionKind;\n  durationFrames: number;\n  color?: string;\n  direction?: SlideDirection;\n}\n\n/** SuperMovie の cutData.ts が持つ CutSegment（残す＝再生する区間）。 */\nexport interface CutSegment {\n  id: number;\n  originalStart: number;\n  originalEnd: number;\n  playbackStart: number;\n  playbackEnd: number;\n}\n",
  "shape": "/**\n * shapePayload の型定義。\n * src/core/types.ts（ShapeKind / ShapeThickness / ShapeSegment）の独立コピー。\n * src/core への依存を持たない（staticFile / node:vm 非依存）。\n */\n\n/** 図形注釈の種類。 */\nexport type ShapeKind = 'arrow' | 'line' | 'rect' | 'ellipse';\n\n/** 図形の線の太さ（描画時にフレーム高さ比へ換算）。 */\nexport type ShapeThickness = 'thin' | 'medium' | 'thick';\n\n/**\n * 図形注釈（再生フレーム基準・プロジェクトの shapeData.ts に出力）。\n * 4 種すべてを 2 点 (x1,y1)-(x2,y2)（正規化 0..1・左上原点）で表す。\n * line/arrow=p1→p2 の線分、rect=2点を対角とする矩形、ellipse=2点の枠に内接する楕円。\n */\nexport interface ShapeSegment {\n  id: number;\n  startFrame: number;\n  endFrame: number;\n  kind: ShapeKind;\n  x1: number;\n  y1: number;\n  x2: number;\n  y2: number;\n  color: string;\n  thickness: ShapeThickness;\n  /** 不透明度（0..1、未指定＝1）。 */\n  opacity?: number;\n}\n"
};
const DEFINITIONS: Record<NativeDataPackId,Definition> = {
  bgm: {directory:'Bgm',marker:'bgm-track.json',data:'src/Bgm/bgmData.ts',defaults:{bgmData:'[]'},types:DATA_TYPES.bgm},
  videoInsert: {directory:'InsertVideo',marker:'insert-video.json',data:'src/InsertVideo/insertVideoData.ts',defaults:{insertVideoData:'[]'},types:DATA_TYPES.videoInsert},
  transition: {directory:'Transition',marker:'transition.json',data:'src/Transition/transitionData.ts',defaults:{transitionData:'[]'},types:DATA_TYPES.transition},
  shape: {directory:'InsertShape',marker:'insert-shape.json',data:'src/InsertShape/shapeData.ts',defaults:{shapeData:'[]'},types:DATA_TYPES.shape},
  speed: {directory:'Speed',marker:'speed.json',data:'src/speedData.ts',defaults:{MAIN_SPEED:'1',SEGMENT_SPEEDS:'{}'}},
  mainLayout: {directory:'MainLayout',marker:'main-layout.json',data:'src/mainLayoutData.ts',defaults:{
    MAIN_LAYOUT:'{ position: { x: 0, y: 0 }, scale: 1, background: "#000000", rotation: 0, flipH: false, flipV: false }',
    SEGMENT_LAYOUTS:'{}',LAYOUT_KEYFRAMES:'[]',COLOR_GRADE:'{ brightness: 0, contrast: 0, saturation: 0, temperature: 0 }'}},
};
export function isNativeDataPackId(id: string): id is NativeDataPackId { return Object.hasOwn(DEFINITIONS,id); }
export function nativeDataPackVersion(id:NativeDataPackId):string {
  return createHash('sha256').update(JSON.stringify({runtime:'harness-native',schemaVersion:1,feature:id,definition:DEFINITIONS[id]})).digest('hex').slice(0,16);
}
function markerPath(id:NativeDataPackId,dir:string) {const d=DEFINITIONS[id];return join(dir,'src',d.directory,d.marker);}
function readOptional(path:string):string|null {
  try {if(!lstatSync(path).isFile())throw new Error(`通常のファイルではありません: ${path}`);return readFileSync(path,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
function check(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
function optionalNumbers(value:Record<string,unknown>,keys:readonly string[],name:string):void {
  for(const key of keys)if(value[key]!==undefined)check(finite(value[key]),`${name}.${key} が不正です`);
}
function motionFields(value:unknown,name:string):void {
  check(record(value),`${name} が不正です`);
  check(['zoomIn','zoomOut','panLeft','panRight','fadeIn','custom','keyframes'].includes(String(value.preset)),`${name}.preset が不正です`);
  optionalNumbers(value,['intensity'],name);
  for(const key of ['from','to'])if(value[key]!==undefined){check(record(value[key]),`${name}.${key} が不正です`);optionalNumbers(value[key],['x','y','scale','opacity','rotation'],`${name}.${key}`);}
  if(value.keys!==undefined){check(Array.isArray(value.keys),`${name}.keys が不正です`);for(const item of value.keys){check(record(item)&&finite(item.t),`${name}.keys の時刻が不正です`);optionalNumbers(item,['x','y','scale','opacity','rotation'],`${name}.keys`);}}
}
function animationFields(value:unknown,name:string):void {
  check(record(value)&&['none','fade','zoom','pop','slideIn'].includes(String(value.kind))&&finite(value.frames),`${name} が不正です`);
  if(value.direction!==undefined)check(['left','right','up','down'].includes(String(value.direction)),`${name}.direction が不正です`);
}
function layoutFields(value:unknown,name:string):void {
  check(record(value),`${name} はオブジェクトが必要です`);
  if(value.position!==undefined){check(record(value.position),`${name}.position が不正です`);optionalNumbers(value.position,['x','y'],`${name}.position`);}
  optionalNumbers(value,['scale','rotation'],name);
  for(const key of ['flipH','flipV'])if(value[key]!==undefined)check(typeof value[key]==='boolean',`${name}.${key} が不正です`);
  if(value.background!==undefined)check(typeof value.background==='string',`${name}.background が不正です`);
  if(value.motion!==undefined)motionFields(value.motion,`${name}.motion`);
}
function validateValue(id:NativeDataPackId,name:string,value:unknown):void {
  assertFiniteNumbers(DEFINITIONS[id].data,name,value);
  if(name==='MAIN_SPEED')check(finite(value),'MAIN_SPEED は有限の数値が必要です');
  else if(name==='SEGMENT_SPEEDS'){
    check(record(value),'SEGMENT_SPEEDS は区間別の値が必要です');
    for(const [key,rate] of Object.entries(value))check(Number.isInteger(Number(key))&&finite(rate),'SEGMENT_SPEEDS の区間と速度が不正です');
  }else if(name==='MAIN_LAYOUT')layoutFields(value,name);
  else if(name==='SEGMENT_LAYOUTS'){
    check(record(value),`${name} はオブジェクトが必要です`);
    for(const [key,item] of Object.entries(value)){check(Number.isInteger(Number(key)),`${name} の区間が不正です`);layoutFields(item,`${name}.${key}`);}
  }else if(name==='COLOR_GRADE'){
    check(record(value),`${name} はオブジェクトが必要です`);
    for(const key of ['brightness','contrast','saturation','temperature'])if(value[key]!==undefined)check(finite(value[key]),`${name}.${key} が不正です`);
    if(value.wheels!==undefined){check(record(value.wheels),`${name}.wheels が不正です`);for(const key of ['lift','gamma','gain'])if(value.wheels[key]!==undefined){check(record(value.wheels[key]),`${name}.wheels.${key} が不正です`);optionalNumbers(value.wheels[key],['x','y','level'],`${name}.wheels.${key}`);}}
  }
  else {
    check(Array.isArray(value),`${name} 配列が必要です`);
    for(const [index,item] of value.entries()){
      check(record(item),`${name}[${index}] が不正です`);
      if(name==='LAYOUT_KEYFRAMES')for(const key of ['originalFrame','x','y','scale','rotation'])check(finite(item[key]),`${name}[${index}].${key} が不正です`);
      else {
        check(finite(item.id),`${name}[${index}].id が不正です`);
        if(id==='transition'){
          check((finite(item.at)||item.at==='head'||item.at==='tail')&&['fadeBlack','fadeWhite','fadeColor','crossfade','slide','wipe'].includes(String(item.kind))&&finite(item.durationFrames),`${name}[${index}] の転換設定が不正です`);
          if(item.direction!==undefined)check(['left','right','up','down'].includes(String(item.direction)),`${name}[${index}].direction が不正です`);
          if(item.color!==undefined)check(typeof item.color==='string',`${name}[${index}].color が不正です`);
        }
        else check(finite(item.startFrame)&&finite(item.endFrame),`${name}[${index}] の区間が不正です`);
        if(id==='bgm'||id==='videoInsert')check(typeof item.file==='string',`${name}[${index}].file が不正です`);
        if(id==='shape') {check(['arrow','line','rect','ellipse'].includes(String(item.kind))&&typeof item.color==='string'&&['thin','medium','thick'].includes(String(item.thickness)),`${name}[${index}] の図形設定が不正です`);for(const key of ['x1','y1','x2','y2'])check(finite(item[key]),`${name}[${index}].${key} が不正です`);optionalNumbers(item,['opacity'],`${name}[${index}]`);}
        if(id==='videoInsert'){
          check(finite(item.sourceInFrame),`${name}[${index}].sourceInFrame が不正です`);optionalNumbers(item,['scale','playbackRate'],`${name}[${index}]`);
          if(item.position!==undefined)check(record(item.position)&&finite(item.position.x)&&finite(item.position.y),`${name}[${index}].position が不正です`);
          for(const key of ['enter','exit'])if(item[key]!==undefined)animationFields(item[key],`${name}[${index}].${key}`);
        }
        if(id==='bgm'){
          optionalNumbers(item,['volume','fadeInFrames','fadeOutFrames'],`${name}[${index}]`);
          if(item.ducking!==undefined){const duck=item.ducking;check(record(duck)&&finite(duck.gain)&&finite(duck.attackFrames)&&finite(duck.releaseFrames)&&Array.isArray(duck.regions),`${name}[${index}].ducking が不正です`);for(const region of duck.regions)check(record(region)&&finite(region.start)&&finite(region.end),`${name}[${index}].ducking.regions が不正です`);}
        }
      }
    }
  }
}
/** Existing source bytes are never normalized or serialized again. */
function planData(id:NativeDataPackId,source:string|null,allowMissing:boolean,fps:number):string {
  // Of these six current project parsers, only insertVideoData injects FPS.
  // Do not certify values that loadProject would reject or replace with defaults.
  // Unregistered imports stay empty just as in evalDataModule's current parser
  // contract, including valid expressions such as an explicit `FPS ?? 1` fallback.
  const stubs:Record<string,Record<string,unknown>>=id==='videoInsert'?{'../videoConfig':{FPS:fps}}:{};
  const d=DEFINITIONS[id],original=source??'',values=source===null?{}:evalDataModule(source,stubs);
  let proposed=original;
  for(const [name,initial] of Object.entries(d.defaults)){
    if(Object.hasOwn(values,name))validateValue(id,name,values[name]);
    else {
      check(allowMissing,`${d.data} に ${name} がありません`);
      // An existing array data file missing its only export is damaged, not a new empty feature.
      check(source===null||id==='speed'||id==='mainLayout',`${d.data} に ${name} がありません`);
      proposed+=`${proposed.endsWith('\n')||proposed===''?'':'\n'}export const ${name} = ${initial};\n`;
    }
  }
  const after=evalDataModule(proposed,stubs);
  for(const name of Object.keys(d.defaults))validateValue(id,name,after[name]);
  return proposed;
}
export type NativeDataPackState = {status:'absent'|'legacy'|'invalid'|'stale'|'ready';reason?:string};
const LEGACY_FEATURE:Record<NativeDataPackId,string>={bgm:'bgm-track',videoInsert:'insert-video',shape:'insert-shape',speed:'speed',transition:'transition',mainLayout:'mainLayout'};
function videoConfig(dir:string){
  const source=readOptional(join(dir,'src/videoConfig.ts'));check(source!==null,'src/videoConfig.ts が見つかりません');
  const syntax=ts.transpileModule(source,{fileName:'videoConfig.ts',reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022}});
  check(!syntax.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error),'videoConfig.ts の構文が不正です');
  const config=parseVideoConfigStatic(source);
  check(['youtube','short','square'].includes(config.format)&&finite(config.fps)&&config.fps>0&&Number.isSafeInteger(config.durationFrames)&&config.durationFrames>0&&
    [config.resolution.width,config.resolution.height].every(n=>Number.isSafeInteger(n)&&n>0)&&config.videoFile.length>0,'videoConfig.ts の形式・fps・寸法・尺が不正です');
  return config;
}
function missingTypeDeclarations(id:NativeDataPackId,path:string,source:string):{path:string;source:string}[] {
  const writes=new Map<string,string>(),types=DEFINITIONS[id].types;
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  for(const node of ast.statements)if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.importClause){
    const clause=node.importClause,bindings=clause.namedBindings;
    const onlyTypes=clause.isTypeOnly||(!clause.name&&bindings&&ts.isNamedImports(bindings)&&bindings.elements.length>0&&bindings.elements.every(item=>item.isTypeOnly));
    if(!onlyTypes)continue;
    const specifier=node.moduleSpecifier.text;
    if(['./types','./BgmSequence','./InsertVideo'].includes(specifier)&&types){
      const base=join(dirname(path),specifier);
      if(!['.ts','.tsx','.d.ts'].some(ext=>existsSync(base+ext)))writes.set(base+'.d.ts',types);
    }
  }
  return [...writes].map(([path,source])=>({path,source}));
}
function assertOwnedWritePath(dir:string,path:string):void {
  const rel=relative(dir,path);check(rel!==''&&!rel.startsWith('..'),'編集データの書込み先が不正です');
  let current=dir;
  for(const segment of rel.split(sep)){
    current=join(current,segment);
    try{check(!lstatSync(current).isSymbolicLink(),'リンクされた編集データへの書込みはできません');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}
/** Read-only: ready certifies both marker identity and readable required exports. */
export function readNativeDataPackState(id:NativeDataPackId,dir:string):NativeDataPackState {
  try {
    const raw=readOptional(markerPath(id,dir));if(raw===null)return {status:'absent'};
    const marker:unknown=JSON.parse(raw);if(!record(marker))return {status:'invalid',reason:'導入記録が不正です'};
    if(!Object.hasOwn(marker,'runtime'))return marker.feature===LEGACY_FEATURE[id]&&!Object.hasOwn(marker,'schemaVersion')?{status:'legacy'}:{status:'invalid',reason:'導入記録が不正です'};
    if(marker.runtime!=='harness-native'||marker.schemaVersion!==1||marker.feature!==id||typeof marker.version!=='string'||Object.keys(marker).some(key=>!['runtime','schemaVersion','feature','version'].includes(key)))return {status:'invalid',reason:'native 導入記録が不正です'};
    const config=videoConfig(dir),path=join(dir,DEFINITIONS[id].data),data=readOptional(path);check(data!==null,'編集データがありません');planData(id,data,false,config.fps);
    check(missingTypeDeclarations(id,path,data).length===0,'編集データの型宣言がありません');
    return {status:marker.version===nativeDataPackVersion(id)?'ready':'stale'};
  }catch(error){return {status:'invalid',reason:error instanceof Error?error.message:String(error)};}
}
export function isNativeDataPackInstalled(id:NativeDataPackId,dir:string):boolean{return readNativeDataPackState(id,dir).status==='ready';}

/** Install only editing data/type declarations. The native marker is committed last. */
export function installNativeDataPack(id:NativeDataPackId,dir:string):{installed:boolean} {
  const staged:{temporary:string;path:string}[]=[];
  let writing=false;
  try {
    const config=videoConfig(dir);
    const d=DEFINITIONS[id],path=join(dir,d.data),original=readOptional(path),source=planData(id,original,true,config.fps);
    const writes:{path:string;source:string}[]=[];
    if(source!==original)writes.push({path,source});
    // Only declared type imports in the data need standalone declarations. Existing files stay intact.
    writes.push(...missingTypeDeclarations(id,path,source));
    const mp=markerPath(id,dir),marker=JSON.stringify({runtime:'harness-native',schemaVersion:1,feature:id,version:nativeDataPackVersion(id)},null,2)+'\n';
    if(!writes.length&&readOptional(mp)===marker)return {installed:true};
    writes.push({path:mp,source:marker});
    for(const write of writes)assertOwnedWritePath(dir,write.path);
    // Finish all temporary files before changing existing data or marker.
    writing=true;
    for(const write of writes){mkdirSync(dirname(write.path),{recursive:true});const temporary=write.path+`.native-${randomUUID()}.tmp`;staged.push({temporary,path:write.path});writeFileSync(temporary,write.source,{encoding:'utf8',flag:'wx'});}
    // A previous native marker must not remain current if a later rename fails.
    const previous=readOptional(mp);if(previous!==null){let old:unknown;try{old=JSON.parse(previous);}catch{}if(record(old)&&old.runtime==='harness-native')unlinkSync(mp);}
    for(const write of staged)renameSync(write.temporary,write.path);
    return {installed:true};
  }catch(error){throw new HttpError(writing?500:400,`機能の編集データを準備できませんでした: ${error instanceof Error?error.message:String(error)}`);}
  finally{for(const write of staged)try{unlinkSync(write.temporary);}catch{}}
}
