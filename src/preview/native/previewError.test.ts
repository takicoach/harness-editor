import { afterEach, expect, it, vi } from 'vitest';
import { httpByteSource } from './mp4FrameSource';
import { previewFailure, previewResourceError } from './previewError';

afterEach(() => vi.unstubAllGlobals());
it.each(['initial', 'range'] as const)('preserves a legacy asset 404 from %s video reads', async stage => {
  let requests = 0;
  const cancel = vi.fn(async () => {});
  vi.stubGlobal('fetch', vi.fn(async () => stage === 'range' && requests++ === 0
    ? {status:206,headers:new Headers({'content-range':'bytes 0-0/100'}),body:{cancel},arrayBuffer:async()=>new ArrayBuffer(1)}
    : {status:404,headers:new Headers(),body:{cancel}}));
  const get = async () => { const source = await httpByteSource('/api/legacy-preview/asset?id=a&context=b&asset=c'); await source.read(0,10); };
  await expect(get()).rejects.toMatchObject({kind:'context-unavailable',status:404,resource:'asset'});
  expect(cancel).toHaveBeenCalled();
});
it('uses explicit metadata across realms and never guesses expiry from an error message', () => {
  const failure = previewResourceError('失効',404,'component','/api/legacy-preview/component?context=x');
  expect(previewFailure({message:failure.message,kind:failure.kind,status:failure.status,resource:failure.resource})).toEqual({kind:'context-unavailable',message:'失効',status:404,resource:'component'});
  expect(previewFailure(new Error('404 expired'))).toEqual({kind:'render',message:'404 expired'});
  expect(previewFailure(previewResourceError('missing',404,'asset','/api/sequence/asset'))).toMatchObject({kind:'resource',status:404});
  expect(previewFailure(previewResourceError('failed',500,'component','/api/legacy-preview/component'))).toMatchObject({kind:'resource',status:500});
});
