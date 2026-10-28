/** Orchestrate the native incremental sync in two phases: network preparation
 * happens without blocking the editor; only local application/capture is guarded.
 * A failed publication never advances the saved baseline. */
export interface DriveBinding { group: string; base: string; enabled: boolean }
export interface DrivePrepared { ticket: string; incoming: boolean }
export interface DriveApplied { applied: number; deleted: number; conflicts: number; safetyFolder: string | null; changedPaths: string[] }
export interface DrivePublished { group: string; base: string; uploaded: number; downloaded: number; more: boolean }
export interface DriveRunSummary extends DriveApplied { uploaded: number; downloaded: number; more: boolean }
export type DrivePhase = "checking" | "applying" | "uploading";
export const bindingKey = (vault: string) => `comet:drive-incremental:v1:${encodeURIComponent(vault)}`;
export function validBinding(value: unknown): value is DriveBinding {
  const b = value as Partial<DriveBinding> | null;
  return !!b && typeof b.group === "string" && /^[0-9a-f]{32}$/i.test(b.group) && typeof b.base === "string" && /^[a-z0-9_-]{1,200}$/i.test(b.base) && typeof b.enabled === "boolean";
}
export function readDriveBinding(vault: string): DriveBinding | null {
  try { const value: unknown = JSON.parse(localStorage.getItem(bindingKey(vault)) || "null"); return validBinding(value) ? value : null; }
  catch { return null; }
}
export function saveDriveBinding(vault: string, binding: DriveBinding): void {
  if (!validBinding(binding)) throw new Error("Invalid Drive sync binding.");
  // Do not claim a successful link when persistent state is unavailable.
  localStorage.setItem(bindingKey(vault), JSON.stringify(binding));
  const saved = readDriveBinding(vault);
  if (!saved || saved.group !== binding.group || saved.base !== binding.base || saved.enabled !== binding.enabled) throw new Error("This device could not save its Drive sync state.");
}
export interface DriveAdapter {
  prepare(vault: string, group: string, base: string): Promise<DrivePrepared>;
  apply(ticket: string): Promise<DriveApplied>;
  publish(ticket: string): Promise<DrivePublished>;
  abort(ticket: string): Promise<void>;
  beforeApply(vault: string): Promise<boolean>;
  afterApply(vault: string, result: DriveApplied | null): Promise<void>;
  isCurrent(vault: string): boolean;
  save(vault: string, binding: DriveBinding): void;
  phase(phase: DrivePhase): void;
}
export class DriveSyncRunner {
  private running = false;
  constructor(private readonly adapter: DriveAdapter) {}
  async run(vault: string, binding: DriveBinding | null): Promise<{ binding: DriveBinding; summary: DriveRunSummary } | null> {
    if (this.running) return null;
    this.running = true;
    let current = binding, ticket = "", applying = false;
    const summary: DriveRunSummary = { applied: 0, deleted: 0, conflicts: 0, safetyFolder: null, changedPaths: [], uploaded: 0, downloaded: 0, more: false };
    const safety: string[] = [];
    try {
      for (let count = 0; count < 5; count++) {
        this.adapter.phase("checking");
        const prepared = await this.adapter.prepare(vault, current?.group ?? "", current?.base ?? "");
        if (!prepared || !/^[0-9a-f]{32}$/i.test(prepared.ticket)) throw new Error("Drive returned an invalid sync operation.");
        ticket = prepared.ticket;
        if (!this.adapter.isCurrent(vault)) return null;
        if (!(await this.adapter.beforeApply(vault))) return null;
        applying = true;
        let applied: DriveApplied | null = null;
        try {
          this.adapter.phase("applying");
          applied = await this.adapter.apply(ticket);
        } finally {
          // Refresh even if a partial native merge reported an error.
          try { await this.adapter.afterApply(vault, applied); } finally { applying = false; }
        }
        if (!applied) throw new Error("The local sync was interrupted.");
        summary.applied += applied.applied; summary.deleted += applied.deleted; summary.conflicts += applied.conflicts; summary.changedPaths.push(...applied.changedPaths);
        if (applied.safetyFolder) { safety.push(applied.safetyFolder); summary.safetyFolder = safety.join(", "); }
        if (!this.adapter.isCurrent(vault)) return null;
        this.adapter.phase("uploading");
        const published = await this.adapter.publish(ticket);
        ticket = ""; // publication releases the native job even when successful
        const next: DriveBinding = { group: published.group, base: published.base, enabled: true };
        if (!validBinding(next)) throw new Error("Drive returned invalid sync state; local files were preserved.");
        try { this.adapter.save(vault, next); }
        catch { throw new Error("Drive received a revision, but this device could not save its sync state. Local files were preserved; restore device storage before retrying."); }
        current = next;
        summary.uploaded += published.uploaded; summary.downloaded += published.downloaded; summary.more = published.more;
        if (!published.more || !this.adapter.isCurrent(vault)) break;
      }
      return current ? { binding: current, summary } : null;
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      const preserved = summary.safetyFolder ? ` Originals moved during sync are in ${summary.safetyFolder}.` : "";
      throw new Error(`${detail}${preserved}`);
    } finally {
      if (applying) { try { await this.adapter.afterApply(vault, null); } catch {} }
      if (ticket) { try { await this.adapter.abort(ticket); } catch {} }
      this.running = false;
    }
  }
}
