import {expect,it} from 'vitest';
import {currentStyleEntry} from './textStyleCurrent';

const asset=(id:string,entries:{id:number;name:string}[])=>({id,textStyleCatalog:{packId:id,source:'builtin',entries}} as any);
it('選択中の資産と template 番号から現在のスタイルを返す',()=>{
  const a=asset('a',[{id:1,name:'白文字黒シャドウ'},{id:2,name:'黒文字白背景'}]);
  expect(currentStyleEntry([a],{kind:'telop',data:{text:'x',template:2}} as any,'a')).toEqual({asset:a,entry:{id:2,name:'黒文字白背景'}});
});
it('template が無ければ 1 番、資産が無ければ null',()=>{
  const a=asset('a',[{id:1,name:'一番'}]);
  expect(currentStyleEntry([a],{kind:'telop',data:{text:'x'}} as any,'a')?.entry.name).toBe('一番');
  expect(currentStyleEntry([],{kind:'telop',data:{text:'x'}} as any,undefined)).toBeNull();
});
