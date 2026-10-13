// src/server/sequence/importAgent.paths.test.ts
// 本物の準備（ffprobe・指紋・参照の登録）で、AI に返す形にパスが出ないことと、受付から準備までの間の差し替えを断ることを確かめる。素材は lavfi の合成。
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {SequenceStore} from './store';
import {buildEmptyDocument} from './createDocuments';
import {ImportBatches} from './importBatches';
import {createEditorImportAdapter} from './importAgent';
import {registerSequenceReferenceDetailed} from './references';
import {importSequenceAssetDetailed} from './assets';

let media='',root='',allowed='',outside='',project='';
beforeAll(()=>{
  media=realpathSync(mkdtempSync(join(tmpdir(),'import-agent-media-')));
  const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=64x36:rate=10','-t','0.3','-c:v','mpeg4','-pix_fmt','yuv420p',join(media,'take.mp4')]);
},30000);
afterAll(()=>rmSync(media,{recursive:true,force:true}));
beforeEach(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'import-agent-paths-')));allowed=join(root,'allowed');outside=join(root,'outside');project=join(root,'case');
  for(const dir of [allowed,outside,project])mkdirSync(dir);copyFileSync(join(media,'take.mp4'),join(outside,'take.mp4'));
  new SequenceStore(project).save({document:buildEmptyDocument('case',()=>'doc'),expectedSavedRevision:null,executionId:'seed'});
});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
const place=(folder:string)=>{mkdirSync(join(allowed,folder));copyFileSync(join(media,'take.mp4'),join(allowed,folder,'take.mp4'));return join(allowed,folder,'take.mp4');};
const setup=()=>{const b=new ImportBatches();return {b,a:createEditorImportAdapter(root,b,()=>[{key:'allowed',label:'許可',path:allowed}])};};
/** 受付の直後（準備が走る前）に、途中のフォルダを許可外へのリンクに差し替える。 */
const swap=(folder:string)=>{renameSync(join(allowed,folder),join(allowed,`${folder}-old`));symlinkSync(outside,join(allowed,folder));};

it('never returns a path to the AI when preparing fails after the file moved',async()=>{
  const {a,b}=setup(),path=place('moved'),view=a.start({projectId:'case',operationId:'op-moved',paths:[path],placement:'append-main'});
  renameSync(path,join(root,'gone.mp4'));await b.idle(project,view.batchId);
  // 記録には fs の例外文（パス入り）が残る＝この試験は本当に漏れうる文を通している。
  expect(b.get(project,view.batchId).items[0]!.error).toContain(root);
  for(const answer of [a.runs('case',view.batchId)[0]!,a.runs('case')[0]!,a.start({projectId:'case',operationId:'op-moved',paths:[path],placement:'append-main'})]){
    expect(answer.items[0]).toMatchObject({phase:'failed',error:'この素材を読み込めませんでした'});
    const text=JSON.stringify(answer);expect(text).not.toContain('/');expect(text).not.toContain(homedir());
  }
});
it('prepares an untouched authorized video (control), but refuses one whose folder became a link to the outside after acceptance',async()=>{
  const {a,b}=setup(),ok=a.start({projectId:'case',operationId:'op-ok',paths:[place('ok')],placement:'append-main'});
  await b.idle(project,ok.batchId);expect(a.runs('case',ok.batchId)[0]!.items[0]!.phase).toBe('ready');
  for(const mode of ['link','copy'] as const){
    const view=a.start({projectId:'case',operationId:`op-swap-${mode}`,paths:[place(`swap-${mode}`)],placement:'append-main',mode});
    swap(`swap-${mode}`);await b.idle(project,view.batchId);
    expect(b.get(project,view.batchId).items[0]).toMatchObject({phase:'failed',error:expect.stringContaining('受け付けた時から変わりました')});
  }
});
it('the reference and copy imports refuse a source that is no longer its own real path only when asked to',async()=>{
  const path=place('direct');swap('direct');
  await expect(registerSequenceReferenceDetailed(project,path,'take.mp4',undefined,undefined,undefined,{resolvedSource:true})).rejects.toThrow(/受け付けた時から変わりました/);
  await expect(importSequenceAssetDetailed(project,path,'take.mp4',undefined,undefined,{resolvedSource:true})).rejects.toThrow(/受け付けた時から変わりました/);
  // 指定しない既存の呼び出し（移行の再接続など）は今のまま実パスへ解決して読む。
  await expect(registerSequenceReferenceDetailed(project,path,'take.mp4')).resolves.toMatchObject({asset:{kind:'media'}});
});

// 受付（許可の確認）と準備の再確認は、同じ「ディスク上の形」で比べる。macOS は名前の Unicode 正規化と大文字小文字を区別しない（APFS 既定）。
const NFD='ドライバー.mp4'.normalize('NFD'),NFC='ドライバー.mp4'.normalize('NFC');
it('imports a Japanese name saved in NFD but given in NFC, and a case-different path, through to ready',async()=>{
  mkdirSync(join(allowed,'names'));copyFileSync(join(media,'take.mp4'),join(allowed,'names',NFD));copyFileSync(join(media,'take.mp4'),join(allowed,'names','case-take.mp4'));
  const given=[join(allowed,'names',NFC),join(allowed,'NAMES','CASE-TAKE.MP4')];
  // この試験は名前の正規化・大小を区別しないファイルシステムでだけ意味を持つ（存在の確認）。
  expect(NFC).not.toBe(NFD);expect(given.every(path=>existsSync(path))).toBe(true);
  const {a,b}=setup();
  for(const [index,path] of given.entries()){
    const view=a.start({projectId:'case',operationId:`op-name-${index}`,paths:[path],placement:'append-main'});await b.idle(project,view.batchId);
    expect(a.runs('case',view.batchId)[0]!.items[0]).toMatchObject({phase:'ready'});expect(b.get(project,view.batchId).items[0]).not.toHaveProperty('error');
  }
});
