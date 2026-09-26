import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {HttpError} from './http';
import {compileSequenceComponent,storeSequenceComponent} from './sequence/components';
import {declaredAnimationIds,declaredTextStyleIds} from './sequence/textStyles';
import {textComponentId,type TextContent} from '../core/sequence/textStyle';
import type {SequenceAsset,SequenceClip,SequenceDocument} from '../core/sequence/model';
import {componentHash,PROJECT_TEMPLATE_PACK_ID} from './telopPack/identity';
import {KNOWN_TELOP_TEMPLATE_VERSIONS,TELOP_TEMPLATE_ANCHORS,isTelopPackTelop,matchTelopTemplateVersion,missingAnchors,
  sourceSha,type TelopTemplateSources} from './telopTemplateVersions';

/** 中止理由の機械可読コード（M-7）。UI が文言をコードで出し分けるために使う。 */
export type TelopTemplatePlanReason='unknown-version'|'missing-anchors'|'telop-pack'|'style-ids-changed';
export type TelopTemplateApplyReason='plan-not-found'|'revision-changed'|'source-changed'|'compile-failed';
export type TelopTemplateRevertReason='plan-not-found'|'backup-missing';

/** 案件の中のエディタ管理領域。案件のソース（src/）とは分ける。 */
export const TELOP_TEMPLATE_DIR=join('src','テロップテンプレート');
export const TELOP_STAGING_ROOT=join('.harness','telop-template-staging');
export const TELOP_BACKUP_ROOT=join('.harness','telop-template-backup');
/** 移植片の正本（エディタ自身の案件テンプレート。パート 2 が更新する）。 */
const CANONICAL=resolve(import.meta.dirname,'../..','project-template',TELOP_TEMPLATE_DIR);
const ADDED_FILES=['telopAnimations.ts','telopAnimationEffect.ts'] as const;

/**
 * planId は `randomUUID()` の出力しか使わない。`../` を含む値がそのまま `join` に入ると
 * 案件の外の削除（rmSync）・上書き（cpSync）へ届くため、パスを組む前に形を固定する
 * （resolveProjectDir と同じ「破壊経路も封じ込める」水準に揃える。I-4）。
 */
const PLAN_ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function assertTelopTemplatePlanId(planId:unknown):string {
  if(typeof planId!=='string'||!PLAN_ID_PATTERN.test(planId))throw new HttpError(400,'確認の結果が不正です');
  return planId;
}

/** plan 1 件ぶんの置き場。この 1 フォルダの中に案件のレイアウト（src/…）をそのまま写す。 */
export function telopTemplateStagingDir(projectDir:string,planId:string):string {
  return containedPlanDir(projectDir,TELOP_STAGING_ROOT,planId);
}
/** テロップテンプレート本体の置き場（案件と同じ相対パス）。Telop.tsx 等はここに入る。 */
export function telopTemplateStagingTemplateDir(projectDir:string,planId:string):string {
  return join(telopTemplateStagingDir(projectDir,planId),TELOP_TEMPLATE_DIR);
}
export function telopTemplateBackupDir(projectDir:string,planId:string):string {
  return containedPlanDir(projectDir,TELOP_BACKUP_ROOT,planId);
}

/** 形の検査に加えて、組み立てた実パスが `.harness/…` 配下に収まることも確かめる（二重化）。 */
function containedPlanDir(projectDir:string,rootRelative:string,planId:string):string {
  const root=resolve(projectDir,rootRelative),dir=resolve(root,assertTelopTemplatePlanId(planId));
  if(dir!==join(root,planId))throw new HttpError(400,'確認の結果が不正です');
  return dir;
}

/** 新しい plan を作る前に、溜まった過去の plan フォルダを一掃する（掃除経路がここにしか無いため）。 */
function sweepTelopTemplateStaging(projectDir:string):void {
  const root=join(projectDir,TELOP_STAGING_ROOT);
  if(!existsSync(root))return;
  for(const entry of readdirSync(root))rmSync(join(root,entry),{recursive:true,force:true});
}

