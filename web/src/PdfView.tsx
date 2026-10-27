import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Minus, Plus } from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline";

function PdfPage({ document: pdf, page, zoom }: { document: PDFDocumentProxy; page: number; zoom: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true; let task: RenderTask | null = null;
    void pdf.getPage(page).then(async (pdfPage) => {
      if (!active || !canvas.current) { pdfPage.cleanup(); return; }
      const viewport = pdfPage.getViewport({ scale: zoom });
      if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || Math.max(viewport.width, viewport.height) > 100_000) { pdfPage.cleanup(); throw new Error("This PDF page is too large to preview safely."); }
      // Reduce raster resolution rather than displayed size when the page is
      // extreme. That keeps zoom and two-page layout geometrically correct.
      const ratio = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(viewport.width, viewport.height), Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      const element = canvas.current;
      element.width = Math.max(1, Math.ceil(viewport.width * ratio)); element.height = Math.max(1, Math.ceil(viewport.height * ratio));
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`;
      task = pdfPage.render({ canvas: element, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      try { await task.promise; } finally { try { pdfPage.cleanup(); } catch { /* cancelled page */ } }
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Couldn't render this page."); }).finally(() => { if (active) setRendering(false); });
    return () => { active = false; task?.cancel(); };
  }, [pdf, page, zoom]);
  return <div className="pdf-sheet" aria-busy={rendering}><canvas ref={canvas} aria-label={`PDF page ${page}`} />{rendering && <span className="pdf-loading">Rendering page {page}…</span>}{error && <span className="pdf-page-error" role="alert">{error}</span>}</div>;
}

/** PDF.js is bundled with its worker and resources; documents stay local. */
export function PdfView({ url, path, sample, onOpenExternal }: { url: string; path: string; sample: boolean; onOpenExternal: () => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [layout, setLayout] = useState<"single" | "spread">("single");
  const [error, setError] = useState("");
  const [panning, setPanning] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const fitRequest = useRef(0);
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    let active = true;
    setPdf(null); setPage(1); setError("");
    const port = new PdfWorker();
    GlobalWorkerOptions.workerPort = port;
    const base = new URL("./pdfjs/", window.location.href).href;
    const task = getDocument({ url, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/`, maxImageSize: 32_000_000 });
    void task.promise.then((result) => { if (active) setPdf(result); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Couldn't read this PDF."); });
    return () => { active = false; void task.destroy().catch(() => undefined).finally(() => port.terminate()); };
  }, [url]);
  const changeZoom = (value: number, cursor?: Point) => {
    const previous = zoomRef.current, next = Math.max(.1, Math.min(4, Math.round(value * 100) / 100));
    if (next === previous) return;
    const el = stage.current; const left = el?.scrollLeft ?? 0, top = el?.scrollTop ?? 0;
    zoomRef.current = next; setZoom(next);
    if (el) requestAnimationFrame(() => { const px = cursor?.x ?? el.clientWidth / 2, py = cursor?.y ?? el.clientHeight / 2; el.scrollLeft = (left + px) * next / previous - px; el.scrollTop = (top + py) * next / previous - py; });
  };
  const manualZoom = (value: number, cursor?: Point) => { fitRequest.current++; changeZoom(value, cursor); };
  const fitPages = async (targetLayout: "single" | "spread") => {
    const element = stage.current; if (!pdf || !element) return;
    const request = ++fitRequest.current;
    try {
      const numbers = [page, ...(targetLayout === "spread" && page < pdf.numPages ? [page + 1] : [])];
      const pageObjects = await Promise.all(numbers.map((number) => pdf.getPage(number)));
      const widths = pageObjects.map((pdfPage) => pdfPage.getViewport({ scale: 1 }).width);
      if (request !== fitRequest.current || widths.some((width) => !Number.isFinite(width) || width <= 0)) return;
      // Account for the stage's padding and the gutter between pages.
      const available = element.clientWidth - 48 - (numbers.length - 1) * 20;
      if (available > 0) changeZoom(Math.floor(100 * available / widths.reduce((sum, width) => sum + width, 0)) / 100);
    } catch { /* The page renderer will show a useful error if needed. */ }
  };
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); const rect = element.getBoundingClientRect();
      manualZoom(zoomRef.current * (event.deltaY < 0 ? 1.12 : 1 / 1.12), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [pdf, error]);
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const el = event.currentTarget; pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    setPanning(true); el.setPointerCapture(event.pointerId); event.preventDefault();
  };
  const last = pdf ? Math.min(pdf.numPages, page + (layout === "spread" ? 1 : 0)) : page;
  const pages = pdf ? Array.from({ length: last - page + 1 }, (_, index) => page + index) : [];
  return <div className="pdf-view">
    <div className="pdf-toolbar" aria-label="PDF controls">
      <FileText size={17} /><strong title={path}>{path.split(/[\\/]/).pop()}</strong><span className="pdf-spacer" />
      <button type="button" aria-label="Previous page" disabled={!pdf || page <= 1} onClick={() => { fitRequest.current++; setPage((value) => Math.max(1, value - (layout === "spread" ? 2 : 1))); }}><ChevronLeft size={17} /></button>
      <span aria-live="polite">{pdf ? `${page}${last > page ? `–${last}` : ""} / ${pdf.numPages}` : "— / —"}</span>
      <button type="button" aria-label="Next page" disabled={!pdf || last >= pdf.numPages} onClick={() => { fitRequest.current++; setPage((value) => Math.min(pdf?.numPages ?? value, value + (layout === "spread" ? 2 : 1))); }}><ChevronRight size={17} /></button>
      <label className="pdf-layout-label"><span className="sr-only">PDF page layout</span><select aria-label="PDF page layout" value={layout} onChange={(event) => { const next = event.target.value as "single" | "spread"; setLayout(next); void fitPages(next); }}><option value="single">Single page</option><option value="spread">Two pages</option></select></label>
      <button type="button" className="pdf-fit" aria-label="Fit pages to width" title="Fit pages to width" disabled={!pdf} onClick={() => void fitPages(layout)}>Fit</button>
      <span className="pdf-separator" /><button type="button" aria-label="Zoom out" disabled={zoom <= .1} onClick={() => manualZoom(zoomRef.current - .2)}><Minus size={16} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => manualZoom(zoomRef.current + .2)}><Plus size={16} /></button>
      {!sample && <button type="button" aria-label="Open PDF in system app" title="Open in system app" onClick={onOpenExternal}><ExternalLink size={16} /></button>}
    </div>
    {error ? <div className="pdf-message" role="alert"><strong>Couldn't preview this PDF.</strong><p>{error}</p>{!sample && <button type="button" className="secondary-button" onClick={onOpenExternal}>Open with system app</button>}</div> : <div ref={stage} className={`pdf-stage${panning ? " panning" : ""}`} aria-busy={!pdf} onPointerDown={beginPan} onPointerMove={(event) => { const drag = pan.current; if (!drag || drag.pointer !== event.pointerId) return; event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x); event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y); }} onPointerUp={() => { pan.current = null; setPanning(false); }} onPointerCancel={() => { pan.current = null; setPanning(false); }}><div className="pdf-pages">{pages.map((number) => <PdfPage key={`${number}:${zoom}`} document={pdf!} page={number} zoom={zoom} />)}{!pdf && <span className="pdf-loading">Opening PDF…</span>}</div></div>}
  </div>;
}
type Point = { x: number; y: number };
