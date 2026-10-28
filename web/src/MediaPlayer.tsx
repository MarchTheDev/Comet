import { AppSelect } from "./AppSelect";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize, Minimize, Music2, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import { parseWebStream, selectCover } from "music-metadata";
import { invoke } from "@tauri-apps/api/core";
import { desktopAvailable } from "./utils/vaultBridge";
import { downloadCover, readCover, saveCover, validCoverUrl, readCoverAlias, saveCoverAlias, sampleCoverFingerprint, readAudioInfo, saveAudioInfo, type CachedAudioInfo } from "./utils/coverCache";

function time(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds / 60) % 60; const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
const boundVolume = (value: number) => Math.max(0, Math.min(1, Math.round(value * 100) / 100));
function useVolumeWheel(ref: React.RefObject<HTMLElement | null>, change: (delta: number) => void) {
  const handler = useRef(change); handler.current = change;
  useEffect(() => {
    const element = ref.current; if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); handler.current(event.deltaY < 0 ? .05 : -.05); };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [ref]);
}


function usePlayerKeys(player: React.RefObject<HTMLElement | null>, onKey: (key: string) => void) {
  const handler = useRef(onKey); handler.current = onKey;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const insidePlayer = !!target && !!player.current?.contains(target);
      const playerRange = insidePlayer && target?.tagName === "INPUT" && (target as HTMLInputElement).type === "range";
      const editing = target?.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target?.tagName ?? "") || (target?.tagName === "INPUT" && !playerRange);
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || editing || (!insidePlayer && /^(BUTTON|A)$/.test(target?.tagName ?? "")) || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.repeat && !event.key.startsWith("Arrow")) return;
      if (![" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "m", "M", "f", "F"].includes(event.key)) return;
      event.preventDefault(); handler.current(event.key);
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
}

interface AudioInfo { title: string; artist: string; artwork: string; loading: boolean }
type NativeAudioMetadata = { title: string; artist: string; mime: string | null; data: string | null };
function nativeAudioMetadata(value: NativeAudioMetadata | null): CachedAudioInfo | null {
  try {
    if (!value || typeof value.title !== "string" || value.title.length > 1000 || typeof value.artist !== "string" || value.artist.length > 1000) return null;
    if (value.mime == null && value.data == null) return { title: value.title, artist: value.artist };
    if (typeof value.mime !== "string" || !/^image\/(?:jpeg|png|gif|webp)$/.test(value.mime) || typeof value.data !== "string" || value.data.length > 11_185_000) return null;
    const bytes = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0));
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return null;
    return { title: value.title, artist: value.artist, artwork: new Blob([bytes], { type: value.mime }) };
  } catch { return null; }
}
async function rememberAudioInfo(fingerprint: string, info: CachedAudioInfo): Promise<void> {
  await saveAudioInfo(fingerprint, info);
  if (!desktopAvailable) return;
  try {
    let data: string | null = null;
    if (info.artwork) {
      const bytes = new Uint8Array(await info.artwork.arrayBuffer()); let binary = "";
      for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
      data = btoa(binary);
    }
    await invoke("remember_audio_metadata", { fingerprint, metadata: { title: info.title, artist: info.artist, mime: info.artwork?.type ?? null, data } });
  } catch { /* Artwork caching is optional. */ }
}
function useAudioInfo(url: string, name: string, fingerprint: string | null | undefined): AudioInfo {
  const [info, setInfo] = useState<AudioInfo>({ title: "", artist: "", artwork: "", loading: true });
  useEffect(() => {
    let active = true, objectUrl = "";
    const controller = new AbortController();
    setInfo({ title: "", artist: "", artwork: "", loading: true });
    if (fingerprint === undefined) return () => { active = false; controller.abort(); };
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    const show = (cached: CachedAudioInfo) => {
      if (!active) return;
      if (cached.artwork) objectUrl = URL.createObjectURL(cached.artwork);
      setInfo({ title: cached.title, artist: cached.artist, artwork: objectUrl, loading: false });
    };
    void (async () => {
      try {
        if (fingerprint) {
          let cached = await readAudioInfo(fingerprint);
          if (!cached && desktopAvailable) {
            cached = nativeAudioMetadata(await invoke<NativeAudioMetadata | null>("read_audio_metadata", { fingerprint }).catch(() => null));
            if (cached) void saveAudioInfo(fingerprint, cached);
          }
          if (cached) { show(cached); return; }
        }
        if (!active) return;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) return;
        // Stream metadata, bounded independently from normal media playback.
        let bytes = 0;
        const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, writer) { bytes += chunk.byteLength; if (bytes > 64 * 1024 * 1024) throw new Error("Metadata scan limit reached"); writer.enqueue(chunk); } }));
        const tags = await parseWebStream(bounded, { path: name, mimeType: response.headers.get("content-type")?.split(";")[0] || undefined }, { duration: false, skipPostHeaders: true, maxMemoryAllocation: 8 * 1024 * 1024, maxMetadataEntries: 5000 });
        if (!active) return;
        const picture = selectCover(tags.common.picture);
        const artwork = picture && picture.data.byteLength > 0 && picture.data.byteLength <= 8 * 1024 * 1024 && /^image\/(?:jpeg|png|gif|webp)$/i.test(picture.format) ? new Blob([Uint8Array.from(picture.data)], { type: picture.format.toLowerCase() }) : undefined;
        const parsed = { title: (tags.common.title ?? "").slice(0, 1000), artist: (tags.common.artist ?? "").slice(0, 1000), artwork };
        // Persist only a successful scan, and let it finish if the user switches files.
        if (fingerprint) void rememberAudioInfo(fingerprint, parsed);
        show(parsed);
      } catch { /* Missing metadata never blocks playback or online lookup. */ }
      finally { window.clearTimeout(timeout); if (active) setInfo((previous) => previous.loading ? { ...previous, loading: false } : previous); }
    })();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, name, fingerprint]);
  return info;
}
type NativeArtwork = { url: string; mime: string; data: string };
function nativeArtwork(value: NativeArtwork | null): { url: string; blob: Blob } | null {
  try {
    if (!value || !validCoverUrl(value.url) || !/^image\/(?:jpeg|png|gif|webp)$/.test(value.mime) || value.data.length > 5_600_000) return null;
    return { url: value.url, blob: new Blob([Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0))], { type: value.mime }) };
  } catch { return null; }
}