export function readTelopTemplateSources(projectDir:string):TelopTemplateSources {
  const dir=join(projectDir,TELOP_TEMPLATE_DIR);
  const read=(name:string):string=>{
    try{return readFileSync(join(dir,name),'utf8');}
    catch{throw new HttpError(400,'この案件にはテロップテンプレートがありません。');}
  };
  return {telop:read('Telop.tsx'),telopStyles:read('telopStyles.ts'),telopTypes:read('telopTypes.ts')};
}

/** パート 2 が入れた区切りの中身だけを取り出す（写しを 2 つ持たない）。 */
function fragment(source:string,id:string):string {
  const open=`// <telop-effect:${id}>`,close=`// </telop-effect:${id}>`;
  const from=source.indexOf(open),to=source.indexOf(close);
  if(from<0||to<from)throw new HttpError(500,`エディタ側のテロップ部品に ${id} の目印がありません。エディタを更新してください。`);
  return source.slice(from+open.length,to).replace(/^\n/,'').replace(/\s+$/,'');
}

/**
 * アンカー表どおりに 1 箇所ずつ当てる。`find` を持つものは呼ぶ前に一意性を確かめてある
 * （missingAnchors）。移植片は正本（エディタ同梱の project-template）の区切りの中身をそのまま使う。
 */
function applyPatch(sources:TelopTemplateSources,canonical:TelopTemplateSources):{telop:string;telopTypes:string} {
  let telop=sources.telop,telopTypes=sources.telopTypes;
  for(const anchor of TELOP_TEMPLATE_ANCHORS){
    const piece=fragment(anchor.file==='Telop.tsx'?canonical.telop:canonical.telopTypes,anchor.id);
    const target=anchor.file==='Telop.tsx'?telop:telopTypes;
    // 置換文字列に `$&`／`` $` ``／`$'`／`$1` があると String.replace が黙って解釈する。
    // 移植片は「そのまま貼る」ものなので関数形で渡す（M-4）。
    const next=anchor.kind==='append'?`${target.replace(/\s+$/,'')}\n\n${piece}\n`
      :anchor.kind==='replace'?target.replace(anchor.find,()=>piece)
      :anchor.kind==='insert-before'?target.replace(anchor.find,match=>`${piece}\n${match}`)
      :target.replace(anchor.find,match=>`${match}\n${piece}`);
    if(anchor.file==='Telop.tsx')telop=next;else telopTypes=next;
  }
  return {telop,telopTypes};
}

/** 字幕クリップだけを型ごと絞る。`as never` のキャストを置かないための述語（M-6）。 */
function telopClips(document:SequenceDocument):(SequenceClip&{content:TextContent})[] {
  return document.clips.filter((clip):clip is SequenceClip&{content:TextContent}=>clip.content.kind==='telop');
}

/**
 * 与えたコンパイル済みバイトと同じ中身で凍結されている部品資産を探す。
 * `storeSequenceComponent` は `fingerprint` に sha256 全体を、`backfillTextStyleCatalog` は
 * カタログの `componentHash`（同じ sha256 の先頭 16 桁）を刻む。どちらか一方しか無い古い文書も
 * あるため両方を見る。同梱パック（`source:'builtin'`）は対象外。
 */
function frozenAssetForSource(document:SequenceDocument,bytes:Uint8Array):SequenceAsset|undefined {
  const fingerprint=createHash('sha256').update(bytes).digest('hex'),hash=componentHash(bytes);
  return document.assets.find(asset=>asset.kind==='component'&&asset.textStyleCatalog?.source!=='builtin'
    &&(asset.fingerprint===fingerprint||asset.textStyleCatalog?.componentHash===hash));
}

export interface TelopTemplatePlanFile {path:string;action:'add'|'modify';sha256Before:string|null;sha256After:string}
export interface TelopTemplateUpdatePlan {
  planId:string; documentId:string; revision:number; versionLabel:string;
  files:TelopTemplatePlanFile[]; styleIds:number[]; animations:string[];
  captionCount:number; fromAssetId:string|null;
}

/**
 * 案件を一切変えずに「変えるとこうなる」を作る。書き込みはステージング
 * （.harness/telop-template-staging/<planId>）だけで、src/ には触れない。
 */
