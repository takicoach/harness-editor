import {expect,it} from 'vitest';
import {renderHttpError} from './renderHttpError';
import {renderErrorHint} from './panels/Toolbar';

it('preserves an unfamiliar server code and its explanation through the raw-message fallback',()=>{
  const error=renderHttpError({error:'future-server-code',message:'保存先を確認してください'},409);
  expect(error).toEqual({code:'future-server-code',message:'保存先を確認してください'});
  expect(renderErrorHint(error.code)).toBeNull();
});
it('preserves a server-only error string when no separate explanation is supplied',()=>{
  expect(renderHttpError({error:'サーバー側の説明',message:42},400)).toEqual({code:'サーバー側の説明',message:'サーバー側の説明'});
});
it('uses the existing unknown classification and HTTP status when the response has no usable error strings',()=>{
  expect(renderHttpError({error:{nested:'value'},message:null},503)).toEqual({code:'unknown',message:'HTTP 503'});
  expect(renderErrorHint('unknown')).not.toBeNull();
});