function useCoverFingerprint(vault: string, path: string, url: string, sample: boolean): string | null | undefined {
  const source = `${vault}\0${path}\0${url}`;
  const [result, setResult] = useState<{ source: string; id: string | null }>({ source: "", id: null });
  useEffect(() => {
    let active = true;
    // A slow or unavailable native file cannot block playback or catalog lookup.
    const timer = window.setTimeout(() => { if (active) setResult({ source, id: null }); }, 4_000);
    void (async () => {
      try {
        const id = !path || !vault ? null : sample ? await sampleCoverFingerprint(path, url) : desktopAvailable ? await invoke<string>("music_file_fingerprint", { vault, path }) : null;
        if (active) setResult({ source, id: typeof id === "string" && /^[a-f0-9]{64}$/.test(id) ? id : null });
      } catch { if (active) setResult({ source, id: null }); }
      finally { window.clearTimeout(timer); }
    })();
    return () => { active = false; window.clearTimeout(timer); };
  }, [source, vault, path, url, sample]);
  return result.source === source ? result.id : undefined;
}

function useOnlineCover(info: AudioInfo, name: string, automatic: boolean, vault: string, path: string, url: string, fingerprint: string | null | undefined) {
  const source = `${vault}\0${path}\0${url}`;
  const [displayed, setDisplayed] = useState({ source: "", cover: "" });
  const [restored, setRestored] = useState<{ source: string; fingerprint: string | null | undefined; status: "pending" | "hit" | "miss" }>({ source: "", fingerprint: undefined, status: "pending" });
  const [message, setMessage] = useState("");
  const [searching, setSearching] = useState(false);
  const [retry, setRetry] = useState(0);
  const restoration = restored.source === source && restored.fingerprint === fingerprint ? restored.status : "pending";

  // Restore by file identity immediately, without waiting for metadata parsing.
  // Both native and browser aliases point to the bounded, existing image cache.
  useEffect(() => {
    let active = true, objectUrl = "";
    setDisplayed({ source, cover: "" }); setMessage(""); setSearching(false);
    setRestored({ source, fingerprint, status: "pending" });
    if (fingerprint === undefined) return () => { active = false; };
    if (!fingerprint) { setRestored({ source, fingerprint, status: "miss" }); return () => { active = false; }; }
    const show = (blob: Blob) => { if (active) { objectUrl = URL.createObjectURL(blob); setDisplayed({ source, cover: objectUrl }); } };
    void (async () => {
      try {
        const alias = readCoverAlias(fingerprint);
        const cached = alias ? await readCover(alias) : null;
        if (cached?.blob) {
          if (desktopAvailable && alias) void invoke("remember_music_cover_for_file", { fingerprint, query: alias }).catch(() => undefined);
          show(cached.blob); if (active) setRestored({ source, fingerprint, status: "hit" }); return;
        }
        if (desktopAvailable) {
          const found = await invoke<{ query: string; artwork: NativeArtwork } | null>("read_music_cover_for_file", { fingerprint }).catch(() => null);
          const native = nativeArtwork(found?.artwork ?? null);
          if (native && found?.query) {
            const key = found.query.toLocaleLowerCase();
            await saveCover(key, native.url, native.blob); saveCoverAlias(fingerprint, key);
            show(native.blob); if (active) setRestored({ source, fingerprint, status: "hit" }); return;
          }
          // Existing query-only caches can be upgraded to file identity too.
          if (alias) {
            const old = nativeArtwork(await invoke<NativeArtwork | null>("read_cached_music_cover", { query: alias }).catch(() => null));
            if (old) {
              await saveCover(alias, old.url, old.blob); void invoke("remember_music_cover_for_file", { fingerprint, query: alias }).catch(() => undefined);
              show(old.blob); if (active) setRestored({ source, fingerprint, status: "hit" }); return;
            }
          }
        }
        if (cached) {
          // Older browser caches might have only a URL; show it and try to
          // upgrade it to local bytes without re-searching the catalog.
          if (active) { setDisplayed({ source, cover: cached.url }); setRestored({ source, fingerprint, status: "hit" }); }
          if (!desktopAvailable && alias) {
            const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 15_000);
            try { const blob = await downloadCover(cached.url, controller.signal); if (blob) { await saveCover(alias, cached.url, blob); show(blob); } }
            catch { /* CORS or offline: the saved catalog URL is still usable. */ }
            finally { window.clearTimeout(timer); }
          }
          return;
        }
      } catch { /* An unavailable cache must not prevent playback or lookup. */ }
      if (active) setRestored({ source, fingerprint, status: "miss" });
    })();
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source, fingerprint]);

  useEffect(() => {
    if (fingerprint === undefined || restoration !== "miss" || info.loading || info.artwork) return;
    const query = [info.artist, info.title || name.replace(/\.[^.]+$/, "")].filter(Boolean).join(" ").trim().slice(0, 400);
    if (!query) return;
    const key = query.toLocaleLowerCase(), controller = new AbortController(); let active = true, objectUrl = "";
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    const show = (blob: Blob) => { if (active) { objectUrl = URL.createObjectURL(blob); setDisplayed({ source, cover: objectUrl }); } };
    const remember = () => {
      if (!fingerprint) return;
      saveCoverAlias(fingerprint, key);
      if (desktopAvailable) void invoke("remember_music_cover_for_file", { fingerprint, query }).catch(() => undefined);
    };
    void (async () => {
      try {
        const cached = await readCover(key);
        if (!active) return;
        if (cached?.blob) { remember(); show(cached.blob); return; }
        if (desktopAvailable) {
          const restore = nativeArtwork(await invoke<NativeArtwork | null>("read_cached_music_cover", { query }).catch(() => null));
          if (restore) { await saveCover(key, restore.url, restore.blob); remember(); show(restore.blob); return; }
        }
        if (cached) {
          if (active) setDisplayed({ source, cover: cached.url });
          remember();
          // A query-only URL is upgraded in the background whenever possible.
          if (desktopAvailable && (automatic || retry)) {
            try {
              const result = nativeArtwork(await invoke<NativeArtwork | null>("lookup_music_cover", { query }));
              if (result) { await saveCover(key, result.url, result.blob); remember(); show(result.blob); }
            } catch { /* The existing URL is still usable. */ }
          } else if (!desktopAvailable) {
            const imageRequest = new AbortController(), imageTimeout = window.setTimeout(() => imageRequest.abort(), 15_000);
            try { const blob = await downloadCover(cached.url, imageRequest.signal); if (blob) { await saveCover(key, cached.url, blob); show(blob); } }
            catch { /* Some catalog images cannot be fetched across origins. */ }
            finally { window.clearTimeout(imageTimeout); }
          }
          return;
        }
        if (!automatic && !retry) return;
        setSearching(true);
        if (desktopAvailable) {
          const result = nativeArtwork(await invoke<NativeArtwork | null>("lookup_music_cover", { query }));
          if (!result) throw new Error("No cover found");
          await saveCover(key, result.url, result.blob); remember(); show(result.blob); return;
        }
        const response = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Search failed");
        const result: unknown = await response.json();
        const first = result && typeof result === "object" && "results" in result && Array.isArray(result.results) ? result.results[0] : null;
        const candidate = first && typeof first.artworkUrl100 === "string" ? first.artworkUrl100.replace(/100x100[^/]*\./, "600x600bb.") : "";
        if (!validCoverUrl(candidate)) throw new Error("No cover found");
        if (!active) return;
        setDisplayed({ source, cover: candidate }); await saveCover(key, candidate); remember();
        // Finish the bounded image download even if the user switches files.
        const imageRequest = new AbortController(), imageTimeout = window.setTimeout(() => imageRequest.abort(), 15_000);
        try { const blob = await downloadCover(candidate, imageRequest.signal); if (blob) { await saveCover(key, candidate, blob); show(blob); } }
        catch { /* A remote image URL is still usable if CORS blocks caching. */ }
        finally { window.clearTimeout(imageTimeout); }
      } catch { if (active && retry) setMessage("No cover found. You can still play this track."); }
      finally { window.clearTimeout(timeout); if (active) setSearching(false); }
    })();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source, fingerprint, restoration, info.loading, info.artwork, info.artist, info.title, name, automatic, retry]);
  return { cover: displayed.source === source ? displayed.cover : "", message, searching, search: () => setRetry((value) => value + 1) };
}
export function AudioPlayer({ url, name, vault = "", path = "", sample = false, autoCoverArt = true }: { url: string; name: string; vault?: string; path?: string; sample?: boolean; autoCoverArt?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null); const player = useRef<HTMLDivElement>(null); const visualizer = useRef<HTMLCanvasElement>(null); const volumeArea = useRef<HTMLDivElement>(null);
  const context = useRef<AudioContext | null>(null); const analyser = useRef<AnalyserNode | null>(null); const nativeFullscreen = useRef(false);
  const [playing, setPlaying] = useState(false); const [current, setCurrent] = useState(0); const [duration, setDuration] = useState(0); const [volume, setVolume] = useState(1); const [failed, setFailed] = useState(""); const [fullPlayer, setFullPlayer] = useState(false);
  const fingerprint = useCoverFingerprint(vault, path, url, sample); const info = useAudioInfo(url, name, fingerprint); const online = useOnlineCover(info, name, autoCoverArt, vault, path, url, fingerprint); const artwork = info.artwork || online.cover;
  const changeVolume = (value: number) => { const next = boundVolume(value); if (audio.current) audio.current.volume = next; setVolume(next); };
  const adjustVolume = (delta: number) => setVolume((previous) => { const next = boundVolume(previous + delta); if (audio.current) audio.current.volume = next; return next; });
  useVolumeWheel(volumeArea, adjustVolume);
  const toggle = async () => {
    const element = audio.current; if (!element) return;
    if (!element.paused) { element.pause(); return; }
    try {
      if (!context.current && typeof AudioContext !== "undefined") {
        // An unavailable visualizer must not prevent ordinary playback.
        try {
          const next = new AudioContext();
          try {
            const source = next.createMediaElementSource(element); const meter = next.createAnalyser(); meter.fftSize = 2048; meter.smoothingTimeConstant = .7;
            source.connect(meter); meter.connect(next.destination); context.current = next; analyser.current = meter;
          } catch { void next.close().catch(() => undefined); }
        } catch { /* Playback can still work without Web Audio. */ }
      }
      if (context.current?.state === "suspended") await context.current.resume();
      await element.play(); setFailed("");
    } catch { setFailed("This audio couldn't be played. The format or codec may not be supported."); }
  };
  const seek = (value: number) => { const element = audio.current; if (!element || !Number.isFinite(element.duration)) return; element.currentTime = Math.min(Math.max(0, value), element.duration); setCurrent(element.currentTime); };
  const closeFullscreen = () => { setFullPlayer(false); if (document.fullscreenElement === player.current) void document.exitFullscreen().catch(() => undefined); nativeFullscreen.current = false; };
  const openFullscreen = () => { setFullPlayer(true); if (player.current?.requestFullscreen) void player.current.requestFullscreen().then(() => { nativeFullscreen.current = true; }).catch(() => undefined); };
  usePlayerKeys(player, (key) => { if (key === " ") void toggle(); else if (key === "ArrowLeft") seek((audio.current?.currentTime ?? current) - 10); else if (key === "ArrowRight") seek((audio.current?.currentTime ?? current) + 10); else if (key === "ArrowUp") adjustVolume(.05); else if (key === "ArrowDown") adjustVolume(-.05); else if (key.toLowerCase() === "m") changeVolume(volume ? 0 : 1); else if (key.toLowerCase() === "f") fullPlayer ? closeFullscreen() : openFullscreen(); });
  useEffect(() => {
    const change = () => { if (nativeFullscreen.current && document.fullscreenElement !== player.current) { nativeFullscreen.current = false; setFullPlayer(false); } };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && fullPlayer) { event.stopPropagation(); closeFullscreen(); } };
    document.addEventListener("fullscreenchange", change); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("fullscreenchange", change); document.removeEventListener("keydown", key); };
  }, [fullPlayer]);
  useEffect(() => {
    const canvas = visualizer.current; if (!canvas) return;
    let frame = 0; const levels = new Float32Array(48);
    const draw = () => {
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      const width = canvas.width, height = canvas.height; ctx.clearRect(0, 0, width, height);
      const meter = analyser.current; const data = meter ? new Uint8Array(meter.frequencyBinCount) : null;
      if (data && meter) meter.getByteFrequencyData(data);
      const bars = fullPlayer ? 48 : 36, gap = fullPlayer ? 3 : 4, size = (width - gap * (bars - 1)) / bars;
      const gradient = ctx.createLinearGradient(0, height, width, 0); gradient.addColorStop(0, "#75d0c7"); gradient.addColorStop(.52, "#aab8eb"); gradient.addColorStop(1, "#e4a4c7");
      let peak = 0; if (data && playing) for (const value of data) peak = Math.max(peak, value / 255);
      const sampleRate = context.current?.sampleRate ?? 44100, binHz = sampleRate / (meter?.fftSize ?? 2048);
      for (let i = 0; i < bars; i++) {
        const start = Math.max(0, Math.min((data?.length ?? 1) - 1, Math.floor((35 * Math.pow(10000 / 35, i / bars)) / binHz)));
        const end = Math.max(start + 1, Math.min(data?.length ?? 1, Math.ceil((35 * Math.pow(10000 / 35, (i + 1) / bars)) / binHz)));
        let band = 0; if (data && playing) for (let j = start; j < end; j++) band = Math.max(band, data[j] / 255);
        // Mix a little live overall energy into every frequency band, so a
        // bass-heavy recording still animates the full visualizer, not just
        // the first few bars. Silence remains still.
        const level = Math.min(1, Math.max(band * 1.25, peak * (.12 + .18 * (1 + Math.sin(i * .8 + peak * 5)) / 2)));
        levels[i] = Math.max(level, levels[i] * .88); const h = Math.max(3, levels[i] * (height - 5));
        ctx.globalAlpha = .35 + levels[i] * .65; ctx.fillStyle = gradient; ctx.beginPath(); ctx.roundRect(i * (size + gap), height - h, size, h, Math.min(4, size / 2)); ctx.fill();
      }
      ctx.globalAlpha = 1; frame = requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(frame);
  }, [playing, fullPlayer]);
  useEffect(() => () => { const currentContext = context.current; if (currentContext) void currentContext.close().catch(() => undefined); context.current = null; analyser.current = null; }, []);
  return <div ref={player} className={`audio-stage audio-player${fullPlayer ? " audio-fullscreen" : ""}`} role="group" aria-label={`Audio player: ${name}`} style={artwork ? { "--audio-cover": `url(${JSON.stringify(artwork)})` } as CSSProperties : undefined}>
    <div className={`audio-art${artwork ? " has-art" : ""}`}>{artwork ? <img src={artwork} draggable={false} alt={`Cover art for ${info.title || name}`} /> : <Music2 size={42} />}</div>
    <div className="audio-copy"><span>YOUR AUDIO</span><h3>{info.title || name}</h3><p className="audio-artist">{info.artist || "\u00a0"}</p><div className="audio-cover-slot">{!info.artwork && !online.cover && !info.loading && <button type="button" className="audio-cover-search" title="Search Apple’s music catalog using this track’s title and artist" disabled={online.searching} onClick={online.search}>{online.searching ? "Looking for cover…" : "Find cover online"}</button>}</div></div>
    <button type="button" className="audio-fullscreen-toggle" aria-label={fullPlayer ? "Exit full-screen player" : "Open full-screen player"} title={fullPlayer ? "Exit full screen" : "Full-screen player"} onClick={fullPlayer ? closeFullscreen : openFullscreen}>{fullPlayer ? <Minimize size={18} /> : <Maximize size={18} />}</button>
    <audio ref={audio} hidden crossOrigin="anonymous" preload="metadata" src={url} onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setFailed("This audio format couldn't be loaded on this device.")} />
    <div className="audio-controls"><div className="audio-transport"><button type="button" aria-label="Back 10 seconds" onClick={() => seek(current - 10)}><RotateCcw size={17} /></button><button className="audio-play" type="button" aria-label={playing ? "Pause audio" : "Play audio"} onClick={() => void toggle()}>{playing ? <Pause size={20} /> : <Play size={20} />}</button><button type="button" aria-label="Forward 10 seconds" onClick={() => seek(current + 10)}><RotateCw size={17} /></button><span className="audio-time">{time(current)} / {time(duration)}</span></div>
      <canvas ref={visualizer} className="audio-visualizer" width="480" height="60" aria-label="Live audio visualizer" />
      <input className="audio-progress" aria-label="Audio position" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(current, duration || 0)} disabled={!duration} onChange={(event) => seek(Number(event.target.value))} />
      <div className="audio-volume" ref={volumeArea} title="Scroll to change volume"><button type="button" aria-label={volume ? "Mute audio" : "Unmute audio"} onClick={() => changeVolume(volume ? 0 : 1)}>{volume ? <Volume2 size={16} /> : <VolumeX size={16} />}</button><input type="range" aria-label="Audio volume" min="0" max="1" step="0.05" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} /></div>
    </div>{(failed || online.message) && <div className="media-error" role="status">{failed || online.message}</div>}
  </div>;
}