export async function planTelopTemplateUpdate(projectDir:string,document:SequenceDocument,
  testing?:{styleIdsAfterOverride?:number[]}):Promise<TelopTemplateUpdatePlan> {
  const sources=readTelopTemplateSources(projectDir);
  const version=matchTelopTemplateVersion(sources);
  if(!version){
    // 同梱パック（35 種）構成は「手を入れた版」ではなく別系統。誤った説明にならないよう理由を分ける（M-7）。
    if(isTelopPackTelop(sources))throw new HttpError(409,
      'この案件はテロップパック（35 種）構成です。自動更新の対象は製品テンプレート版のみです。',{reason:'telop-pack'});
    throw new HttpError(409,
      `この案件のテロップ部品は自動更新に対応していません（手を入れた版か、対応外の版です）。対応しているのは ${KNOWN_TELOP_TEMPLATE_VERSIONS.length} 種類の製品版だけです。`,
      {reason:'unknown-version'});
  }
  const missing=missingAnchors(sources);
  if(missing.length)throw new HttpError(409,
    `この案件のテロップ部品は自動更新に対応していません（目印 ${missing.join('、')} が見つかりません）。`,{reason:'missing-anchors'});

  const canonical:TelopTemplateSources={telop:readFileSync(join(CANONICAL,'Telop.tsx'),'utf8'),
    telopStyles:sources.telopStyles,telopTypes:readFileSync(join(CANONICAL,'telopTypes.ts'),'utf8')};
  const added=ADDED_FILES.map(name=>({name,source:readFileSync(join(CANONICAL,name),'utf8')}));
  // 動きの一覧は正本 Telop.tsx の `<telop-effect:declare>` にある TELOP_ANIMATIONS（17 種）を読む。
  const animationIds=declaredAnimationIds(canonical.telop)
    ??(()=>{throw new HttpError(500,'エディタ側の動きの一覧を読み取れません。エディタを更新してください。');})();
  const patched=applyPatch(sources,canonical);

  sweepTelopTemplateStaging(projectDir);
  const planId=randomUUID();
  const staging=telopTemplateStagingDir(projectDir,planId);
  const templateStaging=telopTemplateStagingTemplateDir(projectDir,planId);
  mkdirSync(templateStaging,{recursive:true});
  try{
    cpSync(join(projectDir,TELOP_TEMPLATE_DIR),templateStaging,{recursive:true});
    writeFileSync(join(templateStaging,'Telop.tsx'),patched.telop,'utf8');
    writeFileSync(join(templateStaging,'telopTypes.ts'),patched.telopTypes,'utf8');
    for(const file of added)writeFileSync(join(templateStaging,file.name),file.source,'utf8');
    // Telop.tsx は同じ案件の `../videoConfig`（テンプレ外・案件ごとの共通設定）を相対 import する。
    // compileSequenceComponent はコンパイル root の外へ出る相対 import を拒否するため、
    // 案件と同じレイアウト（src/videoConfig.ts）を plan フォルダの中に写し、
    // 「plan フォルダそのもの」を root にして entry を案件と同じ相対パスで渡す
    // （before 側の compileSequenceComponent(projectDir, 'src/テロップテンプレート/Telop.tsx', …) と同形）。
    // 複製は .harness/telop-template-staging/<planId> の中だけで、案件そのものは書き換えない。
    const videoConfigSrc=join(projectDir,'src','videoConfig.ts');
    if(existsSync(videoConfigSrc)){
      mkdirSync(join(staging,'src'),{recursive:true});
      writeFileSync(join(staging,'src','videoConfig.ts'),readFileSync(videoConfigSrc,'utf8'),'utf8');
    }

    // ステージングをコンパイルし、スタイル id 集合が変わらないこと・17 種を宣言することを確かめる。
    const beforeBytes=await compileSequenceComponent(projectDir,join(TELOP_TEMPLATE_DIR,'Telop.tsx'),'Telop');
    const before=declaredTextStyleIds(new TextDecoder().decode(beforeBytes));
    const compiled=new TextDecoder().decode(
      await compileSequenceComponent(staging,join(TELOP_TEMPLATE_DIR,'Telop.tsx'),'Telop'));
    const after=testing?.styleIdsAfterOverride??declaredTextStyleIds(compiled);
    if(before.join(',')!==after.join(','))throw new HttpError(409,
      `更新するとスタイルの構成が変わってしまうため中止しました（更新前 ${before.length}件 → 更新後 ${after.length}件）。`,
      {reason:'style-ids-changed'});
    const animations=declaredAnimationIds(compiled);
    if(!animations||animations.length!==animationIds.length)throw new HttpError(409,
      '更新後の部品が新しい動きを宣言できていないため中止しました。');

    // 切り替える相手は「更新前のテンプレートをコンパイルした凍結資産」だけ。案件が同梱パックや
    // 追加スタイルも併用していると、最初の字幕が指す資産は別系統でありうる。それを
    // replace-text-style-asset に渡すと、無関係な字幕の見た目まで製品テンプレートへ変わる（Codex P1-2）。
    const fromAsset=frozenAssetForSource(document,beforeBytes);
    const fromAssetId=fromAsset?.id??null;
    // 件数も「その資産を参照する字幕」だけで数える（全 telop 件数は過大申告。M-7）。
    const captions=telopClips(document).filter(clip=>textComponentId(document,clip.content)===fromAssetId);
    const files:TelopTemplatePlanFile[]=[
      {path:'Telop.tsx',action:'modify',sha256Before:sourceSha(sources.telop),sha256After:sourceSha(patched.telop)},
      {path:'telopTypes.ts',action:'modify',sha256Before:sourceSha(sources.telopTypes),sha256After:sourceSha(patched.telopTypes)},
      ...added.map(file=>({path:file.name,action:'add' as const,sha256Before:null,sha256After:sourceSha(file.source)})),
    ];
    const plan:TelopTemplateUpdatePlan={planId,documentId:document.id,revision:document.revision,versionLabel:version.label,
      files,styleIds:after,animations,captionCount:captions.length,
      fromAssetId:fromAssetId&&captions.length?fromAssetId:null};
    // 計画そのものをステージングへ残す。apply／revert が「計画時と何が違うか」を照合する拠り所。
    writeFileSync(join(staging,'.plan.json'),JSON.stringify(plan,null,2),'utf8');
    return plan;
  }catch(error){
    rmSync(staging,{recursive:true,force:true});
    throw error;
  }
}

