import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installMainLayout,isMainLayoutInstalled} from './installMainLayout';
import {installSpeed} from './installSpeed';
import {installVideoInsert} from './installVideoInsert';
import {detectColorGradeSupport,detectColorWheelsSupport} from './colorGradeSupport';
import {evalDataModule} from '../core/dataModule';
import {readNativeDataPackState} from './nativeDataPacks';

let dir:string;
const config="export const FORMAT='youtube';export const FPS=30;export const DURATION_FRAMES=300;export const VIDEO_FILE='main.mp4';export const RESOLUTION={width:1280,height:720};";
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'native-layout-install-'));mkdirSync(join(dir,'src'));writeFileSync(join(dir,'src/videoConfig.ts'),config);});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
const read=(path:string)=>readFileSync(join(dir,path),'utf8');
function put(path:string,source:string){const parts=path.split('/');parts.pop();mkdirSync(join(dir,...parts),{recursive:true});writeFileSync(join(dir,path),source);}

describe('native layout data installation',()=>{
  it('works without MainVideo, Root, runtime components or project dependencies',()=>{
    expect(installMainLayout(dir)).toEqual({installed:true});
    expect(isMainLayoutInstalled(dir)).toBe(true);
    const data=evalDataModule(read('src/mainLayoutData.ts'));
    expect(data.MAIN_LAYOUT).toMatchObject({scale:1,position:{x:0,y:0}});
    expect(data.SEGMENT_LAYOUTS).toEqual({});expect(data.LAYOUT_KEYFRAMES).toEqual([]);
    expect(data.COLOR_GRADE).toEqual({brightness:0,contrast:0,saturation:0,temperature:0});
    for(const path of ['src/MainVideo.tsx','src/Root.tsx','package.json','src/MainLayout/MainLayout.tsx','src/MainLayout/colorGrade.ts'])
      expect(existsSync(join(dir,path))).toBe(false);
    expect(detectColorGradeSupport(dir)).toBe(true);expect(detectColorWheelsSupport(dir)).toBe(true);
  });
  it('preserves custom old source, component files, dependency declarations and original backup',()=>{
    const protectedFiles={'src/MainVideo.tsx':'export const MainVideo=()=> <CustomComposition />;',
      'src/Root.tsx':'export const Root=()=> <CustomRoot />;','package.json':'{"private":true,"custom":"keep"}',
      'src/MainVideo.original.bak.tsx':'original backup',
      'src/MainLayout/MainLayout.tsx':'export const MainLayout=()=> null;',
      'src/MainLayout/colorGrade.ts':'export const customMath=42;'};
    for(const [path,source] of Object.entries(protectedFiles))put(path,source);
    put('src/MainLayout/main-layout.json','{"feature":"mainLayout","version":"old"}');
    installMainLayout(dir);installMainLayout(dir);
    for(const [path,source] of Object.entries(protectedFiles))expect(read(path)).toBe(source);
    expect(readNativeDataPackState('mainLayout',dir).status).toBe('ready');
  });
  it('preserves complete layout, per-segment values, keyframes, wheel settings and unrelated exports byte for byte',()=>{
    const source=`export const CUSTOM_TAG='keep';
export const MAIN_LAYOUT={position:{x:12,y:-8},scale:1.6,background:'#123456'};
export const SEGMENT_LAYOUTS={7:{position:{x:5,y:6},scale:0.9,rotation:12}};
export const LAYOUT_KEYFRAMES=[{originalFrame:15,x:7,y:8,scale:1.1,rotation:9}];
export const COLOR_GRADE={brightness:7,contrast:8,saturation:9,temperature:10,wheels:{lift:{x:1,y:2,level:3},gamma:{x:4,y:5,level:6},gain:{x:7,y:8,level:9}}};
`;
    put('src/mainLayoutData.ts',source);installMainLayout(dir);
    expect(read('src/mainLayoutData.ts')).toBe(source);
    expect(detectColorWheelsSupport(dir)).toBe(true);
  });
  it('only appends missing exports to an older data file',()=>{
    const source="export const CUSTOM_TAG='keep';\nexport const MAIN_LAYOUT={position:{x:4,y:5},scale:2,background:'#000000'};\n";
    put('src/mainLayoutData.ts',source);installMainLayout(dir);
    expect(read('src/mainLayoutData.ts').startsWith(source)).toBe(true);
    const data=evalDataModule(read('src/mainLayoutData.ts'));expect(data.CUSTOM_TAG).toBe('keep');
    expect(data.MAIN_LAYOUT).toMatchObject({scale:2});expect(data.SEGMENT_LAYOUTS).toEqual({});
    const once=read('src/mainLayoutData.ts');installMainLayout(dir);expect(read('src/mainLayoutData.ts')).toBe(once);
  });
  it.each([true,false])('preserves speed values in either installation order (layout first=%s)',layoutFirst=>{
    const source="export const MAIN_SPEED=1.5;export const SEGMENT_SPEEDS={7:2};export const CUSTOM='speed';";
    put('src/speedData.ts',source);
    if(layoutFirst){installMainLayout(dir);installSpeed(dir);}else{installSpeed(dir);installMainLayout(dir);}
    expect(read('src/speedData.ts')).toBe(source);expect(isMainLayoutInstalled(dir)).toBe(true);
  });
  it.each([true,false])('keeps color available for inserted video in either order (layout first=%s)',layoutFirst=>{
    if(layoutFirst){installMainLayout(dir);installVideoInsert(dir);}else{installVideoInsert(dir);installMainLayout(dir);}
    expect(detectColorGradeSupport(dir)).toBe(true);expect(detectColorWheelsSupport(dir)).toBe(true);
    expect(readNativeDataPackState('videoInsert',dir).status).toBe('ready');
    expect(existsSync(join(dir,'src/MainVideo.tsx'))).toBe(false);
  });
  it('rejects damaged existing data without replacing it or recording a completed install',()=>{
    const source='export const MAIN_LAYOUT=null;';put('src/mainLayoutData.ts',source);
    expect(()=>installMainLayout(dir)).toThrow();expect(read('src/mainLayoutData.ts')).toBe(source);
    expect(isMainLayoutInstalled(dir)).toBe(false);
  });
  it('does not grant color capability from only a native marker or a broken config',()=>{
    installMainLayout(dir);put('src/mainLayoutData.ts','export const MAIN_LAYOUT=null;');
    expect(detectColorGradeSupport(dir)).toBe(false);expect(detectColorWheelsSupport(dir)).toBe(false);
    expect(isMainLayoutInstalled(dir)).toBe(false);
    put('src/videoConfig.ts',"export const VIDEO_FILE='main.mp4';");
    expect(()=>installMainLayout(dir)).toThrow();
  });
});