/** Custom controls live over the video itself; no platform-native control bar. */
export function VideoPlayer({ url, name }: { url: string; name: string }) {
  const video = useRef<HTMLVideoElement>(null); const player = useRef<HTMLDivElement>(null); const volumeArea = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false); const [current, setCurrent] = useState(0); const [duration, setDuration] = useState(0); const [volume, setVolume] = useState(1); const [rate, setRate] = useState(1); const [failed, setFailed] = useState(false);
  const changeVolume = (value: number) => { const next = boundVolume(value); if (video.current) video.current.volume = next; setVolume(next); };
  const adjustVolume = (delta: number) => setVolume((previous) => { const next = boundVolume(previous + delta); if (video.current) video.current.volume = next; return next; });
  useVolumeWheel(volumeArea, adjustVolume);
  const toggle = () => { const element = video.current; if (!element) return; if (element.paused) void element.play().catch(() => setFailed(true)); else element.pause(); };
  const seek = (value: number) => { const element = video.current; if (!element || !Number.isFinite(element.duration)) return; element.currentTime = Math.min(Math.max(0, value), element.duration); setCurrent(element.currentTime); };
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); else if (player.current?.requestFullscreen) void player.current.requestFullscreen().catch(() => undefined); };
  usePlayerKeys(player, (key) => { if (key === " ") toggle(); else if (key === "ArrowLeft") seek((video.current?.currentTime ?? current) - 10); else if (key === "ArrowRight") seek((video.current?.currentTime ?? current) + 10); else if (key === "ArrowUp") adjustVolume(.05); else if (key === "ArrowDown") adjustVolume(-.05); else if (key.toLowerCase() === "m") changeVolume(volume ? 0 : 1); else if (key.toLowerCase() === "f") fullscreen(); });
  useEffect(() => { player.current?.focus({ preventScroll: true }); }, []);
  return <div className="video-stage comet-video" ref={player} onPointerDown={(event) => { if (!(event.target as Element).closest("button,input,select,a")) event.currentTarget.focus({ preventScroll: true }); }} tabIndex={-1} role="group" aria-label={`Video player: ${name}`}>
    <video ref={video} playsInline preload="metadata" src={url} onClick={toggle} onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setFailed(true)}>Your browser cannot play this video format.</video>
    {!playing && !failed && <button type="button" className="video-center-play" aria-label="Play video" onClick={toggle}><Play size={26} fill="currentColor" /></button>}
    <div className="video-controls"><input className="video-progress" aria-label="Video position" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(current, duration || 0)} disabled={!duration} onChange={(event) => seek(Number(event.target.value))} /><div className="video-control-row"><button type="button" aria-label={playing ? "Pause video" : "Play video controls"} onClick={toggle}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button><button type="button" aria-label="Video back 10 seconds" onClick={() => seek(current - 10)}><RotateCcw size={16} /></button><span className="video-time">{time(current)} / {time(duration)}</span><span className="video-controls-spacer" /><div className="video-volume" ref={volumeArea} title="Scroll to change volume"><button type="button" aria-label={volume ? "Mute video" : "Unmute video"} onClick={() => changeVolume(volume ? 0 : 1)}>{volume ? <Volume2 size={17} /> : <VolumeX size={17} />}</button><input type="range" aria-label="Video volume" min="0" max="1" step="0.05" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} /></div><AppSelect label="Video playback speed" value={rate} onChange={(value) => { const next = Number(value); setRate(next); if (video.current) video.current.playbackRate = next; }}><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></AppSelect><button type="button" aria-label="Toggle video fullscreen" onClick={fullscreen}><Maximize size={17} /></button></div></div>
    {failed && <p className="media-error video-error" role="alert">This video format couldn't be loaded on this device.</p>}
  </div>;
}
