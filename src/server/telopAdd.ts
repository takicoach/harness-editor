import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {basename,join,posix} from 'node:path';
import ts from 'typescript';
import {HttpError} from './http';
import type {SequenceAsset} from '../core/sequence/model';
import {SHARED_COMPONENT_MODULES,compileSequenceComponent,storeSequenceComponent} from './sequence/components';
import {componentHash} from './telopPack/identity';
/** 製品「動画編集ハーネス」本体テンプレの署名。この署名がある案件へ、エディタ同梱パックを上書き導入しない。
 * 正本は telopTemplateVersions.ts（同じ文字列を 2 箇所に置かない）。 */
import {PRODUCT_TELOP_SIGNATURE as PRODUCT_SIGNATURE} from './telopTemplateVersions';

/** 取り込んだパックの置き場（案件の中・エディタ管理領域）。案件のソースには触れない。 */
export const TELOP_ADD_MANAGED_DIR='.sme/telop-packs';

export interface TelopFolderReport {kind:'pack'|'template';packId:string;version:string;ids:number[];names:string[];files:string[]}

function styleNames(source:string):Map<number,string> {
  const file=ts.createSourceFile('manifest.ts',source,ts.ScriptTarget.Latest,true),names=new Map<number,string>();
  const visit=(node:ts.Node)=>{
    if(ts.isObjectLiteralExpression(node)){
      let id:number|null=null,name:string|null=null;
      for(const property of node.properties){
        if(!ts.isPropertyAssignment(property)||!ts.isIdentifier(property.name))continue;
        if(property.name.text==='id'&&ts.isNumericLiteral(property.initializer))id=Number(property.initializer.text);
        if(property.name.text==='name'&&ts.isStringLiteralLike(property.initializer))name=property.initializer.text;
      }
      if(id!==null&&name!==null)names.set(id,name);
    }
    ts.forEachChild(node,visit);
  };
  visit(file);return names;
}

/**
 * 案件テンプレート形式（telopStyles*.ts ＋ TEMPLATE_MAP）から番号を読み取る。
 *
 * ブリーフ原案は `declaredTextStyleIds`（コンパイル済み部品の `.template===N` 比較や
 * switch から番号を拾う関数）の流用を指示していたが、実測すると TEMPLATE_MAP のような
 * 生ソースのオブジェクトリテラルキーは拾えず空配列になる（同関数はコンパイル後の
 * 実行時コード向け）。ここでは実際の案件テンプレート命名規約
 * （`export const template31_neonGlow = …` のような `templateNN_...` 変数宣言）から
 * 直接番号を拾う。Interfaces の戻り値型（ids:number[]）は変えていない。
 */
function templateExportIds(source:string):number[] {
  const file=ts.createSourceFile('templates.ts',source,ts.ScriptTarget.Latest,true),ids=new Set<number>();
  const pattern=/^template(\d+)_/;
  const visit=(node:ts.Node)=>{
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)){
      const match=pattern.exec(node.name.text);
      if(match)ids.add(Number(match[1]));
    }
    ts.forEachChild(node,visit);
  };
  visit(file);return [...ids].sort((a,b)=>a-b);
}

/**
 * 版はフォルダの中身そのものから作る（M-8）。
 *
 * `telopPack/identity.ts` は「同じ packId ＋ version なら同じ見た目」を不変条件として
 * 宣言している。番号と名前だけのハッシュでは、見た目だけ違う同名パックが同じ版になり、
 * 保管フォルダと凍結資産の中身も食い違い得た。ここでは対象の相対パス・サイズ・バイト列を
 * 決まった順で流し込む（シンボリックリンクは読まない）。
 *
 * R2-I1: 読むのは**見た目を決める材料だけ**（style ファイル群・`manifest.ts`・`styles/`）で、
 * しかも**形が確定してから**呼ぶ。以前は形の判定より前にフォルダ配下の全バイトを上限なしで
 * 同期読みしていたため、隣に置かれた大きな無関係ファイルがそのままサーバーを止めた。
 */
const HASH_MAX_BYTES=64*1024*1024;
const HASH_MAX_ENTRIES=1000;

