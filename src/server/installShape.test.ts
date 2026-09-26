import {afterEach,beforeEach,expect,it} from 'vitest';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installShape,isShapeInstalled} from './installShape';
import {evalDataModule} from '../core/dataModule';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'native-shape-install-'));mkdirSync(join(dir,'src'));writeFileSync(join(dir,'src/videoConfig.ts'),"export const FORMAT='youtube';export const FPS=30;export const DURATION_FRAMES=300;export const VIDEO_FILE='main.mp4';export const RESOLUTION={width:1280,height:720};");});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
it('installs standalone shape data without importing or generating a runtime component',()=>{
  expect(installShape(dir)).toEqual({installed:true});expect(isShapeInstalled(dir)).toBe(true);
  expect(evalDataModule(readFileSync(join(dir,'src/InsertShape/shapeData.ts'),'utf8')).shapeData).toEqual([]);
  for(const path of ['src/MainVideo.tsx','src/Root.tsx','src/InsertShape/ShapeSequence.tsx','src/InsertShape/InsertShape.tsx','package.json'])
    expect(existsSync(join(dir,path))).toBe(false);
});
it('preserves existing shape geometry, custom component and old source through repeat installation',()=>{
  mkdirSync(join(dir,'src/InsertShape'));
  const source="export const CUSTOM='keep';export const shapeData=[{id:1,startFrame:10,endFrame:40,kind:'ellipse',x1:.1,y1:.2,x2:.8,y2:.9,color:'#123456',thickness:'thick',opacity:.6}];";
  writeFileSync(join(dir,'src/InsertShape/shapeData.ts'),source);
  writeFileSync(join(dir,'src/InsertShape/InsertShape.tsx'),'custom shape');
  writeFileSync(join(dir,'src/MainVideo.tsx'),'custom main');
  installShape(dir);installShape(dir);
  expect(readFileSync(join(dir,'src/InsertShape/shapeData.ts'),'utf8')).toBe(source);
  expect(readFileSync(join(dir,'src/InsertShape/InsertShape.tsx'),'utf8')).toBe('custom shape');
  expect(readFileSync(join(dir,'src/MainVideo.tsx'),'utf8')).toBe('custom main');
});
it('rejects a malformed existing shape export and leaves the original intact',()=>{
  mkdirSync(join(dir,'src/InsertShape'));const source='export const shapeData=null;';
  writeFileSync(join(dir,'src/InsertShape/shapeData.ts'),source);
  expect(()=>installShape(dir)).toThrow();expect(isShapeInstalled(dir)).toBe(false);
  expect(readFileSync(join(dir,'src/InsertShape/shapeData.ts'),'utf8')).toBe(source);
});
