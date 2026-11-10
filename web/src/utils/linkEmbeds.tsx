import { invoke } from "@tauri-apps/api/core";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ExternalLink, Globe, X } from "lucide-react";
import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { safeWebUrl, videoLink } from "./links";
import { faviconUrl } from "./passwords";
import { desktopAvailable } from "./vaultBridge";

export interface LinkPreview {
  url: string;
  siteName: string;
  title: string;
  description: string;
  image: string;
  themeColor: string;
  favicon: string;
}

const DISMISSED_STORAGE_KEY = "comet:dismissed-embeds:v1";
const previewCache = new Map<string, LinkPreview>();
const inflightCache = new Map<string, Promise<LinkPreview>>();
const dismissedListeners = new Set<() => void>();
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i;

export function normalizeEmbedUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/[),.;!?]+$/, "");
  const safe = safeWebUrl(trimmed);
  if (!safe) return null;
  try {
    const parsed = new URL(safe);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function extractLinksFromText(input: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // Remove angle-bracketed <https://...> links when extracting auto-embeds, unless explicitly parsed.
  const regex = /(?<!<)https?:\/\/[^\s<>")\]]+/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    const normalized = normalizeEmbedUrl(match[0]);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      found.push(normalized);
    }
    if (found.length >= 25) break;
  }
  return found;
}

function readDismissedMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [scope, urls] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(urls)) {
        out[scope] = urls.filter((u): u is string => typeof u === "string" && u.length <= 2048).slice(-200);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeDismissedMap(map: Record<string, string[]>): void {
  try {
    const entries = Object.entries(map).filter(([, list]) => list.length > 0).slice(-200);
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Session UI still updates cleanly if storage is unavailable.
  }
}

export function isEmbedDismissed(scope: string, rawUrl: string): boolean {
  const normalized = normalizeEmbedUrl(rawUrl) ?? rawUrl;
  const key = scope || "__default__";
  const map = readDismissedMap();
  return Boolean(map[key]?.includes(normalized));
}

export function subscribeDismissedEmbeds(listener: () => void): () => void {
  dismissedListeners.add(listener);
  return () => {
    dismissedListeners.delete(listener);
  };
}

export function setEmbedDismissed(scope: string, rawUrl: string, dismissed = true): void {
  const normalized = normalizeEmbedUrl(rawUrl) ?? rawUrl;
  const key = scope || "__default__";
  const map = readDismissedMap();
  const current = new Set(map[key] ?? []);
  if (dismissed) current.add(normalized);
  else current.delete(normalized);
  map[key] = [...current];
  writeDismissedMap(map);
  for (const listener of dismissedListeners) listener();
}

function readableFallback(href: string): LinkPreview {
  let siteName = href;
  let title = href;
  let description = "";
  try {
    const parsed = new URL(href);
    siteName = parsed.hostname.replace(/^www\./i, "");
    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      });
    if (segments.length > 0) {
      const last = segments[segments.length - 1].replace(/[-_]+/g, " ").trim();
      title = last ? `${siteName} — ${last}` : siteName;
      description = `${parsed.origin}${parsed.pathname}`;
    } else {
      title = siteName;
      description = parsed.origin;
    }
  } catch {
    // Keep raw href fallback.
  }
  const isImage = IMAGE_EXT.test(href);
  return {
    url: href,
    siteName,
    title,
    description: isImage ? "" : description,
    image: isImage ? href : "",
    themeColor: "",
    favicon: faviconUrl(href) ?? "",
  };
}

async function resolveGitHubPreview(parsed: URL): Promise<LinkPreview | null> {
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, section, number] = parts;
  if (["orgs", "topics", "settings", "marketplace", "explore", "login", "signup"].includes(owner.toLowerCase())) {
    return null;
  }
  const cleanRepo = repo.replace(/\.git$/i, "");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(cleanRepo)}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      full_name?: string;
      description?: string | null;
      stargazers_count?: number;
      language?: string | null;
      owner?: { avatar_url?: string };
    };
    const suffix =
      section && number
        ? ` · ${section === "pull" ? "PR" : section === "issues" ? "Issue" : section} #${number}`
        : section === "releases"
          ? " · Releases"
          : "";
    const metaBits = [
      data.language ? String(data.language) : "",
      typeof data.stargazers_count === "number" ? `★ ${data.stargazers_count.toLocaleString()}` : "",
    ].filter(Boolean);
    const descParts = [data.description ? String(data.description) : "", metaBits.join(" · ")].filter(Boolean);
    return {
      url: parsed.href,
      siteName: "GitHub",
      title: `${data.full_name || `${owner}/${cleanRepo}`}${suffix}`,
      description: descParts.join(" — "),
      image: safeWebUrl(data.owner?.avatar_url ?? "") ?? "",
      themeColor: "#5865f2",
      favicon: faviconUrl(parsed.href) ?? "",
    };
  } catch {
    return null;
  }
}