/**
 * その plan の作業領域（ステージングとバックアップ）を消す。revert が成功した時点で
 * バックアップは役目を終えており、残しておくと将来の revert が古い版を書き戻せてしまう（M-3）。
 */
export function discardTelopTemplatePlan(projectDir:string,planId:string):void {
  for(const dir of [telopTemplateStagingDir(projectDir,planId),telopTemplateBackupDir(projectDir,planId)])
    if(existsSync(dir))rmSync(dir,{recursive:true,force:true});
}

/** apply／revert が触る 4 ファイル。ここに無いファイル（拡張スタイル等）は 1 バイトも触らない。 */
const UPDATED_FILES=['Telop.tsx','telopTypes.ts',...ADDED_FILES] as const;

function readPlan(projectDir:string,planId:string):TelopTemplateUpdatePlan {
  const staging=telopTemplateStagingDir(projectDir,planId);
  if(!existsSync(staging))throw new HttpError(404,'確認の結果が見つかりません。もう一度確認からやり直してください。',{reason:'plan-not-found'});
  return JSON.parse(readFileSync(join(staging,'.plan.json'),'utf8')) as TelopTemplateUpdatePlan;
}

/** apply が実際に登録した新資産 id の控え。revert の `stillReferenced` 判定はこれだけを根拠にする
 * （「旧資産以外」を見ると、部品資産を持たない字幕まで真になる誤判定が起きるため）。
 * fromAssetId／captionCount／appliedAt は画面側の状態復元（status エンドポイント）が使う（Codex P2）。 */
interface TelopTemplateAppliedRecord {assetId:string;fromAssetId:string|null;captionCount:number;appliedAt:string}
function telopTemplateAppliedRecordPath(projectDir:string,planId:string):string {
  return join(telopTemplateBackupDir(projectDir,planId),'.applied.json');
}
function readTelopTemplateAppliedRecord(projectDir:string,planId:string):TelopTemplateAppliedRecord|null {
  const path=telopTemplateAppliedRecordPath(projectDir,planId);
  if(!existsSync(path))return null;
  try{
    const raw=JSON.parse(readFileSync(path,'utf8')) as Partial<TelopTemplateAppliedRecord>;
    if(typeof raw.assetId!=='string')return null;
    return {assetId:raw.assetId,fromAssetId:typeof raw.fromAssetId==='string'?raw.fromAssetId:null,
      captionCount:typeof raw.captionCount==='number'?raw.captionCount:0,
      appliedAt:typeof raw.appliedAt==='string'?raw.appliedAt:''};
  }catch{return null;}
}

