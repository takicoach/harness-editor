import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Run the actual entrypoint. Only dependencies are shims; no network/npm/real tools.
it.skipIf(process.platform==='win32').each([0,42])('propagates native installer exit %s after successful legacy health',async(code)=>{
 const root=await mkdtemp(join(tmpdir(),'native-setup-result-'));
 try {
  const bin=join(root,'bin'),legacy=join(root,'tools/legacy'),calls=join(root,'calls');await mkdir(bin);await mkdir(legacy,{recursive:true});
  await writeFile(join(legacy,'chrome-headless-shell'),'legacy');await copyFile('setup.command',join(root,'setup.command'));
  const node=`#!/bin/sh\nprintf '%s\\n' "$*" >> "$PROBE_CALLS"\nif [ "$1" = "-v" ]; then echo v24.18.1; exit 0; fi\ncase "$*" in\n *native-chromium-setup.ts*) exit ${code};;\n *--print-tools-path*) echo "$PROBE_LEGACY"; exit 0;;\n *chromium-health.ts*) exit 0;;\nesac\nexit 87\n`;
  for(const [name,body] of Object.entries({node,ffmpeg:'#!/bin/sh\nexit 0\n',curl:'#!/bin/sh\necho NETWORK_FORBIDDEN >&2\nexit 88\n',npm:'#!/bin/sh\necho INSTALL_FORBIDDEN >&2\nexit 89\n'}))await writeFile(join(bin,name),body,{mode:0o755});
  const env:NodeJS.ProcessEnv={...process.env,PATH:`${bin}:/usr/bin:/bin`,HE_SETUP_SKIP_NPM:'1',PROBE_CALLS:calls,PROBE_LEGACY:legacy};delete env.HE_SETUP_SKIP_CHROMIUM;
  const p=spawnSync('/bin/bash',[join(root,'setup.command')],{cwd:root,env,input:'',encoding:'utf8',timeout:30000});
  expect(p.error).toBeUndefined();expect(await readFile(calls,'utf8')).toContain('native-chromium-setup.ts');expect(p.stdout+p.stderr).not.toMatch(/NETWORK_FORBIDDEN|INSTALL_FORBIDDEN/);
  expect(p.status).toBe(code===0?0:1);expect(p.stdout.includes('✅ セットアップ完了。')).toBe(code===0);
  if(code!==0)expect(p.stdout).toContain('セットアップ未完了');
 } finally {await rm(root,{recursive:true,force:true});}
});

it('keeps the Windows failure exit in the main completion branch, before helper labels',async()=>{
 const source=await readFile('setup.bat','utf8');
 // Normalize CRLF before selecting labels, so this checks the executed main tail.
 const normalized=source.replace(/\r/g,''),completion=normalized.slice(normalized.indexOf(':chromium_done\n'),normalized.indexOf(':chromium_health\n'));
 expect(completion).toContain('set "NATIVE_CHROMIUM_FAILED=1"');
 expect(completion).toContain('セットアップ未完了');
 expect(completion).toContain('pause\nif defined NATIVE_CHROMIUM_FAILED exit /b 1\nexit /b 0');
 expect(normalized.slice(0,normalized.indexOf(':chromium_done\n'))).not.toContain('if defined NATIVE_CHROMIUM_FAILED exit /b 1');
});
