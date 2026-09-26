import {cp, mkdir} from 'node:fs/promises';
import {join} from 'node:path';

/** Both transcription entry points resolve this file relative to runtime/src/server. */
export async function stageTranscriptionScript(repo, runtime) {
  const scripts = join(runtime, 'scripts');
  await mkdir(scripts, {recursive: true});
  await cp(join(repo, 'scripts', 'transcribe.py'), join(scripts, 'transcribe.py'));
}
