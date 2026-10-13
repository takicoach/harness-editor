// src/server/sequence/media.fdProtocol.test.ts
// 参照（リンク）取り込みは開いたファイルを「fd:」で ffprobe に渡す。fd: を読めない古い ffprobe では、パスへ黙って切り替えず、分かる理由で断る。
// 偽の ffprobe（シェルスクリプト）は呼ばれた引数を記録し、一覧（-protocols）以外は本物の ffprobe に渡す。古い方は fd: を「Protocol not found」で断る。
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {chmodSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {defaultWhich} from '../resolveFfmpeg';
import {FFPROBE_FD_UNSUPPORTED,ffprobeReadsFd,inputProtocols,probePinnedSequenceAsset,probeSequenceAssetSource} from './media';
import {registerSequenceReferenceDetailed,registeredSequenceReferences} from './references';
import {SequenceStore} from './store';
import {buildEmptyDocument} from './createDocuments';
import {ImportBatches} from './importBatches';
import {createEditorImportAdapter} from './importAgent';
import {makeVideoSamples,type VideoSamples} from './__fixtures__/videoSamples';

const listing=(input:string[],output:string[])=>`Supported file protocols:\nInput:\n${input.map(p=>`  ${p}\n`).join('')}Output:\n${output.map(p=>`  ${p}\n`).join('')}`;
let root='',samples:VideoSamples,image='',realProbe='',realFfmpeg='';
const saved={HARNESS_FFMPEG:process.env.HARNESS_FFMPEG,SUPERMOVIE_FFMPEG:process.env.SUPERMOVIE_FFMPEG};
beforeAll(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'ffprobe-fd-')));samples=makeVideoSamples(root);
  realProbe=defaultWhich('ffprobe')??'';realFfmpeg=defaultWhich('ffmpeg')??'';
  if(!realProbe||!realFfmpeg)throw new Error('ffmpeg と ffprobe が必要です');
  image=join(root,'still.png');execFileSync(realFfmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:size=32x32','-frames:v','1',image]);
},60000);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
afterEach(()=>{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});

interface Fake {ffprobe:string;ffmpeg:string;calls():string[]}
/** 偽の ffprobe を作る。fd: 対応なら一覧の Input 欄に fd を出す。非対応なら一覧に fd を出さず、fd: の入力は古い版と同じく断る。list が null なら一覧は終了コード1で失敗する。 */
function fake(name:string,list:string|null,readsFd=list===NEW):Fake{
  const dir=join(root,name);mkdirSync(dir);const log=join(dir,'calls.log');writeFileSync(log,'');
  writeFileSync(join(dir,'ffprobe'),['#!/bin/sh',`printf '%s\\n' "$*" >> '${log}'`,'case " $* " in',
    list===null?`  *" -protocols "*) echo 'Unrecognized option' >&2; exit 1;;`:`  *" -protocols "*) printf '%s' '${list}'; exit 0;;`,
    ...(readsFd?[]:[`  *" fd: "*) echo 'fd:: Protocol not found' >&2; exit 1;;`]),
    'esac',`exec '${realProbe}' "$@"`,''].join('\n'));
  chmodSync(join(dir,'ffprobe'),0o755);symlinkSync(realFfmpeg,join(dir,'ffmpeg'));
  return {ffprobe:join(dir,'ffprobe'),ffmpeg:join(dir,'ffmpeg'),calls:()=>readFileSync(log,'utf8').split('\n').filter(Boolean)};
}
/** この偽の ffprobe を使う（resolveFfprobeBin は HARNESS_FFMPEG の隣の ffprobe を選ぶ）。 */
const use=(f:Fake)=>{process.env.HARNESS_FFMPEG=f.ffmpeg;delete process.env.SUPERMOVIE_FFMPEG;};
/** 断る理由（音声の準備・文字起こしはコピーした素材も fd: で ffmpeg に渡すので、古い ffmpeg ではコピーも勧めない）。 */
const REFUSAL='この ffmpeg は古いため、この素材を取り込めません。ffmpeg を新しくしてください';
const OLD=listing(['async','file','pipe'],['file','pipe']),NEW=listing(['async','fd','file','pipe'],['fd','file','pipe']);
const copy=(from:string,name:string)=>{const to=join(root,name);copyFileSync(from,to);return to;};
const project=()=>realpathSync(mkdtempSync(join(root,'project-')));

describe('ffprobe が fd: を読めるかの判定',()=>{
  it('一覧の Input の欄に fd があれば対応、無ければ非対応（Output の欄だけの fd は数えない）',async()=>{
    expect(inputProtocols(NEW)).toEqual(['async','fd','file','pipe']);
    expect(inputProtocols(listing(['file'],['fd','file']))).toEqual(['file']);
    expect(inputProtocols('')).toEqual([]);
    expect(await ffprobeReadsFd(fake('judge-new',NEW).ffprobe)).toBe(true);
    expect(await ffprobeReadsFd(fake('judge-old',OLD).ffprobe)).toBe(false);
    expect(await ffprobeReadsFd(fake('judge-output-only',listing(['file','pipe'],['fd','file'])).ffprobe)).toBe(false);
  });
  it('対応している結果は bin ごとに1回だけ調べて覚える。非対応の結果は覚えない（ffmpeg を新しくした後に開き直さずに通す）',async()=>{
    const ok=fake('remember-new',NEW),old=fake('remember-old',OLD);
    await Promise.all([ffprobeReadsFd(ok.ffprobe),ffprobeReadsFd(ok.ffprobe)]);await ffprobeReadsFd(ok.ffprobe);
    expect(ok.calls()).toEqual(['-hide_banner -protocols']);
    await ffprobeReadsFd(old.ffprobe);await ffprobeReadsFd(old.ffprobe);
    expect(old.calls()).toEqual(['-hide_banner -protocols','-hide_banner -protocols']);
  });
});

