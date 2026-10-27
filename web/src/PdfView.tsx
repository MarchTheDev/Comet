import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Minus, Plus } from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline";

/** PDF.js is bundled with its worker and resources; documents stay local. */
export function PdfView({ url, path, sample, onOpenExternal }: { url: string; path: string; sample: boolean; onOpenExternal: () => void }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1.15);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    setDocument(null); setPage(1); setError("");
    // A dedicated worker prevents a rapid file switch from destroying the
    // worker of a newly opened document. Vite embeds the worker in the bundle.
    const port = new PdfWorker();
    GlobalWorkerOptions.workerPort = port;
    const base = new URL("./pdfjs/", window.location.href).href;
    const task = getDocument({ url, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/`, maxImageSize: 32_000_000 });
    void task.promise.then((result) => { if (active) setDocument(result); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Couldn't read this PDF."); });
    return () => { active = false; void task.destroy().catch(() => undefined).finally(() => port.terminate()); };
  }, [url]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true; let renderTask: RenderTask | null = null;
    setRendering(true);
    void document.getPage(page).then((pdfPage) => {
      if (!active || !canvas.current) return;
      const initial = pdfPage.getViewport({ scale: zoom });
      // Bound memory even for malformed PDFs with extreme page dimensions.
      const scale = Math.min(1, 4096 / Math.max(initial.width, initial.height), Math.sqrt(16_000_000 / (initial.width * initial.height)));
      const viewport = pdfPage.getViewport({ scale: zoom * scale });
      canvas.current.width = Math.ceil(viewport.width); canvas.current.height = Math.ceil(viewport.height);
      renderTask = pdfPage.render({ canvas: canvas.current, viewport });
      return renderTask.promise;
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Couldn't render this page."); }).finally(() => { if (active) setRendering(false); });
    return () => { active = false; renderTask?.cancel(); };
  }, [document, page, zoom]);
  return <div className="pdf-view">
    <div className="pdf-toolbar" aria-label="PDF controls">
      <FileText size={17} /><strong title={path}>{path.split(/[\\/]/).pop()}</strong><span className="pdf-spacer" />
      <button type="button" aria-label="Previous page" disabled={!document || page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17} /></button>
      <span aria-live="polite">{document ? `${page} / ${document.numPages}` : "— / —"}</span>
      <button type="button" aria-label="Next page" disabled={!document || page >= document.numPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button>
      <span className="pdf-separator" /><button type="button" aria-label="Zoom out" disabled={zoom <= .6} onClick={() => setZoom((value) => Math.max(.6, Math.round((value - .2) * 100) / 100))}><Minus size={16} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom in" disabled={zoom >= 2.4} onClick={() => setZoom((value) => Math.min(2.4, Math.round((value + .2) * 100) / 100))}><Plus size={16} /></button>
      {!sample && <button type="button" aria-label="Open PDF in system app" title="Open in system app" onClick={onOpenExternal}><ExternalLink size={16} /></button>}
    </div>
    {error ? <div className="pdf-message" role="alert"><strong>Couldn't preview this PDF.</strong><p>{error}</p>{!sample && <button type="button" className="secondary-button" onClick={onOpenExternal}>Open with system app</button>}</div> : <div className="pdf-stage" aria-busy={!document || rendering}><canvas ref={canvas} aria-label={`PDF page ${page}`} />{(!document || rendering) && <span className="pdf-loading">{document ? "Rendering page…" : "Opening PDF…"}</span>}</div>}
  </div>;
}
