import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize, Minimize, Music2, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import { parseWebStream, selectCover } from "music-metadata";
import { downloadCover, readCover, saveCover, validCoverUrl } from "./utils/coverCache";

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

interface AudioInfo { title: string; artist: string; artwork: string; loading: boolean }
function useAudioInfo(url: string, name: string): AudioInfo {
  const [info, setInfo] = useState<AudioInfo>({ title: "", artist: "", artwork: "", loading: true });
  useEffect(() => {
    let active = true, objectUrl = "";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    setInfo({ title: "", artist: "", artwork: "", loading: true });
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) return;
        // Stream metadata, bounded independently from normal media playback.
        let bytes = 0;
        const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, writer) { bytes += chunk.byteLength; if (bytes > 64 * 1024 * 1024) throw new Error("Metadata scan limit reached"); writer.enqueue(chunk); } }));
        const tags = await parseWebStream(bounded, { path: name, mimeType: response.headers.get("content-type")?.split(";")[0] || undefined }, { duration: false, skipPostHeaders: true, maxMemoryAllocation: 8 * 1024 * 1024, maxMetadataEntries: 5000 });
        if (!active) return;
        const picture = selectCover(tags.common.picture);
        if (picture && picture.data.byteLength <= 8 * 1024 * 1024 && /^image\/(?:jpeg|png|gif|webp)$/i.test(picture.format)) objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(picture.data)], { type: picture.format }));
        if (active) setInfo({ title: tags.common.title ?? "", artist: tags.common.artist ?? "", artwork: objectUrl, loading: false });
      } catch { /* Missing metadata never blocks playback or online lookup. */ }
      finally { window.clearTimeout(timeout); if (active) setInfo((previous) => previous.loading ? { ...previous, loading: false } : previous); }
    })();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, name]);
  return info;
}

function useOnlineCover(info: AudioInfo, name: string, automatic: boolean) {
  const [cover, setCover] = useState("");
  const [message, setMessage] = useState("");
  const [searching, setSearching] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setCover(""); setMessage("");
    if (info.loading || info.artwork) { setSearching(false); return; }
    const query = [info.artist, info.title || name.replace(/\.[^.]+$/, "")].filter(Boolean).join(" ").trim().slice(0, 400);
    if (!query) return;
    const key = query.toLocaleLowerCase(); const controller = new AbortController(); let active = true, objectUrl = "";
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      try {
        const cached = await readCover(key);
        if (!active) return;
        if (cached) {
          if (cached.blob) objectUrl = URL.createObjectURL(cached.blob);
          setCover(objectUrl || cached.url); return;
        }
        if (!automatic && !retry) return;
        setSearching(true);
        const response = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Search failed");
        const result: unknown = await response.json();
        const first = result && typeof result === "object" && "results" in result && Array.isArray(result.results) ? result.results[0] : null;
        const candidate = first && typeof first.artworkUrl100 === "string" ? first.artworkUrl100.replace(/100x100[^/]*\./, "600x600bb.") : "";
        if (!validCoverUrl(candidate)) throw new Error("No cover found");
        if (!active) return;
        setCover(candidate); void saveCover(key, candidate);
        // Store the actual image when CORS permits; URL caching remains a
        // graceful fallback if a catalog or browser blocks the image fetch.
        try {
          const blob = await downloadCover(candidate, controller.signal);
          if (blob) { await saveCover(key, candidate, blob); if (active) { objectUrl = URL.createObjectURL(blob); setCover(objectUrl); } }
        } catch { /* A remote image URL is still usable. */ }
      } catch { if (active && retry) setMessage("No cover found. You can still play this track."); }
      finally { window.clearTimeout(timeout); if (active) setSearching(false); }
    })();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [info.loading, info.artwork, info.artist, info.title, name, automatic, retry]);
  return { cover, message, searching, search: () => setRetry((value) => value + 1) };
}

