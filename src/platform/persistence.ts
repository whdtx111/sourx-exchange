import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DomainStore } from "../domain/store.js";

/** Atomic local storage for a single control-plane instance; files contain credentials and stay private. */
export class LocalPersistence {
  private readonly sections: Record<string, unknown>;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.sections = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
  }
  read<T>(name: string): T | undefined { return this.sections[name] as T | undefined; }
  save(sections: Record<string, unknown>) {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(sections), {mode: 0o600});
    renameSync(temporary, this.path);
  }
}

export function restoreDomain(store: DomainStore, raw: Record<string, unknown> | undefined) {
  if (!raw) return;
  for (const key of ["users", "nodes", "listings", "orders", "payments", "leases", "reservations"] as const) {
    for (const [id, value] of (raw[key] as [string, never][] | undefined) ?? []) store[key].set(id, value);
  }
  store.auditEvents.push(...((raw.auditEvents as DomainStore["auditEvents"]) ?? []));
}
export function snapshotDomain(store: DomainStore) {
  return Object.fromEntries(Object.entries(store).map(([key, value]) => [key, value instanceof Map ? [...value.entries()] : value]));
}
