import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {stageTranscriptionScript} from './runtime-support.mjs';

test('packaged runtime resolves the transcription script from src/server and src/server/sequence', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'desktop-runtime-support-'));
  const source = join(scratch, 'source'), runtime = join(scratch, 'runtime');
  try {
    await mkdir(join(source, 'scripts'), {recursive: true});
    await mkdir(join(runtime, 'src/server/sequence'), {recursive: true});
    await writeFile(join(source, 'scripts/transcribe.py'), '# local test script\n');
    await stageTranscriptionScript(source, runtime);
    const apiPath = resolve(runtime, 'src/server', '..', '..', 'scripts', 'transcribe.py');
    const runnerPath = resolve(runtime, 'src/server/sequence', '../../../scripts/transcribe.py');
    assert.equal(apiPath, runnerPath);
    assert.equal(await readFile(apiPath, 'utf8'), '# local test script\n');
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
});
