import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BookOpen,
  Bookmark,
  Check,
  CircleDot,
  Code2,
  Compass,
  Cpu,
  Download,
  ExternalLink,
  Feather,
  Film,
  Flame,
  Gamepad2,
  Globe,
  GripVertical,
  Headphones,
  ImagePlus,
  Layers,
  Maximize2,
  Minimize2,
  Newspaper,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { openExternalWebUrl } from "./utils/linkEmbeds";
import {
  articleNeedsFullExtraction,
  compareArticleDates,
  CURRENT_EXTRACTOR_VERSION,
  faviconForSite,
  fetchAndParseFeed,
  fetchFullArticleContent,
  fetchProxiedRssImage,
  hostnameLabel,
  isValidCustomIconImageUrl,
  MAX_RSS_FEEDS,
  mergeFetchedArticles,
  normalizeFeedUrl,
  parseOpmlFeeds,
  readRssState,
  resizeIconFileToDataUrl,
  RSS_ACCENT_COLORS,
  RSS_ICON_PRESETS,
  rssErrorMessage,
  rssId,
  saveOpmlWithDialog,
  saveRssState,
  STARTER_RSS_FEEDS,
  type RssArticle,
  type RssFeed,
  type RssFeedIcon,
  type RssIconPreset,
  type RssState,
  type StarterFeedSuggestion,
} from "./utils/rss";

const PRESET_ICON_MAP: Record<RssIconPreset, LucideIcon> = {
  rss: Rss,
  newspaper: Newspaper,
  globe: Globe,
  code: Code2,
  cpu: Cpu,
  sparkles: Sparkles,
  terminal: Terminal,
  book: BookOpen,
  headphones: Headphones,
  film: Film,
  flame: Flame,
  compass: Compass,
  feather: Feather,
  layers: Layers,
  zap: Zap,
  gamepad: Gamepad2,
};

const QUICK_EMOJIS = ["📰", "🦀", "🚀", "💡", "🎨", "🌍", "☕", "⚡", "🧪", "🎧"];

type FeedSelection = "all" | "unread" | "saved" | `feed:${string}`;

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);
    promise.then(
      (val) => {
        globalThis.clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        globalThis.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function formatRelativeDate(iso: string): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec >= 0 && diffSec < 60) return "just now";
  if (diffSec >= 60 && diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec >= 3600 && diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec >= 86400 && diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(new Date(ts));
}

function inferSlugBundleImageFallback(imgUrl: string, articleUrl?: string): string {
  if (!imgUrl || !articleUrl) return "";
  try {
    const imgParsed = new URL(imgUrl);
    const artParsed = new URL(articleUrl);
    if (imgParsed.origin !== artParsed.origin) return "";
    const artPath = artParsed.pathname.replace(/\/+$/, "");
    const artSegments = artPath.split("/").filter(Boolean);
    const imgSegments = imgParsed.pathname.split("/").filter(Boolean);
    if (artSegments.length === 0 || imgSegments.length === 0) return "";
    const slug = artSegments[artSegments.length - 1];
    if (/\.[a-z0-9]{2,5}$/i.test(slug)) return "";
    const parentDir = "/" + artSegments.slice(0, -1).join("/");
    const imgDir = "/" + imgSegments.slice(0, -1).join("/");
    const fileName = imgSegments[imgSegments.length - 1];
    if (imgDir === parentDir && fileName && fileName !== slug) {
      return `${artParsed.origin}${artPath}/${fileName}${imgParsed.search}`;
    }
  } catch {
    // ignore
  }
  return "";
}

function RssReaderImage({
  src,
  altUrl,
  articleUrl,
  alt = "",
  caption = "",
  className,
  asFigure = false,
}: {
  src: string;
  altUrl?: string;
  articleUrl?: string;
  alt?: string;
  caption?: string;
  className?: string;
  asFigure?: boolean;
}) {
  const candidates = useMemo(() => {
    const inferred = inferSlugBundleImageFallback(src, articleUrl);
    const list: string[] = [];
    for (const u of [src, altUrl || "", inferred]) {
      if (u && !list.includes(u)) list.push(u);
    }
    return list;
  }, [src, altUrl, articleUrl]);

  const [idx, setIdx] = useState(0);
  const [proxiedDataUrl, setProxiedDataUrl] = useState("");
  const [hidden, setHidden] = useState(false);
  const proxyTriedRef = useRef(false);

  useEffect(() => {
    setIdx(0);
    setProxiedDataUrl("");
    setHidden(false);
    proxyTriedRef.current = false;
  }, [candidates]);

  const handleError = () => {
    if (proxiedDataUrl) {
      setHidden(true);
      return;
    }
    if (idx + 1 < candidates.length) {
      setIdx(idx + 1);
      return;
    }
    if (!proxyTriedRef.current) {
      proxyTriedRef.current = true;
      void (async () => {
        for (const candidate of candidates) {
          const dataUrl = await fetchProxiedRssImage(candidate, articleUrl);
          if (dataUrl) {
            setProxiedDataUrl(dataUrl);
            return;
          }
        }
        setHidden(true);
      })();
      return;
    }
    setHidden(true);
  };

  if (hidden || candidates.length === 0) return null;
  const activeSrc = proxiedDataUrl || candidates[idx] || src;

  if (asFigure) {
    const captionText = caption || alt;
    return (
      <figure className="rss-reader-figure">
        <img
          src={activeSrc}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={handleError}
        />
        {captionText && <figcaption>{captionText}</figcaption>}
      </figure>
    );
  }

  return (
    <img
      className={className}
      src={activeSrc}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={handleError}
    />
  );
}

export function RssFeedAvatar({
  icon,
  color,
  feedIconUrl,
  siteUrl,
  feedUrl,
  size = "md",
}: {
  icon: RssFeedIcon;
  color: string;
  feedIconUrl?: string;
  siteUrl?: string;
  feedUrl?: string;
  size?: "sm" | "md" | "lg";
}) {
  const [failedSrc, setFailedSrc] = useState("");
  const style = { "--rss-feed-color": color || RSS_ACCENT_COLORS[0] } as CSSProperties;

  if (icon.kind === "emoji" && icon.value.trim()) {
    return (
      <span className={`rss-feed-avatar is-${size}`} style={style} aria-hidden="true">
        <span className="rss-feed-emoji">{icon.value}</span>
      </span>
    );
  }

  if (icon.kind === "image" && icon.url && failedSrc !== icon.url) {
    return (
      <span className={`rss-feed-avatar is-${size} has-image`} style={style} aria-hidden="true">
        <img
          src={icon.url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(icon.url)}
        />
      </span>
    );
  }

  if (icon.kind === "auto") {
    const candidate = feedIconUrl || faviconForSite(siteUrl || feedUrl || "");
    if (candidate && failedSrc !== candidate) {
      return (
        <span className={`rss-feed-avatar is-${size} has-image`} style={style} aria-hidden="true">
          <img
            src={candidate}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc(candidate)}
          />
        </span>
      );
    }
  }

  const PresetIcon =
    icon.kind === "preset" ? (PRESET_ICON_MAP[icon.preset] ?? Rss) : Rss;
  const px = size === "sm" ? 13 : size === "lg" ? 19 : 15;
  return (
    <span className={`rss-feed-avatar is-${size}`} style={style} aria-hidden="true">
      <PresetIcon size={px} />
    </span>
  );
}

