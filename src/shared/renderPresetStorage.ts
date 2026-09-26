import {DEFAULT_RENDER_OPTIONS,parseRenderOptions,type RenderOptions} from './renderPreset';

export const PRESET_STORAGE_KEY='sme:render-preset';
/** Shared with the old dialog. Keep its optional ducking preference, but never
 * carry a project's output filename into a different project. Storage is optional. */
export function loadStoredRenderOptions(storage?:Pick<Storage,'getItem'>):RenderOptions {
  try{
    const raw=(storage??localStorage).getItem(PRESET_STORAGE_KEY);
    const parsed=raw?parseRenderOptions(JSON.parse(raw))??DEFAULT_RENDER_OPTIONS:DEFAULT_RENDER_OPTIONS;
    const {outputName:_previousProjectName,...settings}=parsed;
    return settings;
  }catch{return {...DEFAULT_RENDER_OPTIONS};}
}
export function saveStoredRenderOptions(options:RenderOptions,storage?:Pick<Storage,'setItem'>):void {
  try{(storage??localStorage).setItem(PRESET_STORAGE_KEY,JSON.stringify(options));}
  catch{/* Remembering a preference must not prevent exporting saved data. */}
}
