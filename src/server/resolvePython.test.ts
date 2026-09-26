import { describe, it, expect, vi } from 'vitest';
import { resolvePythonBin, resolvePythonBinAsync } from './resolvePython';
import * as childProcess from 'node:child_process';
vi.mock('node:child_process',async load=>{const actual=await load<typeof childProcess>();return {...actual,execFileSync:vi.fn(actual.execFileSync),spawn:vi.fn(actual.spawn)};});

describe('resolvePythonBin', () => {
  it('finds an installed backend outside the GUI PATH before settling for a bare interpreter',()=>{
    const backend='/home/test/.local/share/uv/tools/mlx-whisper/bin/python';
    expect(resolvePythonBin({env:{PATH:'/usr/bin:/bin'},readConfig:()=>null,installedCandidates:()=>[backend],hasWhisper:bin=>bin===backend,canRunScript:()=>true})).toBe(backend);
  });
  it('SUPERMOVIE_PYTHON が設定されていれば検証せずそれを使う', () => {
    const bin = resolvePythonBin({
      env: { SUPERMOVIE_PYTHON: '/custom/python' },
      hasWhisper: () => false, // 検証は呼ばれない
      readConfig: () => '/config/python', // override が勝つ
    });
    expect(bin).toBe('/custom/python');
  });

  it('SUPERMOVIE_PYTHON が空白だけなら無視して次へ', () => {
    const bin = resolvePythonBin({
      env: { SUPERMOVIE_PYTHON: '   ' },
      hasWhisper: () => false,
      readConfig: () => '/config/python',
    });
    expect(bin).toBe('/config/python');
  });

  it('env が無ければ .supermovie-python 設定ファイルの値を使う（probe せず尊重）', () => {
    let probed = false;
    const bin = resolvePythonBin({
      env: {},
      hasWhisper: () => {
        probed = true;
        return false;
      },
      readConfig: () => '/venv/bin/python3',
    });
    expect(bin).toBe('/venv/bin/python3');
    expect(probed).toBe(false); // 設定ファイルがあれば PATH probe しない
  });

  it('env も設定ファイルも無ければ、whisper を import できる最初の PATH 候補を返す', () => {
    const probed: string[] = [];
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: (b) => {
        probed.push(b);
        return b === 'python3.11';
      },
    });
    expect(bin).toBe('python3.11');
    // python3 → 3.14 → 3.13 → 3.12 → 3.11 の順で探索し、見つけたら止まる
    expect(probed).toEqual(['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11']);
  });

  it('壊れた早い候補は skip し、後ろの動く候補を拾う（実 import 判定）', () => {
    // python3 は import 失敗（壊れ）、python3.10 で成功する想定
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: (b) => b === 'python3.10',
    });
    expect(bin).toBe('python3.10');
  });

  it('win32 では py ランチャーも候補になる（python3/python が無い環境の定番）', () => {
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: (b) => b === 'py',
      platform: 'win32',
    });
    expect(bin).toBe('py');
  });

  it('win32 以外では py は候補にならない', () => {
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: (b) => b === 'py',
      platform: 'darwin',
      canRunScript: b => b === 'python3',
    });
    expect(bin).toBe('python3');
  });

  it('どの候補にも whisper が無ければ実行可能な最初の Python 3.10 以上へフォールバックする', () => {
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: () => false,
      canRunScript: b => b === 'python3.12',
    });
    expect(bin).toBe('python3.12');
  });

  it('later working backends take precedence over earlier version-only fallback candidates',()=>{
    const compatible=vi.fn(()=>true);
    expect(resolvePythonBin({env:{},readConfig:()=>null,hasWhisper:b=>b==='python3.10',canRunScript:compatible})).toBe('python3.10');
    expect(compatible).not.toHaveBeenCalled();
  });
  it('reports a missing compatible interpreter instead of returning an old or absent python3',()=>{
    expect(()=>resolvePythonBin({env:{},readConfig:()=>null,hasWhisper:()=>false,canRunScript:()=>false})).toThrow(/Python 3\.10/);
  });
});

