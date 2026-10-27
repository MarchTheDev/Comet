import { useState } from "react";
import { ExternalLink, File, FileAudio, FileImage, FileVideo, Film, Music2 } from "lucide-react";
import { fileKind, fileKindLabel, youtubeIds } from "./utils/fileTypes";
import { fileName } from "./utils/vault";

interface MediaViewProps {
  path: string;
  url: string;
  sample: boolean;
  onOpenExternal: () => void;
  onEditAsText: () => void;
}

export function MediaView({ path, url, sample, onOpenExternal, onEditAsText }: MediaViewProps) {
  const kind = fileKind(path);
  const Icon = kind === "audio" ? FileAudio : kind === "video" ? FileVideo : kind === "image" ? FileImage : File;
  return <section className="media-card" aria-label={`File: ${fileName(path)}`}>
    <div className="media-heading"><span className="media-heading-icon"><Icon size={20} /></span><div><span className="section-eyebrow">{fileKindLabel(path).toUpperCase()}</span><h2>{fileName(path)}</h2></div></div>
    {kind === "image" && url ? <div className="image-stage"><img src={url} alt={fileName(path)} /></div> : kind === "audio" && url ? <div className="audio-stage"><div className="audio-art"><Music2 size={42} /></div><div className="audio-copy"><span>NOW PLAYING</span><h3>{fileName(path)}</h3><p>Audio from your workspace</p></div><audio controls preload="metadata" src={url}>Your browser cannot play this audio format.</audio></div> : kind === "video" && url ? <div className="video-stage"><video controls preload="metadata" src={url}>Your browser cannot play this video format.</video><div><Film size={16} /> {fileName(path)}</div></div> : <div className="media-unsupported"><div className="overview-empty-icon"><File size={24} /></div><h3>This file is safely stored here.</h3><p>Comet doesn't preview this file type. Open it in another app, or explicitly try editing it as text.</p><div className="media-actions">{!sample && <button className="secondary-button" type="button" onClick={onOpenExternal}><ExternalLink size={15} /> Open with system app</button>}<button className="secondary-button" type="button" onClick={onEditAsText}>Try as text</button>{sample && url && <a className="secondary-button" href={url} download={fileName(path)}>Download</a>}</div></div>}
    {(kind === "audio" || kind === "video") && <p className="media-note">Playback depends on the codecs available on your device.</p>}
  </section>;
}

/** Video frames are created only after a deliberate click. URLs are reduced to
 * validated YouTube IDs so notes cannot inject arbitrary iframe origins. */
export function YouTubeEmbeds({ markdown }: { markdown: string }) {
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const ids = youtubeIds(markdown);
  if (!ids.length) return null;
  return <div className="youtube-embeds" aria-label="YouTube videos"><span className="section-eyebrow">VIDEOS IN THIS NOTE</span>{ids.map((id) => <div className="youtube-card" key={id}>{loaded.has(id) ? <iframe title={`YouTube video ${id}`} src={`https://www.youtube-nocookie.com/embed/${id}`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /> : <div><Film size={22} /><span><strong>YouTube video</strong><small>Loading connects to YouTube.</small></span><button className="secondary-button" type="button" onClick={() => setLoaded((previous) => new Set([...previous, id]))}>Load video</button></div>}</div>)}</div>;
}
