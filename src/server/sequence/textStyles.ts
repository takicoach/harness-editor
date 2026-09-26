import {findInstalledTextStylePacks,prepareInstalledTextStylePack,type InstalledTextStylePack} from './installedTextStylePacks';
import {resolve} from 'node:path';
import ts from 'typescript';
import {TELOP_PACK} from '../telopPack/manifest';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {textComponentId} from '../../core/sequence/textStyle';
import {compileSequenceComponent,readSequenceComponent,storeSequenceComponent} from './components';
import {BUILTIN_TELOP_PACK_ID,BUILTIN_TELOP_PACK_VERSION,PROJECT_TEMPLATE_PACK_ID,UNKNOWN_TELOP_PACK_VERSION,builtinVersionForStoredHash,componentHash} from '../telopPack/identity';
import {currentBuiltinTextStyleAsset} from '../../core/sequence/builtinTextStyleAsset';

/** Static candidates from a frozen adapter, never a guessed 1..35 range. */
export function declaredTextStyleIds(source:string):number[] {
  const file=ts.createSourceFile('component.mjs',source,ts.ScriptTarget.Latest,true),ids=new Set<number>();
  let arrayCount=0,usesArray=false;
  const template=(node:ts.Node)=>ts.isPropertyAccessExpression(node)&&node.name.text==='template';
  const addId=(value:number)=>{if(Number.isSafeInteger(value)&&value>0)ids.add(value);};
  const add=(node:ts.Node)=>{if(ts.isNumericLiteral(node))addId(Number(node.text));};
  // `TEMPLATE_MAP[segment.template]` form: which identifiers are indexed by a `.template` value,
  // and every object literal that could be one of them. Reconciled after the walk because the
  // lookup can appear before or after the declaration.
  const mapNames=new Set<string>(),literals=new Map<string,ts.ObjectLiteralExpression[]>();
  const unwrap=(node:ts.Expression):ts.Expression=>
    ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isParenthesizedExpression(node)?unwrap(node.expression):node;
  const visit=(node:ts.Node)=>{
    if(ts.isElementAccessExpression(node)&&ts.isIdentifier(node.expression)&&template(node.argumentExpression))mapNames.add(node.expression.text);
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer) {
      const value=unwrap(node.initializer);
      if(ts.isObjectLiteralExpression(value))literals.set(node.name.text,[...(literals.get(node.name.text)??[]),value]);
    }
    if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) {
      if(template(node.left))add(node.right);if(template(node.right))add(node.left);
    }
    if(ts.isSwitchStatement(node)&&template(node.expression))for(const clause of node.caseBlock.clauses)if(ts.isCaseClause(clause))add(clause.expression);
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='STYLES'&&node.initializer&&ts.isArrayLiteralExpression(node.initializer))arrayCount=node.initializer.elements.length;
    if(ts.isCallExpression(node)&&node.arguments.length===2&&template(node.arguments[0]!)) {
      const count=node.arguments[1]!;
      if(ts.isPropertyAccessExpression(count)&&ts.isIdentifier(count.expression)&&count.expression.text==='STYLES'&&count.name.text==='length')usesArray=true;
    }
    ts.forEachChild(node,visit);
  };
  visit(file);
  for(const name of mapNames)for(const literal of literals.get(name)??[])for(const property of literal.properties) {
    if(!ts.isPropertyAssignment(property))continue;
    if(ts.isNumericLiteral(property.name))add(property.name);
    else if(ts.isStringLiteral(property.name)&&/^\d+$/.test(property.name.text))addId(Number(property.name.text));
  }
  if(usesArray&&arrayCount<=200)for(let id=1;id<=arrayCount;id++)ids.add(id);
  return [...ids].sort((a,b)=>a-b);
}

/**
 * 凍結部品が自分で宣言した対応アニメーションを読む。**推定しない**。
 * 宣言が無い・読めない場合は null（＝不明）を返し、呼び出し側は「9 種対応」とみなさず
 * 全種を非対応として扱う。esbuild は entry の export を `export { X as TELOP_ANIMATIONS }`
 * へ畳むことがあるので、名前の当て推量ではなく export 句から実体を引く。
 */
