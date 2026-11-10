import { AudioPlayer, VideoPlayer } from "./MediaPlayer";
import { EpubView } from "./EpubView";
import { PdfView } from "./PdfView";
import { ExternalLink, File, Globe, Pencil } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { fileKind, fileKindLabel } from "./utils/fileTypes";
import { LinkEmbedCard } from "./utils/linkEmbeds";
import { parseShortcut, videoLink } from "./utils/links";
import { displayEntryName, fileName } from "./utils/vault";

interface MediaViewProps {
  path: string;
  vault: string;
  url: string;
  sample: boolean;
  autoCoverArt: boolean;
  content: string;
  onRename: () => void;
  onOpenWeb: (url: string) => void;
  onOpenExternal: () => void;
  onEditAsText: () => void;
}

export function MediaView({
  path,
  vault,
  url,
  sample,
  autoCoverArt,
  content,
  onRename,
  onOpenExternal,
  onEditAsText,
  onOpenWeb,
}: MediaViewProps) {
  const kind = fileKind(path);
  const rawName = fileName(path);
  const shownName = displayEntryName(rawName);
  const shortcut = kind === "link" ? parseShortcut(content) : null;
  const linkedVideo = shortcut ? videoLink(shortcut) : null;

  return (
    <section className="media-card" aria-label={`File: ${rawName}`}>
      <div className="media-heading">
        <span className="media-heading-icon">
          <FileIcon entry={{ path, name: rawName, kind: "file" }} size={20} />
        </span>
        <div>
          <span className="section-eyebrow">
            {linkedVideo ? "SAVED VIDEO LINK" : fileKindLabel(path).toUpperCase()}
          </span>
          <h2>
            <button
              type="button"
              className="rename-title"
              aria-label={`Rename ${rawName}`}
              title="Click to rename"
              onClick={onRename}
            >
              {shownName}
              <Pencil size={13} />
            </button>
          </h2>
        </div>
      </div>

      {kind === "link" ? (
        <div className="saved-link-view">
          {shortcut ? (
            <>
              {linkedVideo?.kind === "youtube" ? (
                <div className="linked-video">
                  <iframe
                    title={`YouTube video ${linkedVideo.id}`}
                    src={`https://www.youtube-nocookie.com/embed/${linkedVideo.id}`}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </div>
              ) : linkedVideo?.kind === "video" ? (
                <VideoPlayer url={linkedVideo.url} name={shownName} />
              ) : (
                <LinkEmbedCard url={shortcut} onOpen={onOpenWeb} />
              )}
              <div className="saved-link-meta">
                <a
                  href={shortcut}
                  className="saved-link-inline"
                  rel="noreferrer noopener"
                  title={`Open ${shortcut}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenWeb(shortcut);
                  }}
                >
                  <Globe size={14} aria-hidden="true" />
                  <span>{shortcut}</span>
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              </div>
            </>
          ) : (
            <div className="media-unsupported">
              <h3>This shortcut could not be previewed.</h3>
              <p>The file must contain a valid HTTP or HTTPS URL. Its contents have not been changed.</p>
              <button className="secondary-button" type="button" onClick={onEditAsText}>
                Try as text
              </button>
            </div>
          )}
        </div>
      ) : kind === "pdf" && url ? (
        <PdfView key={url} url={url} path={path} sample={sample} onOpenExternal={onOpenExternal} />
      ) : kind === "ebook" && url ? (
        <EpubView key={url} url={url} path={path} sample={sample} onOpenExternal={onOpenExternal} />
      ) : kind === "image" && url ? (
        <div className="image-stage">
          <img src={url} alt={rawName} />
        </div>
      ) : kind === "audio" && url ? (
        <AudioPlayer
          url={url}
          name={rawName}
          path={path}
          vault={vault}
          sample={sample}
          autoCoverArt={autoCoverArt}
        />
      ) : kind === "video" && url ? (
        <VideoPlayer url={url} name={rawName} />
      ) : (
        <div className="media-unsupported">
          <div className="overview-empty-icon">
            <File size={24} />
          </div>
          <h3>This file is safely stored here.</h3>
          <p>
            Comet doesn't preview this file type. Open it in another app, or explicitly try editing it as text.
          </p>
          <div className="media-actions">
            {!sample && (
              <button className="secondary-button" type="button" onClick={onOpenExternal}>
                <ExternalLink size={15} /> Open with system app
              </button>
            )}
            <button className="secondary-button" type="button" onClick={onEditAsText}>
              Try as text
            </button>
            {sample && url && (
              <a className="secondary-button" href={url} download={rawName}>
                Download
              </a>
            )}
          </div>
        </div>
      )}
      {(kind === "audio" || kind === "video") && (
        <p className="media-note">Playback depends on the codecs available on your device.</p>
      )}
    </section>
  );
}
