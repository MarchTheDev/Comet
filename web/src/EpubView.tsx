import { useEffect, useRef, useState } from "react";
import ePub, { type Book, type Rendition, type Location, type NavItem } from "epubjs";
import { BookOpen, Bookmark, ChevronLeft, ChevronRight, ExternalLink, Minus, Plus, Settings2, Trash2 } from "lucide-react";
import { boundedEpubResponse, validateEpubArchive } from "./utils/epubSafety";

const positionKey = (path: string) => `comet:epub-position:v1:${encodeURIComponent(path)}`;
const bookmarkKey = (path: string) => `comet:epub-bookmarks:v1:${encodeURIComponent(path)}`;
const PREFS_KEY = "comet:epub-preferences:v1";
const internalLink = (href: string) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href) && !href.includes("\\") && !href.split("/").includes("..");
interface ReaderPreferences { font: number; family: "book" | "serif" | "sans"; lineHeight: number; paper: "light" | "sepia" | "dark" }
interface BookmarkEntry { cfi: string; label: string }
const defaultPrefs: ReaderPreferences = { font: 100, family: "book", lineHeight: 1.65, paper: "light" };
function preferences(): ReaderPreferences {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { font: typeof v.font === "number" && v.font >= 70 && v.font <= 180 ? v.font : 100, family: ["book", "serif", "sans"].includes(v.family) ? v.family : "book", lineHeight: typeof v.lineHeight === "number" && v.lineHeight >= 1.2 && v.lineHeight <= 2.2 ? v.lineHeight : 1.65, paper: ["light", "sepia", "dark"].includes(v.paper) ? v.paper : "light" };
  } catch { return defaultPrefs; }
}
function readBookmarks(path: string): BookmarkEntry[] {
  try { const v: unknown = JSON.parse(localStorage.getItem(bookmarkKey(path)) || "[]"); return Array.isArray(v) ? v.filter((b): b is BookmarkEntry => b && typeof b.cfi === "string" && /^epubcfi\(/.test(b.cfi) && b.cfi.length < 2000 && typeof b.label === "string" && b.label.length <= 200).slice(0, 100) : []; } catch { return []; }
}
function chapters(items: NavItem[], depth = 0): { href: string; label: string }[] {
  return items.flatMap((item) => [...(typeof item.href === "string" && internalLink(item.href) ? [{ href: item.href, label: `${"  ".repeat(Math.min(depth, 4))}${item.label.trim()}` }] : []), ...chapters(item.subitems ?? [], depth + 1)]).slice(0, 1000);
}
function isEditing(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return !!node && (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.isContentEditable);
}

/** A local, script-disabled EPUB reader. Remote book resources are blocked. */
export function EpubView({ url, path, sample, onOpenExternal }: { url: string; path: string; sample: boolean; onOpenExternal: () => void }) {
  const host = useRef<HTMLDivElement>(null), rendition = useRef<Rendition | null>(null), currentCfi = useRef(""), turning = useRef(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [ready, setReady] = useState(false), [toc, setToc] = useState<{ href: string; label: string }[]>([]);
  const [prefs, setPrefs] = useState(preferences), [options, setOptions] = useState(false), [bookmarks, setBookmarks] = useState(() => readBookmarks(path)), [selectedBookmark, setSelectedBookmark] = useState("");
  const [chapter, setChapter] = useState(""), [page, setPage] = useState<{ current: number; total: number; atStart: boolean; atEnd: boolean } | null>(null);
  const turn = (direction: "next" | "prev") => {
    const reader = rendition.current; if (!reader || turning.current) return;
    setNotice(""); turning.current = true; void reader[direction]().catch(() => setNotice("Couldn't turn this page. Try again." )).finally(() => { turning.current = false; });
  };
  const turnRef = useRef(turn); turnRef.current = turn;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditing(event.target)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault(); event.stopPropagation(); turnRef.current(event.key === "ArrowRight" ? "next" : "prev");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let active = true, book: Book | null = null;
    setError(""); setNotice(""); setReady(false); setToc([]); setPage(null); setBookmarks(readBookmarks(path)); setSelectedBookmark(""); currentCfi.current = "";
    void (async () => {
      const response = await fetch(url, { signal: controller.signal });
      const data = await boundedEpubResponse(response); validateEpubArchive(data);
      if (!active || !host.current) return;
      book = ePub(data, { replacements: "blobUrl" });
      // Never let book content execute scripts, submit forms, or load remote resources.
      book.spine.hooks.content.register((doc: Document) => {
        doc.querySelectorAll("script, iframe, object, embed, form, base").forEach((node) => node.remove());
        doc.querySelectorAll("meta[http-equiv]").forEach((node) => { if (/^(?:refresh|content-security-policy)$/i.test(node.getAttribute("http-equiv") ?? "")) node.remove(); });
        const head = doc.querySelector("head");
        if (head) { const meta = doc.createElementNS("http://www.w3.org/1999/xhtml", "meta"); meta.setAttribute("http-equiv", "Content-Security-Policy"); meta.setAttribute("content", "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob: data:;"); head.prepend(meta); }
      });
      await book.ready;
      if (!active || !host.current) return;
      setToc(chapters((await book.loaded.navigation).toc));
      const reader = book.renderTo(host.current, { width: "100%", height: "100%", flow: "paginated", spread: "none", allowScriptedContent: false });
      rendition.current = reader;
      reader.themes.default({ body: { color: "#263342", background: "#fff", "line-height": "1.65" } });
      reader.on("keydown", (event: KeyboardEvent) => {
        if (!active || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditing(event.target)) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); turnRef.current(event.key === "ArrowRight" ? "next" : "prev"); }
      });
      reader.on("relocated", (location: Location) => {
        if (!active) return;
        setChapter(location.start?.href ?? "");
        const displayed = location.start?.displayed;
        if (displayed && Number.isFinite(displayed.page) && Number.isFinite(displayed.total)) setPage({ current: displayed.page, total: displayed.total, atStart: !!location.atStart, atEnd: !!location.atEnd });
        if (typeof location.start?.cfi === "string" && location.start.cfi.length < 2000) { currentCfi.current = location.start.cfi; try { localStorage.setItem(positionKey(path), location.start.cfi); } catch { /* Position is optional. */ } }
      });
      let saved = ""; try { saved = localStorage.getItem(positionKey(path)) ?? ""; } catch {}
      try { await reader.display(saved && /^epubcfi\(/.test(saved) ? saved : undefined); } catch { await reader.display(); }
      if (active) setReady(true);
    })().catch((reason: unknown) => { if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This EPUB could not be opened."); });
    return () => { active = false; controller.abort(); rendition.current = null; turning.current = false; book?.destroy(); };
  }, [url, path]);
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
    const reader = rendition.current; if (!reader || !ready) return;
    const colors = prefs.paper === "dark" ? { color: "#e6e2dc", background: "#20242a" } : prefs.paper === "sepia" ? { color: "#51402d", background: "#f5ecd9" } : { color: "#263342", background: "#fff" };
    reader.themes.fontSize(`${prefs.font}%`); reader.themes.override("line-height", String(prefs.lineHeight), true);
    reader.themes.override("color", colors.color, true); reader.themes.override("background", colors.background, true);
    reader.themes.override("font-family", prefs.family === "serif" ? "Georgia, serif" : prefs.family === "sans" ? "Arial, sans-serif" : "inherit", prefs.family !== "book");
  }, [prefs, ready]);
  const updatePrefs = (patch: Partial<ReaderPreferences>) => setPrefs((old) => ({ ...old, ...patch }));
  const addBookmark = () => {
    const cfi = currentCfi.current; if (!cfi || bookmarks.some((item) => item.cfi === cfi) || bookmarks.length >= 100) return;
    const label = `${toc.find((item) => item.href.split("#")[0] === chapter.split("#")[0])?.label.trim() || "Book"} · page ${page?.current ?? 1}`.slice(0, 200);
    const next = [...bookmarks, { cfi, label }]; try { localStorage.setItem(bookmarkKey(path), JSON.stringify(next)); setBookmarks(next); setSelectedBookmark(cfi); } catch { setNotice("Couldn't save the bookmark on this device."); }
  };
  const removeBookmark = () => { const next = bookmarks.filter((item) => item.cfi !== selectedBookmark); try { localStorage.setItem(bookmarkKey(path), JSON.stringify(next)); setBookmarks(next); setSelectedBookmark(""); } catch { setNotice("Couldn't update bookmarks on this device."); } };
  return <div className={`comet-epub-view epub-paper-${prefs.paper}`}>
    <div className="epub-toolbar"><BookOpen size={17} /><strong>EPUB reader</strong><span className="pdf-spacer" />
      <select aria-label="Book chapter" value={toc.find((item) => item.href.split("#")[0] === chapter.split("#")[0])?.href ?? ""} disabled={!ready || !toc.length} onChange={(event) => { if (internalLink(event.target.value)) void rendition.current?.display(event.target.value).catch(() => setNotice("Couldn't open that chapter.")); }}><option value="">Contents</option>{toc.map((item, index) => <option key={`${item.href}:${index}`} value={item.href}>{item.label}</option>)}</select>
      <button type="button" aria-label="Smaller book text" disabled={!ready || prefs.font <= 70} onClick={() => updatePrefs({ font: Math.max(70, prefs.font - 10) })}><Minus size={16} /></button><span>{prefs.font}%</span><button type="button" aria-label="Larger book text" disabled={!ready || prefs.font >= 180} onClick={() => updatePrefs({ font: Math.min(180, prefs.font + 10) })}><Plus size={16} /></button>
      <button type="button" title="Reading options" aria-label="Reading options" aria-expanded={options} onClick={() => setOptions(!options)}><Settings2 size={17} /></button><button type="button" title="Bookmark this page" aria-label="Bookmark this page" disabled={!ready || !currentCfi.current} onClick={addBookmark}><Bookmark size={17} /></button>{!sample && <button type="button" aria-label="Open ebook in system app" onClick={onOpenExternal}><ExternalLink size={16} /></button>}
    </div>
    {options && <div className="epub-options"><label>Font <select value={prefs.family} onChange={(event) => updatePrefs({ family: event.target.value as ReaderPreferences["family"] })}><option value="book">Book default</option><option value="serif">Serif</option><option value="sans">Sans serif</option></select></label><label>Line spacing <select value={prefs.lineHeight} onChange={(event) => updatePrefs({ lineHeight: Number(event.target.value) })}><option value="1.3">Compact</option><option value="1.65">Comfortable</option><option value="2">Relaxed</option></select></label><label>Page color <select value={prefs.paper} onChange={(event) => updatePrefs({ paper: event.target.value as ReaderPreferences["paper"] })}><option value="light">Light</option><option value="sepia">Sepia</option><option value="dark">Dark</option></select></label>{bookmarks.length > 0 && <><label>Bookmarks <select aria-label="Book bookmarks" value={selectedBookmark} onChange={(event) => { const cfi = event.target.value; setSelectedBookmark(cfi); if (cfi) void rendition.current?.display(cfi).catch(() => setNotice("Couldn't open that bookmark.")); }}><option value="">Choose a bookmark</option>{bookmarks.map((item) => <option key={item.cfi} value={item.cfi}>{item.label}</option>)}</select></label><button type="button" className="icon-button" disabled={!selectedBookmark} aria-label="Remove bookmark" onClick={removeBookmark}><Trash2 size={15} /></button></>}</div>}
    {notice && <p className="epub-status" role="status">{notice} <button type="button" onClick={() => setNotice("")}>Dismiss</button></p>}
    {error ? <div className="pdf-message" role="alert"><strong>Couldn't open this EPUB.</strong><p>{error} DRM-protected books are not supported.</p>{!sample && <button className="secondary-button" type="button" onClick={onOpenExternal}>Open with system app</button>}</div> : <><div className="epub-page" ref={host} aria-busy={!ready} />{!ready && <p className="epub-status">Opening book…</p>}<div className="epub-navigation"><button type="button" className="secondary-button" disabled={!ready || page?.atStart} onClick={() => turn("prev")}><ChevronLeft size={16} /> Previous page</button><span aria-live="polite">{page ? `Page ${page.current} of ${page.total} in this section` : "Pages reflow with the window"} · ← / → to turn</span><button type="button" className="secondary-button" disabled={!ready || page?.atEnd} onClick={() => turn("next")}>Next page <ChevronRight size={16} /></button></div></>}
  </div>;
}
