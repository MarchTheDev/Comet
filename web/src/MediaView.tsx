import { AudioPlayer, VideoPlayer } from "./MediaPlayer";
import { PdfView } from "./PdfView";
import { ExternalLink, File, Link2 } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { fileKind, fileKindLabel } from "./utils/fileTypes";
import { parseShortcut, videoLink } from "./utils/links";
import { fileName } from "./utils/vault";

interface MediaViewProps {
  path: string;
  url: string;
  sample: boolean;
  content: string;
  onOpenWeb: (url: string) => void;
  onOpenExternal: () => void;
  onEditAsText: () => void;
}

export function MediaView({ path, url, sample, content, onOpenExternal, onEditAsText, onOpenWeb }: MediaViewProps) {
  const kind = fileKind(path);
  const shortcut = kind === "link" ? parseShortcut(content) : null;
  const linkedVideo = shortcut ? videoLink(shortcut) : null;
  return <section className="media-card" aria-label={`File: ${fileName(path)}`}>
    <div className="media-heading"><span className="media-heading-icon"><FileIcon entry={{ path, name: fileName(path), kind: "file" }} size={20} /></span><div><span className="section-eyebrow">{fileKindLabel(path).toUpperCase()}</span><h2>{fileName(path)}</h2></div></div>
    {kind === "link" ? <div className="saved-link-view">{shortcut ? <><div className="saved-link-address"><Link2 size={17} /><span>{shortcut}</span><button type="button" className="secondary-button" onClick={() => onOpenWeb(shortcut)}>Open link <ExternalLink size={14} /></button></div>{linkedVideo?.kind === "youtube" ? <div className="linked-video"><iframe title={`YouTube video ${linkedVideo.id}`} src={`https://www.youtube-nocookie.com/embed/${linkedVideo.id}`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div> : linkedVideo?.kind === "video" ? <VideoPlayer url={linkedVideo.url} name={fileName(path)} /> : <p>This shortcut points to a web page. Open it in your browser.</p>}<small>Web previews connect to the linked service. This shortcut does not download the video.</small></> : <div className="media-unsupported"><h3>This shortcut could not be previewed.</h3><p>The file must contain a valid HTTP or HTTPS URL. Its contents have not been changed.</p><button className="secondary-button" type="button" onClick={onEditAsText}>Try as text</button></div>}</div> : kind === "pdf" && url ? <PdfView key={url} url={url} path={path} sample={sample} onOpenExternal={onOpenExternal} /> : kind === "image" && url ? <div className="image-stage"><img src={url} alt={fileName(path)} /></div> : kind === "audio" && url ? <AudioPlayer url={url} name={fileName(path)} /> : kind === "video" && url ? <VideoPlayer url={url} name={fileName(path)} /> : <div className="media-unsupported"><div className="overview-empty-icon"><File size={24} /></div><h3>This file is safely stored here.</h3><p>Comet doesn't preview this file type. Open it in another app, or explicitly try editing it as text.</p><div className="media-actions">{!sample && <button className="secondary-button" type="button" onClick={onOpenExternal}><ExternalLink size={15} /> Open with system app</button>}<button className="secondary-button" type="button" onClick={onEditAsText}>Try as text</button>{sample && url && <a className="secondary-button" href={url} download={fileName(path)}>Download</a>}</div></div>}
    {(kind === "audio" || kind === "video") && <p className="media-note">Playback depends on the codecs available on your device.</p>}
  </section>;
}