describe('resolvePythonBinAsync',()=>{
  it('finds the same GUI-independent backend asynchronously',async()=>{
    const backend='/home/test/.local/share/uv/tools/mlx-whisper/bin/python';
    expect(await resolvePythonBinAsync(undefined,{env:{PATH:'/usr/bin:/bin'},readConfig:()=>null,installedCandidates:()=>[backend],hasWhisper:async bin=>bin===backend,canRunScript:async()=>true})).toBe(backend);
  });
  const empty={env:{},readConfig:()=>null,installedCandidates:()=>[],hasWhisper:async()=>false};
  it('selects the same successful backend despite more than 2KB of real stdout and stderr',async()=>{
    const actual=await vi.importActual<typeof childProcess>('node:child_process');
    const source="process.stdout.write('o'.repeat(4096));process.stderr.write('w'.repeat(4096));";
    const sync=vi.mocked(childProcess.execFileSync).mockImplementation((...args)=>Reflect.apply(actual.execFileSync,childProcess,[process.execPath,['-e',source],args[2]]));
    const spawn=vi.mocked(childProcess.spawn).mockImplementation((...args)=>Reflect.apply(actual.spawn,childProcess,[process.execPath,['-e',source],args[2]]));
    try {
      expect(resolvePythonBin({env:{},readConfig:()=>null,canRunScript:()=>false})).toBe('python3');
      expect(await resolvePythonBinAsync(undefined,{env:{},readConfig:()=>null,canRunScript:async()=>false})).toBe('python3');
    } finally {sync.mockImplementation(actual.execFileSync);spawn.mockImplementation(actual.spawn);}
  });
  it.each(['nonzero','signal','missing'])('rejects a real %s probe and selects the next compatible interpreter after close',async failure=>{
    const original=(await vi.importActual<typeof childProcess>('node:child_process')).spawn;
    let first:childProcess.ChildProcess|undefined;
    const spy=vi.mocked(childProcess.spawn).mockClear().mockImplementation((...args)=>{
      if(first){if(first.pid)expect(()=>process.kill(first!.pid!,0)).toThrow();return Reflect.apply(original,childProcess,[process.execPath,['-e',''],args[2]]);}
      first=Reflect.apply(original,childProcess,[failure==='missing'?process.execPath+'.missing-probe':process.execPath,
        ['-e',failure==='signal'?"process.kill(process.pid,'SIGTERM')":"process.exit(9)"],args[2]]);
      return first as ReturnType<typeof childProcess.spawn>;
    });
    try {expect(await resolvePythonBinAsync(undefined,{...empty})).toBe('python3.14');expect(spy).toHaveBeenCalledTimes(2);}
    finally {first?.kill('SIGKILL');spy.mockImplementation(original);}
  });
  it('kills a real hung version probe at its 5s deadline before trying the next candidate',async()=>{
    const original=(await vi.importActual<typeof childProcess>('node:child_process')).spawn;
    let first:childProcess.ChildProcess|undefined,forced=false;
    const watchdog=setTimeout(()=>{forced=true;first?.kill('SIGKILL');},7000);
    const spy=vi.mocked(childProcess.spawn).mockClear().mockImplementation((...args)=>{
      if(first){expect(first.signalCode).toBe('SIGKILL');expect(()=>process.kill(first!.pid!,0)).toThrow();return Reflect.apply(original,childProcess,[process.execPath,['-e',''],args[2]]);}
      first=Reflect.apply(original,childProcess,[process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],args[2]]);
      return first as ReturnType<typeof childProcess.spawn>;
    });
    try {expect(await resolvePythonBinAsync(undefined,{...empty})).toBe('python3.14');expect(spy).toHaveBeenCalledTimes(2);expect(forced).toBe(false);}
    finally {clearTimeout(watchdog);first?.kill('SIGKILL');spy.mockImplementation(original);}
  },8500);
  it('preserves explicit environment and local config priority without validating them',async()=>{
    const probe=vi.fn(async()=>false),config=vi.fn(()=>'/config/python');
    expect(await resolvePythonBinAsync(undefined,{env:{SUPERMOVIE_PYTHON:' /explicit/python '},readConfig:config,hasWhisper:probe,canRunScript:probe})).toBe('/explicit/python');
    expect(config).not.toHaveBeenCalled();expect(probe).not.toHaveBeenCalled();
    expect(await resolvePythonBinAsync(undefined,{env:{SUPERMOVIE_PYTHON:' '},readConfig:config,hasWhisper:probe,canRunScript:probe})).toBe('/config/python');expect(probe).not.toHaveBeenCalled();
  });
  it('only checks compatible fallback interpreters after all backend probes fail',async()=>{
    const calls:string[]=[];
    const selected=await resolvePythonBinAsync(undefined,{...empty,hasWhisper:async b=>{calls.push('backend:'+b);return false;},canRunScript:async b=>{calls.push('version:'+b);return b==='python3.12';}});
    expect(selected).toBe('python3.12');expect(calls.slice(0,7).every(c=>c.startsWith('backend:'))).toBe(true);expect(calls.slice(7)).toEqual(['version:python3','version:python3.14','version:python3.13','version:python3.12']);
  });
  it('keeps a working later backend ahead of every version-only candidate',async()=>{
    const compatible=vi.fn(async()=>true);
    expect(await resolvePythonBinAsync(undefined,{...empty,hasWhisper:async b=>b==='python3.11',canRunScript:compatible})).toBe('python3.11');expect(compatible).not.toHaveBeenCalled();
  });
  it('rejects missing compatible interpreters, pre-abort and abort during successful probing',async()=>{
    await expect(resolvePythonBinAsync(undefined,{...empty,canRunScript:async()=>false})).rejects.toThrow(/Python 3\.10/);
    const pre=new AbortController();pre.abort(new Error('cancelled before selection'));const probe=vi.fn(async()=>true);
    await expect(resolvePythonBinAsync(pre.signal,{env:{SUPERMOVIE_PYTHON:'/explicit'},hasWhisper:probe})).rejects.toThrow('cancelled before selection');expect(probe).not.toHaveBeenCalled();
    for(const phase of ['backend','version']){
      const active=new AbortController();const abort=async()=>{active.abort(new Error('cancelled while probing'));return true;};
      await expect(resolvePythonBinAsync(active.signal,{...empty,hasWhisper:phase==='backend'?abort:async()=>false,canRunScript:abort})).rejects.toThrow('cancelled while probing');
    }
  });
  it.each(['backend','version'])('waits for a real uncooperative %s probe process to terminate on cancellation',async phase=>{
    const original=(await vi.importActual<typeof childProcess>('node:child_process')).spawn,controller=new AbortController();
    let child:childProcess.ChildProcess|undefined,announce!:()=>void,forced=false,watchdog:ReturnType<typeof setTimeout>|undefined;
    const ready=new Promise<void>(resolve=>{announce=resolve;});
    // The real probe has no output pipes. A test-only IPC channel announces that
    // the portable Node child installed its SIGTERM handler before we abort.
    const spy=vi.mocked(childProcess.spawn).mockClear().mockImplementation((...args)=>{
      expect(args[2]).toEqual({stdio:'ignore'});
      child=Reflect.apply(original,childProcess,[process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);"],{...args[2],stdio:['ignore','ignore','ignore','ipc']}]);
      watchdog=setTimeout(()=>{forced=true;child?.kill('SIGKILL');},1000);
      child!.once('message',()=>announce());return child as ReturnType<typeof childProcess.spawn>;
    });
    try {
      const pending=resolvePythonBinAsync(controller.signal,{env:{},readConfig:()=>null,...(phase==='version'?{hasWhisper:async()=>false}:{})});
      const stopped=expect(pending).rejects.toThrow('cancel probe');
      await ready;controller.abort(new Error('cancel probe'));await stopped;
      expect(forced,'the probe must end itself, before the test cleanup watchdog').toBe(false);
      expect(child?.signalCode).toBe('SIGKILL');expect(child?.stdout).toBe(null);expect(child?.connected).toBe(false);
      expect(()=>process.kill(child!.pid!,0)).toThrow();expect(spy).toHaveBeenCalledTimes(1);
    } finally {if(watchdog)clearTimeout(watchdog);child?.kill('SIGKILL');spy.mockImplementation(original);}
  },5000);
});
