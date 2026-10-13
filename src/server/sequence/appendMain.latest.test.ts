import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {SequenceService} from './service';
import {SequenceStore} from './store';
import {buildEmptyDocument} from './createDocuments';

/** 素材の確認（全体のハッシュ）を待つ間に、別の編集が版を進める。 */
const h=vi.hoisted(()=>({during:null as null|(()=>void|Promise<void>)}));
const asset:SequenceAsset={id:'media-take',kind:'media',file:'.harness/assets/take.mp4',name:'take.mp4',fingerprint:'a'.repeat(64),
  streams:[{index:0,kind:'video',codec:'h264',duration:r(1),frameRate:r(30),width:160,height:90},{index:1,kind:'audio',codec:'aac',duration:r(1),sampleRate:48000,channels:2}]};
vi.mock('./assets',async importOriginal=>({...(await importOriginal<typeof import('./assets')>()),
  registeredSequenceAssets:vi.fn(async()=>[asset]),
  verifiedSequenceAssetPath:vi.fn(async()=>{await h.during?.();return '/media/take.mp4';})}));
import {appendAssetsToMain} from './appendMain';
import {verifiedSequenceAssetPath} from './assets';

let dir='',sessions:SequenceService;
beforeEach(()=>{
  dir=realpathSync(mkdtempSync(join(tmpdir(),'append-latest-')));sessions=new SequenceService();h.during=null;
  new SequenceStore(dir).save({document:buildEmptyDocument('空',()=>'doc'),expectedSavedRevision:null,executionId:'seed'});
});
afterEach(()=>{rmSync(dir,{recursive:true,force:true});});

it('builds the append on the document as it is after the material check, keeping an edit made meanwhile',async()=>{
  const state=sessions.open(dir);
  h.during=()=>{sessions.execute(dir,{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:'other',command:{type:'add-track',track:{id:'v-extra',name:'映像2',kind:'visual',enabled:true}}});};
  const done=await appendAssetsToMain(dir,sessions,{sessionId:state.sessionId,executionId:'append',assetIds:[asset.id]});
  expect(done.document.revision).toBe(state.document.revision+2);
  expect(done.document.tracks.map(t=>t.id)).toContain('v-extra');
  expect(done.document.clips.filter(c=>c.content.kind==='video').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,30]]);
});
it('does not place anything when the request was dropped during the material check',async()=>{
  const state=sessions.open(dir),controller=new AbortController();
  h.during=()=>{controller.abort(new Error('切断'));};
  await expect(appendAssetsToMain(dir,sessions,{sessionId:state.sessionId,executionId:'append-dropped',assetIds:[asset.id]},controller.signal)).rejects.toThrow('切断');
  expect(sessions.open(dir).document.revision).toBe(state.document.revision);
});

/** 素材の確認を止めておく門。閉じている間に届いた確認はすべて待ち、開ける（release）と通る（fail を渡すとその理由で失敗する）。 */
const gate=()=>{let open!:(failure?:Error)=>void;const closed=new Promise<void>((resolve,reject)=>{open=failure=>failure?reject(failure):resolve();});
  void closed.catch(()=>undefined);h.during=()=>closed;return open;};