interface FeedDialogDraft {
  mode: "add" | "edit";
  feedId: string;
  url: string;
  name: string;
  iconTab: "auto" | "preset" | "emoji" | "image";
  preset: RssIconPreset;
  emoji: string;
  imageUrl: string;
  color: string;
}

function draftFromFeed(feed?: RssFeed): FeedDialogDraft {
  if (!feed) {
    return {
      mode: "add",
      feedId: "",
      url: "",
      name: "",
      iconTab: "auto",
      preset: "rss",
      emoji: "📰",
      imageUrl: "",
      color: RSS_ACCENT_COLORS[0],
    };
  }
  return {
    mode: "edit",
    feedId: feed.id,
    url: feed.url,
    name: feed.name,
    iconTab: feed.icon.kind,
    preset: feed.icon.kind === "preset" ? feed.icon.preset : "rss",
    emoji: feed.icon.kind === "emoji" ? feed.icon.value : "📰",
    imageUrl: feed.icon.kind === "image" ? feed.icon.url : "",
    color: feed.color || RSS_ACCENT_COLORS[0],
  };
}

function buildIconFromDraft(draft: FeedDialogDraft): RssFeedIcon {
  if (draft.iconTab === "preset") {
    return { kind: "preset", preset: draft.preset };
  }
  if (draft.iconTab === "emoji") {
    const val = [...draft.emoji.trim()].slice(0, 6).join("");
    return val ? { kind: "emoji", value: val } : { kind: "preset", preset: "rss" };
  }
  if (draft.iconTab === "image" && isValidCustomIconImageUrl(draft.imageUrl)) {
    return { kind: "image", url: draft.imageUrl.trim() };
  }
  return { kind: "auto" };
}