export function declaredAnimationIds(source:string):string[]|null {
  const file=ts.createSourceFile('component.mjs',source,ts.ScriptTarget.Latest,true);
  const initializers=new Map<string,ts.Expression>();
  let local:string|null=null;
  const visit=(node:ts.Node)=>{
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer)initializers.set(node.name.text,node.initializer);
    if(ts.isVariableStatement(node)&&node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword))
      for(const declaration of node.declarationList.declarations)
        if(ts.isIdentifier(declaration.name)&&declaration.name.text==='TELOP_ANIMATIONS')local='TELOP_ANIMATIONS';
    if(ts.isExportDeclaration(node)&&!node.moduleSpecifier&&node.exportClause&&ts.isNamedExports(node.exportClause))
      for(const element of node.exportClause.elements)
        if(element.name.text==='TELOP_ANIMATIONS')local=(element.propertyName??element.name).text;
    ts.forEachChild(node,visit);
  };
  visit(file);
  if(local===null)return null;
  const unwrap=(node:ts.Expression):ts.Expression=>
    ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isParenthesizedExpression(node)?unwrap(node.expression):node;
  const declared=initializers.get(local);
  if(!declared)return null;
  const array=unwrap(declared);
  if(!ts.isArrayLiteralExpression(array))return null;
  const ids:string[]=[];
  for(const element of array.elements) {
    if(!ts.isStringLiteral(element)&&!ts.isNoSubstitutionTemplateLiteral(element))return null;
    ids.push(element.text);
  }
  return ids;
}

/**
 * Fills packId/version/componentHash on a pre-T0b catalog (shipped before commit 88d84987) that
 * has none. No-op once all three are present. componentHash is derived from the frozen component's
 * full source bytes (not just the catalog's own footer) — that's the best available proxy since the
 * catalog footer can't be isolated from an already-compiled component.
 */
export async function backfillTextStyleCatalog(projectDirectory:string,asset:SequenceAsset):Promise<SequenceAsset> {
  const catalog=asset.textStyleCatalog;
  if(!catalog)return asset;
  const identityDone=catalog.packId!==undefined&&catalog.version!==undefined&&catalog.componentHash!==undefined;
  if(identityDone&&catalog.animations!==undefined)return asset;
  const source=await readSequenceComponent(projectDirectory,asset);
  // 宣言が無い資産は「不明」のまま（undefined）。9 種対応とはみなさない。
  const animations=declaredAnimationIds(source)??undefined;
  if(identityDone)return animations===undefined?asset:{...asset,textStyleCatalog:{...catalog,animations}};
  const hash=componentHash(new TextEncoder().encode(source));
  // 保存バイトから分かる事実だけを補完する。`hash` は保存バイト（footer 込み）由来なので信用できるが、
  // 版は推定できない。既知のビルドと照合し、一致しなければ 'unknown'（**最新とは推定しない**。Codex P1-6）。
  // `componentHash` フィールドに載せるのは従来どおりこの hash（`validate.ts:103` の 16 桁 hex）。
  // **表引きも同じ `hash` で行う**（probe 側の値で引くと、どの資産にも当たらないまま全件 'unknown' になる）。
  const filled=catalog.source==='builtin'
    ?{packId:BUILTIN_TELOP_PACK_ID,version:builtinVersionForStoredHash(hash)??UNKNOWN_TELOP_PACK_VERSION}
    :{packId:PROJECT_TEMPLATE_PACK_ID,version:asset.fingerprint.slice(0,8)};
  return {...asset,textStyleCatalog:{...catalog,...filled,componentHash:hash,...(animations===undefined?{}:{animations})}};
}

/** Freeze the editor-owned pack without installing or replacing a project's old TSX. */
export async function prepareNativeTextStyles(projectDirectory:string):Promise<SequenceAsset> {
  // スタイル単位の能力を凍結カタログへ積む（裁定 5）。backfill 側は旧資産なので宣言を推定しない。
  const entries=TELOP_PACK.map(({id,name,animations})=>({id,name,animations:[...animations]}));
  const probe=await compileSequenceComponent(resolve(import.meta.dirname,'../telopPack'),'Telop.tsx','Telop');
  const declared=declaredAnimationIds(new TextDecoder().decode(probe))??undefined;
  const textStyleCatalog:NonNullable<SequenceAsset['textStyleCatalog']>={source:'builtin',
    packId:BUILTIN_TELOP_PACK_ID,version:BUILTIN_TELOP_PACK_VERSION,componentHash:componentHash(probe),entries,
    ...(declared===undefined?{}:{animations:declared})};
  const bytes=await compileSequenceComponent(resolve(import.meta.dirname,'../telopPack'),'Telop.tsx','Telop',
    `export const NATIVE_TEXT_STYLE_CATALOG = ${JSON.stringify(textStyleCatalog)};`);
  return {...await storeSequenceComponent(projectDirectory,bytes,'テロップスタイル'),textStyleCatalog};
}