export interface TelopTemplateUpdateStatus {planId:string;assetId:string;fromAssetId:string|null;captionCount:number;appliedAt:string}

/**
 * 画面（NativeTelopTemplateUpdate）の `applied` state 復元用。字幕クリップ選択で NativeInspector が
 * アンマウントされると state は消えるため、最新 1 件の適用結果をここから読み直す（Codex P2）。
 * 読み取り専用。案件に控えが複数（apply 後に revert していない過去分）残っていても、
 * appliedAt が最も新しいものだけを返す。
 */
export function readTelopTemplateUpdateStatus(projectDir:string):TelopTemplateUpdateStatus|null {
  const root=join(projectDir,TELOP_BACKUP_ROOT);
  if(!existsSync(root))return null;
  let latest:TelopTemplateUpdateStatus|null=null;
  for(const entry of readdirSync(root)){
    if(!PLAN_ID_PATTERN.test(entry))continue;
    const record=readTelopTemplateAppliedRecord(projectDir,entry);
    if(!record)continue;
    if(!latest||record.appliedAt>latest.appliedAt)latest={planId:entry,...record};
  }
  return latest;
}

/** バックアップから 4 ファイルを戻す。apply の失敗時復旧と revert が同じ規則を共有する。 */
function restoreFromBackup(projectDir:string,planId:string):string[] {
  const backup=telopTemplateBackupDir(projectDir,planId),target=join(projectDir,TELOP_TEMPLATE_DIR);
  const restored:string[]=[];
  for(const name of UPDATED_FILES){
    if(existsSync(join(backup,`${name}.absent`))){rmSync(join(target,name),{force:true});restored.push(name);}
    else if(existsSync(join(backup,name))){cpSync(join(backup,name),join(target,name));restored.push(name);}
  }
  return restored;
}

export interface TelopTemplateApplyRequest {planId:string;expectedRevision:number}
export interface TelopTemplateUpdateResult {
  planId:string; asset:SequenceAsset; fromAssetId:string|null; captionCount:number; versionLabel:string;
}

/**
 * 計画どおりに src/テロップテンプレート/ を更新し、コンパイル済みバイトを**新しい**凍結資産として
 * 登録する。旧資産には一切触れない（`remove-asset` も `fingerprint` の書き換えもしない。
 * 参照切替は別コマンド `replace-text-style-asset`）。
 *
 * 途中のどこで失敗してもバックアップから自動復元して中止する。呼び出し側から見て
 * 「成功して全部反映された」か「失敗して計画前と同じ」かの 2 つしか無い。
 */
