import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { validateScriptEditArtifact } from '../core/scriptEditArtifact';
import { PreferenceWorkspaceStore } from './preferenceWorkspaceStore';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'script-journal-integrity-'));
  directories.push(directory);
  const store = new PreferenceWorkspaceStore(directory);
  const event = scriptJudgmentFixture();
  const command = { kind: 'decision' as const, operationId: event.operationId, at: event.createdAt, actor: event.actor, event };
  return { store, command };
}

describe('persisted script judgment input integrity', () => {
  it.each(['packet', 'editing'] as const)('%s hash corruption is rejected by every Node store entry point', corruption => {
    const { store, command } = setup();
    store.execute(command);
    const original = readFileSync(store.file, 'utf8');
    const tampered = structuredClone(command);
    if (corruption === 'packet') tampered.event.artifact.input.alignment.packet.source.id = 'changed-source.mp4';
    else tampered.event.artifact.input.editing.telops[0]!.originalEnd += 1;
    // Valid shape and references are insufficient: these bytes no longer match the recorded input hashes.
    expect(() => validateScriptEditArtifact(tampered.event.artifact)).not.toThrow();
    tampered.operationId = tampered.event.operationId = 'tampered-command';
    tampered.event.id = 'tampered-judgment';
    expect(() => store.execute(tampered)).toThrow(/HASH_MISMATCH/);
    expect(readFileSync(store.file, 'utf8')).toBe(original);
    expect(() => store.import({ schemaVersion: 1, commands: [tampered] })).toThrow(/HASH_MISMATCH/);
    expect(readFileSync(store.file, 'utf8')).toBe(original);
    const bytes = JSON.stringify({ schemaVersion: 1, commands: [tampered] });
    writeFileSync(store.file, bytes);
    expect(() => store.read()).toThrow(/HASH_MISMATCH/);
    expect(() => store.export()).toThrow(/HASH_MISMATCH/);
    expect(readFileSync(store.file, 'utf8')).toBe(bytes);
  });
  it('valid script records survive export and import exactly, without changing consent or provenance', () => {
    const source = setup(); const target = setup();
    source.store.execute(source.command);
    const exported = source.store.export();
    target.store.import(JSON.parse(exported));
    expect(target.store.export()).toBe(exported);
    expect(target.store.read().decisions.events).toEqual(source.store.read().decisions.events);
    expect(target.store.read().decisions.events[0]).toMatchObject({ learningConsent: false, provenance: { kind: 'synthetic' } });
  });
});
