import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readRcloneBinding } from "./rcloneBinding";
import { DriveSyncRunner, readDriveActivity, readDriveBinding, recordDriveActivity, saveDriveBinding, type DriveActivity, type DriveApplied, type DriveBinding, type DrivePhase, type DrivePrepared, type DrivePublished } from "./incrementalSync";

export type DriveStatus = "off" | "paused" | "waiting" | "checking" | "applying" | "uploading" | "error" | "synced";
export interface IncrementalDriveController {
  binding: DriveBinding | null;
  status: DriveStatus;
  detail: string;
  busy: boolean;
  connected: boolean;
  activity: DriveActivity[];
  start(): Promise<void>;
  retry(): Promise<void>;
  pause(): void;
  resume(): void;
  connectionChanged(connected: boolean): void;
  changed(): void;
  finishForQuit(): Promise<boolean>;
}
interface Options { desktop: boolean; vault: string; isSample: boolean; beforeApply(vault: string, incoming: boolean): Promise<boolean>; afterApply(vault: string, result: DriveApplied | null): Promise<void> }
const INTERVAL = 30_000;
const MAX_RETRY = 5 * 60_000;
export function useIncrementalDrive(options: Options): IncrementalDriveController {
  const latest = useRef(options); latest.current = options;
  const [binding, setBinding] = useState(() => readDriveBinding(options.vault));
  const [status, setStatus] = useState<DriveStatus>(binding?.enabled ? "waiting" : binding ? "paused" : "off");
  const [detail, setDetail] = useState("");
  const [activity, setActivity] = useState(() => readDriveActivity(options.vault));
  const [connected, setConnected] = useState(false), connectionRef = useRef(false);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const timer = useRef<number | null>(null), failures = useRef(0), mounted = useRef(true), runnerVault = useRef("");
  const recovered = useRef<Promise<unknown> | null>(null), pendingChanges = useRef(false);
  const activeRun = useRef<Promise<boolean> | null>(null);
  const runRef = useRef<(initial?: boolean) => Promise<boolean>>(async () => false);
  const schedule = useCallback((delay: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void runRef.current(); }, delay);
  }, []);
  const runner = useRef<DriveSyncRunner | null>(null);
  if (!runner.current) runner.current = new DriveSyncRunner({
    prepare: (vault, group, base) => invoke<DrivePrepared>("google_incremental_prepare", { vault, group, base }),
    apply: (ticket) => invoke<DriveApplied>("google_incremental_apply", { ticket }),
    publish: (ticket) => invoke<DrivePublished>("google_incremental_publish", { ticket }),
    abort: (ticket) => invoke("google_incremental_abort", { ticket }),
    beforeApply: (vault, incoming) => latest.current.beforeApply(vault, incoming),
    afterApply: (vault, result) => latest.current.afterApply(vault, result),
    isCurrent: (vault) => mounted.current && latest.current.vault === vault && connectionRef.current && !readRcloneBinding(vault)?.enabled,
    save: (vault, next) => saveDriveBinding(vault, next),
    phase: (phase: DrivePhase) => { if (mounted.current && latest.current.vault === runnerVault.current) setStatus(phase); },
  });
  const execute = useCallback(async (initial = false): Promise<boolean> => {
    const { vault, desktop, isSample } = latest.current;
    const current = readDriveBinding(vault);
    if (busyRef.current || !desktop || isSample || !connectionRef.current || (!initial && !current?.enabled)) return false;
    if (readRcloneBinding(vault)?.enabled) { setStatus("error"); setDetail("Pause rclone cloud sync before using the older Google Drive sync. Both histories are preserved."); return false; }
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    pendingChanges.current = false; busyRef.current = true; runnerVault.current = vault; setBusy(true); setDetail("");
    try {
      if (recovered.current) await recovered.current;
      const result = await runner.current!.run(vault, initial ? null : current);
      if (!mounted.current || latest.current.vault !== vault) return false;
      if (result) {
        failures.current = 0; setBinding(result.binding); setStatus("synced");
        const { applied, deleted, conflicts, uploaded, downloaded, safetyFolder, more } = result.summary;
        const description = `Last sync: ${uploaded} ${uploaded === 1 ? "file" : "files"} uploaded, ${downloaded} downloaded, ${applied} incoming changes, ${deleted} deletions, ${conflicts} conflict copies.${safetyFolder ? ` Originals are in ${safetyFolder}.` : ""}${more ? " More revisions will be checked shortly." : ""}`;
        setDetail(description);
        if (!current || result.binding.base !== current.base || uploaded || downloaded || applied || deleted || conflicts || safetyFolder) {
          setActivity(recordDriveActivity(vault, { time: Date.now(), kind: conflicts ? "conflict" : "sync", text: description }));
        }
        schedule(more ? 1000 : INTERVAL);
        return true;
      } else {
        setStatus("waiting"); setDetail("Waiting until the workspace is ready to sync.");
        if (readDriveBinding(vault)?.enabled) schedule(5000);
        return false;
      }
    } catch (error) {
      if (!mounted.current || latest.current.vault !== vault) return false;
      const description = error instanceof Error ? error.message : String(error);
      setStatus("error"); setDetail(description);
      if (failures.current === 0) setActivity(recordDriveActivity(vault, { time: Date.now(), kind: "error", text: description }));
      failures.current += 1;
      if (readDriveBinding(vault)?.enabled && connectionRef.current) schedule(Math.min(MAX_RETRY, 15_000 * 2 ** Math.min(failures.current - 1, 5)));
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        if (latest.current.vault !== vault && connectionRef.current && readDriveBinding(latest.current.vault)?.enabled) schedule(250);
        else if (pendingChanges.current && readDriveBinding(vault)?.enabled) schedule(1200);
      }
    }
  }, [schedule]);
  const run = useCallback((initial = false) => {
    if (activeRun.current) return activeRun.current;
    const promise = execute(initial); activeRun.current = promise;
    void promise.finally(() => { if (activeRun.current === promise) activeRun.current = null; });
    return promise;
  }, [execute]);
  runRef.current = run;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current !== null) window.clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    const current = readDriveBinding(options.vault); setBinding(current); setActivity(readDriveActivity(options.vault)); setDetail("");
    setStatus(current?.enabled ? "waiting" : current ? "paused" : "off");
    failures.current = 0;
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    if (current?.enabled && connectionRef.current && options.desktop && !options.isSample) schedule(1500);
  }, [options.vault, options.desktop, options.isSample, schedule]);
  const connectionChanged = useCallback((value: boolean) => {
    connectionRef.current = value; setConnected(value);
    if (!value) { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }
    else if (readDriveBinding(latest.current.vault)?.enabled) schedule(1500);
  }, [schedule]);
  useEffect(() => {
    if (!options.desktop) return;
    // A webview reload can abandon a prepared (but not applying) native job.
    recovered.current = invoke("google_incremental_recover").catch(() => undefined);
    let live = true;
    void Promise.all([invoke<boolean>("google_status", { service: "all" }), invoke<boolean>("google_status", { service: "drive" })]).then(([all, drive]) => { if (live) connectionChanged(all || drive); }).catch(() => { if (live) connectionChanged(false); });
    return () => { live = false; };
  }, [options.desktop, connectionChanged]);
  useEffect(() => {
    const online = () => { if (connectionRef.current && readDriveBinding(latest.current.vault)?.enabled) schedule(250); };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [schedule]);
  const start = useCallback(async () => { if (!readDriveBinding(latest.current.vault)) await run(true); }, [run]);
  const retry = useCallback(async () => { await run(); }, [run]);
  const pause = useCallback(() => {
    const vault = latest.current.vault, current = readDriveBinding(vault);
    if (!current || busyRef.current) return;
    try { const next = { ...current, enabled: false }; saveDriveBinding(vault, next); setBinding(next); setStatus("paused"); setDetail("Automatic sync is paused on this device. Files and Drive history were not deleted."); if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }
    catch { setStatus("error"); setDetail("Couldn't save the pause setting on this device."); }
  }, []);
  const resume = useCallback(() => {
    const vault = latest.current.vault, current = readDriveBinding(vault);
    if (!current || busyRef.current) return;
    if (readRcloneBinding(vault)?.enabled) { setStatus("error"); setDetail("Pause rclone cloud sync before resuming the older Google Drive sync."); return; }
    try { const next = { ...current, enabled: true }; saveDriveBinding(vault, next); setBinding(next); setStatus("waiting"); setDetail(""); if (connectionRef.current) schedule(250); }
    catch { setStatus("error"); setDetail("Couldn't save the sync setting on this device."); }
  }, [schedule]);
  const changed = useCallback(() => { if (readDriveBinding(latest.current.vault)?.enabled) { pendingChanges.current = true; if (!busyRef.current) schedule(1200); } }, [schedule]);
  const finishForQuit = useCallback(async () => { if (!readDriveBinding(latest.current.vault)?.enabled) return true; if (activeRun.current) await activeRun.current; return run(); }, [run]);
  return { binding, status, detail, busy, connected, activity, start, retry, pause, resume, connectionChanged, changed, finishForQuit };
}
