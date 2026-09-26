import {describe,it,expect} from 'vitest';
import {SequenceSession} from './session';
import {fixture} from './fixtures';

// I2: NativeWorkspace の「案件から外す」トレイは Undo で asset が doc.assets へ戻ったことを
// 検知して自分から消える設計になっている。その前提（remove-asset の Undo で asset が実際に
// document へ戻る）が history 機構側で保証されていることを確認する回帰テスト。
describe('remove-asset の Undo',()=>{
  it('外した素材が Undo で document へ戻る',()=>{
    const original=fixture();
    const withUnused={...original,assets:[...original.assets,{id:'unused',kind:'media' as const,file:'public/se/unused.wav',name:'未使用',fingerprint:'unused',
      streams:[{index:0,kind:'audio' as const,codec:'aac',duration:{num:1,den:1},sampleRate:48000,channels:2}]}]};
    const session=new SequenceSession('session',withUnused);
    const removed=session.execute({sessionId:'session',executionId:'remove',expectedRevision:0,command:{type:'remove-asset',assetId:'unused'}});
    expect(removed.document.assets.some(a=>a.id==='unused')).toBe(false);
    const undone=session.execute({sessionId:'session',executionId:'undo',expectedRevision:removed.document.revision,command:{type:'undo'}});
    expect(undone.document.assets.some(a=>a.id==='unused')).toBe(true);
  });
});
