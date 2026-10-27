import { useRef, useState } from "react";
import { Film, Music2, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";

function time(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds / 60) % 60; const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
export function AudioPlayer({ url, name }: { url: string; name: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false); const [current, setCurrent] = useState(0); const [duration, setDuration] = useState(0); const [volume, setVolume] = useState(1); const [failed, setFailed] = useState("");
  const toggle = () => { const element = audio.current; if (!element) return; if (element.paused) void element.play().catch(() => setFailed("This audio couldn't be played. The format or codec may not be supported.")); else element.pause(); };
  const seek = (value: number) => { const element = audio.current; if (!element || !Number.isFinite(element.duration)) return; element.currentTime = Math.min(Math.max(0, value), element.duration); setCurrent(element.currentTime); };
  return <div className="audio-stage audio-player"><div className="audio-art"><Music2 size={42} /></div><div className="audio-copy"><span>YOUR AUDIO</span><h3>{name}</h3><p>Play from your workspace</p></div>
    <audio ref={audio} hidden controls preload="metadata" src={url} onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setFailed("This audio format couldn't be loaded on this device.")} />
    <div className="audio-controls"><div className="audio-transport"><button type="button" aria-label="Back 10 seconds" onClick={() => seek(current - 10)}><RotateCcw size={17} /></button><button className="audio-play" type="button" aria-label={playing ? "Pause audio" : "Play audio"} onClick={toggle}>{playing ? <Pause size={20} /> : <Play size={20} />}</button><button type="button" aria-label="Forward 10 seconds" onClick={() => seek(current + 10)}><RotateCw size={17} /></button><span className="audio-time">{time(current)} / {time(duration)}</span></div>
      <input className="audio-progress" aria-label="Audio position" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(current, duration || 0)} disabled={!duration} onChange={(event) => seek(Number(event.target.value))} />
      <div className="audio-volume"><button type="button" aria-label={volume ? "Mute audio" : "Unmute audio"} onClick={() => { const next = volume ? 0 : 1; if (audio.current) audio.current.volume = next; setVolume(next); }}>{volume ? <Volume2 size={16} /> : <VolumeX size={16} />}</button><input type="range" aria-label="Audio volume" min="0" max="1" step="0.05" value={volume} onChange={(event) => { const next = Number(event.target.value); if (audio.current) audio.current.volume = next; setVolume(next); }} /></div>
    </div>{failed && <div className="media-error" role="alert">{failed}</div>}
  </div>;
}
export function VideoPlayer({ url, name }: { url: string; name: string }) {
  const video = useRef<HTMLVideoElement>(null); const [rate, setRate] = useState(1); const [failed, setFailed] = useState(false);
  return <div className="video-stage"><video ref={video} controls preload="metadata" src={url} onError={() => setFailed(true)}>Your browser cannot play this video format.</video><div className="video-player-bar"><Film size={16} /><span>{name}</span><label>Speed <select aria-label="Video playback speed" value={rate} onChange={(event) => { const next = Number(event.target.value); setRate(next); if (video.current) video.current.playbackRate = next; }}><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label></div>{failed && <p className="media-error" role="alert">This video format couldn't be loaded on this device.</p>}</div>;
}
