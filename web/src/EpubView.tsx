import { useEffect, useRef, useState } from "react";
import ePub, { type Book, type Rendition, type Location, type NavItem } from "epubjs";
import { BookOpen, ChevronLeft, ChevronRight, ExternalLink, Minus, Plus } from "lucide-react";
import { validateEpubArchive } from "./utils/epubSafety";

const positionKey = (path: string) => `comet:epub-position:v1:${encodeURIComponent(path)}`;
const internalLink = (href: string) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href) && !href.includes("\\") && !href.split("/").includes("..");

/** A local, script-disabled EPUB reader. Remote book resources are blocked. */
export function EpubView({ url, path, sample, onOpenExternal }: { url: string; path: string; sample: boolean; onOpenExternal: () => void }) {
  const host = useRef<HTMLDivElement>(null), rendition = useRef<Rendition | null>(null);
  const [error, setError] = useState(""), [ready, setReady] = useState(false), [toc, setToc] = useState<NavItem[]>([]), [font, setFont] = useState(100);
  const [chapter, setChapter] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let active = true, book: Book | null = null;
    setError(""); setReady(false); setToc([]);
    void (async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("The file could not be read.");
      if (Number(response.headers.get("content-length") || 0) > 100 * 1024 * 1024) throw new Error("EPUB files are limited to 100 MB.");
      const data = await response.arrayBuffer(); validateEpubArchive(data);
      if (!active || !host.current) return;
      book = ePub(data, { replacements: "blobUrl" });
      // Inject CSP before the XHTML is serialized into the sandboxed iframe.
      // Scripts and external requests are never allowed, even for local books.
      book.spine.hooks.content.register((doc: Document) => {
        doc.querySelectorAll("script, iframe, object, embed, form, base").forEach((node) => node.remove());
        doc.querySelectorAll("meta[http-equiv]").forEach((node) => { if (/^(?:refresh|content-security-policy)$/i.test(node.getAttribute("http-equiv") ?? "")) node.remove(); });
        const head = doc.querySelector("head");
        if (head) { const meta = doc.createElementNS("http://www.w3.org/1999/xhtml", "meta"); meta.setAttribute("http-equiv", "Content-Security-Policy"); meta.setAttribute("content", "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob: data:;"); head.prepend(meta); }
      });
      await book.ready;
      if (!active || !host.current) return;
      const nav = (await book.loaded.navigation).toc.filter((item) => typeof item.href === "string" && internalLink(item.href)).slice(0, 1000);
      if (active) setToc(nav);
      const reader = book.renderTo(host.current, { width: "100%", height: "100%", flow: "paginated", spread: "none", allowScriptedContent: false });
      rendition.current = reader;
      reader.themes.default({ body: { color: "#263342", background: "#fff", "line-height": "1.65" } });
      reader.on("relocated", (location: Location) => {
        if (!active) return;
        setChapter(location.start?.href ?? "");
        if (typeof location.start?.cfi === "string" && location.start.cfi.length < 2000) try { localStorage.setItem(positionKey(path), location.start.cfi); } catch { /* Reading position is optional. */ }
      });
      let saved = ""; try { saved = localStorage.getItem(positionKey(path)) ?? ""; } catch {}
      try { await reader.display(saved && /^epubcfi\(/.test(saved) ? saved : undefined); } catch { await reader.display(); }
      if (active) setReady(true);
    })().catch((reason: unknown) => { if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This EPUB could not be opened."); });
    return () => { active = false; controller.abort(); rendition.current = null; book?.destroy(); };
  }, [url, path]);
  const changeFont = (value: number) => { const next = Math.max(70, Math.min(180, value)); setFont(next); rendition.current?.themes.fontSize(`${next}%`); };
  return <div className="epub-view">
    <div className="epub-toolbar"><BookOpen size={17} /><strong>EPUB reader</strong><span className="pdf-spacer" /><select aria-label="Book chapter" value={toc.some((item) => item.href === chapter) ? chapter : ""} disabled={!ready || !toc.length} onChange={(event) => { if (internalLink(event.target.value)) void rendition.current?.display(event.target.value); }}><option value="">Chapters</option>{toc.map((item, index) => <option key={`${item.href}:${index}`} value={item.href}>{item.label.trim()}</option>)}</select><button type="button" aria-label="Smaller book text" disabled={!ready || font <= 70} onClick={() => changeFont(font - 10)}><Minus size={16} /></button><span>{font}%</span><button type="button" aria-label="Larger book text" disabled={!ready || font >= 180} onClick={() => changeFont(font + 10)}><Plus size={16} /></button>{!sample && <button type="button" aria-label="Open ebook in system app" onClick={onOpenExternal}><ExternalLink size={16} /></button>}</div>
    {error ? <div className="pdf-message" role="alert"><strong>Couldn't open this EPUB.</strong><p>{error} DRM-protected books are not supported.</p>{!sample && <button className="secondary-button" type="button" onClick={onOpenExternal}>Open with system app</button>}</div> : <><div className="epub-page" ref={host} aria-busy={!ready} />{!ready && <p className="epub-status">Opening book…</p>}<div className="epub-navigation"><button type="button" className="secondary-button" disabled={!ready} onClick={() => void rendition.current?.prev()}><ChevronLeft size={16} /> Previous</button><span>Scripts and remote book resources are disabled.</span><button type="button" className="secondary-button" disabled={!ready} onClick={() => void rendition.current?.next()}>Next <ChevronRight size={16} /></button></div></>}
  </div>;
}
