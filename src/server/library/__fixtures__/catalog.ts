export const FP='a'.repeat(64);
export function sampleCatalog(){return {version:2,
  packs:[{packId:'sample.motion',name:'見本モーション',component:'モーション/p/component/m.mjs',asset:'モーション/p/component/asset.json'}],
  templates:[{key:'tpl:sample.motion:38',packId:'sample.motion',template:38,name:'見本チップ',group:'見本の分類',use:'1行目=本文',preview:'モーション/p/previews/t38.jpg',sample:'1行目\n2行目',durationSec:7}],
  media:[{key:`se:${FP.slice(0,16)}`,kind:'se',name:'ポン',desc:'見本の説明',file:'効果音/pop.wav',fingerprint:FP,durationSec:0.16,gainDb:-10}]};}