export function RssView({
  vault,
  name,
}: {
  vault: string;
  name: string;
}) {
  const [initial] = useState(() => readRssState(vault));
  const [rssState, setRssState] = useState<RssState>(initial.state);
  const stateRef = useRef(rssState);
  stateRef.current = rssState;

  const [selection, setSelection] = useState<FeedSelection>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "unread" | "saved">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeArticleId, setActiveArticleId] = useState<string>("");
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(() => new Set());
  const [dialogDraft, setDialogDraft] = useState<FeedDialogDraft | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>("");
  const [bannerNotice, setBannerNotice] = useState<string>("");
  const [draggingFeedId, setDraggingFeedId] = useState<string | null>(null);
  const [feedDropHint, setFeedDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const [fullLoadingId, setFullLoadingId] = useState<string>("");
  const [fullLoadError, setFullLoadError] = useState<string>("");
  const [readerExpanded, setReaderExpanded] = useState(false);

  const feedListRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLElement>(null);
  const opmlInputRef = useRef<HTMLInputElement>(null);
  const iconUploadRef = useRef<HTMLInputElement>(null);
  const attemptedFullIdsRef = useRef<Set<string>>(new Set());

  const ready = initial.status === "ready";
  const readSet = useMemo(() => new Set(rssState.readIds), [rssState.readIds]);
  const savedSet = useMemo(() => new Set(rssState.savedIds), [rssState.savedIds]);
  const feedsById = useMemo(
    () => new Map(rssState.feeds.map((feed) => [feed.id, feed])),
    [rssState.feeds],
  );

  const commitState = useCallback(
    (updater: (prev: RssState) => RssState) => {
      setRssState((prev) => {
        const next = updater(prev);
        stateRef.current = next;
        saveRssState(vault, next);
        return next;
      });
    },
    [vault],
  );

  const refreshSingleFeed = useCallback(
    async (feed: RssFeed): Promise<{ ok: boolean; feedName: string; error?: string }> => {
      setRefreshingIds((prev) => new Set(prev).add(feed.id));
      try {
        const parsed = await withTimeout(
          fetchAndParseFeed(feed.url),
          20000,
          "Feed request timed out.",
        );
        const nowIso = new Date().toISOString();
        commitState((prev) => {
          const saved = new Set(prev.savedIds);
          const nextFeeds = prev.feeds.map((f) =>
            f.id === feed.id
              ? {
                  ...f,
                  siteUrl: parsed.siteUrl || f.siteUrl,
                  feedIconUrl: parsed.iconUrl || f.feedIconUrl,
                  lastFetchedAt: nowIso,
                  lastError: "",
                }
              : f,
          );
          const nextArticles = mergeFetchedArticles(
            feed.id,
            prev.articles,
            parsed.items,
            saved,
          );
          return { ...prev, feeds: nextFeeds, articles: nextArticles };
        });
        return { ok: true, feedName: feed.name };
      } catch (err) {
        const message = rssErrorMessage(err, "Couldn't refresh feed.");
        commitState((prev) => ({
          ...prev,
          feeds: prev.feeds.map((f) =>
            f.id === feed.id ? { ...f, lastError: message } : f,
          ),
        }));
        return { ok: false, feedName: feed.name, error: message };
      } finally {
        setRefreshingIds((prev) => {
          const next = new Set(prev);
          next.delete(feed.id);
          return next;
        });
      }
    },
    [commitState],
  );

  const refreshAllFeeds = useCallback(async () => {
    const currentFeeds = stateRef.current.feeds;
    if (!currentFeeds.length) return;
    setBannerNotice("");
    const CONCURRENCY = 4;
    const failed: { feedName: string; error: string }[] = [];
    for (let i = 0; i < currentFeeds.length; i += CONCURRENCY) {
      const batch = currentFeeds.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((f) => refreshSingleFeed(f)));
      for (const r of results) {
        if (!r.ok && r.error) {
          failed.push({ feedName: r.feedName, error: r.error });
        }
      }
    }
    if (failed.length === 1) {
      setBannerNotice(`${failed[0].feedName}: ${failed[0].error}`);
    } else if (failed.length > 1) {
      setBannerNotice(
        `${failed.length} of ${currentFeeds.length} feeds couldn't refresh (${failed[0].feedName}: ${failed[0].error}).`,
      );
    }
  }, [refreshSingleFeed]);

  // Auto-refresh feeds once on open if stale (> 15 minutes)
  const didInitialRefresh = useRef(false);
  useEffect(() => {
    if (didInitialRefresh.current || !ready) return;
    didInitialRefresh.current = true;
    const stale = stateRef.current.feeds.filter((f) => {
      if (!f.lastFetchedAt) return true;
      const age = Date.now() - Date.parse(f.lastFetchedAt);
      return !Number.isFinite(age) || age > 15 * 60 * 1000;
    });
    if (stale.length > 0) {
      void (async () => {
        const CONCURRENCY = 4;
        for (let i = 0; i < stale.length; i += CONCURRENCY) {
          await Promise.allSettled(
            stale.slice(i, i + CONCURRENCY).map((f) => refreshSingleFeed(f)),
          );
        }
      })();
    }
  }, [ready, refreshSingleFeed]);

  const unreadByFeed = useMemo(() => {
    const counts = new Map<string, number>();
    for (const art of rssState.articles) {
      if (!readSet.has(art.id)) {
        counts.set(art.feedId, (counts.get(art.feedId) ?? 0) + 1);
      }
    }
    return counts;
  }, [rssState.articles, readSet]);

  const totalUnread = useMemo(
    () => rssState.articles.reduce((acc, a) => acc + (readSet.has(a.id) ? 0 : 1), 0),
    [rssState.articles, readSet],
  );

  const selectedFeed = useMemo(() => {
    if (!selection.startsWith("feed:")) return null;
    return feedsById.get(selection.slice(5)) ?? null;
  }, [selection, feedsById]);

  const filteredArticles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rssState.articles
      .filter((art) => {
        if (selection === "unread" && readSet.has(art.id)) return false;
        if (selection === "saved" && !savedSet.has(art.id)) return false;
        if (selection.startsWith("feed:") && art.feedId !== selection.slice(5)) return false;

        if (statusFilter === "unread" && readSet.has(art.id)) return false;
        if (statusFilter === "saved" && !savedSet.has(art.id)) return false;

        if (q) {
          const feedName = feedsById.get(art.feedId)?.name.toLowerCase() ?? "";
          const hay = `${art.title} ${art.summary} ${art.author} ${feedName} ${art.categories.join(" ")}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => compareArticleDates(b.publishedAt, a.publishedAt));
  }, [rssState.articles, selection, statusFilter, searchQuery, readSet, savedSet, feedsById]);

  const activeArticle = useMemo(() => {
    if (!activeArticleId) return filteredArticles[0] ?? null;
    return (
      rssState.articles.find((a) => a.id === activeArticleId) ??
      filteredArticles[0] ??
      null
    );
  }, [activeArticleId, rssState.articles, filteredArticles]);

  const loadFullArticle = useCallback(
    async (article: RssArticle, manual = false) => {
      if (!article.url) return;
      attemptedFullIdsRef.current.add(article.id);
      setFullLoadingId(article.id);
      setFullLoadError("");
      try {
        const extracted = await withTimeout(
          fetchFullArticleContent(article.url, article.title, article.author),
          22000,
          "Full article request timed out.",
        );
        if (extracted.blocks.length > 0) {
          commitState((prev) => ({
            ...prev,
            articles: prev.articles.map((a) =>
              a.id === article.id
                ? {
                    ...a,
                    author: a.author || extracted.author || "",
                    fullBlocks: extracted.blocks,
                    extractorVersion: CURRENT_EXTRACTOR_VERSION,
                    imageUrl: a.imageUrl || extracted.heroImage || "",
                  }
                : a,
            ),
          }));
        } else if (manual || (article.blocks.length === 0 && !article.summary)) {
          setFullLoadError("Couldn't extract full article text from this page.");
        }
      } catch (err) {
        if (manual || (article.blocks.length === 0 && !article.summary)) {
          setFullLoadError(rssErrorMessage(err, "Couldn't load full post."));
        }
      } finally {
        setFullLoadingId((curr) => (curr === article.id ? "" : curr));
      }
    },
    [commitState],
  );

  // Automatically extract the full post when opening summary-only or Hacker News stub items
  useEffect(() => {
    setFullLoadError("");
    if (!activeArticle) return;
    if (attemptedFullIdsRef.current.has(activeArticle.id)) return;
    if (!articleNeedsFullExtraction(activeArticle)) return;
    void loadFullArticle(activeArticle, false);
  }, [activeArticle, loadFullArticle]);

  const openArticle = (article: RssArticle) => {
    setActiveArticleId(article.id);
    readerRef.current?.scrollTo?.({ top: 0 });
    if (!readSet.has(article.id)) {
      commitState((prev) => ({
        ...prev,
        readIds: prev.readIds.includes(article.id)
          ? prev.readIds
          : [...prev.readIds, article.id],
      }));
    }
  };

  const toggleRead = (articleId: string) => {
    commitState((prev) => ({
      ...prev,
      readIds: prev.readIds.includes(articleId)
        ? prev.readIds.filter((id) => id !== articleId)
        : [...prev.readIds, articleId],
    }));
  };

  const toggleSaved = (articleId: string) => {
    commitState((prev) => ({
      ...prev,
      savedIds: prev.savedIds.includes(articleId)
        ? prev.savedIds.filter((id) => id !== articleId)
        : [...prev.savedIds, articleId],
    }));
  };

  const markVisibleRead = () => {
    const ids = filteredArticles.map((a) => a.id);
    if (!ids.length) return;
    commitState((prev) => ({
      ...prev,
      readIds: [...new Set([...prev.readIds, ...ids])],
    }));
  };

  const moveFeedByOffset = (feedId: string, delta: -1 | 1) => {
    commitState((prev) => {
      const idx = prev.feeds.findIndex((f) => f.id === feedId);
      const target = idx + delta;
      if (idx < 0 || target < 0 || target >= prev.feeds.length) return prev;
      const next = [...prev.feeds];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return { ...prev, feeds: next };
    });
  };

  const startFeedReorder = (event: ReactPointerEvent<HTMLButtonElement>, feedId: string) => {
    if (event.button !== 0 || stateRef.current.feeds.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startY = event.clientY;
    let moved = false;
    let hint: { id: string; after: boolean } | null = null;
    setDraggingFeedId(feedId);

    const onMove = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!moved && Math.abs(next.clientY - startY) < 4) return;
      moved = true;
      const container = feedListRef.current;
      if (!container) return;
      const rows = [...container.querySelectorAll<HTMLElement>("[data-rss-feed-id]")];
      let picked: { id: string; after: boolean } | null = null;
      for (const row of rows) {
        const rowId = row.dataset.rssFeedId;
        if (!rowId || rowId === feedId) continue;
        const r = row.getBoundingClientRect();
        if (next.clientY <= r.bottom) {
          picked = { id: rowId, after: next.clientY >= r.top + r.height / 2 };
          break;
        }
        picked = { id: rowId, after: true };
      }
      hint = picked;
      setFeedDropHint(picked);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDraggingFeedId(null);
      setFeedDropHint(null);
    };

    const onUp = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const finalHint = hint;
      cleanup();
      if (!moved || !finalHint || finalHint.id === feedId) return;
      commitState((prev) => {
        const fromIdx = prev.feeds.findIndex((f) => f.id === feedId);
        if (fromIdx < 0) return prev;
        const without = prev.feeds.filter((f) => f.id !== feedId);
        const targetIdx = without.findIndex((f) => f.id === finalHint.id);
        if (targetIdx < 0) return prev;
        const insertAt = finalHint.after ? targetIdx + 1 : targetIdx;
        const reordered = [...without];
        reordered.splice(insertAt, 0, prev.feeds[fromIdx]);
        return { ...prev, feeds: reordered };
      });
    };

    const onCancel = (next: PointerEvent) => {
      if (next.pointerId === pointerId) cleanup();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const addStarterFeed = async (starter: StarterFeedSuggestion) => {
    const existing = stateRef.current.feeds.find(
      (f) => f.url.toLowerCase() === starter.url.toLowerCase(),
    );
    if (existing) {
      setSelection(`feed:${existing.id}`);
      return;
    }
    if (stateRef.current.feeds.length >= MAX_RSS_FEEDS) return;
    const newFeed: RssFeed = {
      id: rssId("feed"),
      name: starter.name,
      url: starter.url,
      siteUrl: "",
      feedIconUrl: "",
      icon: starter.icon,
      color: starter.color,
      lastFetchedAt: "",
      lastError: "",
    };
    commitState((prev) => ({ ...prev, feeds: [...prev.feeds, newFeed] }));
    setSelection(`feed:${newFeed.id}`);
    await refreshSingleFeed(newFeed);
  };

  const openAddDialog = () => {
    setDialogError("");
    setDialogBusy(false);
    setDialogDraft(draftFromFeed());
  };

  const openEditDialog = (feed: RssFeed) => {
    setDialogError("");
    setDialogBusy(false);
    setDialogDraft(draftFromFeed(feed));
  };

  const submitFeedDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialogDraft || dialogBusy) return;

    const normalizedUrl = normalizeFeedUrl(dialogDraft.url);
    if (!normalizedUrl) {
      setDialogError("Enter a valid http:// or https:// feed URL.");
      return;
    }

    if (dialogDraft.iconTab === "image" && !isValidCustomIconImageUrl(dialogDraft.imageUrl)) {
      setDialogError("Enter a valid https:// icon URL or upload an image file.");
      return;
    }

    const icon = buildIconFromDraft(dialogDraft);
    const customName = dialogDraft.name.trim().slice(0, 120);

    if (dialogDraft.mode === "edit") {
      const existing = stateRef.current.feeds.find((f) => f.id === dialogDraft.feedId);
      if (!existing) {
        setDialogDraft(null);
        return;
      }
      const finalName = customName || existing.name || hostnameLabel(normalizedUrl);
      const urlChanged = existing.url !== normalizedUrl;
      const updatedFeed: RssFeed = {
        ...existing,
        name: finalName,
        url: normalizedUrl,
        icon,
        color: dialogDraft.color,
        lastError: urlChanged ? "" : existing.lastError,
      };
      commitState((prev) => ({
        ...prev,
        feeds: prev.feeds.map((f) => (f.id === updatedFeed.id ? updatedFeed : f)),
      }));
      setDialogDraft(null);
      if (urlChanged) {
        void refreshSingleFeed(updatedFeed);
      }
      return;
    }

    // Add mode
    if (stateRef.current.feeds.length >= MAX_RSS_FEEDS) {
      setDialogError(`You can store up to ${MAX_RSS_FEEDS} feeds per workspace.`);
      return;
    }
    const duplicate = stateRef.current.feeds.find(
      (f) => f.url.toLowerCase() === normalizedUrl.toLowerCase(),
    );
    if (duplicate) {
      setDialogError(`"${duplicate.name}" already uses this feed URL.`);
      return;
    }

    setDialogBusy(true);
    setDialogError("");
    try {
      let resolvedUrl = normalizedUrl;
      let discoveredTitle = "";
      let siteUrl = "";
      let feedIconUrl = "";
      let initialItems: Omit<RssArticle, "id" | "feedId">[] = [];
      let fetchWarning = "";

      try {
        const parsed = await withTimeout(
          fetchAndParseFeed(normalizedUrl),
          20000,
          "Feed request timed out.",
        );
        resolvedUrl = parsed.feedUrl || normalizedUrl;
        discoveredTitle = parsed.title;
        siteUrl = parsed.siteUrl;
        feedIconUrl = parsed.iconUrl;
        initialItems = parsed.items;
      } catch (err) {
        fetchWarning = rssErrorMessage(err, "Couldn't fetch articles right now.");
      }

      const newFeed: RssFeed = {
        id: rssId("feed"),
        name: customName || discoveredTitle || hostnameLabel(resolvedUrl),
        url: resolvedUrl,
        siteUrl,
        feedIconUrl,
        icon,
        color: dialogDraft.color,
        lastFetchedAt: fetchWarning ? "" : new Date().toISOString(),
        lastError: fetchWarning,
      };

      commitState((prev) => {
        const saved = new Set(prev.savedIds);
        const nextArticles = initialItems.length
          ? mergeFetchedArticles(newFeed.id, prev.articles, initialItems, saved)
          : prev.articles;
        return {
          ...prev,
          feeds: [...prev.feeds, newFeed],
          articles: nextArticles,
        };
      });
      setSelection(`feed:${newFeed.id}`);
      setDialogDraft(null);
      if (fetchWarning) {
        setBannerNotice(`Saved "${newFeed.name}". ${fetchWarning}`);
      }
    } finally {
      setDialogBusy(false);
    }
  };

  const deleteFeed = (feedId: string) => {
    commitState((prev) => {
      const nextFeeds = prev.feeds.filter((f) => f.id !== feedId);
      const nextArticles = prev.articles.filter((a) => a.feedId !== feedId);
      const validIds = new Set(nextArticles.map((a) => a.id));
      return {
        feeds: nextFeeds,
        articles: nextArticles,
        readIds: prev.readIds.filter((id) => validIds.has(id)),
        savedIds: prev.savedIds.filter((id) => validIds.has(id)),
      };
    });
    if (selection === `feed:${feedId}`) {
      setSelection("all");
    }
    setConfirmDeleteId("");
  };

  const handleExportOpml = async () => {
    if (!rssState.feeds.length) return;
    setBannerNotice("");
    try {
      await saveOpmlWithDialog(rssState.feeds, name);
    } catch (err) {
      setBannerNotice(rssErrorMessage(err, "Couldn't export OPML file."));
    }
  };

  const handleImportOpml = async (file: File) => {
    try {
      const text = await file.text();
      const entries = parseOpmlFeeds(text);
      if (!entries.length) {
        setBannerNotice("No RSS/Atom feeds were found in that OPML file.");
        return;
      }
      const existingUrls = new Set(
        stateRef.current.feeds.map((f) => f.url.toLowerCase()),
      );
      const added: RssFeed[] = [];
      for (const entry of entries) {
        if (existingUrls.has(entry.url.toLowerCase())) continue;
        if (stateRef.current.feeds.length + added.length >= MAX_RSS_FEEDS) break;
        existingUrls.add(entry.url.toLowerCase());
        added.push({
          id: rssId("feed"),
          name: entry.name,
          url: entry.url,
          siteUrl: entry.siteUrl,
          feedIconUrl: "",
          icon: {
            kind: "auto",
          },
          color: RSS_ACCENT_COLORS[(stateRef.current.feeds.length + added.length) % RSS_ACCENT_COLORS.length],
          lastFetchedAt: "",
          lastError: "",
        });
      }
      if (!added.length) {
        setBannerNotice("All feeds from that OPML file are already in your list.");
        return;
      }
      commitState((prev) => ({ ...prev, feeds: [...prev.feeds, ...added] }));
      setBannerNotice(`Imported ${added.length} feed${added.length === 1 ? "" : "s"}. Fetching latest articles…`);
      void (async () => {
        const CONCURRENCY = 4;
        for (let i = 0; i < added.length; i += CONCURRENCY) {
          await Promise.allSettled(
            added.slice(i, i + CONCURRENCY).map((f) => refreshSingleFeed(f)),
          );
        }
      })();
    } catch {
      setBannerNotice("Couldn't read that OPML file.");
    }
  };

  const anyRefreshing = refreshingIds.size > 0;
  const activeFeedForArticle = activeArticle ? feedsById.get(activeArticle.feedId) : null;
  const displayedBlocks = useMemo(() => {
    if (!activeArticle) return [];
    if (activeArticle.fullBlocks && activeArticle.fullBlocks.length > 0) {
      return activeArticle.fullBlocks;
    }
    return activeArticle.blocks;
  }, [activeArticle]);
  const isLoadingFullForActive = Boolean(activeArticle && fullLoadingId === activeArticle.id);

  return (
    <section className="calendar-card rss-card" aria-labelledby="rss-title">
      <div className="calendar-heading rss-heading">
        <span className="calendar-heading-icon">
          <Rss size={21} />
        </span>
        <div>
          <span className="section-eyebrow">FOLLOW WHAT MATTERS</span>
          <h1 id="rss-title">RSS</h1>
          <p>Custom feeds for {name}, stored on this device.</p>
        </div>
        <div className="calendar-heading-actions rss-heading-actions">
          <input
            ref={opmlInputRef}
            type="file"
            accept=".opml,.xml,text/xml,application/xml"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void handleImportOpml(file);
            }}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={!ready}
            onClick={() => opmlInputRef.current?.click()}
            title="Import feeds from an OPML file"
          >
            <Upload size={15} /> Import
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!ready || rssState.feeds.length === 0}
            onClick={() => void handleExportOpml()}
            title="Choose where to export feeds as an OPML file"
          >
            <Download size={15} /> Export
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!ready || rssState.feeds.length === 0 || anyRefreshing}
            onClick={() => void refreshAllFeeds()}
            title="Refresh all feeds"
          >
            <RefreshCw size={15} className={anyRefreshing ? "rss-spin" : ""} /> Refresh
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!ready || rssState.feeds.length >= MAX_RSS_FEEDS}
            onClick={openAddDialog}
          >
            <Plus size={16} /> Add feed
          </button>
        </div>
      </div>

      {!ready && (
        <div className="dialog-error" role="alert">
          {initial.status === "invalid"
            ? "This workspace's RSS storage has an unrecognized format. Stored data has not been overwritten."
            : "Local storage isn't available on this device."}
        </div>
      )}

      {bannerNotice && (
        <div className="rss-banner" role="status">
          <span>{bannerNotice}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notice"
            onClick={() => setBannerNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className={`rss-layout${readerExpanded && rssState.feeds.length > 0 ? " is-reader-expanded" : ""}`}>
        {/* Left column: Smart views + Custom Feeds list */}
        <aside className="rss-sidebar" aria-label="RSS feeds">
          <div className="rss-smart-views">
            <button
              type="button"
              className={`rss-nav-row${selection === "all" ? " is-active" : ""}`}
              onClick={() => setSelection("all")}
            >
              <Rss size={15} />
              <span>All entries</span>
              <small>{totalUnread > 0 ? totalUnread : rssState.articles.length}</small>
            </button>
            <button
              type="button"
              className={`rss-nav-row${selection === "unread" ? " is-active" : ""}`}
              onClick={() => setSelection("unread")}
            >
              <CircleDot size={15} />
              <span>Unread</span>
              <small>{totalUnread}</small>
            </button>
            <button
              type="button"
              className={`rss-nav-row${selection === "saved" ? " is-active" : ""}`}
              onClick={() => setSelection("saved")}
            >
              <Bookmark size={15} />
              <span>Saved</span>
              <small>{rssState.savedIds.length}</small>
            </button>
          </div>

          <div className="rss-feeds-header">
            <span>YOUR FEEDS ({rssState.feeds.length})</span>
            <button
              type="button"
              className="icon-button"
              title="Add custom feed"
              aria-label="Add custom feed"
              onClick={openAddDialog}
            >
              <Plus size={15} />
            </button>
          </div>

          <div ref={feedListRef} className="rss-feed-list">
            {rssState.feeds.length === 0 ? (
              <p className="rss-sidebar-empty">
                No feeds yet. Click <strong>Add feed</strong> or pick a starter feed on the right.
              </p>
            ) : (
              rssState.feeds.map((feed) => {
                const isSelected = selection === `feed:${feed.id}`;
                const unread = unreadByFeed.get(feed.id) ?? 0;
                const isSyncing = refreshingIds.has(feed.id);
                return (
                  <div
                    key={feed.id}
                    data-rss-feed-id={feed.id}
                    className={`rss-feed-row${isSelected ? " is-active" : ""}${
                      confirmDeleteId === feed.id ? " is-confirming" : ""
                    }${
                      draggingFeedId === feed.id ? " is-dragging" : ""
                    }${
                      feedDropHint?.id === feed.id
                        ? feedDropHint.after
                          ? " drop-after"
                          : " drop-before"
                        : ""
                    }`}
                  >
                    {rssState.feeds.length > 1 && (
                      <button
                        type="button"
                        className="rss-feed-grip"
                        aria-label={`Reorder ${feed.name}`}
                        title="Drag to reorder (or press Up / Down arrows)"
                        onPointerDown={(e) => startFeedReorder(e, feed.id)}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            moveFeedByOffset(feed.id, -1);
                          } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            moveFeedByOffset(feed.id, 1);
                          }
                        }}
                      >
                        <GripVertical size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="rss-feed-select"
                      onClick={() => {
                        setSelection(`feed:${feed.id}`);
                        setConfirmDeleteId("");
                      }}
                      title={feed.lastError ? `${feed.name} — ${feed.lastError}` : `${feed.name} (${feed.url})`}
                    >
                      <RssFeedAvatar
                        icon={feed.icon}
                        color={feed.color}
                        feedIconUrl={feed.feedIconUrl}
                        siteUrl={feed.siteUrl}
                        feedUrl={feed.url}
                        size="sm"
                      />
                      <span className="rss-feed-name">{feed.name}</span>
                      {feed.lastError && !isSyncing && (
                        <span className="rss-feed-err-dot" title={feed.lastError} aria-label="Sync warning" />
                      )}
                      {isSyncing ? (
                        <RefreshCw size={12} className="rss-spin rss-feed-spinner" />
                      ) : (
                        unread > 0 && <small className="rss-unread-pill">{unread}</small>
                      )}
                    </button>
                    <div className="rss-feed-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Edit ${feed.name}`}
                        title="Edit name, icon & URL"
                        onClick={() => openEditDialog(feed)}
                      >
                        <Pencil size={13} />
                      </button>
                      {confirmDeleteId === feed.id ? (
                        <button
                          type="button"
                          className="rss-confirm-remove"
                          onClick={() => deleteFeed(feed.id)}
                        >
                          Remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove ${feed.name}`}
                          title={`Remove ${feed.name}`}
                          onClick={() => setConfirmDeleteId(feed.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Main Workspace: Onboarding OR Stream + Clean Reader */}
        {rssState.feeds.length === 0 ? (
          <div className="rss-onboarding">
            <div className="rss-onboarding-hero">
              <h2>Build your personal RSS reader</h2>
              <p>
                Subscribe to blogs, news sites, newsletters, YouTube channels, or JSON feeds.
                Every feed can have its own custom name, icon, and color.
              </p>
              <button type="button" className="primary-button" onClick={openAddDialog}>
                <Plus size={16} /> Add custom feed
              </button>
            </div>
            <div className="rss-starter-section">
              <span className="section-eyebrow">QUICK STARTER FEEDS</span>
              <div className="rss-starter-grid">
                {STARTER_RSS_FEEDS.map((starter) => (
                  <div key={starter.url} className="rss-starter-card">
                    <RssFeedAvatar
                      icon={starter.icon}
                      color={starter.color}
                      feedUrl={starter.url}
                      size="md"
                    />
                    <div className="rss-starter-info">
                      <strong>{starter.name}</strong>
                      <span>{starter.description}</span>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void addStarterFeed(starter)}
                    >
                      <Plus size={14} /> Add
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="rss-workspace">
            {/* Middle column: Search + Filter + Article list */}
            <div className="rss-stream">
              <div className="rss-stream-header">
                {selectedFeed ? (
                  <div className="rss-selected-feed-bar">
                    <RssFeedAvatar
                      icon={selectedFeed.icon}
                      color={selectedFeed.color}
                      feedIconUrl={selectedFeed.feedIconUrl}
                      siteUrl={selectedFeed.siteUrl}
                      feedUrl={selectedFeed.url}
                      size="sm"
                    />
                    <strong>{selectedFeed.name}</strong>
                    <button
                      type="button"
                      className="icon-button"
                      title="Edit feed name, icon & URL"
                      aria-label={`Customize ${selectedFeed.name}`}
                      onClick={() => openEditDialog(selectedFeed)}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title="Refresh this feed"
                      aria-label={`Refresh ${selectedFeed.name}`}
                      disabled={refreshingIds.has(selectedFeed.id)}
                      onClick={() => void refreshSingleFeed(selectedFeed)}
                    >
                      <RefreshCw
                        size={14}
                        className={refreshingIds.has(selectedFeed.id) ? "rss-spin" : ""}
                      />
                    </button>
                  </div>
                ) : (
                  <strong className="rss-stream-title">
                    {selection === "unread"
                      ? "Unread"
                      : selection === "saved"
                        ? "Saved"
                        : "All entries"}
                  </strong>
                )}
                <button
                  type="button"
                  className="rss-mark-read-btn"
                  disabled={filteredArticles.every((a) => readSet.has(a.id))}
                  onClick={markVisibleRead}
                  title="Mark visible articles as read"
                >
                  <Check size={13} /> Mark read
                </button>
              </div>

              <div className="rss-stream-controls">
                <div className="rss-search-box">
                  <Search size={14} />
                  <input
                    type="search"
                    placeholder="Filter articles…"
                    aria-label="Filter articles"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <div className="rss-filter-pills" role="tablist" aria-label="Article status filter">
                  {(["all", "unread", "saved"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={statusFilter === tab}
                      className={statusFilter === tab ? "is-active" : ""}
                      onClick={() => setStatusFilter(tab)}
                    >
                      {tab === "all" ? "All" : tab === "unread" ? "Unread" : "Saved"}
                    </button>
                  ))}
                </div>
              </div>

              {selectedFeed?.lastError && (
                <div className="rss-feed-error-card" role="status">
                  <span>{selectedFeed.lastError}</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void refreshSingleFeed(selectedFeed)}
                  >
                    Retry
                  </button>
                </div>
              )}

              <div className="rss-article-list">
                {filteredArticles.length === 0 ? (
                  <div className="rss-empty-stream">
                    <p>No matching articles right now.</p>
                    {selectedFeed && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={refreshingIds.has(selectedFeed.id)}
                        onClick={() => void refreshSingleFeed(selectedFeed)}
                      >
                        <RefreshCw size={14} /> Fetch latest
                      </button>
                    )}
                  </div>
                ) : (
                  filteredArticles.map((article) => {
                    const feed = feedsById.get(article.feedId);
                    const isUnread = !readSet.has(article.id);
                    const isSaved = savedSet.has(article.id);
                    const isActive = activeArticle?.id === article.id;
                    const metaSubline = [
                      article.url ? hostnameLabel(article.url) : "",
                      article.points !== undefined ? `${article.points} pts` : "",
                      article.commentCount !== undefined ? `${article.commentCount} comments` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <button
                        key={article.id}
                        type="button"
                        className={`rss-article-item${isActive ? " is-active" : ""}${
                          isUnread ? " is-unread" : ""
                        }`}
                        onClick={() => openArticle(article)}
                      >
                        <div className="rss-article-item-meta">
                          {feed && (
                            <span className="rss-article-source">
                              <RssFeedAvatar
                                icon={feed.icon}
                                color={feed.color}
                                feedIconUrl={feed.feedIconUrl}
                                siteUrl={feed.siteUrl}
                                feedUrl={feed.url}
                                size="sm"
                              />
                              <span>{feed.name}</span>
                            </span>
                          )}
                          <span className="rss-article-date">
                            {isSaved && <Bookmark size={11} className="rss-saved-badge" />}
                            {isUnread && <span className="rss-unread-dot" aria-label="Unread" />}
                            {formatRelativeDate(article.publishedAt)}
                          </span>
                        </div>
                        <strong className="rss-article-item-title">{article.title}</strong>
                        {article.summary ? (
                          <p className="rss-article-item-excerpt">{article.summary}</p>
                        ) : metaSubline ? (
                          <p className="rss-article-item-excerpt">{metaSubline}</p>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right column: Clean built-in Article Reader */}
            <article ref={readerRef} className="rss-reader" aria-label="Article reader">
              {!activeArticle ? (
                <div className="rss-reader-empty">
                  <Rss size={28} />
                  <p>Select an article from the list to read it cleanly here.</p>
                </div>
              ) : (
                <>
                  <header className="rss-reader-header">
                    <div className="rss-reader-toolbar">
                      {activeFeedForArticle && (
                        <div className="rss-reader-feed-chip">
                          <RssFeedAvatar
                            icon={activeFeedForArticle.icon}
                            color={activeFeedForArticle.color}
                            feedIconUrl={activeFeedForArticle.feedIconUrl}
                            siteUrl={activeFeedForArticle.siteUrl}
                            feedUrl={activeFeedForArticle.url}
                            size="sm"
                          />
                          <span>{activeFeedForArticle.name}</span>
                        </div>
                      )}
                      <div className="rss-reader-actions">
                        <button
                          type="button"
                          className={`icon-button rss-expand-reader-btn${readerExpanded ? " active" : ""}`}
                          onClick={() => setReaderExpanded((v) => !v)}
                          aria-label={readerExpanded ? "Show feed list" : "Expand article reader"}
                          title={readerExpanded ? "Show feed list" : "Expand article reader"}
                        >
                          {readerExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => toggleRead(activeArticle.id)}
                          title={
                            readSet.has(activeArticle.id) ? "Mark as unread" : "Mark as read"
                          }
                        >
                          <CircleDot size={14} />{" "}
                          {readSet.has(activeArticle.id) ? "Unread" : "Read"}
                        </button>
                        <button
                          type="button"
                          className={`secondary-button${
                            savedSet.has(activeArticle.id) ? " is-saved" : ""
                          }`}
                          onClick={() => toggleSaved(activeArticle.id)}
                          title={
                            savedSet.has(activeArticle.id)
                              ? "Remove from saved"
                              : "Save article"
                          }
                        >
                          <Bookmark size={14} />{" "}
                          {savedSet.has(activeArticle.id) ? "Saved" : "Save"}
                        </button>
                        {activeArticle.url && (
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => openExternalWebUrl(activeArticle.url)}
                          >
                            <ExternalLink size={14} /> Open original
                          </button>
                        )}
                      </div>
                    </div>

                    <h2 className="rss-reader-title">{activeArticle.title}</h2>
                    <div className="rss-reader-byline">
                      {activeArticle.author && <span>By {activeArticle.author}</span>}
                      {activeArticle.publishedAt && (
                        <span>{formatRelativeDate(activeArticle.publishedAt)}</span>
                      )}
                      {activeArticle.url && (
                        <span>{hostnameLabel(activeArticle.url)}</span>
                      )}
                      {activeArticle.points !== undefined && (
                        <span>{activeArticle.points} points</span>
                      )}
                      {activeArticle.categories.length > 0 && (
                        <span className="rss-reader-tags">
                          {activeArticle.categories.slice(0, 4).map((cat) => (
                            <em key={cat}>{cat}</em>
                          ))}
                        </span>
                      )}
                    </div>
                  </header>

                  <div className="rss-reader-body">
                    {activeArticle.imageUrl &&
                      !displayedBlocks.some(
                        (b) =>
                          b.kind === "image" &&
                          (b.url === activeArticle.imageUrl ||
                            b.altUrl === activeArticle.imageUrl),
                      ) && (
                        <RssReaderImage
                          className="rss-reader-hero-img"
                          src={activeArticle.imageUrl}
                          articleUrl={activeArticle.url}
                          alt=""
                        />
                      )}
                    {isLoadingFullForActive && displayedBlocks.length > 0 && (
                      <p className="rss-reader-muted">
                        <RefreshCw size={13} className="rss-spin" /> Loading full post from{" "}
                        {hostnameLabel(activeArticle.url)}…
                      </p>
                    )}
                    {fullLoadError && displayedBlocks.length > 0 && (
                      <p className="rss-reader-muted">{fullLoadError}</p>
                    )}
                    {displayedBlocks.length > 0 ? (
                      displayedBlocks.map((block, idx) => {
                        if (block.kind === "heading") {
                          return block.level === 2 ? (
                            <h3 key={idx}>{block.text}</h3>
                          ) : (
                            <h4 key={idx}>{block.text}</h4>
                          );
                        }
                        if (block.kind === "quote") {
                          return <blockquote key={idx}>{block.text}</blockquote>;
                        }
                        if (block.kind === "code") {
                          return (
                            <pre key={idx}>
                              <code>{block.text}</code>
                            </pre>
                          );
                        }
                        if (block.kind === "list") {
                          return block.ordered ? (
                            <ol key={idx}>
                              {block.items.map((it, i) => (
                                <li key={i}>{it}</li>
                              ))}
                            </ol>
                          ) : (
                            <ul key={idx}>
                              {block.items.map((it, i) => (
                                <li key={i}>{it}</li>
                              ))}
                            </ul>
                          );
                        }
                        if (block.kind === "table") {
                          return (
                            <div key={idx} className="rss-table-wrap">
                              <table className="rss-reader-table">
                                {block.headers.length > 0 && (
                                  <thead>
                                    <tr>
                                      {block.headers.map((h, hi) => (
                                        <th key={hi}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                )}
                                <tbody>
                                  {block.rows.map((row, ri) => (
                                    <tr key={ri}>
                                      {row.map((cell, ci) => (
                                        <td key={ci}>{cell}</td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          );
                        }
                        if (block.kind === "image") {
                          return (
                            <RssReaderImage
                              key={idx}
                              src={block.url}
                              altUrl={block.altUrl}
                              articleUrl={activeArticle.url}
                              alt={block.alt}
                              caption={block.caption}
                              asFigure
                            />
                          );
                        }
                        return <p key={idx}>{block.text}</p>;
                      })
                    ) : isLoadingFullForActive ? (
                      <p className="rss-reader-muted">
                        <RefreshCw size={13} className="rss-spin" /> Loading full post from{" "}
                        {hostnameLabel(activeArticle.url)}…
                      </p>
                    ) : activeArticle.summary ? (
                      <p>{activeArticle.summary}</p>
                    ) : (
                      <div className="rss-reader-fallback">
                        <p className="rss-reader-muted">
                          {fullLoadError || (
                            <>
                              This entry links directly to an external page. Click{" "}
                              <strong>Open original</strong> above to view it in your browser.
                            </>
                          )}
                        </p>
                        {activeArticle.url && (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void loadFullArticle(activeArticle, true)}
                          >
                            <RefreshCw size={13} /> Retry loading article
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </article>
          </div>
        )}
      </div>

      {/* Add / Edit Custom Feed Modal (Name + URL + Icon + Color) */}
      {dialogDraft && (
        <div
          className="modal-backdrop"
          onMouseDown={() => !dialogBusy && setDialogDraft(null)}
        >
          <form
            className="modal rss-feed-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rss-modal-title"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => void submitFeedDialog(e)}
          >
            <div className="modal-icon">
              <RssFeedAvatar
                icon={buildIconFromDraft(dialogDraft)}
                color={dialogDraft.color}
                feedUrl={dialogDraft.url}
                size="lg"
              />
            </div>
            <button
              type="button"
              className="modal-close icon-button"
              aria-label="Close feed dialog"
              disabled={dialogBusy}
              onClick={() => setDialogDraft(null)}
            >
              <X size={18} />
            </button>
            <h2 id="rss-modal-title">
              {dialogDraft.mode === "add" ? "Add RSS feed" : "Customize feed"}
            </h2>
            <p>
              {dialogDraft.mode === "add"
                ? "Paste an RSS, Atom, JSON Feed, or site URL. Customize its display name and icon anytime."
                : "Edit this feed's display name, feed URL, custom icon, and accent color."}
            </p>

            <label className="modal-label" htmlFor="rss-feed-url">
              Feed or website URL
            </label>
            <input
              id="rss-feed-url"
              type="text"
              autoFocus={dialogDraft.mode === "add"}
              placeholder="https://example.com/feed.xml"
              value={dialogDraft.url}
              onChange={(e) => {
                const url = e.target.value;
                setDialogDraft((curr) => (curr ? { ...curr, url } : curr));
                setDialogError("");
              }}
            />

            <label className="modal-label" htmlFor="rss-feed-name">
              Custom display name{" "}
              {dialogDraft.mode === "add" && (
                <span className="rss-optional-hint">(optional — auto-detected if blank)</span>
              )}
            </label>
            <input
              id="rss-feed-name"
              type="text"
              maxLength={120}
              autoFocus={dialogDraft.mode === "edit"}
              placeholder="e.g. Morning Tech Digest"
              value={dialogDraft.name}
              onChange={(e) => {
                const nextName = e.target.value;
                setDialogDraft((curr) => (curr ? { ...curr, name: nextName } : curr));
                setDialogError("");
              }}
            />

            <label className="modal-label">Feed icon</label>
            <div className="rss-icon-mode-tabs" role="tablist" aria-label="Feed icon type">
              {(
                [
                  ["auto", "Site icon"],
                  ["preset", "Icon"],
                  ["emoji", "Emoji"],
                  ["image", "Custom image"],
                ] as const
              ).map(([tabId, label]) => (
                <button
                  key={tabId}
                  type="button"
                  role="tab"
                  aria-selected={dialogDraft.iconTab === tabId}
                  className={dialogDraft.iconTab === tabId ? "is-active" : ""}
                  onClick={() => {
                    setDialogDraft((curr) => (curr ? { ...curr, iconTab: tabId } : curr));
                    setDialogError("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {dialogDraft.iconTab === "preset" && (
              <div className="rss-preset-grid" aria-label="Preset icons">
                {RSS_ICON_PRESETS.map((preset) => {
                  const IconComp = PRESET_ICON_MAP[preset];
                  return (
                    <button
                      key={preset}
                      type="button"
                      aria-label={`Use ${preset} icon`}
                      aria-pressed={dialogDraft.preset === preset}
                      className={dialogDraft.preset === preset ? "is-selected" : ""}
                      onClick={() =>
                        setDialogDraft((curr) => (curr ? { ...curr, preset } : curr))
                      }
                    >
                      <IconComp size={16} />
                    </button>
                  );
                })}
              </div>
            )}

            {dialogDraft.iconTab === "emoji" && (
              <div className="rss-emoji-picker">
                <input
                  type="text"
                  maxLength={10}
                  aria-label="Custom emoji or initials"
                  placeholder="e.g. 🦀 or HN"
                  value={dialogDraft.emoji}
                  onChange={(e) => {
                    const emoji = e.target.value;
                    setDialogDraft((curr) => (curr ? { ...curr, emoji } : curr));
                  }}
                />
                <div className="workspace-icon-options">
                  {QUICK_EMOJIS.map((em) => (
                    <button
                      key={em}
                      type="button"
                      aria-label={`Use ${em}`}
                      aria-pressed={dialogDraft.emoji === em}
                      onClick={() =>
                        setDialogDraft((curr) => (curr ? { ...curr, emoji: em } : curr))
                      }
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {dialogDraft.iconTab === "image" && (
              <div className="rss-custom-image-picker">
                <input
                  ref={iconUploadRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (!file) return;
                    void resizeIconFileToDataUrl(file)
                      .then((dataUrl) => {
                        setDialogDraft((curr) =>
                          curr ? { ...curr, imageUrl: dataUrl } : curr,
                        );
                        setDialogError("");
                      })
                      .catch((err) =>
                        setDialogError(rssErrorMessage(err, "Couldn't read icon image.")),
                      );
                  }}
                />
                <div className="rss-custom-image-row">
                  <input
                    type="text"
                    aria-label="Custom icon image URL"
                    placeholder="https://example.com/icon.png"
                    value={
                      dialogDraft.imageUrl.startsWith("data:")
                        ? ""
                        : dialogDraft.imageUrl
                    }
                    onChange={(e) => {
                      const imageUrl = e.target.value;
                      setDialogDraft((curr) => (curr ? { ...curr, imageUrl } : curr));
                      setDialogError("");
                    }}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => iconUploadRef.current?.click()}
                  >
                    <ImagePlus size={15} /> Upload image
                  </button>
                </div>
                {dialogDraft.imageUrl.startsWith("data:") && (
                  <small className="rss-uploaded-note">
                    Uploaded custom icon ready ·{" "}
                    <button
                      type="button"
                      className="rss-inline-clear"
                      onClick={() =>
                        setDialogDraft((curr) => (curr ? { ...curr, imageUrl: "" } : curr))
                      }
                    >
                      Clear
                    </button>
                  </small>
                )}
              </div>
            )}

            <label className="modal-label">Accent color</label>
            <div className="rss-color-swatches">
              {RSS_ACCENT_COLORS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  aria-label={`Color ${hex}`}
                  aria-pressed={dialogDraft.color === hex}
                  className={`rss-color-swatch${
                    dialogDraft.color === hex ? " is-selected" : ""
                  }`}
                  style={{ "--swatch-color": hex } as CSSProperties}
                  onClick={() =>
                    setDialogDraft((curr) => (curr ? { ...curr, color: hex } : curr))
                  }
                />
              ))}
            </div>

            {dialogError && (
              <div className="dialog-error" role="alert">
                {dialogError}
              </div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={dialogBusy}
                onClick={() => setDialogDraft(null)}
              >
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={dialogBusy}>
                {dialogBusy
                  ? "Adding…"
                  : dialogDraft.mode === "add"
                    ? "Add feed"
                    : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