export async function prepareNativeTextStyleAssets(projectDirectory:string,document:SequenceDocument,
  installedPacks:readonly InstalledTextStylePack[]=findInstalledTextStylePacks()):Promise<SequenceAsset[]> {
  // 参照されている builtin を起点にする（複数版共存で配列先頭＝旧資産を掴み続けない。B9-2）。
  const foundBuiltin=currentBuiltinTextStyleAsset(document,BUILTIN_TELOP_PACK_VERSION);
  const builtin=foundBuiltin?await backfillTextStyleCatalog(projectDirectory,foundBuiltin):await prepareNativeTextStyles(projectDirectory);
  // 追加パック（同梱されていれば）は、まだ登録されていない物だけを足す。無い配布物では何も足さない。
  const assets:SequenceAsset[]=[builtin];
  for(const pack of installedPacks)
    if(!document.assets.some(asset=>asset.textStyleCatalog?.packId===pack.packId))assets.push(await prepareInstalledTextStylePack(projectDirectory,pack));
  await readSequenceComponent(projectDirectory,builtin);
  for(const asset of document.assets) {
    if(asset.kind!=='component'||asset.textStyleCatalog?.source==='builtin')continue;
    if(asset.textStyleCatalog) { assets.push(await backfillTextStyleCatalog(projectDirectory,asset)); continue; }
    const captions=document.clips.flatMap(clip=>clip.content.kind==='telop'&&textComponentId(document,clip.content)===asset.id?[clip.content]:[]);
    if(!captions.length)continue;
    const source=await readSequenceComponent(projectDirectory,asset);
    const ids=new Set(declaredTextStyleIds(source));
    for(const caption of captions)ids.add(Number.isSafeInteger(caption.data.template)&&caption.data.template!>0?caption.data.template!:1);
    if(ids.size>200)throw new Error('文字スタイルの候補が多すぎます');
    assets.push({...asset,textStyleCatalog:{source:'project',packId:PROJECT_TEMPLATE_PACK_ID,
      version:asset.fingerprint.slice(0,8),componentHash:componentHash(new TextEncoder().encode(source)),
      entries:[...ids].sort((a,b)=>a-b).map(id=>({id,name:`スタイル ${id}`})),
      ...(declaredAnimationIds(source)===null?{}:{animations:declaredAnimationIds(source)!})}});
  }
  return assets;
}

/** A catalog is only complete once the frozen identity and the declared capability are on it. */
const CATALOG_IDENTITY_KEYS=['packId','version','componentHash','animations'] as const;

/**
 * Which of the prepared text-style assets would actually change `document.assets` if registered.
 * Selecting a telop clip triggers prepare on every render of the tab; without this filter the
 * `/text-styles` route always executes register-assets and advances the revision even when the
 * catalog is already up to date, so merely selecting a caption marks the document dirty.
 *
 * I-6: 「カタログがあるか」だけで判定すると、pre-T0b の案件（カタログはあるが packId/version/
 * componentHash が無い）は常に除外され、backfillTextStyleCatalog の結果がどこにも保存されない。
 * 欠けている 3 項目を補える asset も登録対象に含める。埋まったあとは差分が無くなるので、
 * 2 回目以降は空配列に戻る（revision は進まない）。
 */
export function textStyleAssetsToRegister(document:SequenceDocument,prepared:SequenceAsset[]):SequenceAsset[] {
  return prepared.filter(asset=>{
    const existing=document.assets.find(item=>item.id===asset.id);
    if(!existing)return true;
    if(!asset.textStyleCatalog)return false;
    const catalog=existing.textStyleCatalog;
    if(!catalog)return true;
    return CATALOG_IDENTITY_KEYS.some(key=>catalog[key]===undefined&&asset.textStyleCatalog![key]!==undefined);
  });
}
