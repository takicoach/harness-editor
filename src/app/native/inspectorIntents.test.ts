import {describe,it,expect} from 'vitest';
import {InspectorIntentQueue,InspectorRevisionGuard} from './inspectorIntents';

const deferred=()=>{let resolve!:(value:boolean)=>void;const promise=new Promise<boolean>(done=>{resolve=done;});return {promise,resolve};};
describe('Inspector commit ordering',()=>{
  it('registers before dispatch, reads the latest state, and gives each field its own revision',async()=>{
    const delay=deferred(),queue=new InspectorIntentQueue();let document={revision:0,x:0,y:0};const seen:number[]=[];
    const first=queue.enqueue(async()=>{seen.push(document.revision);await delay.promise;document={...document,revision:document.revision+1,x:10};return true;});
    const second=queue.enqueue(async()=>{seen.push(document.revision);document={...document,revision:document.revision+1,y:20};return true;});
    expect(queue.pending).toBe(2);expect(seen).toEqual([]);
    const flushed=queue.flush();await Promise.resolve();expect(seen).toEqual([0]);
    delay.resolve(true);expect(await flushed).toBe(true);expect(await first).toBe(true);expect(await second).toBe(true);
    expect(seen).toEqual([0,1]);expect(document).toEqual({revision:2,x:10,y:20});expect(queue.pending).toBe(0);
  });
  it('keeps a rejected commit visible when a later independent field succeeds',async()=>{
    const errors:unknown[]=[];const queue=new InspectorIntentQueue(undefined,error=>errors.push(error));
    const first=queue.enqueue(async()=>false),second=queue.enqueue(async()=>true);
    const flushed=queue.flush();expect(await first).toBe(false);expect(await second).toBe(true);expect(await flushed).toBe(false);
    expect(errors).toHaveLength(1);expect(await queue.flush()).toBe(true);
  });
  it('settles after exceptions and includes work appended while flush is waiting',async()=>{
    const delay=deferred(),queue=new InspectorIntentQueue();
    const first=queue.enqueue(()=>delay.promise),flushed=queue.flush();
    const second=queue.enqueue(async()=>{throw new Error('target removed');});
    delay.resolve(true);await expect(second).rejects.toThrow('target removed');expect(await first).toBe(true);
    expect(await flushed).toBe(false);expect(queue.pending).toBe(0);
  });
});

describe('Inspector revision ownership',()=>{
  const at=(revision:number,id='document')=>({id,revision});
  it('rebases only across contiguous successful own commits, including no-ops',()=>{
    const guard=new InspectorRevisionGuard();
    guard.before(at(3),at(3));guard.accepted(at(3),at(4));
    guard.before(at(3),at(4));guard.accepted(at(4),at(4));
    guard.before(at(3),at(4));guard.accepted(at(4),at(5));
    expect(()=>guard.before(at(3),at(5))).not.toThrow();
    expect(()=>guard.before(at(2),at(5))).toThrow('別の編集');
  });
  it('rejects queued old intentions when external revision arrives during a delayed commit',async()=>{
    const guard=new InspectorRevisionGuard(),queue=new InspectorIntentQueue(),delay=deferred();let current=at(3),applied=false;
    const first=queue.enqueue(async()=>{guard.before(at(3),current);await delay.promise;return false;});
    const next=queue.enqueue(async()=>{guard.before(at(3),current);applied=true;return true;});
    const flushed=queue.flush();await Promise.resolve();current=at(4);delay.resolve(false);
    expect(await first).toBe(false);await expect(next).rejects.toThrow('別の編集');expect(await flushed).toBe(false);expect(applied).toBe(false);
    expect(()=>guard.before(at(4),current)).not.toThrow();expect(await queue.flush()).toBe(true);
  });
  it('rejects external gaps after own success and checks identity and post-dispatch revision',()=>{
    const guard=new InspectorRevisionGuard();guard.accepted(at(3),at(4));
    expect(()=>guard.before(at(3),at(5))).toThrow('別の編集');
    expect(()=>guard.before(at(4),at(4,'other'))).toThrow('別の編集');
    expect(()=>guard.accepted(at(4),at(6))).toThrow('保存中');
    expect(()=>guard.before(at(3),at(4))).toThrow('別の編集');
    expect(()=>guard.accepted(at(4),at(4,'other'))).toThrow('保存中');
  });
});