async function resolveWikipediaPreview(parsed: URL): Promise<LinkPreview | null> {
  if (!/^[a-z-]+\.wikipedia\.org$/i.test(parsed.hostname)) return null;
  const match = /^\/wiki\/([^#?]+)/i.exec(parsed.pathname);
  if (!match) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(`${parsed.origin}/api/rest_v1/page/summary/${match[1]}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      title?: string;
      extract?: string;
      thumbnail?: { source?: string };
    };
    if (!data.title) return null;
    return {
      url: parsed.href,
      siteName: "Wikipedia",
      title: String(data.title),
      description: String(data.extract ?? "").slice(0, 280),
      image: safeWebUrl(data.thumbnail?.source ?? "") ?? "",
      themeColor: "#6b8ba4",
      favicon: faviconUrl(parsed.href) ?? "",
    };
  } catch {
    return null;
  }
}

export function resolveLinkPreview(rawUrl: string): Promise<LinkPreview> {
  const normalized = normalizeEmbedUrl(rawUrl);
  if (!normalized) return Promise.resolve(readableFallback(rawUrl));
  const cached = previewCache.get(normalized);
  if (cached) return Promise.resolve(cached);
  const existing = inflightCache.get(normalized);
  if (existing) return existing;

  const fallback = readableFallback(normalized);
  if (IMAGE_EXT.test(normalized)) {
    previewCache.set(normalized, fallback);
    return Promise.resolve(fallback);
  }

  const job = (async (): Promise<LinkPreview> => {
    try {
      const parsed = new URL(normalized);
      const gh = await resolveGitHubPreview(parsed);
      if (gh) {
        previewCache.set(normalized, gh);
        return gh;
      }
      const wiki = await resolveWikipediaPreview(parsed);
      if (wiki) {
        previewCache.set(normalized, wiki);
        return wiki;
      }
      if (desktopAvailable) {
        const native = await invoke<{
          url: string;
          siteName: string;
          title: string;
          description: string;
          image: string;
          themeColor: string;
        }>("fetch_link_preview", { url: normalized });
        if (native && (native.title || native.description || native.image)) {
          const resolved: LinkPreview = {
            url: normalized,
            siteName: native.siteName || fallback.siteName,
            title: native.title || fallback.title,
            description: native.description || "",
            image: safeWebUrl(native.image) ?? "",
            themeColor: native.themeColor || "",
            favicon: fallback.favicon,
          };
          previewCache.set(normalized, resolved);
          return resolved;
        }
      }
    } catch {
      // Fall back to clean domain card when offline or blocked.
    }
    previewCache.set(normalized, fallback);
    return fallback;
  })().finally(() => {
    inflightCache.delete(normalized);
  });

  inflightCache.set(normalized, job);
  return job;
}

let lastExternalUrl = "";
let lastExternalAt = 0;

export function openExternalWebUrl(url: string): void {
  const safe = safeWebUrl(url);
  if (!safe) return;
  const now = Date.now();
  if (safe === lastExternalUrl && now - lastExternalAt < 350) return;
  lastExternalUrl = safe;
  lastExternalAt = now;
  if (desktopAvailable) {
    void import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(safe))
      .catch(() => window.open(safe, "_blank", "noopener,noreferrer"));
  } else {
    window.open(safe, "_blank", "noopener,noreferrer");
  }
}

export function LinkEmbedCard({
  url,
  onOpen,
  onDismiss,
  compact = false,
}: {
  url: string;
  onOpen?: (url: string) => void;
  onDismiss?: () => void;
  compact?: boolean;
}) {
  const normalized = normalizeEmbedUrl(url) ?? url;
  const [preview, setPreview] = useState<LinkPreview>(() => previewCache.get(normalized) ?? readableFallback(normalized));
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFaviconFailed(false);
    setImageFailed(false);
    void resolveLinkPreview(normalized).then((next) => {
      if (active) setPreview(next);
    });
    return () => {
      active = false;
    };
  }, [normalized]);

  const handleOpen = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (onOpen) onOpen(normalized);
    else openExternalWebUrl(normalized);
  };

  const isDirectImage = IMAGE_EXT.test(normalized);
  const style = preview.themeColor
    ? ({ "--embed-accent": preview.themeColor } as CSSProperties)
    : undefined;

  return (
    <div
      className={`comet-link-embed${compact ? " is-compact" : ""}`}
      data-embed-url={normalized}
      style={style}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="comet-link-embed-main">
        <div className="comet-link-embed-site">
          {preview.favicon && !faviconFailed ? (
            <img
              src={preview.favicon}
              alt=""
              width={14}
              height={14}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setFaviconFailed(true)}
            />
          ) : (
            <Globe size={13} aria-hidden="true" />
          )}
          <span>{preview.siteName}</span>
        </div>
        <a
          href={normalized}
          className="comet-link-embed-title"
          rel="noreferrer noopener"
          onClick={handleOpen}
          title={`Open ${normalized}`}
        >
          <span>{preview.title || normalized}</span>
          <ExternalLink size={12} aria-hidden="true" />
        </a>
        {preview.description && <p className="comet-link-embed-desc">{preview.description}</p>}
        {isDirectImage && preview.image && !imageFailed && (
          <a
            href={normalized}
            className="comet-link-embed-banner"
            rel="noreferrer noopener"
            onClick={handleOpen}
          >
            <img
              src={preview.image}
              alt={preview.title}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImageFailed(true)}
            />
          </a>
        )}
      </div>
      {!isDirectImage && preview.image && !imageFailed && (
        <a
          href={normalized}
          className="comet-link-embed-thumb"
          rel="noreferrer noopener"
          onClick={handleOpen}
          tabIndex={-1}
          aria-hidden="true"
        >
          <img
            src={preview.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        </a>
      )}
      {onDismiss && (
        <button
          type="button"
          className="comet-link-embed-dismiss"
          aria-label="Remove link preview"
          title="Remove embed"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

const linkEmbedPluginKey = new PluginKey<DecorationSet>("cometLinkEmbeds");

function collectBlockUrls(node: ProseMirrorNode): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const normalized = normalizeEmbedUrl(candidate);
    if (!normalized || seen.has(normalized)) return;
    // Video links are rendered by VideoEmbeds instead so they don't duplicate.
    if (videoLink(normalized)) return;
    seen.add(normalized);
    found.push(normalized);
  };

  node.descendants((child) => {
    if (!child.isText) return;
    for (const mark of child.marks) {
      if (mark.type.name === "link" && typeof mark.attrs.href === "string") {
        // Respect Discord's `<https://...>` convention if raw text was wrapped in angle brackets.
        const txt = (child.text ?? "").trim();
        if (txt.startsWith("<") && txt.endsWith(">")) continue;
        add(mark.attrs.href);
      }
    }
    if (child.text) {
      for (const raw of extractLinksFromText(child.text)) {
        add(raw);
      }
    }
  });
  return found;
}