const videos=()=>sessions.open(dir).document.clips.filter(c=>c.content.kind==='video');
describe('同じ実行 ID の並行した要求（応答が届かなかった時の再送）',()=>{
  it('同じ内容の2要求は両方とも同じ結果を受け取り、追加は1回だけ',async()=>{
    const state=sessions.open(dir),release=gate(),request={sessionId:state.sessionId,executionId:'twice',assetIds:[asset.id]};
    const first=appendAssetsToMain(dir,sessions,request),second=appendAssetsToMain(dir,sessions,{...request,assetIds:[asset.id]});
    release();const [a,b]=await Promise.all([first,second]);
    expect(b).toStrictEqual(a);expect(a).toMatchObject({appliedRevision:state.document.revision+1,changed:true});
    expect(videos()).toHaveLength(1);expect(sessions.open(dir).document.revision).toBe(state.document.revision+1);
  });
  it('処理中の実行 ID に違う内容が届いたら、待たずに 409 で断り、先の追加は通る',async()=>{
    const state=sessions.open(dir),release=gate();
    const first=appendAssetsToMain(dir,sessions,{sessionId:state.sessionId,executionId:'clash',assetIds:[asset.id]});
    await expect(appendAssetsToMain(dir,sessions,{sessionId:state.sessionId,executionId:'clash',assetIds:[asset.id,asset.id]}))
      .rejects.toMatchObject({status:409,message:'同じ実行IDに異なる追加があります'});
    release();await expect(first).resolves.toMatchObject({changed:true});expect(videos()).toHaveLength(1);
  });
  it('先の処理が失敗したら、待っていた要求も同じ失敗を受け取り、同じ実行 ID の再送は新しく実行する',async()=>{
    const state=sessions.open(dir),release=gate(),request={sessionId:state.sessionId,executionId:'retry',assetIds:[asset.id]};
    const first=appendAssetsToMain(dir,sessions,request),second=appendAssetsToMain(dir,sessions,request);
    release(new Error('素材を確認できません'));
    await expect(first).rejects.toThrow('素材を確認できません');await expect(second).rejects.toThrow('素材を確認できません');
    expect(videos()).toHaveLength(0);h.during=null;
    const done=await appendAssetsToMain(dir,sessions,request);
    expect(done).toMatchObject({appliedRevision:state.document.revision+1,changed:true,replayed:false});expect(videos()).toHaveLength(1);
  });
  it('先の要求の接続が切れても、待っている後の要求は巻き込まれず追加を受け取る',async()=>{
    const state=sessions.open(dir),release=gate(),leader=new AbortController(),request={sessionId:state.sessionId,executionId:'leader-dropped',assetIds:[asset.id]};
    const first=appendAssetsToMain(dir,sessions,request,leader.signal),second=appendAssetsToMain(dir,sessions,request,new AbortController().signal);
    leader.abort(new Error('切断'));release();
    await expect(first).rejects.toThrow('切断');
    await expect(second).resolves.toMatchObject({appliedRevision:state.document.revision+1,changed:true});expect(videos()).toHaveLength(1);
  });
  it('処理中の実行 ID に、別のセッション・別の案件フォルダから届いた要求は 409 で断り、先の追加は通る',async()=>{
    const state=sessions.open(dir),release=gate(),other=realpathSync(mkdtempSync(join(tmpdir(),'append-latest-other-')));
    try{
      new SequenceStore(other).save({document:buildEmptyDocument('別',()=>'doc'),expectedSavedRevision:null,executionId:'seed'});
      const first=appendAssetsToMain(dir,sessions,{sessionId:state.sessionId,executionId:'keyed',assetIds:[asset.id]});
      await expect(appendAssetsToMain(dir,sessions,{sessionId:'another-session',executionId:'keyed',assetIds:[asset.id]}))
        .rejects.toMatchObject({status:409,message:'同じ実行IDに異なる追加があります'});
      await expect(appendAssetsToMain(other,sessions,{sessionId:state.sessionId,executionId:'keyed',assetIds:[asset.id]}))
        .rejects.toMatchObject({status:409,message:'同じ実行IDに異なる追加があります'});
      release();await expect(first).resolves.toMatchObject({changed:true});expect(videos()).toHaveLength(1);
    }finally{rmSync(other,{recursive:true,force:true});}
  });
  it('待っている要求が全部切れたら、門を開けても追加しない（版が進まない）',async()=>{
    const state=sessions.open(dir),release=gate(),one=new AbortController(),two=new AbortController(),request={sessionId:state.sessionId,executionId:'all-dropped-only',assetIds:[asset.id]};
    const verify=vi.mocked(verifiedSequenceAssetPath),before=verify.mock.results.length;
    const first=appendAssetsToMain(dir,sessions,request,one.signal),second=appendAssetsToMain(dir,sessions,request,two.signal);
    one.abort(new Error('切断'));two.abort(new Error('切断'));
    await expect(first).rejects.toThrow('切断');await expect(second).rejects.toThrow('切断');
    release();
    // 捨てた処理が素材の確認を実際に終えたこと（処理が実在すること）を確かめ、実行の直前の中止の確認まで進ませてから見る。
    await vi.waitFor(()=>expect(verify.mock.results.length).toBe(before+1));await verify.mock.results.at(-1)!.value;await new Promise(done=>setTimeout(done,0));
    expect(videos()).toHaveLength(0);expect(sessions.open(dir).document.revision).toBe(state.document.revision);
  });
  it('待っている要求が全部切れた後に届いた同じ実行 ID の要求は、捨てた処理に加わらず新しく実行する',async()=>{
    const state=sessions.open(dir),release=gate(),one=new AbortController(),two=new AbortController(),request={sessionId:state.sessionId,executionId:'all-dropped',assetIds:[asset.id]};
    const first=appendAssetsToMain(dir,sessions,request,one.signal),second=appendAssetsToMain(dir,sessions,request,two.signal);
    one.abort(new Error('切断'));two.abort(new Error('切断'));
    const third=appendAssetsToMain(dir,sessions,request);release();
    await expect(first).rejects.toThrow('切断');await expect(second).rejects.toThrow('切断');
    await expect(third).resolves.toMatchObject({appliedRevision:state.document.revision+1,changed:true});
    expect(videos()).toHaveLength(1);expect(sessions.open(dir).document.revision).toBe(state.document.revision+1);
  });
});
