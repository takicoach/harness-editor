export type NativeExportPhase = 'queued' | 'preparing' | 'audio' | 'rendering' | 'finalizing' | 'complete' | 'cancelled' | 'failed';
export interface NativeExportPreflight {
  checked:number;referenceCount:number;
  issues:Array<{assetId:string;name:string;message:string}>;
}
export interface NativeExportStatus {
  id: string; projectId: string; revision: number; contentHash: string; executionId: string | null;
  phase: NativeExportPhase; completedFrames: number; totalFrames: number; createdAt: string;
  audioProgress?: number; error?: string; downloadUrl?: string;finishedAt?:string;
  historical?: boolean;
  settings?:NativeExportSettings;outputResolution?:{width:number;height:number};
}
import type {RenderQuality,RenderResolution} from './renderPreset';
/** 'canvas' = HTML in Canvas with the browser's VideoEncoder (exportCanvas.ts). Absent = the screenshot path, whose
 * settings and records carry no engine key at all, so they stay exactly what they were before engines existed. */
export type NativeExportEngine='canvas';
export interface NativeExportSettings {resolution:RenderResolution;quality:RenderQuality;engine?:NativeExportEngine}
export const DEFAULT_NATIVE_EXPORT_SETTINGS:Readonly<NativeExportSettings>=Object.freeze({resolution:'full',quality:'high'});
export function nativeExportSettings(value:unknown):NativeExportSettings {
  if(value===undefined)return {...DEFAULT_NATIVE_EXPORT_SETTINGS};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('書き出し設定が不正です');
  const item=value as Record<string,unknown>;
  if(Object.keys(item).some(key=>key!=='resolution'&&key!=='quality'&&key!=='engine')
    ||typeof item.resolution!=='string'||!['full','1080p','720p'].includes(item.resolution)||typeof item.quality!=='string'||!['high','standard','light'].includes(item.quality)
    ||item.engine!==undefined&&item.engine!=='canvas')throw new Error('書き出し設定が不正です');
  // Key order is part of the record: assertVerifiedSettings and the replay check compare JSON.
  return {resolution:item.resolution as RenderResolution,quality:item.quality as RenderQuality,...(item.engine==='canvas'?{engine:'canvas' as const}:{})};
}