function buildLinkEmbedDecorations(
  doc: ProseMirrorNode,
  getScope: () => string,
  onOpenUrl: ((url: string) => void) | undefined,
  refresh: () => void,
): DecorationSet {
  const decorations: Decoration[] = [];
  const scope = getScope();

  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isTextblock) return true;
    const urls = collectBlockUrls(node).filter((url) => !isEmbedDismissed(scope, url));
    for (const url of urls.slice(0, 4)) {
      decorations.push(
        Decoration.widget(
          pos + node.nodeSize,
          () => {
            const host = document.createElement("div");
            host.className = "comet-link-embed-widget";
            host.contentEditable = "false";
            const root: Root = createRoot(host);
            root.render(
              <LinkEmbedCard
                url={url}
                onOpen={onOpenUrl}
                onDismiss={() => {
                  setEmbedDismissed(getScope(), url, true);
                  refresh();
                }}
              />,
            );
            (host as unknown as { __root?: Root }).__root = root;
            return host;
          },
          {
            key: `link-embed:${scope}:${url}`,
            side: 1,
            ignoreSelection: true,
            destroy: (element) => {
              const root = (element as unknown as { __root?: Root }).__root;
              if (root) setTimeout(() => root.unmount(), 0);
            },
          },
        ),
      );
    }
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

export interface LinkEmbedsOptions {
  getScope?: () => string;
  onOpenUrl?: (url: string) => void;
}

export const LinkEmbeds = Extension.create<LinkEmbedsOptions>({
  name: "cometLinkEmbeds",
  addOptions() {
    return {
      getScope: () => "__note__",
      onOpenUrl: undefined,
    };
  },
  addProseMirrorPlugins() {
    const getScope = () => this.options.getScope?.() ?? "__note__";
    const onOpenUrl = this.options.onOpenUrl;
    const editor = this.editor;
    const triggerRefresh = () => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(linkEmbedPluginKey, true).setMeta("addToHistory", false));
    };

    return [
      new Plugin({
        key: linkEmbedPluginKey,
        state: {
          init: (_, state) => buildLinkEmbedDecorations(state.doc, getScope, onOpenUrl, triggerRefresh),
          apply: (tr, previous, _oldState, newState) =>
            tr.docChanged || Boolean(tr.getMeta(linkEmbedPluginKey))
              ? buildLinkEmbedDecorations(newState.doc, getScope, onOpenUrl, triggerRefresh)
              : previous,
        },
        props: {
          decorations(state) {
            return linkEmbedPluginKey.getState(state) ?? DecorationSet.empty;
          },
        },
        view: () => {
          const onDismissEvent = () => triggerRefresh();
          dismissedListeners.add(onDismissEvent);
          return {
            destroy() {
              dismissedListeners.delete(onDismissEvent);
            },
          };
        },
      }),
    ];
  },
});
