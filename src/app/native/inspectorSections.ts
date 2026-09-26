import type {SequenceDocument} from '../../core/sequence/model';

export type InspectorSelectionKind='none'|'telop'|'title'|'video'|'image'|'audio'|'shape'|'scene-fade'|'multi';
export type InspectorSectionId=
  |'project-speed'|'project-ducking'|'project-audio-fix'|'project-transitions'
  |'text-body'|'text-style-list'|'text-mode'|'font'|'decoration'|'position-3x3'|'apply-all'
  |'title-body'|'clip-speed'|'layout'|'keyframes'|'color'|'image-style'
  |'audio-volume'|'audio-fade'|'shape'|'shape-palette'|'angle-readout'|'timing';

/** 調整タブが何を出すかは「選択の種別」だけで決める。描画と判断を分けてテストできるようにする。 */
export function inspectorSelectionKind(document:SequenceDocument,selected:readonly string[]):InspectorSelectionKind {
  const clips=selected.map(id=>document.clips.find(clip=>clip.id===id)).filter(clip=>clip!==undefined);
  if(!clips.length)return 'none';
  if(clips.length>1)return 'multi';
  const kind=clips[0]!.content.kind;
  return kind==='telop'||kind==='title'||kind==='video'||kind==='image'||kind==='audio'||kind==='shape'||kind==='scene-fade'?kind:'none';
}

const SECTIONS:Record<InspectorSelectionKind,InspectorSectionId[]>={
  none:['project-speed','project-ducking','project-audio-fix','project-transitions'],
  // 字幕はスタイル一覧が主役。title は別描画で component スタイルを受けないので出さない（Codex 裁定 P1-8）。
  // font/decoration は T16 がタイトル向けの専用コントロールへ置き換える予定（暫定で共通フィールドを流用）。
  telop:['project-speed','text-body','text-style-list','text-mode','font','decoration','position-3x3','apply-all','layout','keyframes','timing'],
  title:['project-speed','title-body','font','decoration','layout','position-3x3','keyframes','timing'],
  video:['project-speed','clip-speed','layout','color','keyframes','timing'],
  image:['project-speed','image-style','layout','position-3x3','keyframes','timing'],
  audio:['project-speed','clip-speed','audio-volume','audio-fade','timing'],
  shape:['project-speed','shape','shape-palette','angle-readout','layout','position-3x3','keyframes','timing'],
  'scene-fade':['project-speed','project-transitions','timing'],
  // 複数選択でも「色設定の貼り付け」等の一括操作へ届くよう、旧挙動どおり見た目・配置・動きの群を出す。
  // 各節の描画条件（clip.content.kind===…）は先頭クリップで判定されるので、出る中身は旧コードと同じ。
  multi:['project-speed','layout','color','audio-volume','audio-fade','keyframes','timing'],
};
/**
 * 区分ごとの表示項目。速度（project-speed）は全区分に含む — 速度ブロックは
 * 選択に関わらず常時表示するため（T12 の不変条件）。案件全体／このクリップの
 * 出し分けは NativeGlobalSpeedSettings / NativeClipSpeedSettings 側が担う。
 *
 * project-transitions は「編集モードでこの区分に出す」印。編集モード
 * （showSceneFades===false）では、この印を持つ区分（案件全体＝未選択／
 * scene-fade クリップ選択）でのみ場面フェード欄を出す。仕上げモード
 * （showSceneFades===true）はこの印と無関係に選択に関わらず常時表示する
 * （NativeInspector.tsx 側の判定。T13 回帰の裁定で復元、2026-09-16）。
 */
export function inspectorSections(kind:InspectorSelectionKind):InspectorSectionId[] {return [...SECTIONS[kind]];}

export function inspectorHeading(kind:InspectorSelectionKind,clipName?:string):string {
  const label:Record<InspectorSelectionKind,string>={none:'案件全体',telop:'字幕',title:'タイトル',video:'映像',image:'画像',audio:'音声',shape:'図形','scene-fade':'場面フェード',multi:'複数選択'};
  if(kind==='none'||kind==='multi')return label[kind];
  return clipName?`${label[kind]}「${clipName}」`:label[kind];
}

/** F14: 調整タブの 6 群。表示順は固定、「案件全体」は常に最後。 */
export type InspectorGroupId='content'|'look'|'place'|'motion'|'time'|'project';
export const INSPECTOR_GROUPS:ReadonlyArray<{id:InspectorGroupId;label:string}>=[
  {id:'content',label:'内容'},{id:'look',label:'見た目'},{id:'place',label:'配置'},{id:'motion',label:'動き'},{id:'time',label:'時間'},{id:'project',label:'案件全体'},
];
/** 群の表示名。`INSPECTOR_GROUPS` から導出する（片方だけ足す事故を防ぐ）。名前を `INSPECTOR_` で始めるのは、
 *  `GROUP_LABEL` が NativeTextStyleList（出どころ名）・NativeFontField（書体種別）にも別物として在るため（Rec 3/4）。 */
export const INSPECTOR_GROUP_LABEL=Object.fromEntries(INSPECTOR_GROUPS.map(g=>[g.id,g.label])) as Record<InspectorGroupId,string>;
export const SECTION_GROUP:Record<InspectorSectionId,InspectorGroupId>={
  'project-speed':'project','project-ducking':'project','project-audio-fix':'project','project-transitions':'project',
  'text-body':'content','text-style-list':'content','apply-all':'content','title-body':'content',
  'text-mode':'look','font':'look','decoration':'look','color':'look','image-style':'look','shape':'look','shape-palette':'look','angle-readout':'look','audio-volume':'look',
  'position-3x3':'place','layout':'place',
  'keyframes':'motion','audio-fade':'motion',
  'clip-speed':'time','timing':'time',
};
export function inspectorGroups(kind:InspectorSelectionKind):InspectorGroupId[]{
  const present=new Set(inspectorSections(kind).map(id=>SECTION_GROUP[id]));
  return INSPECTOR_GROUPS.map(g=>g.id).filter(id=>present.has(id));
}
/** 最初に開く群（内容を持つ群。内容が無い区分は主役の群）。他は畳んで要約行だけ。 */
const OPEN_DEFAULT:Record<InspectorSelectionKind,InspectorGroupId>={none:'project',multi:'time',telop:'content',title:'content',video:'place',image:'place',audio:'look',shape:'look','scene-fade':'project'};
export function defaultGroupOpen(kind:InspectorSelectionKind,group:InspectorGroupId):boolean{return OPEN_DEFAULT[kind]===group;}