function folderContentHash(dir:string,targets:readonly string[]):string {
  const digest=createHash('sha256');
  let bytes=0,count=0;
  const refuse=():never=>{throw new HttpError(400,'このフォルダは版を作るには大きすぎます。スタイルのファイルだけを入れたフォルダを選んでください。');};
  const countEntry=():void=>{if(++count>HASH_MAX_ENTRIES)refuse();};
  const addFile=(path:string,relative:string):void=>{
    countEntry();
    bytes+=statSync(path).size;if(bytes>HASH_MAX_BYTES)refuse();
    const content=readFileSync(path);
    digest.update(`F:${relative}:${content.length}\n`);digest.update(content);
  };
  const walk=(current:string,prefix:string):void=>{
    const entries=readdirSync(current,{withFileTypes:true}).filter(entry=>!entry.name.startsWith('.'))
      .sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
    for(const entry of entries){
      const path=join(current,entry.name),relative=`${prefix}/${entry.name}`;
      if(entry.isDirectory()){countEntry();digest.update(`D:${relative}\n`);walk(path,relative);}
      else if(entry.isFile())addFile(path,relative);
    }
  };
  // 呼び出し側の列挙順（readdirSync）に版が左右されないよう、対象は名前順に固定する。
  for(const target of [...new Set(targets)].sort((left,right)=>left<right?-1:left>right?1:0)){
    let info;
    try{info=lstatSync(join(dir,target));}catch{continue;}
    if(info.isDirectory()){countEntry();digest.update(`D:${target}\n`);walk(join(dir,target),target);}
    else if(info.isFile())addFile(join(dir,target),target);
  }
  return digest.digest('hex').slice(0,8);
}

// C4: 取り込みは「選ばれたフォルダだけ」を staging へ写してコンパイルする。
// 案件の設定ファイル（`../videoConfig` など）を読む案件テンプレートは、その依存が
// staging に無く、コンパイラも staging 外の読み込みを拒否するため必ず失敗する。
// 取り込んでから失敗させず、下見の時点で理由つきで断る。見た目を変えかねない
// stub（TELOP_CONFIG の固定値など）を staging へ足す案は採らない。

/** 凍結した部品が残してよい裸モジュール（components.ts の許可集合＋別名の remotion）。 */
const EXTERNAL_MODULES = new Set([...SHARED_COMPONENT_MODULES, 'remotion']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
/** 追跡するファイル数の上限（壊れた相互参照で歩き続けない）。 */
const SCAN_FILE_LIMIT = 300;

interface ImportRef {specifier:string;dynamic:boolean}

/** R3-M1: `import type` ／ `export type ... from` は esbuild が構文段階で消すので、外部依存としては数えない。 */
function importSpecifiers(name: string, source: string): ImportRef[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true), found: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      found.push({specifier:node.moduleSpecifier.text,dynamic:false});
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      found.push({specifier:node.moduleSpecifier.text,dynamic:false});
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteralLike(node.moduleReference.expression)) found.push({specifier:node.moduleReference.expression.text,dynamic:false});
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) found.push({specifier:first.text,dynamic:true});
    }
    ts.forEachChild(node, visit);
  };
  visit(file); return found;
}

type SpecifierLocation =
  | {kind:'external'}
  | {kind:'inside';relative:string}
  | {kind:'escape';specifier:string}
  | {kind:'bare';specifier:string};

/**
 * 指定子の行き先を判定する（Codex#5: importer からの相対解決に直す）。
 * 相対指定子は「参照元ファイルの場所」を基準に解決してから、選択フォルダの中に留まるかを見る
 * （生の指定子文字列だけを見ると、サブフォルダから `../shared` のようにフォルダ内で完結する
 * 参照まで誤って拒否していた）。裸指定子（コンパイラが解決するもの）は許可集合以外すべて `bare`
 * として区別し、R3-M2 のとおり「相対でフォルダ外へ出る」場合と文言を分ける。
 */
function locateSpecifier(from: string, specifier: string): SpecifierLocation {
  if (EXTERNAL_MODULES.has(specifier)) return {kind:'external'};
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return {kind:'bare',specifier};
  const relative = posix.normalize(posix.join(posix.dirname(from), specifier));
  return relative === '..' || relative.startsWith('../') ? {kind:'escape',specifier} : {kind:'inside',relative};
}

/** フォルダ内の相対パス（既に importer 基準で解決済み）を実ファイルへ解決する（拡張子・index 補完）。見つからなければ追跡しない。 */
function resolveLocal(dir: string, relativeBase: string): string|undefined {
  for (const candidate of [relativeBase, ...SOURCE_EXTENSIONS.map(ext => relativeBase + ext), ...SOURCE_EXTENSIONS.map(ext => `${relativeBase}/index${ext}`)]) {
    try { if (statSync(join(dir, ...candidate.split('/'))).isFile()) return candidate; } catch { /* 次の候補 */ }
  }
  return undefined;
}

interface DependencyScan {escapes:string[];bare:string[];reached:string[]}

