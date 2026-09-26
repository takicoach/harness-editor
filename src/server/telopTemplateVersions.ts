import {createHash} from 'node:crypto';

/** sha256 の先頭 16 桁。telopPack/identity.ts:14 の componentHash と同じ刻み方に揃える。 */
export function sourceSha(source:string):string {
  return createHash('sha256').update(source,'utf8').digest('hex').slice(0,16);
}

export interface TelopTemplateVersion {
  telopSha:string; telopStylesSha:string; telopTypesSha:string; label:string; signature:boolean;
}

/** 製品テンプレートの署名。ここが正本で、telopAdd.ts はこれを import する。 */
export const PRODUCT_TELOP_SIGNATURE='TAKICOACH_TELOP_STYLES';

/**
 * 自動更新の対象にする版（設計 7 の未確定を 2026-09-17 の実測で確定）。
 * 測り方は計画 Task 18 Step 1。証跡 docs/research/2026-09-17-feedback-after/telop-template-versions.txt。
 *
 * 署名付き 1 行（899 行・a73685d6cea1c0c9）は project-template 自身の移行前の本文
 * （コミット f7f82cb9 時点）。project-template は Task 11/13 でこの表の先（移行先）に
 * 更新済みなので、現在のハッシュはこの表に載らない（telopTemplateVersions.test.ts の
 * git show 参照が根拠）。残り 3 版は video-jobs の実測（anchors=6 の行）そのもの。
 *
 * 署名は「版ごとの期待値」であって必須条件ではない。実在 16 案件の署名保持は 0 件で、
 * 必須にすると移行対象が消える。互換性はハッシュ 3 本＋アンカー一意＋
 * コンパイル後のスタイル id 集合一致で証明する（Codex P1-2）。
 */
export const KNOWN_TELOP_TEMPLATE_VERSIONS:readonly TelopTemplateVersion[]=[
  {telopSha:'a73685d6cea1c0c9',telopStylesSha:'231c305f07f1f24c',telopTypesSha:'c96b22f60b34701f',
   label:'製品テンプレート TEMPLATE_MAP 版（project-template 移行前・899 行）',signature:true},
  {telopSha:'723299cd4c613c2f',telopStylesSha:'69e97e3c3a4d822b',telopTypesSha:'8a930f2388fc31bd',
   label:'製品テンプレート 2026-08 版（template=== 連鎖・518 行）',signature:false},
  {telopSha:'723299cd4c613c2f',telopStylesSha:'69e97e3c3a4d822b',telopTypesSha:'868a3658e0b217de',
   label:'製品テンプレート 2026-08 版（template=== 連鎖・518 行・telopTypes 派生）',signature:false},
  {telopSha:'16cfe31b0d872b8c',telopStylesSha:'69e97e3c3a4d822b',telopTypesSha:'8a930f2388fc31bd',
   label:'製品テンプレート 2026-08 版（497 行）',signature:false},
];

export interface TelopTemplateAnchor {
  id:'import'|'branches'|'body-rename'|'wrap'|'declare'|'types-import'|'union'|'types-fields';
  file:'Telop.tsx'|'telopTypes.ts';
  kind:'insert-before'|'insert-after'|'replace'|'append';
  find:string;   // append は空（当て所が末尾なので探さない）
}

/**
 * 最小パッチの当て所。id はパート 2 が `Telop.tsx`／`telopTypes.ts` に入れた
 * `// <telop-effect:ID>` の ID と 1 対 1（移植片はその中身をそのまま読む）。
 * `find` を持つ 6 本は対象 4 版すべてで 1 回だけ現れる（Step 1 で実測）。
 * `wrap`・`declare` は末尾追記で、この順に並ぶ（包み → 能力宣言）。
 */
export const TELOP_TEMPLATE_ANCHORS:readonly TelopTemplateAnchor[]=[
  {id:'import',file:'Telop.tsx',kind:'insert-before',find:'const getVariedAnimation = (id: number) => {'},
  {id:'branches',file:'Telop.tsx',kind:'insert-after',find:'const getAnimationConfig = (segment: TelopSegment) => {'},
  {id:'body-rename',file:'Telop.tsx',kind:'replace',find:'export const Telop: React.FC<TelopProps> = ({ segment }) => {'},
  {id:'types-import',file:'telopTypes.ts',kind:'insert-before',find:'export interface TelopAnimation {'},
  {id:'union',file:'telopTypes.ts',kind:'replace',
   find:"  animation?: 'none' | 'slideIn' | 'fadeOnly' | 'slideFromLeft' | 'fadeBlurFromBottom' | 'slideLeftFadeBlur' | 'fadeFromRight' | 'fadeFromLeft' | 'charByChar';"},
  {id:'types-fields',file:'telopTypes.ts',kind:'insert-after',find:'  charDelay?: number; // animation_charByChar のみ'},
  {id:'wrap',file:'Telop.tsx',kind:'append',find:''},
  {id:'declare',file:'Telop.tsx',kind:'append',find:''},
];

export interface TelopTemplateSources {telop:string;telopStyles:string;telopTypes:string}

/** 同梱パック（テロップパック 35 種）構成の Telop.tsx ハッシュ。既知版表には含めない
 * （対象は「手を入れた版」ではなく別系統の構成）。中止理由を M-7 で分ける判定に使う。 */
export const TELOP_PACK_TELOP_SHAS:readonly string[]=['b5dcadfb22fc6437','44df57600b4c4f08'];

/** Telop.tsx が同梱パック構成のハッシュと一致するか。 */
export function isTelopPackTelop(sources:TelopTemplateSources):boolean {
  return TELOP_PACK_TELOP_SHAS.includes(sourceSha(sources.telop));
}

/** 3 ファイルのハッシュと署名の期待値が丸ごと一致する版だけを返す。1 つでも外れたら undefined。 */
export function matchTelopTemplateVersion(sources:TelopTemplateSources):TelopTemplateVersion|undefined {
  const telopSha=sourceSha(sources.telop),stylesSha=sourceSha(sources.telopStyles),typesSha=sourceSha(sources.telopTypes);
  const signature=sources.telopStyles.includes(PRODUCT_TELOP_SIGNATURE);
  return KNOWN_TELOP_TEMPLATE_VERSIONS.find(version=>
    version.telopSha===telopSha&&version.telopStylesSha===stylesSha
    &&version.telopTypesSha===typesSha&&version.signature===signature);
}

/** `find` を持つアンカーが 1 つでも見つからない／2 回以上あるなら、その id を返す（空なら健全）。 */
export function missingAnchors(sources:TelopTemplateSources):string[] {
  return TELOP_TEMPLATE_ANCHORS.flatMap(anchor=>{
    if(anchor.kind==='append')return [];                 // 末尾追記に当て所は要らない
    const target=anchor.file==='Telop.tsx'?sources.telop:sources.telopTypes;
    return target.split(anchor.find).length-1===1?[]:[anchor.id];
  });
}
