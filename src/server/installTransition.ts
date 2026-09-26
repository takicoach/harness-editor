import { installNativeDataPack, isNativeDataPackInstalled } from './nativeDataPacks';

/** Native editing uses validated data; legacy project TSX stays untouched. */
export function isTransitionInstalled(dir:string):boolean { return isNativeDataPackInstalled('transition',dir); }
export function installTransition(dir:string):{ installed:boolean; needsInstall:boolean } {
  return { ...installNativeDataPack('transition',dir), needsInstall:false };
}
