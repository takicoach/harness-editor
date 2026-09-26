import {expect,it} from 'vitest';
import {loadStoredRenderOptions,saveStoredRenderOptions,PRESET_STORAGE_KEY} from './renderPresetStorage';
import {loadStoredRenderOptions as legacyLoad} from '../app/panels/ExportDialog';

it('keeps native remembered fields readable by existing legacy callers',()=>{
  const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  saveStoredRenderOptions({resolution:'720p',quality:'light'},storage);
  expect(PRESET_STORAGE_KEY).toBe('sme:render-preset');
  expect(legacyLoad(storage)).toEqual({resolution:'720p',quality:'light'});
});
it('preserves valid legacy ducking but removes project-specific filenames on read',()=>{
  const storage={getItem:()=>JSON.stringify({resolution:'1080p',quality:'standard',outputName:'other.mp4',ducking:{enabled:true,strength:'strong'}})};
  expect(loadStoredRenderOptions(storage)).toEqual({resolution:'1080p',quality:'standard',ducking:{enabled:true,strength:'strong'}});
});
it('uses the established defaults for absent or corrupt preferences and tolerates denied access',()=>{
  for(const value of [null,'{bad','{"resolution":"4K","quality":"high"}'])expect(loadStoredRenderOptions({getItem:()=>value})).toEqual({resolution:'full',quality:'high'});
  expect(loadStoredRenderOptions({getItem:()=>{throw new Error('denied');}})).toEqual({resolution:'full',quality:'high'});
  expect(()=>saveStoredRenderOptions({resolution:'full',quality:'high'},{setItem:()=>{throw new Error('denied');}})).not.toThrow();
});