describe('fd: を読めない古い ffprobe',()=>{
  it('参照取り込みは分かる理由で断り、ffprobe をパスで呼ばず、何も登録しない',async()=>{
    expect(FFPROBE_FD_UNSUPPORTED).toBe(REFUSAL);
    const f=fake('old-reference',OLD),source=copy(samples.first,'old-reference.mp4'),dir=project();use(f);
    await expect(registerSequenceReferenceDetailed(dir,source,'old-reference.mp4')).rejects.toThrow(REFUSAL);
    expect(await registeredSequenceReferences(dir)).toEqual([]);
    // 呼ばれたのは一覧だけ（fd: でもパスでも調べていない）。
    expect(f.calls()).toEqual(['-hide_banner -protocols']);
  });
  it('画像の参照も同じ理由で断る（「画像を読み取れません」にまとめない）',async()=>{
    const f=fake('old-image',OLD);use(f);const handle=await open(image,'r');
    try{await expect(probePinnedSequenceAsset(handle,basename(image))).rejects.toThrow(REFUSAL);}finally{await handle.close();}
    expect(f.calls()).toEqual(['-hide_banner -protocols']);
  });
  it('取り込みの束: リンクは素材の失敗として画面に理由を出し（AI には固定文）、コピーとパスで調べる経路は今まで通り準備できる',async()=>{
    const f=fake('old-batches',OLD),base=realpathSync(mkdtempSync(join(root,'batches-'))),allowed=join(base,'allowed'),dir=join(base,'case');
    mkdirSync(allowed);mkdirSync(dir);new SequenceStore(dir).save({document:buildEmptyDocument('case',()=>'doc'),expectedSavedRevision:null,executionId:'seed'});
    copyFileSync(samples.first,join(allowed,'link.mp4'));copyFileSync(samples.second60,join(allowed,'copy.mp4'));use(f);
    const b=new ImportBatches(),a=createEditorImportAdapter(base,b,()=>[{key:'allowed',label:'許可',path:allowed}]);
    const link=a.start({projectId:'case',operationId:'op-link',paths:[join(allowed,'link.mp4')],placement:'append-main'});await b.idle(dir,link.batchId);
    expect(b.get(dir,link.batchId).items[0]).toMatchObject({phase:'failed',error:REFUSAL});
    expect(a.runs('case',link.batchId)[0]!.items[0]).toMatchObject({phase:'failed',error:'この素材を読み込めませんでした'});
    expect(f.calls().some(call=>call.includes(allowed))).toBe(false);
    const before=f.calls().length;
    const copied=a.start({projectId:'case',operationId:'op-copy',paths:[join(allowed,'copy.mp4')],placement:'append-main',mode:'copy'});await b.idle(dir,copied.batchId);
    expect(b.get(dir,copied.batchId).items[0]).toMatchObject({phase:'ready',durationSeconds:2});
    // コピーは一覧を調べず、案件へ写した素材をパスで調べる（古い ffprobe でも今まで通り）。
    expect(f.calls().slice(before).some(call=>call.includes('-protocols'))).toBe(false);
    expect(f.calls().slice(before).some(call=>call.includes('-show_streams'))).toBe(true);
    const path=copy(samples.third25,'old-path.mp4');
    expect((await probeSequenceAssetSource(path,'old-path.mp4','名前')).asset.kind).toBe('media');
  });
});

describe('一覧を取れない ffprobe（-protocols が失敗する）',()=>{
  it('判定せず従来どおり fd: で調べて参照を登録し（パスでは呼ばない）、判定の結果は覚えない',async()=>{
    const f=fake('no-listing',null,true),source=copy(samples.first,'no-listing.mp4'),dir=project();use(f);
    await expect(ffprobeReadsFd(f.ffprobe)).rejects.toThrow('素材の準備に失敗しました');
    await expect(registerSequenceReferenceDetailed(dir,source,'no-listing.mp4')).resolves.toMatchObject({asset:{kind:'media'}});
    const handle=await open(image,'r');
    try{await expect(probePinnedSequenceAsset(handle,basename(image))).resolves.toMatchObject({kind:'image'});}finally{await handle.close();}
    const calls=f.calls();
    // 一覧は毎回取り直す（直接の判定1回＋参照の調査2回）。調査は2回とも開いたファイル（fd:）で、パスを渡していない。
    expect(calls.filter(call=>call==='-hide_banner -protocols')).toHaveLength(3);
    expect(calls.filter(call=>call.includes('-fd 3')&&call.endsWith(' fd:'))).toHaveLength(2);
    expect(calls.some(call=>call.includes(source)||call.includes(image))).toBe(false);
  });
});

describe('fd: を読める ffprobe',()=>{
  it('参照取り込みは今まで通り開いたファイルを fd: で調べて登録し、パスでの調査と同じ素材になる',async()=>{
    const f=fake('new-reference',NEW),source=copy(samples.rotated,'new-reference.mp4'),dir=project();use(f);
    const {asset}=await registerSequenceReferenceDetailed(dir,source,'new-reference.mp4');
    const byPath=await probeSequenceAssetSource(source,asset.file,'new-reference.mp4');
    expect(asset).toStrictEqual(byPath.asset);
    const calls=f.calls();
    expect(calls[0]).toBe('-hide_banner -protocols');
    expect(calls.filter(call=>call.includes('-fd 3')&&call.endsWith(' fd:'))).toHaveLength(1);
    // 参照の調査（一覧の後・パスでの比較の前）はパスを渡していない。
    expect(calls.slice(0,2).some(call=>call.includes(source))).toBe(false);
  });
});