/**
 * 入口から相対 import をたどり、フォルダ内で閉じた到達集合（reached）とフォルダ外へ出る依存を集める。
 * R3-I1: reached はそのまま版の材料に使う（実際にコンパイルへ取り込まれるファイル集合と一致させる）。
 * R3-M3: フォルダ内のファイルが動的 import／require を持っていたら、取り込み段の `auditSource` が
 * 無条件で拒否するため、下見の時点で同じ理由で断る（対象がフォルダ内かどうかは問わない）。
 */
function scanDependencies(dir: string, entries: readonly string[]): DependencyScan {
  const escapes = new Set<string>(), bare = new Set<string>(), seen = new Set<string>(), queue = [...entries];
  while (queue.length && seen.size < SCAN_FILE_LIMIT) {
    const relative = queue.shift()!;
    if (seen.has(relative)) continue;
    seen.add(relative);
    let source: string;
    try { source = readFileSync(join(dir, ...relative.split('/')), 'utf8'); } catch { continue; }
    for (const ref of importSpecifiers(relative, source)) {
      if (ref.dynamic) throw new HttpError(400,
        `${relative} が動的にモジュールを読み込んでいます（${ref.specifier}）。テロップの部品は静的な import だけに対応しています。`);
      const spot = locateSpecifier(relative, ref.specifier);
      if (spot.kind === 'external') continue;
      if (spot.kind === 'bare') { bare.add(spot.specifier); continue; }
      if (spot.kind === 'escape') { escapes.add(spot.specifier); continue; }
      const next = resolveLocal(dir, spot.relative);
      if (next) queue.push(next);
    }
  }
  return {escapes:[...escapes].sort(),bare:[...bare].sort(),reached:[...seen]};
}

