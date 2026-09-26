import { loadNativeTelopComponent, type TelopComponent } from './loadTelopComponent';

interface Entry {
  controller: AbortController;
  users: Set<symbol>;
  pending: boolean;
  component?: TelopComponent;
  promise: Promise<TelopComponent>;
}
/** Explicit identity of one successful project load, without executing its legacy modules. */
export type NativeTelopRevision = Readonly<{ token: symbol }>;

// Weak ownership releases completed modules when their project load is no longer referenced.
const revisions = new WeakMap<NativeTelopRevision, Map<string, Entry>>();

export function cachedNativeTelop(projectId: string, revision: NativeTelopRevision): TelopComponent | undefined {
  return revisions.get(revision)?.get(projectId)?.component;
}

export function acquireNativeTelop(projectId: string, revision: NativeTelopRevision): { promise: Promise<TelopComponent>; release(): void } {
  let projects = revisions.get(revision);
  if (!projects) { projects = new Map(); revisions.set(revision, projects); }
  let entry = projects.get(projectId);
  if (!entry) {
    const controller = new AbortController();
    const cache = projects;
    const created: Entry = { controller, users: new Set(), pending: true, promise: loadNativeTelopComponent(projectId, controller.signal).then(component => {
      created.pending = false; created.component = component; return component;
    }, error => {
      created.pending = false;
      if (cache.get(projectId) === created) cache.delete(projectId);
      throw error;
    }) };
    entry = created;
    projects.set(projectId, created);
  }
  const active = entry, cache = projects, user = Symbol(); active.users.add(user);
  return { promise: active.promise, release() {
    active.users.delete(user);
    // StrictMode's immediate re-subscription shares the same in-flight request.
    queueMicrotask(() => {
      if (active.users.size || !active.pending) return;
      if (cache.get(projectId) === active) cache.delete(projectId);
      active.controller.abort();
    });
  } };
}
