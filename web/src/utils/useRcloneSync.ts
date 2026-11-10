import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DriveSyncRunner, readDriveBinding, type DriveApplied, type DriveBinding, type DrivePhase, type DrivePrepared, type DrivePublished } from "./incrementalSync";
import { accountForBinding, readRcloneBinding, saveRcloneBinding, type CloudAccount, type RcloneBinding } from "./rcloneBinding";
import type { DriveStatus } from "./useIncrementalDrive";

interface Options { desktop: boolean; vault: string; isSample: boolean; beforeApply(vault: string, incoming: boolean): Promise<boolean>; afterApply(vault: string, result: DriveApplied | null): Promise<void> }
export interface RcloneController {
  binding: RcloneBinding | null; accounts: CloudAccount[]; connected: boolean; status: DriveStatus; detail: string; busy: boolean;
  refreshAccounts(): Promise<void>; start(account: CloudAccount, expectedVault?: string): Promise<void>; retry(): Promise<void>; pause(): void; resume(expectedVault?: string): void; changed(): void; finishForQuit(): Promise<boolean>;
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
  const accountRetry = useRef<number | null>(null), refreshRef = useRef<() => Promise<void>>(async () => {});
  const accountRefresh = useRef<Promise<void> | null>(null);
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
    afterPublish: (_vault, published) => invoke("rclone_export_readable", { remote: runnerAccount.current?.remote, group: published.group, id: published.base }),
    abort: (ticket) => invoke("rclone_incremental_abort", { ticket }),
    beforeApply: (vault, incoming) => latest.current.beforeApply(vault, incoming),
    afterApply: (vault, result) => latest.current.afterApply(vault, result),
    isCurrent: (vault) => mounted.current && latest.current.vault === vault && !!runnerAccount.current && readRcloneBinding(vault)?.enabled === true && !readDriveBinding(vault)?.enabled,
    save: (vault, next) => {
      const account = runnerAccount.current, current = readRcloneBinding(vault);
      if (!account || !current?.enabled || current.identity !== account.identity || current.provider !== account.provider) throw new Error("Cloud sync was paused or the account changed.");
      saveRcloneBinding(vault, { ...next, remote: account.remote, provider: account.provider, identity: account.identity });
    },
    phase: (phase: DrivePhase) => { if (mounted.current && latest.current.vault === runnerVault.current) setStatus(phase); },
  });
  const execute = useCallback(async (initial?: CloudAccount): Promise<boolean> => {
    const { vault, desktop, isSample } = latest.current;
    if (busyRef.current || !desktop || isSample) return false;
    // Account checks and sync use the same native cloud lock. Capture the
    // existing refresh before marking this run active; a later refresh waits
    // for this run instead, so neither can deadlock the other.
    const priorRefresh = accountRefresh.current;
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    pendingChanges.current = false; busyRef.current = true; runnerVault.current = vault; setBusy(true); setDetail("");
    try {
      if (recovered.current) await recovered.current;
      if (priorRefresh) await priorRefresh.catch(() => undefined);
      if (!mounted.current || latest.current.vault !== vault) return false;
      const current = readRcloneBinding(vault), account = initial ?? accountForBinding(current, accountsRef.current);
      if (!current?.enabled) return false;
      if (!account) { setStatus("error"); setDetail("Reconnect the cloud account to resume syncing. Your files remain on this device."); return false; }
      if (readDriveBinding(vault)?.enabled) { setStatus("error"); setDetail("Pause the older Google Drive sync before using this cloud connection. Both histories are preserved."); return false; }
      runnerAccount.current = account;
      const result = await runner.current!.run(vault, current as DriveBinding);
      if (!mounted.current || latest.current.vault !== vault) return false;
      if (!result) { setStatus("waiting"); setDetail("Waiting until the workspace is ready to sync."); if (readRcloneBinding(vault)?.enabled) schedule(5000); return false; }
      const saved = readRcloneBinding(vault); setBinding(saved);
      const { applied, deleted, conflicts, uploaded, downloaded, safetyFolder, more, readableWarning, recovered: recoveredHistory } = result.summary;
      if (readableWarning) {
        failures.current += 1; setStatus("error"); setDetail(`${readableWarning}${safetyFolder ? ` Originals are in ${safetyFolder}.` : ""}`);
        // Copy work is the heaviest part of a sync; wait longer before trying
        // again so a provider rate limit has time to clear.
        schedule(Math.min(MAX_RETRY, 60_000 * 2 ** Math.min(failures.current - 1, 4))); return false;
      }
      failures.current = 0; setStatus("synced");
      setDetail(`${recoveredHistory ? "Comet reconnected this device to the cloud history without overwriting local files. " : ""}Last sync: ${uploaded} ${uploaded === 1 ? "file" : "files"} uploaded, ${downloaded} downloaded, ${applied} incoming changes, ${deleted} deletions, ${conflicts} conflict copies.${safetyFolder ? ` Originals are in ${safetyFolder}.` : ""}${more ? " More revisions will be checked shortly." : ""}`);
      schedule(more ? 1000 : INTERVAL); return true;
    } catch (error) {
      if (!mounted.current || latest.current.vault !== vault) return false;
      const text = error instanceof Error ? error.message : String(error);
      setStatus("error"); setDetail(text); failures.current += 1;
      const wait = /rate.?limit|quota/i.test(text) ? 60_000 : 15_000;
      if (readRcloneBinding(vault)?.enabled) schedule(Math.min(MAX_RETRY, wait * 2 ** Math.min(failures.current - 1, 4)));
      return false;
    } finally {
      runnerAccount.current = null; busyRef.current = false;
      if (mounted.current) { setBusy(false); if (latest.current.vault !== vault && readRcloneBinding(latest.current.vault)?.enabled) schedule(250); else if (pendingChanges.current && failures.current === 0 && readRcloneBinding(vault)?.enabled) schedule(1200); }
    }
  }, [schedule]);
  const run = useCallback((initial?: CloudAccount) => {
    if (activeRun.current) return activeRun.current;
    const promise = execute(initial); activeRun.current = promise;
    void promise.finally(() => { if (activeRun.current === promise) activeRun.current = null; });
    return promise;
  }, [execute]);
  runRef.current = run;
  const refreshAccounts = useCallback((): Promise<void> => {
    if (!latest.current.desktop) return Promise.resolve();
    if (accountRefresh.current) return accountRefresh.current;
    const priorRun = activeRun.current;
    const task = (async () => {
      if (priorRun) await priorRun;
      try {
        const result = await invoke<CloudAccount[]>("rclone_accounts");
        if (accountRetry.current !== null) { window.clearTimeout(accountRetry.current); accountRetry.current = null; }
        accountsRef.current = result; if (mounted.current) setAccounts(result);
        const current = readRcloneBinding(latest.current.vault);
        if (current?.enabled) {
          if (accountForBinding(current, result)) schedule(1500);
          else if (mounted.current) { setStatus("error"); setDetail("Reconnect the cloud account to resume syncing. Your files remain on this device."); }
        }
      } catch (error) {
        if (mounted.current && readRcloneBinding(latest.current.vault)?.enabled) {
          setStatus("error"); setDetail(error instanceof Error ? error.message : String(error));
          if (accountRetry.current !== null) window.clearTimeout(accountRetry.current);
          accountRetry.current = window.setTimeout(() => { accountRetry.current = null; void refreshRef.current().catch(() => undefined); }, 15_000);
        }
        throw error;
      }
    })();
    accountRefresh.current = task;
    void task.finally(() => { if (accountRefresh.current === task) accountRefresh.current = null; }).catch(() => undefined);
    return task;
  }, [schedule]);
  refreshRef.current = refreshAccounts;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current !== null) window.clearTimeout(timer.current); if (accountRetry.current !== null) window.clearTimeout(accountRetry.current); };
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
  const start = useCallback(async (account: CloudAccount, expectedVault?: string) => {
    const { vault, desktop, isSample } = latest.current;
    if ((expectedVault && vault !== expectedVault) || !desktop || isSample || busyRef.current || readRcloneBinding(vault)) return;
    if (readDriveBinding(vault)?.enabled) { setStatus("error"); setDetail("Pause the older Google Drive sync before using this cloud connection. Both histories are preserved."); return; }
    try {
      const pending: RcloneBinding = { group: "", base: "", enabled: true, remote: account.remote, provider: account.provider, identity: account.identity };
      saveRcloneBinding(vault, pending); setBinding(pending); setStatus("waiting"); setDetail("");
    } catch { setStatus("error"); setDetail("Couldn't save the sync setting on this device. Check device storage and try again."); return; }
    await run(account);
  }, [run]);
  const retry = useCallback(async () => { await run(); }, [run]);
  const pause = useCallback(() => {
    const vault = latest.current.vault, current = readRcloneBinding(vault); if (!current || busyRef.current) return;
    try { const next = { ...current, enabled: false }; saveRcloneBinding(vault, next); setBinding(next); setStatus("paused"); setDetail("Cloud sync is paused on this device. Local files and cloud history were not deleted."); if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }
    catch { setStatus("error"); setDetail("Couldn't save the pause setting on this device."); }
  }, []);
  const resume = useCallback((expectedVault?: string) => {
    const vault = latest.current.vault, current = readRcloneBinding(vault); if ((expectedVault && vault !== expectedVault) || !current || busyRef.current) return;
    if (readDriveBinding(vault)?.enabled) { setStatus("error"); setDetail("Pause the older Google Drive sync before resuming this cloud connection."); return; }
    try { const next = { ...current, enabled: true }; saveRcloneBinding(vault, next); setBinding(next); failures.current = 0; setStatus("waiting"); setDetail(""); if (accountForBinding(next, accountsRef.current)) schedule(250); else void refreshRef.current().catch(() => undefined); }
    catch { setStatus("error"); setDetail("Couldn't save the sync setting on this device."); }
  }, [schedule]);
  const changed = useCallback(() => { if (readRcloneBinding(latest.current.vault)?.enabled) { pendingChanges.current = true; if (!busyRef.current && failures.current === 0) schedule(1200); } }, [schedule]);
  const finishForQuit = useCallback(async () => {
    const current = readRcloneBinding(latest.current.vault); if (!current?.enabled) return true;
    if (activeRun.current) await activeRun.current;
    return run();
  }, [run]);
  return { binding, accounts, connected: !!accountForBinding(binding, accounts), status, detail, busy, refreshAccounts, start, retry, pause, resume, changed, finishForQuit };
}
