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

export function UploadProgress({ uploads, onDismiss }: { uploads: UploadInfo[]; onDismiss: (id: string) => void }) {
  if (!uploads.length) return null;
  return <aside className="upload-stack" aria-label="File uploads">{uploads.map((upload) => {
    const running = upload.phase !== "done" && upload.phase !== "failed";
    const fraction = upload.bytes && upload.bytes > 0 && upload.loaded !== undefined ? Math.max(0, Math.min(1, upload.loaded / upload.bytes)) : undefined;
    return <section className={`upload-card ${upload.phase}`} key={upload.id} role="status" aria-busy={running}>
      <div className="upload-card-heading"><span className="upload-card-icon">{running ? <LoaderCircle size={18} className="spin" /> : upload.phase === "done" ? <CheckCircle2 size={18} /> : <FileUp size={18} />}</span><div><strong>{running ? "Adding files" : upload.phase === "done" ? "Files added" : "Upload needs attention"}</strong><small>{upload.completed} of {upload.total} files added</small></div>{!running && <button type="button" className="icon-button" aria-label="Dismiss upload" onClick={() => onDismiss(upload.id)}><X size={16} /></button>}</div>
      {running && <><span className="upload-current" title={upload.current}>{upload.phase === "preparing" ? "Preparing…" : `${upload.phase === "reading" ? "Reading" : "Copying"} ${upload.current}…`}</span><progress className="sr-only" aria-label="Current file progress" max={1} value={fraction} /><div className="upload-progress-track" aria-hidden="true"><span className={fraction === undefined ? "indeterminate" : ""} style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }} /></div></>}
      {!!upload.errors?.length && <ul className="upload-errors">{upload.errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul>}
    </section>;
  })}</aside>;
}
