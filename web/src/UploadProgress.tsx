import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle2, FileUp, LoaderCircle, X } from "lucide-react";

export interface UploadInfo {
  id: string;
  total: number;
  completed: number;
  current: string;
  phase: "preparing" | "reading" | "copying" | "done" | "failed";
  loaded?: number;
  bytes?: number;
  errors?: string[];
}

type DisplayedUpload = { upload: UploadInfo; leaving: boolean };
export const UPLOAD_FEEDBACK_MS = 8_000;
export const UPLOAD_EXIT_MS = 220;

export function UploadProgress({ uploads, onDismiss }: { uploads: UploadInfo[]; onDismiss: (id: string) => void }) {
  const timers = useRef(new Map<string, number>()), dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  const exits = useRef(new Map<string, number>()), previous = useRef(uploads), incoming = useRef(uploads); incoming.current = uploads;
  const [displayed, setDisplayed] = useState<DisplayedUpload[]>(() => uploads.map((upload) => ({ upload, leaving: false })));

  // Keep removed cards around for their exit animation; never delay the actual
  // upload/dismissal or put a disappearing status back in the accessibility tree.
  useLayoutEffect(() => {
    const ids = new Set(uploads.map((upload) => upload.id));
    for (const [id, timer] of exits.current) if (ids.has(id)) { window.clearTimeout(timer); exits.current.delete(id); }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const removed = previous.current.filter((upload) => !ids.has(upload.id));
    previous.current = uploads;
    for (const upload of removed) {
      if (reduced || exits.current.has(upload.id)) continue;
      exits.current.set(upload.id, window.setTimeout(() => {
        exits.current.delete(upload.id);
        if (!incoming.current.some((item) => item.id === upload.id)) setDisplayed((items) => items.filter((item) => item.upload.id !== upload.id));
      }, UPLOAD_EXIT_MS));
    }
    setDisplayed((items) => {
      const byId = new Map(uploads.map((upload) => [upload.id, upload]));
      const next: DisplayedUpload[] = [];
      for (const item of items) {
        const upload = byId.get(item.upload.id);
        if (upload) { next.push({ upload, leaving: false }); byId.delete(upload.id); }
        else if (exits.current.has(item.upload.id)) next.push({ ...item, leaving: true });
      }
      for (const upload of uploads) if (byId.has(upload.id)) { next.push({ upload, leaving: false }); byId.delete(upload.id); }
      return next;
    });
  }, [uploads]);
  useEffect(() => {
    const finished = new Set(uploads.filter((upload) => upload.phase === "done" || upload.phase === "failed").map((upload) => upload.id));
    for (const [id, timer] of timers.current) if (!finished.has(id)) { window.clearTimeout(timer); timers.current.delete(id); }
    for (const id of finished) if (!timers.current.has(id)) timers.current.set(id, window.setTimeout(() => { timers.current.delete(id); dismiss.current(id); }, UPLOAD_FEEDBACK_MS));
  }, [uploads]);
  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    for (const timer of exits.current.values()) window.clearTimeout(timer);
    timers.current.clear(); exits.current.clear();
  }, []);
  if (!displayed.length) return null;
  return <aside className="upload-stack" aria-label="File uploads">{displayed.map(({ upload, leaving }) => {
    const running = upload.phase !== "done" && upload.phase !== "failed";
    const fraction = upload.bytes && upload.bytes > 0 && upload.loaded !== undefined ? Math.max(0, Math.min(1, upload.loaded / upload.bytes)) : undefined;
    return <section className={`upload-card ${upload.phase}${leaving ? " is-leaving" : ""}`} key={upload.id} role={leaving ? undefined : "status"} aria-hidden={leaving || undefined} aria-busy={leaving ? undefined : running} inert={leaving}>
      <div className="upload-card-heading"><span className="upload-card-icon">{running ? <LoaderCircle size={18} className="spin" /> : upload.phase === "done" ? <CheckCircle2 size={18} /> : <FileUp size={18} />}</span><div><strong>{running ? "Adding files" : upload.phase === "done" ? "Files added" : "Upload needs attention"}</strong><small>{upload.completed} of {upload.total} files added</small></div>{!running && <button type="button" className="icon-button" aria-label="Dismiss upload" onClick={() => onDismiss(upload.id)}><X size={16} /></button>}</div>
      {running && <><span className="upload-current" title={upload.current}>{upload.phase === "preparing" ? "Preparing…" : `${upload.phase === "reading" ? "Reading" : "Copying"} ${upload.current}…`}</span><progress className="sr-only" aria-label="Current file progress" max={1} value={fraction} /><div className="upload-progress-track" aria-hidden="true"><span className={fraction === undefined ? "indeterminate" : ""} style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }} /></div></>}
      {!!upload.errors?.length && <ul className="upload-errors">{upload.errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul>}
    </section>;
  })}</aside>;
}