export function AudioPlayer({ url, name, autoCoverArt = true }: { url: string; name: string; autoCoverArt?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null); const player = useRef<HTMLDivElement>(null); const visualizer = useRef<HTMLCanvasElement>(null); const volumeArea = useRef<HTMLDivElement>(null);
  const context = useRef<AudioContext | null>(null); const analyser = useRef<AnalyserNode | null>(null); const nativeFullscreen = useRef(false);
  const [playing, setPlaying] = useState(false); const [current, setCurrent] = useState(0); const [duration, setDuration] = useState(0); const [volume, setVolume] = useState(1); const [failed, setFailed] = useState(""); const [fullPlayer, setFullPlayer] = useState(false);
  const info = useAudioInfo(url, name); const online = useOnlineCover(info, name, autoCoverArt); const artwork = info.artwork || online.cover;
  const changeVolume = (value: number) => { const next = boundVolume(value); if (audio.current) audio.current.volume = next; setVolume(next); };
  useVolumeWheel(volumeArea, (delta) => setVolume((previous) => { const next = boundVolume(previous + delta); if (audio.current) audio.current.volume = next; return next; }));
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
  useEffect(() => {
    const change = () => { if (nativeFullscreen.current && document.fullscreenElement !== player.current) { nativeFullscreen.current = false; setFullPlayer(false); } };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && fullPlayer) { event.stopPropagation(); closeFullscreen(); } };
    document.addEventListener("fullscreenchange", change); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("fullscreenchange", change); document.removeEventListener("keydown", key); };
  }, [fullPlayer]);
  useEffect(() => {
    const canvas = visualizer.current; if (!canvas) return;
    let frame = 0;
    const draw = () => {
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      const width = canvas.width, height = canvas.height; ctx.clearRect(0, 0, width, height);
      const meter = analyser.current; const data = meter ? new Uint8Array(meter.frequencyBinCount) : null;
      if (data && meter) meter.getByteFrequencyData(data);
      const bars = 36, gap = 4, size = (width - gap * (bars - 1)) / bars;
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
        const h = Math.max(2, level * (height - 3)); ctx.fillStyle = `rgba(153, 213, 211, ${.28 + level * .72})`; ctx.fillRect(i * (size + gap), height - h, size, h);
      }
      frame = requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => () => { const currentContext = context.current; if (currentContext) void currentContext.close().catch(() => undefined); context.current = null; analyser.current = null; }, []);
  return <div ref={player} className={`audio-stage audio-player${fullPlayer ? " audio-fullscreen" : ""}`} role="group" aria-label={`Audio player: ${name}`} style={artwork ? { "--audio-cover": `url(${JSON.stringify(artwork)})` } as CSSProperties : undefined}>
    <div className={`audio-art${artwork ? " has-art" : ""}`}>{artwork ? <img src={artwork} alt={`Cover art for ${info.title || name}`} /> : <Music2 size={42} />}</div>
    <div className="audio-copy"><span>YOUR AUDIO</span><h3>{info.title || name}</h3>{info.artist && <p>{info.artist}</p>}{!info.artwork && !online.cover && !info.loading && <button type="button" className="audio-cover-search" title="Search Apple’s music catalog using this track’s title and artist" disabled={online.searching} onClick={online.search}>{online.searching ? "Looking for cover…" : "Find cover online"}</button>}</div>
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
  useVolumeWheel(volumeArea, (delta) => setVolume((previous) => { const next = boundVolume(previous + delta); if (video.current) video.current.volume = next; return next; }));
  const toggle = () => { const element = video.current; if (!element) return; if (element.paused) void element.play().catch(() => setFailed(true)); else element.pause(); };
  const seek = (value: number) => { const element = video.current; if (!element || !Number.isFinite(element.duration)) return; element.currentTime = Math.min(Math.max(0, value), element.duration); setCurrent(element.currentTime); };
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); else if (player.current?.requestFullscreen) void player.current.requestFullscreen().catch(() => undefined); };
  return <div className="video-stage comet-video" ref={player} role="group" aria-label={`Video player: ${name}`}>
    <video ref={video} playsInline preload="metadata" src={url} onClick={toggle} onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setFailed(true)}>Your browser cannot play this video format.</video>
    {!playing && !failed && <button type="button" className="video-center-play" aria-label="Play video" onClick={toggle}><Play size={26} fill="currentColor" /></button>}
    <div className="video-controls"><input className="video-progress" aria-label="Video position" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(current, duration || 0)} disabled={!duration} onChange={(event) => seek(Number(event.target.value))} /><div className="video-control-row"><button type="button" aria-label={playing ? "Pause video" : "Play video controls"} onClick={toggle}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button><button type="button" aria-label="Video back 10 seconds" onClick={() => seek(current - 10)}><RotateCcw size={16} /></button><span className="video-time">{time(current)} / {time(duration)}</span><span className="video-controls-spacer" /><div className="video-volume" ref={volumeArea} title="Scroll to change volume"><button type="button" aria-label={volume ? "Mute video" : "Unmute video"} onClick={() => changeVolume(volume ? 0 : 1)}>{volume ? <Volume2 size={17} /> : <VolumeX size={17} />}</button><input type="range" aria-label="Video volume" min="0" max="1" step="0.05" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} /></div><select aria-label="Video playback speed" value={rate} onChange={(event) => { const next = Number(event.target.value); setRate(next); if (video.current) video.current.playbackRate = next; }}><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><button type="button" aria-label="Toggle video fullscreen" onClick={fullscreen}><Maximize size={17} /></button></div></div>
    {failed && <p className="media-error video-error" role="alert">This video format couldn't be loaded on this device.</p>}
  </div>;
}