/** R3-M2: フォルダ外の依存を「相対でフォルダを出る」ものと「裸の外部モジュール」に分けて案内する。 */
function describeOutside(escapes: readonly string[], bare: readonly string[]): string {
  const notes: string[] = [];
  if (escapes.length) notes.push(
    `このフォルダは案件の設定ファイルに依存しているため、単体では取り込めません（${escapes.join('、')}）。案件のテロップ一式ではなく、配布用に切り出したフォルダを選んでください。`);
  if (bare.length) notes.push(
    `このフォルダに無いモジュール ${bare.map(name=>`\`${name}\``).join('、')} を参照しています。配布用に切り出したフォルダには含まれないはずの外部ライブラリです。`);
  return notes.join(' ');
}

/** フォルダ名をカタログの packId（`/^[A-Za-z0-9._-]{1,80}$/`）に収める。 */
function sanitizePackId(name:string):string {
  const cleaned=name.replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
  return cleaned||`pack-${createHash('sha256').update(name).digest('hex').slice(0,8)}`;
}

/**
 * 選ばれたフォルダが「エディタ同梱パック形式」か「案件テンプレート形式」かを判定し、
 * 取り込む前に中身（件数・名前・番号）を報告する。書き込みは一切しない。
 */
export function inspectTelopFolder(dir:string):TelopFolderReport {
  let entries:string[];
  try{entries=readdirSync(dir);}catch{throw new HttpError(400,'フォルダを開けませんでした。zip を展開したフォルダを選んでください。');}
  const files=entries.filter(name=>!name.startsWith('.'));
  const packId=sanitizePackId(basename(dir));
  if(files.includes('manifest.ts')&&files.includes('styles')){
    const names=styleNames(readFileSync(join(dir,'manifest.ts'),'utf8'));
    if(!names.size)throw new HttpError(400,'manifest.ts からスタイルを読み取れませんでした。zip を展開したフォルダを選んでください。');
    const ids=[...names.keys()].sort((a,b)=>a-b);
    // R3-I1: telopAdd はこの後 Telop.tsx もコンパイルする（下記参照）ので、描画本体も
    // 版の材料に入れる。無ければ単に対象から外れる（folderContentHash が黙って飛ばす）。
    return {kind:'pack',packId,version:folderContentHash(dir,['manifest.ts','styles','Telop.tsx']),ids,names:ids.map(id=>names.get(id)!),files};
  }
  const styleFiles=files.filter(name=>/^telopStyles.*\.tsx?$/.test(name));
  if(styleFiles.length){
    const combined=styleFiles.map(name=>readFileSync(join(dir,name),'utf8')).join('\n')
      +(files.includes('Telop.tsx')?'\n'+readFileSync(join(dir,'Telop.tsx'),'utf8'):'');
    const ids=templateExportIds(combined);
    if(!ids.length)throw new HttpError(400,'スタイル番号を読み取れませんでした。TEMPLATE_MAP のあるフォルダを選んでください。');
    const entryFiles=[...styleFiles,...(files.includes('Telop.tsx')?['Telop.tsx']:[])];
    const scan=scanDependencies(dir,entryFiles);
    if(scan.escapes.length||scan.bare.length)throw new HttpError(400,describeOutside(scan.escapes,scan.bare));
    // R3-I1: 版の材料は到達集合（reached）＝実際にコンパイルへ取り込まれるファイルと一致させる。
    // 以前は entryFiles（スタイル本体＋Telop.tsx）だけを見ていたため、同梱ヘルパー
    // （telopPositionMath.ts 等）の変更が版に反映されなかった。
    return {kind:'template',packId,version:folderContentHash(dir,scan.reached),ids,names:ids.map(id=>`スタイル ${id}`),files:styleFiles};
  }
  throw new HttpError(400,'テロップのフォルダではありません。zip を展開したフォルダ（manifest.ts と styles、または telopStyles… のあるフォルダ）を選んでください。');
}

export interface TelopAddResult {packId:string;version:string;kind:'pack'|'template';added:number[];conflicts:number[];asset:SequenceAsset}

/**
 * フォルダを案件のエディタ管理領域へ取り込み、凍結資産としてカタログ登録する。
 *
 * 既存案件の凍結資産は自動で置き換えない（同じ番号＝同じ見た目は packId＋version が同じときだけ保証する）。
 * 既存の番号と衝突したら 1 件も書かずに中止する（半端な取り込みを残さない）。
 */
export async function telopAdd(projectDir:string,sourceDir:string,existingIds:readonly number[]):Promise<TelopAddResult> {
  const report=inspectTelopFolder(sourceDir);
  const conflicts=report.ids.filter(id=>existingIds.includes(id));
  if(conflicts.length)throw new HttpError(409,`同じ番号のスタイルが既にあります（${conflicts.join('、')}）。別のパックを選ぶか、先に古いパックを外してください。`);
  if(report.kind==='pack'&&existsSync(join(projectDir,'src','テロップテンプレート','telopStyles.ts'))
    &&readFileSync(join(projectDir,'src','テロップテンプレート','telopStyles.ts'),'utf8').includes(PRODUCT_SIGNATURE))
    throw new HttpError(409,'この案件には製品同梱のテロップが入っています。エディタ同梱パックで上書きしないため、取り込みを中止しました。');

  // 版はフォルダの内容ハッシュ（inspectTelopFolder が算出済み）。下見と本番で同じ値になる。
  const version=report.version;
  const managedDir=join(projectDir,TELOP_ADD_MANAGED_DIR);
  mkdirSync(managedDir,{recursive:true});
  const target=join(managedDir,`${report.packId}@${version}`);
  // 同一ボリュームの一時フォルダへコピー・コンパイル・凍結保存まで済ませてから、
  // 最後に renameSync で本置き場へ移す。途中で失敗したら一時フォルダごと消して
  // 管理領域（.sme/telop-packs）に孤立フォルダを残さない。
  const staging=join(managedDir,`.tmp-${randomUUID()}`);
  mkdirSync(staging,{recursive:true});
  try{
    cpSync(sourceDir,staging,{recursive:true});
    writeFileSync(join(staging,'telop-add.json'),JSON.stringify({packId:report.packId,version,kind:report.kind,ids:report.ids},null,2),'utf8');

    const bytes=await compileSequenceComponent(staging,'Telop.tsx','Telop');
    const textStyleCatalog:NonNullable<SequenceAsset['textStyleCatalog']>={source:'installed',packId:report.packId,version,componentHash:componentHash(bytes),
      entries:report.ids.map((id,index)=>({id,name:report.names[index]!}))};
    const stored=await storeSequenceComponent(projectDir,bytes,`追加パック ${report.packId}`);
    // 既に同じ packId@version が入っていれば（衝突判定は番号ベースなので、稀に同一版の
    // 再取り込みが起こり得る）本置き場はそのまま残し、今回の一時フォルダだけ捨てる。
    // version は内容ハッシュなので、同じ版＝同じバイト列。保管フォルダと凍結資産が食い違わない。
    if(!existsSync(target))renameSync(staging,target);
    else rmSync(staging,{recursive:true,force:true});
    return {packId:report.packId,version,kind:report.kind,added:report.ids,conflicts:[],asset:{...stored,textStyleCatalog}};
  }catch(error){
    rmSync(staging,{recursive:true,force:true});
    throw error;
  }
}
