import {expect,it} from 'vitest';
import {nativeExportVideoSettings} from './exportRunner';
import {nativeExportSettings,type NativeExportSettings} from '../../shared/nativeExport';
import {verifyExportProbe} from './exportVerification';
import type {SequenceDocument} from '../../core/sequence/model';

it.each([
  [3840,2160,'full',3840,2160],[3840,2160,'1080p',1920,1080],[2160,3840,'1080p',1080,1920],
  [2160,2160,'1080p',1080,1080],[1200,600,'1080p',1200,600],[640,360,'1080p',640,360],
  [1920,1080,'720p',1280,720],[1080,1920,'720p',720,1280],[3840,2160,'720p',2560,1440],
  [640,360,'720p',426,240],[853,481,'720p',568,320],[2,2,'720p',2,2],
] as const)('maps %i×%i %s to independently fixed %i×%i', (width,height,resolution,w,h)=>{
  const value=nativeExportVideoSettings({width,height},{resolution,quality:'high'});
  expect(value.outputResolution).toEqual({width:w,height:h});
  if(width!==w||height!==h)expect(value.filter).toContain(`scale=${w}:${h}:flags=lanczos:`);
  else expect(value.filter).toBe('scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709');
});
it.each([['high',18],['standard',23],['light',24]] as const)('uses the established %s CRF %i',(quality,crf)=>{
  expect(nativeExportVideoSettings({width:640,height:360},{resolution:'full',quality}).crf).toBe(crf);
});
it('keeps the pre-settings default and rejects malformed settings rather than falling back',()=>{
  expect(nativeExportVideoSettings({width:320,height:180})).toMatchObject({settings:{resolution:'full',quality:'high'},crf:18,outputResolution:{width:320,height:180}});
  for(const value of [null,{},'720p',{resolution:'720p',quality:'bad'},{resolution:['full'],quality:'high'},{resolution:'full',quality:'high',extra:true}])expect(()=>nativeExportSettings(value)).toThrow();
});
it('verifies the selected encoded dimensions without changing the frozen composition dimensions',()=>{
  const doc={resolution:{width:1920,height:1080},sequenceEndFrame:30,fps:{num:30,den:1}} as SequenceDocument;
  const probe={streams:[{codec_type:'video',codec_name:'h264',width:1280,height:720,nb_frames:'30',avg_frame_rate:'30/1',color_space:'bt709',color_primaries:'bt709',color_transfer:'iec61966-2-1',color_range:'tv'},
    {codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2,time_base:'1/48000',duration_ts:48000}]};
  expect(()=>verifyExportProbe(doc,probe,48000,{width:1280,height:720})).not.toThrow();
  expect(()=>verifyExportProbe(doc,probe,48000)).toThrow(/寸法/);
  expect(doc.resolution).toEqual({width:1920,height:1080});
  const invalid={resolution:'wrong',quality:'high'} as unknown as NativeExportSettings;
  expect(()=>nativeExportVideoSettings(doc.resolution,invalid)).toThrow();
});
