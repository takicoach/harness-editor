import { installNativeDataPack, isNativeDataPackInstalled } from './nativeDataPacks';

/** Native editing uses validated data; legacy project TSX stays untouched. */
export function isSpeedInstalled(dir:string):boolean { return isNativeDataPackInstalled('speed',dir); }
export function installSpeed(dir:string):{ installed:boolean } {
  return installNativeDataPack('speed',dir);
}
