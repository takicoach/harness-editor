import { installNativeDataPack, isNativeDataPackInstalled } from './nativeDataPacks';

/** Native editing uses validated data; legacy project TSX stays untouched. */
export function isBgmInstalled(dir:string):boolean { return isNativeDataPackInstalled('bgm',dir); }
export function installBgm(dir:string):{ installed:boolean } {
  return installNativeDataPack('bgm',dir);
}
