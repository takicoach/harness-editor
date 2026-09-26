import { afterEach, expect, it,vi } from 'vitest';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync,readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerResponse, IncomingMessage } from 'node:http';
import { loadProjectFromDir } from './loadProjectFiles';
import { saveProjectToDir } from './saveProject';
import { detectColorWheelsSupport } from './colorGradeSupport';
import { DEFAULT_COLOR_GRADE, normalizeColorWheels } from '../core/colorGrade';
import { formatColorGradeExport } from '../core/mainLayoutData';
import { handleRenderPost,renderJobs } from './renderApi';
import {LegacyNativeRenderJobs} from './legacyNativeRenderJobs';
import {SequenceExports} from './sequence/exports';

const roots: string[] = [];
afterEach(() => {vi.restoreAllMocks();roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }));});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wheel-guard-')); roots.push(dir);
  cpSync(resolve('src/server/__fixtures__/sample-project'), dir, { recursive: true });
  return dir;
}
const grade = { ...DEFAULT_COLOR_GRADE, wheels: normalizeColorWheels({ lift: { x: 12, y: -24, level: 18 } }) };

it('rejects unsupported wheel saves before modifying project files', () => {
  const dir = fixture(), loaded = loadProjectFromDir(dir);
  const before = readFileSync(join(dir, loaded.save.telopDataRelPath), 'utf8');
  expect(() => saveProjectToDir(dir, { project: { ...loaded.project, colorGrade: grade }, fingerprint: loaded.save.fingerprint })).toThrow('カラーホイールを保存する前に');
  expect(readFileSync(join(dir, loaded.save.telopDataRelPath), 'utf8')).toBe(before);
  expect(existsSync(join(dir, 'src/mainLayoutData.ts'))).toBe(false);
});
it('accepts the installed payload despite documentation examples, and saves wheel data through the real server', () => {
  const dir = fixture();
  cpSync(resolve('src/server/mainLayoutPayload'), join(dir, 'src/MainLayout'), { recursive: true });
  writeFileSync(join(dir, 'src/MainVideo.tsx'), '// Example: <VideoInsertSequence/>\nexport const MainVideo=()=> <MainLayout colorGrade={COLOR_GRADE}><CutPlayer/></MainLayout>;');
  expect(detectColorWheelsSupport(dir)).toBe(true);
  const loaded = loadProjectFromDir(dir);
  expect(saveProjectToDir(dir, { project: { ...loaded.project, colorGrade: grade }, fingerprint: loaded.save.fingerprint }).ok).toBe(true);
  expect(loadProjectFromDir(dir).project.colorGrade).toEqual(grade);
});
it('dispatches saved wheels to native export without requiring the old rendering payload', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'src/mainLayoutData.ts'), formatColorGradeExport(grade));
  let status = 0, body = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { body = text; }, get writableEnded() { return false; } } as unknown as ServerResponse;
  expect(detectColorWheelsSupport(dir)).toBe(false);
  const start=vi.spyOn(renderJobs,'start').mockReturnValue({projectId:'fixture',phase:'preparing',startedAt:1,outputFile:'out.mp4'});
  const req = { headers: {},socket:{localPort:2109}, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage;
  await handleRenderPost(req, res, 'fixture', dir);
  expect(status).toBe(200); expect(JSON.parse(body).native).toBe(true);expect(start).toHaveBeenCalledWith('fixture',expect.objectContaining({projectDir:dir,origin:'http://127.0.0.1:2109'}));
  expect(loadProjectFromDir(dir).project.colorGrade).toEqual(grade);
  expect(existsSync(join(dir, 'out'))).toBe(false);
});
it('fails native preparation for malformed main audio before the renderer can run',async()=>{
  const dir=fixture();writeFileSync(join(dir,'src/mainAudioData.ts'),'export const MAIN_AUDIO = { gainDb: "broken" };');
  const render=vi.fn(async()=>{}),jobs=new LegacyNativeRenderJobs(new SequenceExports(render));
  jobs.start('invalid-audio',{projectDir:dir,origin:'http://127.0.0.1:2109',options:{resolution:'full',quality:'high'}});await jobs.wait('invalid-audio');
  expect(jobs.getSnapshot('invalid-audio')).toMatchObject({phase:'failed',error:{message:expect.stringContaining('gainDb')}});
  expect(render).not.toHaveBeenCalled();expect(readdirSync(join(dir,'out'))).toEqual([]);
});
