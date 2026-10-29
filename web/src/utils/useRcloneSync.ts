import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DriveSyncRunner, readDriveBinding, type DriveApplied, type DriveBinding, type DrivePhase, type DrivePrepared, type DrivePublished } from "./incrementalSync";
import { accountForBinding, readRcloneBinding, saveRcloneBinding, type CloudAccount, type RcloneBinding } from "./rcloneBinding";
import type { DriveStatus } from "./useIncrementalDrive";

interface Options { desktop: boolean; vault: string; isSample: boolean; beforeApply(vault: string, incoming: boolean): Promise<boolean>; afterApply(vault: string, result: DriveApplied | null): Promise<void> }
export interface RcloneController {
  binding: RcloneBinding | null; accounts: CloudAccount[]; connected: boolean; status: DriveStatus; detail: string; busy: boolean;
  refreshAccounts(): Promise<void>; start(account: CloudAccount): Promise<void>; retry(): Promise<void>; pause(): void; resume(): void; changed(): void; finishForQuit(): Promise<boolean>;
}
const INTERVAL = 30_000, MAX_RETRY = 5 * 60_000;
export function useRcloneSync(options: Options): RcloneController {
  const latest = useRef(options); latest.current = options;
  const [binding, setBinding] = useState(() => readRcloneBinding(options.vault));
  const [accounts, setAccounts] = useState<CloudAccount[]>([]), accountsRef = useRef<CloudAccount[]>([]);
  const [status, setStatus] = useState<DriveStatus>(binding?.enabled ? "waiting" : binding ? "paused" : "off");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const mounted = useRef(true), timer = useRef<number | null>(null), failures = useRef(0), runnerVault = useRef("");
  const runnerAccount = useRef<CloudAccount | null>(null), recovered = useRef<Promise<unknown> | null>(null);
  const pendingChanges = useRef(false);
  const activeRun = useRef<Promise<boolean> | null>(null), runRef = useRef<(initial?: CloudAccount) => Promise<boolean>>(async () => false);
  const schedule = useCallback((delay: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void runRef.current(); }, delay);
  }, []);
  const runner = useRef<DriveSyncRunner | null>(null);
  if (!runner.current) runner.current = new DriveSyncRunner({
    prepare: (vault, group, base) => invoke<DrivePrepared>("rclone_incremental_prepare", { vault, remote: runnerAccount.current?.remote, group, base }),
    apply: (ticket) => invoke<DriveApplied>("rclone_incremental_apply", { ticket }),
    publish: (ticket) => invoke<DrivePublished>("rclone_incremental_publish", { ticket }),
    abort: (ticket) => invoke("rclone_incremental_abort", { ticket }),
    beforeApply: (vault, incoming) => latest.current.beforeApply(vault, incoming),
    afterApply: (vault, result) => latest.current.afterApply(vault, result),
    isCurrent: (vault) => mounted.current && latest.current.vault === vault && !!runnerAccount.current && !readDriveBinding(vault)?.enabled,
    save: (vault, next) => {
      const account = runnerAccount.current; if (!account) throw new Error("Cloud account disconnected.");
      saveRcloneBinding(vault, { ...next, remote: account.remote, provider: account.provider, identity: account.identity });
    },
    phase: (phase: DrivePhase) => { if (mounted.current && latest.current.vault === runnerVault.current) setStatus(phase); },
  });
  const execute = useCallback(async (initial?: CloudAccount): Promise<boolean> => {
    const { vault, desktop, isSample } = latest.current;
    const current = readRcloneBinding(vault), account = initial ?? accountForBinding(current, accountsRef.current);
    if (busyRef.current || !desktop || isSample || !account || (!initial && !current?.enabled)) return false;
    if (readDriveBinding(vault)?.enabled) { setStatus("error"); setDetail("Pause the older Google Drive sync before using this cloud connection. Both histories are preserved."); return false; }
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    pendingChanges.current = false; busyRef.current = true; runnerVault.current = vault; runnerAccount.current = account; setBusy(true); setDetail("");
    try {
      if (recovered.current) await recovered.current;
      const result = await runner.current!.run(vault, initial ? null : current as DriveBinding);
      if (!mounted.current || latest.current.vault !== vault) return false;
      if (!result) { setStatus("waiting"); setDetail("Waiting until the workspace is ready to sync."); if (readRcloneBinding(vault)?.enabled) schedule(5000); return false; }
      const saved = readRcloneBinding(vault); setBinding(saved); failures.current = 0; setStatus("synced");
      const { applied, deleted, conflicts, uploaded, downloaded, safetyFolder, more } = result.summary;
      setDetail(`Last sync: ${uploaded} ${uploaded === 1 ? "file" : "files"} uploaded, ${downloaded} downloaded, ${applied} incoming changes, ${deleted} deletions, ${conflicts} conflict copies.${safetyFolder ? ` Originals are in ${safetyFolder}.` : ""}${more ? " More revisions will be checked shortly." : ""}`);
      schedule(more ? 1000 : INTERVAL); return true;
    } catch (error) {
      if (!mounted.current || latest.current.vault !== vault) return false;
      setStatus("error"); setDetail(error instanceof Error ? error.message : String(error)); failures.current += 1;
      if (readRcloneBinding(vault)?.enabled) schedule(Math.min(MAX_RETRY, 15_000 * 2 ** Math.min(failures.current - 1, 5)));
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(false); if (latest.current.vault !== vault && readRcloneBinding(latest.current.vault)?.enabled) schedule(250); else if (pendingChanges.current && readRcloneBinding(vault)?.enabled) schedule(1200); }
    }
  }, [schedule]);
  const run = useCallback((initial?: CloudAccount) => {
    if (activeRun.current) return activeRun.current;
    const promise = execute(initial); activeRun.current = promise;
    void promise.finally(() => { if (activeRun.current === promise) activeRun.current = null; });
    return promise;
  }, [execute]);
  runRef.current = run;
  const refreshAccounts = useCallback(async () => {
    if (!latest.current.desktop) return;
    const result = await invoke<CloudAccount[]>("rclone_accounts");
    accountsRef.current = result; if (mounted.current) setAccounts(result);
    if (accountForBinding(readRcloneBinding(latest.current.vault), result)?.remote && readRcloneBinding(latest.current.vault)?.enabled) schedule(1500);
  }, [schedule]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current !== null) window.clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    const current = readRcloneBinding(options.vault); setBinding(current); setDetail(""); setStatus(current?.enabled ? "waiting" : current ? "paused" : "off"); failures.current = 0;
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    if (current?.enabled && accountForBinding(current, accountsRef.current) && options.desktop && !options.isSample) schedule(1500);
  }, [options.vault, options.desktop, options.isSample, schedule]);
  useEffect(() => {
    if (!options.desktop) return;
    recovered.current = invoke("rclone_incremental_recover").catch(() => undefined);
    void recovered.current.then(() => refreshAccounts()).catch(() => undefined);
  }, [options.desktop, refreshAccounts]);
  useEffect(() => {
    const online = () => { if (readRcloneBinding(latest.current.vault)?.enabled) schedule(250); };
    window.addEventListener("online", online); return () => window.removeEventListener("online", online);
  }, [schedule]);
  const start = useCallback(async (account: CloudAccount) => { if (!readRcloneBinding(latest.current.vault)) await run(account); }, [run]);
  const retry = useCallback(async () => { await run(); }, [run]);
  const pause = useCallback(() => {
    const vault = latest.current.vault, current = readRcloneBinding(vault); if (!current || busyRef.current) return;
    try { const next = { ...current, enabled: false }; saveRcloneBinding(vault, next); setBinding(next); setStatus("paused"); setDetail("Cloud sync is paused on this device. Local files and cloud history were not deleted."); if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }
    catch { setStatus("error"); setDetail("Couldn't save the pause setting on this device."); }
  }, []);
  const resume = useCallback(() => {
    const vault = latest.current.vault, current = readRcloneBinding(vault); if (!current || busyRef.current) return;
    if (readDriveBinding(vault)?.enabled) { setStatus("error"); setDetail("Pause the older Google Drive sync before resuming this cloud connection."); return; }
    try { const next = { ...current, enabled: true }; saveRcloneBinding(vault, next); setBinding(next); setStatus("waiting"); setDetail(""); if (accountForBinding(next, accountsRef.current)) schedule(250); }
    catch { setStatus("error"); setDetail("Couldn't save the sync setting on this device."); }
  }, [schedule]);
  const changed = useCallback(() => { if (readRcloneBinding(latest.current.vault)?.enabled) { pendingChanges.current = true; if (!busyRef.current) schedule(1200); } }, [schedule]);
  const finishForQuit = useCallback(async () => {
    const current = readRcloneBinding(latest.current.vault); if (!current?.enabled) return true;
    if (activeRun.current) await activeRun.current;
    return run();
  }, [run]);
  return { binding, accounts, connected: !!accountForBinding(binding, accounts), status, detail, busy, refreshAccounts, start, retry, pause, resume, changed, finishForQuit };
}