export async function applyTelopTemplateUpdate(projectDir:string,document:SequenceDocument,
  request:TelopTemplateApplyRequest,testing?:{failAt?:'write'|'compile'|'store'}):Promise<TelopTemplateUpdateResult> {
  const planned=readPlan(projectDir,request.planId);
  if(document.revision!==request.expectedRevision)
    throw new HttpError(409,'編集内容が変わりました。もう一度確認からやり直してください。',{reason:'revision-changed'});

  // 計画の根拠（元ファイルのハッシュ）がまだ有効かを見る。確認中に案件が変わっていたら進めない。
  const live=readTelopTemplateSources(projectDir);
  const version=matchTelopTemplateVersion(live);
  const beforeSha=new Map(planned.files.map(file=>[file.path,file.sha256Before]));
  if(!version||missingAnchors(live).length
    ||beforeSha.get('Telop.tsx')!==sourceSha(live.telop)||beforeSha.get('telopTypes.ts')!==sourceSha(live.telopTypes))
    throw new HttpError(409,'テロップ部品が変更されています。もう一度確認からやり直してください。',{reason:'source-changed'});

  const staging=telopTemplateStagingTemplateDir(projectDir,request.planId);
  const target=join(projectDir,TELOP_TEMPLATE_DIR),backup=telopTemplateBackupDir(projectDir,request.planId);
  mkdirSync(backup,{recursive:true});
  // 退避は「触る 4 ファイルだけ」。フォルダ全体を写すと、更新中に増えた無関係ファイルを
  // 復元で消してしまう。存在しなかったファイルは .absent の印で覚える。
  for(const name of UPDATED_FILES){
    const from=join(target,name);
    if(existsSync(from))cpSync(from,join(backup,name));
    else writeFileSync(join(backup,`${name}.absent`),'','utf8');
  }
  try{
    if(testing?.failAt==='write')throw new Error('test: write');
    for(const name of UPDATED_FILES)cpSync(join(staging,name),join(target,name));
    if(testing?.failAt==='compile')throw new Error('test: compile');
    // root は案件そのもの（target ではない）。Telop.tsx は同じ案件の `../videoConfig` を相対 import
    // しており、compileSequenceComponent はコンパイル root の外へ出る相対 import を拒否するため
    // （plan と同じ理由。task-18-review 判断 3）。
    const bytes=await compileSequenceComponent(projectDir,join(TELOP_TEMPLATE_DIR,'Telop.tsx'),'Telop');
    const source=new TextDecoder().decode(bytes);
    const entries=declaredTextStyleIds(source).map(id=>({id,name:`スタイル ${id}`}));
    const animations=declaredAnimationIds(source);
    if(!animations)throw new Error('動きの宣言を読み取れません');
    if(testing?.failAt==='store')throw new Error('test: store');
    const textStyleCatalog:NonNullable<SequenceAsset['textStyleCatalog']>={
      source:'project',packId:PROJECT_TEMPLATE_PACK_ID,version:componentHash(bytes).slice(0,8),
      componentHash:componentHash(bytes),entries,animations};
    const stored=await storeSequenceComponent(projectDir,bytes,'テロップスタイル（新しい動き対応）');
    // revert 時の stillReferenced 判定の根拠として、新資産 id をバックアップと同じフォルダに控える。
    writeFileSync(telopTemplateAppliedRecordPath(projectDir,request.planId),
      JSON.stringify({assetId:stored.id,fromAssetId:planned.fromAssetId,captionCount:planned.captionCount,
        appliedAt:new Date().toISOString()} satisfies TelopTemplateAppliedRecord),'utf8');
    return {planId:request.planId,asset:{...stored,textStyleCatalog},
      fromAssetId:planned.fromAssetId,captionCount:planned.captionCount,versionLabel:planned.versionLabel};
  }catch(error){
    restoreFromBackup(projectDir,request.planId);
    // 復元済みであることを呼び出し側と画面へ伝える。原因は cause に残す（HttpError のシグネチャは変えず options で運ぶ）。
    throw new HttpError(500,'更新に失敗したため元に戻しました。案件は更新前のままです。',{reason:'compile-failed',cause:error});
  }
}

export interface TelopTemplateRevertResult {restored:string[];stillReferenced:boolean;notice:string}

/**
 * 画面の「更新前に戻す」。ファイルだけを戻す。**資産と文書には触れない** ——
 * 参照切替は 1 コマンド 1 Undo の文書変更なので、取り消しは Undo の役目。
 * 新資産をまだ参照している字幕があるときは、その案内を返す（自動では取り消さない）。
 */
export async function revertTelopTemplateUpdate(projectDir:string,planId:string,
  document?:SequenceDocument):Promise<TelopTemplateRevertResult> {
  const backup=telopTemplateBackupDir(projectDir,planId);
  if(!existsSync(backup))throw new HttpError(404,'更新前の控えが見つかりません。',{reason:'backup-missing'});
  readPlan(projectDir,planId);
  const applied=readTelopTemplateAppliedRecord(projectDir,planId);
  const stillReferenced=!!applied&&!!document
    &&telopClips(document).some(clip=>textComponentId(document,clip.content)===applied.assetId);
  const restored=restoreFromBackup(projectDir,planId);
  // 戻し終えたら控えは不要。2 回目の revert は「控えが無い」として 404 になり、画面は最初へ戻る。
  discardTelopTemplatePlan(projectDir,planId);
  return {restored,stillReferenced,
    notice:stillReferenced
      ? '部品を更新前に戻しました。字幕がまだ新しい部品を指しているので、「元に戻す」を 1 回押して参照も戻してください。'
      : '部品を更新前に戻しました。'};
}
