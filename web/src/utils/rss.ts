import { invoke } from "@tauri-apps/api/core";
import { normalizePath } from "./vault";

export const RSS_ICON_PRESETS = [
  "rss",
  "newspaper",
  "globe",
  "code",
  "cpu",
  "sparkles",
  "terminal",
  "book",
  "headphones",
  "film",
  "flame",
  "compass",
  "feather",
  "layers",
  "zap",
  "gamepad",
] as const;

export type RssIconPreset = (typeof RSS_ICON_PRESETS)[number];

export const RSS_ACCENT_COLORS = [
  "#e6a17f",
  "#d97757",
  "#e5b567",
  "#7fb08a",
  "#68a8ad",
  "#7aa2f7",
  "#9d86e9",
  "#d3869b",
] as const;

export type RssFeedIcon =
  | { kind: "auto" }
  | { kind: "preset"; preset: RssIconPreset }
  | { kind: "emoji"; value: string }
  | { kind: "image"; url: string };

export interface RssFeed {
  id: string;
  name: string;
  url: string;
  siteUrl: string;
  feedIconUrl: string;
  icon: RssFeedIcon;
  color: string;
  lastFetchedAt: string;
  lastError: string;
}

export type RssReaderBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "image"; url: string; altUrl?: string; alt: string; caption?: string };

export const CURRENT_EXTRACTOR_VERSION = 3;

export interface RssArticle {
  id: string;
  feedId: string;
  guid: string;
  title: string;
  url: string;
  commentsUrl?: string;
  points?: number;
  commentCount?: number;
  author: string;
  publishedAt: string;
  summary: string;
  blocks: RssReaderBlock[];
  fullBlocks?: RssReaderBlock[];
  extractorVersion?: number;
  imageUrl: string;
  categories: string[];
}

export interface RssState {
  feeds: RssFeed[];
  articles: RssArticle[];
  readIds: string[];
  savedIds: string[];
}

interface RssDocument extends RssState {
  format: "comet-rss";
  version: 1;
}

export type RssReadResult =
  | { status: "ready"; state: RssState }
  | { status: "unavailable" | "invalid"; state: RssState };

export interface ParsedFeedResult {
  title: string;
  siteUrl: string;
  feedUrl: string;
  iconUrl: string;
  items: Omit<RssArticle, "id" | "feedId">[];
}

export interface StarterFeedSuggestion {
  name: string;
  url: string;
  description: string;
  icon: RssFeedIcon;
  color: string;
}

export const STARTER_RSS_FEEDS: StarterFeedSuggestion[] = [
  {
    name: "Hacker News",
    url: "https://hnrss.org/frontpage",
    description: "Top stories & discussions from Hacker News",
    icon: { kind: "preset", preset: "flame" },
    color: "#e6a17f",
  },
  {
    name: "The Verge",
    url: "https://www.theverge.com/rss/index.xml",
    description: "Technology, science, art & digital culture",
    icon: { kind: "preset", preset: "newspaper" },
    color: "#9d86e9",
  },
  {
    name: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    description: "In-depth technology, science & policy reporting",
    icon: { kind: "preset", preset: "cpu" },
    color: "#d97757",
  },
  {
    name: "NASA Breaking News",
    url: "https://www.nasa.gov/news-release/feed/",
    description: "Space missions, discoveries & science updates",
    icon: { kind: "preset", preset: "sparkles" },
    color: "#7aa2f7",
  },
  {
    name: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    description: "International news & global headlines",
    icon: { kind: "preset", preset: "globe" },
    color: "#68a8ad",
  },
];

export const MAX_RSS_FEEDS = 100;
export const MAX_ITEMS_PER_FEED = 50;
const MAX_CUSTOM_ICON_DATA_URL = 64 * 1024;
const PREFIX = "comet:rss:v1:";

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const keyFor = (vault: string) => `${PREFIX}${encodeURIComponent(normalizePath(vault))}`;

export function rssErrorMessage(err: unknown, fallback = "Couldn't refresh feed."): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return fallback;
}

export function emptyRssState(): RssState {
  return { feeds: [], articles: [], readIds: [], savedIds: [] };
}

export function rssId(prefix = "rss"): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function normalizeFeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const withScheme = /^feed:https?:\/\//i.test(trimmed)
    ? trimmed.replace(/^feed:/i, "")
    : /^feed:\/\//i.test(trimmed)
      ? `https://${trimmed.slice("feed://".length)}`
      : /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : trimmed.includes(".") && !/\s/.test(trimmed)
          ? `https://${trimmed}`
          : "";
  if (!withScheme) return null;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || !parsed.hostname.includes(".")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function safeExternalHttpUrl(raw: string, baseUrl?: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /^data:|^javascript:|^blob:|^about:/i.test(trimmed)) return "";
  try {
    const parsed = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function isValidCustomIconImageUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(trimmed)) {
    return trimmed.length <= MAX_CUSTOM_ICON_DATA_URL;
  }
  return Boolean(safeExternalHttpUrl(trimmed));
}

export function sanitizeFeedIcon(value: unknown): RssFeedIcon {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "auto" };
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind === "preset" && typeof obj.preset === "string") {
    if ((RSS_ICON_PRESETS as readonly string[]).includes(obj.preset)) {
      return { kind: "preset", preset: obj.preset as RssIconPreset };
    }
  }
  if (obj.kind === "emoji" && typeof obj.value === "string") {
    const chars = [...obj.value.trim()].slice(0, 6).join("");
    if (chars) return { kind: "emoji", value: chars };
  }
  if (obj.kind === "image" && typeof obj.url === "string" && isValidCustomIconImageUrl(obj.url)) {
    return { kind: "image", url: obj.url.trim() };
  }
  return { kind: "auto" };
}

export function sanitizeAccentColor(value: unknown): string {
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return RSS_ACCENT_COLORS[0];
}

export function faviconForSite(siteOrFeedUrl: string): string {
  try {
    const parsed = new URL(siteOrFeedUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function sanitizeReaderBlocks(value: unknown, maxBlocks = 260): RssReaderBlock[] {
  if (!Array.isArray(value)) return [];
  const out: RssReaderBlock[] = [];
  for (const raw of value.slice(0, maxBlocks)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const b = raw as Record<string, unknown>;
    if (b.kind === "paragraph" && typeof b.text === "string" && b.text.trim()) {
      out.push({ kind: "paragraph", text: b.text.slice(0, 6000) });
    } else if (
      b.kind === "heading" &&
      (b.level === 2 || b.level === 3) &&
      typeof b.text === "string" &&
      b.text.trim()
    ) {
      out.push({ kind: "heading", level: b.level, text: b.text.slice(0, 500) });
    } else if (b.kind === "quote" && typeof b.text === "string" && b.text.trim()) {
      out.push({ kind: "quote", text: b.text.slice(0, 3000) });
    } else if (b.kind === "code" && typeof b.text === "string" && b.text.trim()) {
      out.push({ kind: "code", text: b.text.slice(0, 12000) });
    } else if (b.kind === "list" && Array.isArray(b.items)) {
      const items = b.items
        .filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
        .slice(0, 60)
        .map((x) => x.slice(0, 1500));
      if (items.length) out.push({ kind: "list", ordered: Boolean(b.ordered), items });
    } else if (b.kind === "table" && Array.isArray(b.rows)) {
      const headers = Array.isArray(b.headers)
        ? b.headers
            .slice(0, 24)
            .map((h) => (typeof h === "string" ? h.slice(0, 400) : ""))
        : [];
      const rows = b.rows
        .filter((r): r is unknown[] => Array.isArray(r))
        .slice(0, 150)
        .map((r) => r.slice(0, 24).map((c) => (typeof c === "string" ? c.slice(0, 800) : "")));
      if (rows.length > 0 || headers.some(Boolean)) {
        out.push({ kind: "table", headers, rows });
      }
    } else if (b.kind === "image" && typeof b.url === "string") {
      const safe = safeExternalHttpUrl(b.url);
      const safeAlt =
        typeof b.altUrl === "string" ? safeExternalHttpUrl(b.altUrl) : "";
      if (safe) {
        const safeCaption =
          typeof b.caption === "string" ? b.caption.trim().slice(0, 240) : "";
        out.push({
          kind: "image",
          url: safe,
          ...(safeAlt && safeAlt !== safe ? { altUrl: safeAlt } : {}),
          alt: typeof b.alt === "string" ? b.alt.slice(0, 240) : "",
          ...(safeCaption ? { caption: safeCaption } : {}),
        });
      }
    }
  }
  return out;
}

export function readRssState(vault: string, store: Store | undefined = storage()): RssReadResult {
  try {
    if (!store) return { status: "unavailable", state: emptyRssState() };
    const raw = store.getItem(keyFor(vault));
    if (raw === null) return { status: "ready", state: emptyRssState() };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "invalid", state: emptyRssState() };
    }
    const doc = parsed as Partial<RssDocument>;
    if (doc.format !== "comet-rss" || doc.version !== 1 || !Array.isArray(doc.feeds)) {
      return { status: "invalid", state: emptyRssState() };
    }
    const seenFeedIds = new Set<string>();
    const feeds: RssFeed[] = [];
    for (const item of doc.feeds.slice(0, MAX_RSS_FEEDS)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const f = item as unknown as Record<string, unknown>;
      const id = typeof f.id === "string" ? f.id.trim().slice(0, 120) : "";
      const url = typeof f.url === "string" ? normalizeFeedUrl(f.url) : null;
      const name = typeof f.name === "string" ? f.name.trim().slice(0, 120) : "";
      if (!id || !url || !name || seenFeedIds.has(id)) continue;
      seenFeedIds.add(id);
      feeds.push({
        id,
        name,
        url,
        siteUrl: typeof f.siteUrl === "string" ? safeExternalHttpUrl(f.siteUrl) : "",
        feedIconUrl: typeof f.feedIconUrl === "string" ? safeExternalHttpUrl(f.feedIconUrl) : "",
        icon: sanitizeFeedIcon(f.icon),
        color: sanitizeAccentColor(f.color),
        lastFetchedAt: typeof f.lastFetchedAt === "string" ? f.lastFetchedAt.slice(0, 60) : "",
        lastError: typeof f.lastError === "string" ? f.lastError.slice(0, 280) : "",
      });
    }

    const articles: RssArticle[] = [];
    const seenArticleIds = new Set<string>();
    if (Array.isArray(doc.articles)) {
      for (const rawArt of doc.articles.slice(0, MAX_RSS_FEEDS * MAX_ITEMS_PER_FEED)) {
        if (!rawArt || typeof rawArt !== "object" || Array.isArray(rawArt)) continue;
        const a = rawArt as unknown as Record<string, unknown>;
        const id = typeof a.id === "string" ? a.id.trim().slice(0, 320) : "";
        const feedId = typeof a.feedId === "string" ? a.feedId.trim() : "";
        const title = typeof a.title === "string" ? a.title.trim().slice(0, 320) : "";
        if (!id || !feedId || !seenFeedIds.has(feedId) || !title || seenArticleIds.has(id)) continue;
        seenArticleIds.add(id);
        const storedVersion =
          typeof a.extractorVersion === "number" ? a.extractorVersion : 0;
        // Discard stale v1 fullBlocks so articles re-extract cleanly with v2 (tables, images, metadata cleanup)
        const fullBlocks =
          storedVersion === CURRENT_EXTRACTOR_VERSION && Array.isArray(a.fullBlocks)
            ? sanitizeReaderBlocks(a.fullBlocks, 280)
            : undefined;
        const rawBlocks = sanitizeReaderBlocks(a.blocks, 260);
        let cleanedUrl = typeof a.url === "string" ? safeExternalHttpUrl(a.url) : "";
        let cleanedCommentsUrl =
          typeof a.commentsUrl === "string" && safeExternalHttpUrl(a.commentsUrl)
            ? safeExternalHttpUrl(a.commentsUrl)
            : undefined;
        let cleanedPoints =
          typeof a.points === "number" && Number.isFinite(a.points) ? a.points : undefined;
        let cleanedCommentCount =
          typeof a.commentCount === "number" && Number.isFinite(a.commentCount)
            ? a.commentCount
            : undefined;
        let cleanedSummary = typeof a.summary === "string" ? a.summary.slice(0, 1200) : "";

        const isLegacyAggregatorStub =
          rawBlocks.length > 0 &&
          rawBlocks.length <= 6 &&
          rawBlocks.some(
            (b) => b.kind === "paragraph" && /^Comments\s*URL\s*:/i.test(b.text.trim()),
          );
        const filteredBlocks = isLegacyAggregatorStub
          ? rawBlocks.filter((b) => {
              if (b.kind !== "paragraph") return true;
              const t = b.text.trim();
              const artMatch = /^Article\s*URL\s*:\s*(https?:\/\/\S+)/i.exec(t);
              if (artMatch) {
                const u = safeExternalHttpUrl(artMatch[1]);
                if (u) cleanedUrl = u;
                return false;
              }
              const cmtMatch = /^Comments\s*URL\s*:\s*(https?:\/\/\S+)/i.exec(t);
              if (cmtMatch) {
                const u = safeExternalHttpUrl(cmtMatch[1]);
                if (u) cleanedCommentsUrl = u;
                return false;
              }
              const ptsMatch = /^Points\s*:\s*(\d+)/i.exec(t);
              if (ptsMatch) {
                cleanedPoints = Number(ptsMatch[1]);
                return false;
              }
              const cntMatch = /^#?\s*Comments\s*:\s*(\d+)/i.exec(t);
              if (cntMatch) {
                cleanedCommentCount = Number(cntMatch[1]);
                return false;
              }
              return true;
            })
          : rawBlocks;
        if (isLegacyAggregatorStub && /^Article\s*URL\s*:/i.test(cleanedSummary.trim())) {
          cleanedSummary = "";
        }

        articles.push({
          id,
          feedId,
          guid: typeof a.guid === "string" ? a.guid.slice(0, 300) : id,
          title,
          url: cleanedUrl,
          commentsUrl: cleanedCommentsUrl,
          points: cleanedPoints,
          commentCount: cleanedCommentCount,
          author: typeof a.author === "string" ? a.author.slice(0, 140) : "",
          publishedAt: typeof a.publishedAt === "string" ? a.publishedAt.slice(0, 60) : "",
          summary: cleanedSummary,
          blocks: filteredBlocks,
          ...(fullBlocks && fullBlocks.length > 0
            ? { fullBlocks, extractorVersion: CURRENT_EXTRACTOR_VERSION }
            : {}),
          imageUrl: typeof a.imageUrl === "string" ? safeExternalHttpUrl(a.imageUrl) : "",
          categories: Array.isArray(a.categories)
            ? a.categories
                .filter((c): c is string => typeof c === "string" && Boolean(c.trim()))
                .slice(0, 8)
                .map((c) => c.slice(0, 60))
            : [],
        });
      }
    }

    const readIds = Array.isArray(doc.readIds)
      ? [...new Set(doc.readIds.filter((x): x is string => typeof x === "string" && Boolean(x)))].slice(
          0,
          8000,
        )
      : [];
    const savedIds = Array.isArray(doc.savedIds)
      ? [...new Set(doc.savedIds.filter((x): x is string => typeof x === "string" && Boolean(x)))].slice(
          0,
          2000,
        )
      : [];

    return { status: "ready", state: { feeds, articles, readIds, savedIds } };
  } catch (error) {
    return {
      status: error instanceof SyntaxError ? "invalid" : "unavailable",
      state: emptyRssState(),
    };
  }
}

export function pruneArticlesForStorage(
  feeds: RssFeed[],
  articles: RssArticle[],
  savedIds: Set<string>,
): RssArticle[] {
  const validFeeds = new Set(feeds.map((f) => f.id));
  const grouped = new Map<string, RssArticle[]>();
  for (const art of articles) {
    if (!validFeeds.has(art.feedId)) continue;
    const list = grouped.get(art.feedId) ?? [];
    list.push(art);
    grouped.set(art.feedId, list);
  }
  const kept: RssArticle[] = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => compareArticleDates(b.publishedAt, a.publishedAt));
    let nonSavedCount = 0;
    for (const item of list) {
      if (savedIds.has(item.id)) {
        kept.push(item);
      } else if (nonSavedCount < MAX_ITEMS_PER_FEED) {
        kept.push(item);
        nonSavedCount += 1;
      }
    }
  }
  kept.sort((a, b) => compareArticleDates(b.publishedAt, a.publishedAt));
  return kept;
}

export function saveRssState(
  vault: string,
  state: RssState,
  store: Store | undefined = storage(),
): boolean {
  try {
    if (!store || state.feeds.length > MAX_RSS_FEEDS) return false;
    const current = readRssState(vault, store);
    if (current.status === "invalid") return false;
    const savedSet = new Set(state.savedIds);
    const prunedArticles = pruneArticlesForStorage(state.feeds, state.articles, savedSet);
    const activeIds = new Set(prunedArticles.map((a) => a.id));
    const doc: RssDocument = {
      format: "comet-rss",
      version: 1,
      feeds: state.feeds.slice(0, MAX_RSS_FEEDS),
      articles: prunedArticles,
      readIds: state.readIds.filter((id) => activeIds.has(id) || savedSet.has(id)).slice(0, 8000),
      savedIds: state.savedIds.filter((id) => activeIds.has(id)).slice(0, 2000),
    };
    store.setItem(keyFor(vault), JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

export function compareArticleDates(a: string, b: string): number {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  const na = Number.isFinite(ta) ? ta : 0;
  const nb = Number.isFinite(tb) ? tb : 0;
  return na - nb;
}

function normalizeDateString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) return new Date(ts).toISOString();
  return "";
}

function decodeHtmlText(raw: string): string {
  if (!raw) return "";
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(`<!doctype html><body>${raw}</body>`, "text/html");
      return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
    } catch {
      // Fall through to entity decode
    }
  }
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface AggregatorMetadata {
  isStub: boolean;
  articleUrl: string;
  commentsUrl: string;
  points?: number;
  commentCount?: number;
  remainingHtml: string;
}

export function parseAggregatorMetadata(rawHtml: string, baseUrl?: string): AggregatorMetadata {
  const trimmed = rawHtml.trim();
  if (!trimmed || !/Comments\s*URL\s*:|news\.ycombinator\.com\/item\?id=/i.test(trimmed)) {
    return { isStub: false, articleUrl: "", commentsUrl: "", remainingHtml: rawHtml };
  }

  let articleUrl = "";
  let commentsUrl = "";
  let points: number | undefined;
  let commentCount: number | undefined;

  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${trimmed}</body>`, "text/html");
    const paragraphs = [...doc.body.querySelectorAll("p")];
    for (const p of paragraphs) {
      const txt = (p.textContent ?? "").replace(/\s+/g, " ").trim();
      const firstHref = safeExternalHttpUrl(
        p.querySelector("a[href]")?.getAttribute("href") || "",
        baseUrl,
      );
      if (/^Article\s*URL\s*:/i.test(txt)) {
        if (firstHref) articleUrl = firstHref;
        p.remove();
        continue;
      }
      if (/^Comments\s*URL\s*:/i.test(txt)) {
        if (firstHref) commentsUrl = firstHref;
        p.remove();
        continue;
      }
      const ptsMatch = /^Points\s*:\s*(\d+)/i.exec(txt);
      if (ptsMatch) {
        points = Number(ptsMatch[1]);
        p.remove();
        continue;
      }
      const cmtsMatch = /^#?\s*Comments\s*:\s*(\d+)/i.exec(txt);
      if (cmtsMatch) {
        commentCount = Number(cmtsMatch[1]);
        p.remove();
        continue;
      }
      if (/^\s*Comments\s*$/i.test(txt) && firstHref.includes("news.ycombinator.com/item")) {
        commentsUrl = firstHref;
        p.remove();
      }
    }
    doc.body.querySelectorAll("hr").forEach((hr) => hr.remove());
    const remainingText = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      isStub: remainingText.length < 160,
      articleUrl,
      commentsUrl,
      points,
      commentCount,
      remainingHtml: remainingText ? doc.body.innerHTML : "",
    };
  }

  return { isStub: true, articleUrl, commentsUrl, points, commentCount, remainingHtml: "" };
}

const STANDALONE_AD_TEXT_RE =
  /^(?:ads?|advert(?:isement)?s?|pubblicit[àa]|annuncio(?: pubblicitario)?|sponsored|sponsorizzato|continua a leggere dopo la pubblicit[àa]|-+\s*(?:ads?|advertisement)\s*-+)$/i;

const HIDDEN_UTILITY_CLASSES = new Set([
  "hidden",
  "d-none",
  "sr-only",
  "visually-hidden",
  "screen-reader-text",
  "invisible",
  "u-hidden",
  "is-hidden",
  "print-only",
]);

function isLikelyAvatarOrBadgeUrl(url: string): boolean {
  return /(?:\/(?:pixel|tracker|beacon|1x1|spacer)\b|\/images\/users\/|\/avatars?\/|gravatar\.com\/avatar|ca\.slack-edge\.com\/)/i.test(
    url,
  );
}

function unwrapNextOrProxyImageUrl(resolvedUrl: string): { primary: string; fallback?: string } {
  try {
    const u = new URL(resolvedUrl);
    if (
      (u.pathname === "/_next/image" || u.pathname === "/_vercel/image") &&
      u.searchParams.get("url")
    ) {
      const innerRaw = u.searchParams.get("url")!;
      const inner = safeExternalHttpUrl(innerRaw, u.origin);
      if (inner && inner !== resolvedUrl) {
        return { primary: inner, fallback: resolvedUrl };
      }
    }
  } catch {
    // ignore
  }
  return { primary: resolvedUrl };
}

function resolveWithSlugBundleSupport(
  rawSrc: string,
  baseUrl?: string,
): { primary: string; altUrl?: string } {
  const trimmed = rawSrc.trim();
  if (!trimmed || /^data:|^javascript:|^blob:|^about:/i.test(trimmed)) {
    return { primary: "" };
  }
  const rfcUrl = safeExternalHttpUrl(trimmed, baseUrl);
  if (!rfcUrl) return { primary: "" };

  const unwrapped = unwrapNextOrProxyImageUrl(rfcUrl);

  // If rawSrc is a relative child filename (e.g. "chart.png" or "./chart.png") and baseUrl is a
  // clean slug URL without trailing slash or file extension (e.g. "https://site.com/blog/my-post"),
  // Hugo/Astro/MDX page bundles serve the asset at "https://site.com/blog/my-post/chart.png".
  if (
    baseUrl &&
    !/^(?:https?:|\/|\.\.\/)/i.test(trimmed) &&
    !trimmed.startsWith("#")
  ) {
    try {
      const baseParsed = new URL(baseUrl);
      const path = baseParsed.pathname;
      const lastSeg = path.split("/").filter(Boolean).pop() ?? "";
      const hasFileExt = /\.[a-z0-9]{2,5}$/i.test(lastSeg);
      if (!path.endsWith("/") && lastSeg && !hasFileExt) {
        const slugBase = `${baseParsed.origin}${path}/${baseParsed.search}`;
        const bundleUrl = safeExternalHttpUrl(trimmed, slugBase);
        if (bundleUrl && bundleUrl !== unwrapped.primary) {
          return { primary: bundleUrl, altUrl: unwrapped.primary };
        }
      }
    } catch {
      // ignore
    }
  }

  return { primary: unwrapped.primary, altUrl: unwrapped.fallback };
}

function bestCandidateFromSrcset(srcsetRaw: string): string {
  const parts = srcsetRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let bestUrl = "";
  let bestWeight = -1;
  for (const part of parts) {
    const tokens = part.split(/\s+/);
    const candidate = tokens[0] ?? "";
    if (!candidate || /^data:/i.test(candidate)) continue;
    const desc = tokens[1] ?? "";
    let weight = 1;
    const wMatch = /^(\d+)w$/i.exec(desc);
    const xMatch = /^(\d+(?:\.\d+)?)x$/i.exec(desc);
    if (wMatch) weight = Number(wMatch[1]);
    else if (xMatch) weight = Number(xMatch[1]) * 1000;
    if (weight >= bestWeight) {
      bestWeight = weight;
      bestUrl = candidate;
    }
  }
  return bestUrl;
}

function extractImageCandidateAttr(img: Element, pictureEl?: Element | null): string {
  const directAttrs = [
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-hi-res-src",
    "data-url",
    "src",
  ];
  let srcCandidate = "";
  for (const attr of directAttrs) {
    const val = (img.getAttribute(attr) || "").trim();
    if (
      val &&
      !/^data:|^about:|^blob:/i.test(val) &&
      !/\/(?:1x1|spacer|blank)\.(?:gif|png|svg)/i.test(val)
    ) {
      srcCandidate = val;
      break;
    }
  }

  // Prefer higher-res srcset URL when src is missing or a Next.js/low-res placeholder
  const srcsetRaw =
    img.getAttribute("data-srcset") ||
    img.getAttribute("srcset") ||
    pictureEl?.querySelector("source[srcset]")?.getAttribute("srcset") ||
    "";
  const fromSrcset = srcsetRaw ? bestCandidateFromSrcset(srcsetRaw) : "";

  if (!srcCandidate && fromSrcset) return fromSrcset;
  if (srcCandidate && srcCandidate.includes("/_next/image") && fromSrcset) {
    return fromSrcset;
  }
  return srcCandidate;
}

function promoteNoscriptImages(root: ParentNode): void {
  if (typeof DOMParser === "undefined") return;
  for (const ns of [...root.querySelectorAll("noscript")]) {
    const inner = (ns.textContent || ns.innerHTML || "").trim();
    if (!inner || !/<img\b/i.test(inner)) {
      ns.remove();
      continue;
    }
    const frag = new DOMParser().parseFromString(`<!doctype html><body>${inner}</body>`, "text/html");
    const nsImg = frag.body.querySelector("img");
    if (nsImg && ns.parentElement) {
      const siblingHasHttpImg = [...ns.parentElement.querySelectorAll("img")].some((existing) => {
        const s = extractImageCandidateAttr(existing);
        return Boolean(s && !/^data:/i.test(s));
      });
      if (!siblingHasHttpImg) {
        const imported = ns.ownerDocument.importNode(nsImg, true);
        ns.replaceWith(imported);
        continue;
      }
    }
    ns.remove();
  }
}

function removeHiddenAndAdNodes(root: Element): void {
  root
    .querySelectorAll(
      "script, style, iframe, object, embed, svg, canvas, form, input, button, select, dialog, [hidden], a.anchor, a.headerlink, a.hash-link, ins.adsbygoogle, [data-ad], [data-ad-slot], [data-ad-client], [id^='google_ads']",
    )
    .forEach((el) => el.remove());

  for (const el of [...root.querySelectorAll("[aria-hidden='true']")]) {
    if (el.querySelector("article, main, [role='main'], [itemprop='articleBody'], h1")) continue;
    el.remove();
  }

  for (const el of [...root.querySelectorAll("*")]) {
    if (el.tagName.toLowerCase() === "article" || el.tagName.toLowerCase() === "main") continue;
    if (el.querySelector("article, main, [role='main'], [itemprop='articleBody']")) continue;
    const style = (el.getAttribute("style") || "").toLowerCase().replace(/\s+/g, "");
    if (style.includes("display:none") || style.includes("visibility:hidden")) {
      el.remove();
      continue;
    }
    if (el.classList && [...el.classList].some((c) => HIDDEN_UTILITY_CLASSES.has(c.toLowerCase()))) {
      el.remove();
      continue;
    }
  }
}

function parseHtmlTable(tableEl: Element): { headers: string[]; rows: string[][] } | null {
  if (tableEl.querySelector("table")) return null;

  const extractRowCells = (tr: Element): { cells: string[]; allHeader: boolean } => {
    const rawCells = [...tr.children].filter((c) => {
      const t = c.tagName.toLowerCase();
      return t === "th" || t === "td";
    });
    const cells: string[] = [];
    let thCount = 0;
    let nonEmptyCount = 0;
    for (const cell of rawCells) {
      const isTh = cell.tagName.toLowerCase() === "th";
      const txt = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
      if (txt) nonEmptyCount += 1;
      if (isTh) thCount += 1;
      const colspan = Math.min(8, Math.max(1, Number(cell.getAttribute("colspan") || 1) || 1));
      cells.push(txt);
      for (let k = 1; k < colspan; k += 1) cells.push("");
    }
    const allHeader =
      rawCells.length > 0 && (thCount === rawCells.length || (thCount > 0 && thCount >= nonEmptyCount));
    return { cells, allHeader };
  };

  let headers: string[] = [];
  const rows: string[][] = [];

  const theadRows = [...tableEl.querySelectorAll(":scope > thead > tr")];
  const tbodyRows = [
    ...tableEl.querySelectorAll(":scope > tbody > tr, :scope > tr, :scope > tfoot > tr"),
  ];

  if (theadRows.length > 0) {
    headers = extractRowCells(theadRows[theadRows.length - 1]).cells;
    for (const tr of tbodyRows) {
      const { cells } = extractRowCells(tr);
      if (cells.some(Boolean)) rows.push(cells);
    }
  } else {
    const allTrs = tbodyRows.length > 0 ? tbodyRows : [...tableEl.querySelectorAll("tr")];
    for (let i = 0; i < allTrs.length; i += 1) {
      const { cells, allHeader } = extractRowCells(allTrs[i]);
      if (!cells.some(Boolean)) continue;
      if (i === 0 && allHeader && headers.length === 0) {
        headers = cells;
      } else {
        rows.push(cells);
      }
    }
  }

  const colCount = Math.min(
    24,
    Math.max(headers.length, ...rows.map((r) => r.length), 0),
  );
  if (colCount === 0 || (rows.length === 0 && !headers.some(Boolean))) {
    return null;
  }
  if (colCount === 1 && rows.length <= 1 && !headers.some(Boolean)) {
    return null;
  }

  const padRow = (r: string[]) => {
    const sliced = r.slice(0, colCount);
    while (sliced.length < colCount) sliced.push("");
    return sliced;
  };

  return {
    headers: headers.length > 0 ? padRow(headers) : [],
    rows: rows.slice(0, 150).map(padRow),
  };
}

export function htmlToReaderBlocks(
  rawHtml: string,
  baseUrl?: string,
  maxBlocks = 220,
): { summary: string; blocks: RssReaderBlock[]; firstImage: string } {
  const trimmed = rawHtml.trim();
  if (!trimmed) return { summary: "", blocks: [], firstImage: "" };

  if (typeof DOMParser === "undefined") {
    const plain = decodeHtmlText(trimmed);
    return {
      summary: plain.slice(0, 320),
      blocks: plain ? [{ kind: "paragraph", text: plain.slice(0, 6000) }] : [],
      firstImage: "",
    };
  }

  const doc = new DOMParser().parseFromString(`<!doctype html><body>${trimmed}</body>`, "text/html");
  promoteNoscriptImages(doc.body);
  doc.querySelectorAll("nav, footer").forEach((el) => el.remove());
  removeHiddenAndAdNodes(doc.body);

  return extractBlocksFromRoot(doc.body, baseUrl, maxBlocks);
}

function cleanHeadingText(raw: string): string {
  return raw
    .replace(/\s*\{#[a-z0-9_-]+\}\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBlocksFromRoot(
  root: Element,
  baseUrl?: string,
  maxBlocks = 240,
): { summary: string; blocks: RssReaderBlock[]; firstImage: string } {
  const blocks: RssReaderBlock[] = [];
  let firstImage = "";
  let lastImageUrl = "";

  const pushImageFromElement = (
    img: Element,
    captionOverride?: string,
    pictureEl?: Element | null,
  ) => {
    if (blocks.length >= maxBlocks) return;
    const w = Number(img.getAttribute("width") || 0);
    const h = Number(img.getAttribute("height") || 0);
    if ((w > 0 && w <= 28) || (h > 0 && h <= 28)) return;

    const rawCandidate = extractImageCandidateAttr(img, pictureEl);
    if (!rawCandidate) return;
    const { primary, altUrl } = resolveWithSlugBundleSupport(rawCandidate, baseUrl);
    if (!primary || isLikelyAvatarOrBadgeUrl(primary)) return;
    if (primary === lastImageUrl) return;
    lastImageUrl = primary;
    if (!firstImage) firstImage = primary;

    const alt = (captionOverride ?? img.getAttribute("alt") ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    blocks.push({
      kind: "image",
      url: primary,
      ...(altUrl && altUrl !== primary ? { altUrl } : {}),
      alt,
    });
  };

  const inlineBuffer: string[] = [];
  const flushInline = () => {
    if (!inlineBuffer.length) return;
    const joined = inlineBuffer.join(" ").replace(/\s+/g, " ").trim();
    inlineBuffer.length = 0;
    if (joined && !STANDALONE_AD_TEXT_RE.test(joined) && blocks.length < maxBlocks) {
      blocks.push({ kind: "paragraph", text: joined.slice(0, 6000) });
      lastImageUrl = "";
    }
  };

  const INLINE_TAGS = new Set([
    "a",
    "span",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "code",
    "mark",
    "small",
    "sup",
    "sub",
    "abbr",
    "time",
  ]);

  const walk = (parent: ParentNode) => {
    for (const node of [...parent.childNodes]) {
      if (blocks.length >= maxBlocks) break;
      if (node.nodeType === 3) {
        const txt = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (txt) inlineBuffer.push(txt);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();

      if (tag === "br") {
        flushInline();
        continue;
      }

      if (INLINE_TAGS.has(tag)) {
        const nestedImgs = [...el.querySelectorAll("img")];
        if (nestedImgs.length > 0) {
          flushInline();
          for (const img of nestedImgs) {
            pushImageFromElement(img, undefined, img.closest("picture"));
          }
        }
        const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (txt) inlineBuffer.push(txt);
        continue;
      }

      flushInline();

      if (tag === "img") {
        pushImageFromElement(el);
        continue;
      }

      if (tag === "picture") {
        const img = el.querySelector("img");
        if (img) {
          pushImageFromElement(img, undefined, el);
        } else {
          const srcEl = el.querySelector("source[srcset]");
          const raw = srcEl ? bestCandidateFromSrcset(srcEl.getAttribute("srcset") || "") : "";
          const { primary, altUrl } = resolveWithSlugBundleSupport(raw, baseUrl);
          if (primary && !isLikelyAvatarOrBadgeUrl(primary) && primary !== lastImageUrl) {
            lastImageUrl = primary;
            if (!firstImage) firstImage = primary;
            blocks.push({
              kind: "image",
              url: primary,
              ...(altUrl && altUrl !== primary ? { altUrl } : {}),
              alt: "",
            });
          }
        }
        continue;
      }

      if (tag === "figure") {
        const img = el.querySelector("img");
        const caption = el.querySelector("figcaption")?.textContent ?? undefined;
        if (img) {
          pushImageFromElement(img, caption, el.querySelector("picture"));
          continue;
        }
      }

      if (tag === "table") {
        const parsedTable = parseHtmlTable(el);
        if (parsedTable) {
          blocks.push({
            kind: "table",
            headers: parsedTable.headers,
            rows: parsedTable.rows,
          });
          lastImageUrl = "";
        }
        continue;
      }

      if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
        const txt = cleanHeadingText(el.textContent ?? "");
        if (txt && !STANDALONE_AD_TEXT_RE.test(txt)) {
          blocks.push({
            kind: "heading",
            level: tag === "h1" || tag === "h2" ? 2 : 3,
            text: txt.slice(0, 500),
          });
          lastImageUrl = "";
        }
        continue;
      }

      if (tag === "pre") {
        const code = (el.textContent ?? "").replace(/\r\n?/g, "\n").trim();
        if (code) {
          blocks.push({ kind: "code", text: code.slice(0, 12000) });
          lastImageUrl = "";
        }
        continue;
      }

      if (tag === "blockquote") {
        const quote = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (quote && !STANDALONE_AD_TEXT_RE.test(quote)) {
          blocks.push({ kind: "quote", text: quote.slice(0, 3000) });
          lastImageUrl = "";
        }
        continue;
      }

      if (tag === "ul" || tag === "ol") {
        const items = [...el.querySelectorAll(":scope > li")]
          .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter((li) => Boolean(li) && !STANDALONE_AD_TEXT_RE.test(li))
          .slice(0, 60);
        if (items.length) {
          blocks.push({ kind: "list", ordered: tag === "ol", items });
          lastImageUrl = "";
        }
        continue;
      }

      if (tag === "p") {
        const pImgs = [...el.querySelectorAll("img")];
        const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        for (const img of pImgs) {
          pushImageFromElement(img, undefined, img.closest("picture"));
        }
        if (txt && !STANDALONE_AD_TEXT_RE.test(txt)) {
          blocks.push({ kind: "paragraph", text: txt.slice(0, 6000) });
          lastImageUrl = "";
        }
        continue;
      }

      walk(el);
      flushInline();
    }
  };

  walk(root);
  flushInline();

  if (blocks.length === 0) {
    const fallback = (root.textContent ?? "").replace(/\s+/g, " ").trim();
    if (fallback && !STANDALONE_AD_TEXT_RE.test(fallback)) {
      blocks.push({ kind: "paragraph", text: fallback.slice(0, 6000) });
    }
  }

  const summarySource = blocks
    .filter((b): b is Extract<RssReaderBlock, { text: string }> => "text" in b && b.kind !== "code")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const summary =
    summarySource.length <= 280 ? summarySource : `${summarySource.slice(0, 277).trimEnd()}…`;

  return { summary, blocks, firstImage };
}

function detectPageAuthor(doc: Document): string {
  const selectors = [
    'meta[name="author"]',
    'meta[property="author"]',
    'meta[name="twitter:creator"]',
    '[itemprop="author"] [itemprop="name"]',
    '[itemprop="author"]',
    'a[rel="author"]',
    'a[href*="/autori/"]',
    'a[href*="/autore/"]',
    'a[href*="/authors/"]',
    'a[href*="/author/"]',
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    const raw =
      el.tagName.toLowerCase() === "meta"
        ? el.getAttribute("content") || ""
        : el.textContent || "";
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (
      cleaned &&
      cleaned.length >= 2 &&
      cleaned.length <= 70 &&
      !/^https?:\/\//i.test(cleaned) &&
      !cleaned.startsWith("/")
    ) {
      return cleaned;
    }
  }
  return "";
}

function normalizeTitleForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u2032`]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isLeadingMetadataLine(text: string, knownAuthor: string, articleTitle?: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length >= 110) return false;

  // 1. Exact duplicate of article title or author name
  if (articleTitle && normalizeTitleForCompare(t) === normalizeTitleForCompare(articleTitle)) {
    return true;
  }
  if (knownAuthor) {
    const normAuthor = normalizeTitleForCompare(knownAuthor).replace(/^@/, "");
    const normLine = normalizeTitleForCompare(t)
      .replace(/^(?:by|di|written by|scritto da|autore:?)\s+/i, "")
      .trim();
    if (normAuthor && normLine === normAuthor) return true;
  }
  if (/^(?:by|written by)\s+[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ.' -]{2,45}$/.test(t) && !/[!?:;()]/.test(t)) {
    return true;
  }

  // 2. Bare URL paths or social handle paths ("/pubblicazioni/...", "/autori/...", "in/patrickmgarrity/")
  if (/^\/[a-z0-9/_.,%-]+$/i.test(t)) return true;
  if (/^(?:in|u|r)\/[a-z0-9_.-]+\/?$/i.test(t)) return true;

  // 3. Bare numeric IDs / Unix epoch timestamps ("1794296406097")
  if (/^\d{5,18}$/.test(t)) return true;

  // 4. Back links / breadcrumbs
  if (/^(?:←\s*)?(?:go back|back(?: to [a-z ]+)?|torna(?: indietro| al blog)?|indietro)$/i.test(t)) {
    return true;
  }

  // 5. Standalone relative/calendar timestamps & reading times (English, AP style, Italian, & ISO)
  if (/^(?:oggi|ieri)\s+alle\s+\d{1,2}[:.]\d{2}$/i.test(t)) return true;
  if (/^\d+\s*(?:sec|min|mins|minute|minutes|hour|hours|day|days|ora|ore|minuti|giorni)\s+ago$/i.test(t)) {
    return true;
  }
  if (/^\d+\s*(?:min|minute|minutes|minuti)\s*(?:read|di lettura)$/i.test(t)) return true;
  if (
    /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}(?:[,\s·•|-]+(?:\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?|\d+\s*min\s*read))?$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /^\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+\d{4}(?:\s*[,-]?\s*(?:alle\s+)?\d{1,2}[:.]\d{2})?$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/.test(t) && t.length <= 32) {
    return true;
  }

  return false;
}

const TRAILING_FOOTER_HEADING_RE =
  /^(?:condividi(?: su)?|suggeriti|articoli correlati|potrebbe interessarti|leggi anche|seguici(?: sui social)?|recenti|share(?: this(?: post| article)?)?|related (?:posts|articles|stories)|recommended(?: for you)?|more from [a-z0-9 ._-]+)$/i;

function cleanExtractedArticleBlocks(
  rawBlocks: RssReaderBlock[],
  knownAuthor: string,
  articleTitle?: string,
): RssReaderBlock[] {
  // 1. Filter standalone ad labels anywhere
  let blocks = rawBlocks.filter((b) => {
    if ("text" in b && STANDALONE_AD_TEXT_RE.test(b.text.trim())) {
      return false;
    }
    return true;
  });

  // 2. Scrub leading byline/microdata clutter before the first real content block
  let startIdx = 0;
  let strippedAnyMeta = false;
  while (startIdx < blocks.length && startIdx < 12) {
    const b = blocks[startIdx];
    if (b.kind === "heading") {
      if (
        articleTitle &&
        normalizeTitleForCompare(b.text) === normalizeTitleForCompare(articleTitle)
      ) {
        startIdx += 1;
        strippedAnyMeta = true;
        continue;
      }
      break;
    }
    if (b.kind === "paragraph") {
      if (isLeadingMetadataLine(b.text, knownAuthor, articleTitle)) {
        startIdx += 1;
        strippedAnyMeta = true;
        continue;
      }
      // A short 2-3 word capitalized author name sitting immediately next to other metadata lines
      const nextBlock = blocks[startIdx + 1];
      const nextIsMeta =
        nextBlock?.kind === "paragraph" &&
        isLeadingMetadataLine(nextBlock.text, knownAuthor, articleTitle);
      if (
        (strippedAnyMeta || nextIsMeta) &&
        b.text.length <= 42 &&
        !/[.!?:;()]/.test(b.text) &&
        /^[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ'-]+(?:\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ.'-]+){1,3}$/.test(b.text.trim())
      ) {
        startIdx += 1;
        strippedAnyMeta = true;
        continue;
      }
      break;
    }
    if (b.kind === "image") {
      // Keep genuine lead hero image, skip tiny/avatar URLs
      if (isLikelyAvatarOrBadgeUrl(b.url)) {
        startIdx += 1;
        continue;
      }
      break;
    }
    break;
  }
  blocks = blocks.slice(startIdx);

  // If the first block was a valid hero image followed immediately by a photo credit and/or
  // post-H1 metadata lines (byline, date), attach any parenthesized photo credit as caption and
  // scrub the metadata lines right after it.
  if (blocks.length > 1 && blocks[0].kind === "image") {
    let heroBlock = blocks[0];
    let afterHero = 1;
    const creditCandidate = blocks[afterHero];
    if (
      creditCandidate?.kind === "paragraph" &&
      !heroBlock.caption &&
      /^\([^()]{4,110}\)$/.test(creditCandidate.text.trim())
    ) {
      heroBlock = {
        ...heroBlock,
        caption: creditCandidate.text.trim().replace(/^\(|\)$/g, "").trim(),
      };
      afterHero += 1;
    }
    let strippedAfter = false;
    while (afterHero < blocks.length && afterHero < 14) {
      const b = blocks[afterHero];
      if (
        b.kind === "heading" &&
        articleTitle &&
        normalizeTitleForCompare(b.text) === normalizeTitleForCompare(articleTitle)
      ) {
        afterHero += 1;
        strippedAfter = true;
        continue;
      }
      if (b.kind === "paragraph") {
        if (isLeadingMetadataLine(b.text, knownAuthor, articleTitle)) {
          afterHero += 1;
          strippedAfter = true;
          continue;
        }
        const nextB = blocks[afterHero + 1];
        const nextIsMeta =
          nextB?.kind === "paragraph" &&
          isLeadingMetadataLine(nextB.text, knownAuthor, articleTitle);
        if (
          (strippedAfter || nextIsMeta) &&
          b.text.length <= 42 &&
          !/[.!?:;()]/.test(b.text) &&
          /^[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ'-]+(?:\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ.'-]+){1,3}$/.test(b.text.trim())
        ) {
          afterHero += 1;
          strippedAfter = true;
          continue;
        }
      }
      break;
    }
    if (afterHero > 1) {
      blocks = [heroBlock, ...blocks.slice(afterHero)];
    }
  }

  // 3. Truncate trailing share / related-articles footer sections near the bottom
  const minBodyIdx = Math.max(1, Math.floor(blocks.length * 0.45));
  for (let i = minBodyIdx; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (
      (b.kind === "heading" || b.kind === "paragraph") &&
      b.text.trim().length <= 48 &&
      TRAILING_FOOTER_HEADING_RE.test(b.text.trim())
    ) {
      blocks = blocks.slice(0, i);
      break;
    }
  }

  return blocks;
}

function extractJsonLdArticleBody(doc: Document): string {
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
  let best = "";
  const inspectNode = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(inspectNode);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec["@graph"])) inspectNode(rec["@graph"]);
    const body =
      typeof rec.articleBody === "string"
        ? rec.articleBody
        : typeof rec.text === "string" &&
            typeof rec["@type"] === "string" &&
            /article|posting|report|news/i.test(rec["@type"])
          ? rec.text
          : "";
    if (body && body.trim().length > best.length) {
      best = body.trim();
    }
  };
  for (const s of scripts) {
    const raw = (s.textContent ?? "").trim();
    if (!raw) continue;
    try {
      inspectNode(JSON.parse(raw));
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }
  return best;
}

const EXACT_NOISE_CLASS_TOKENS = new Set([
  "nav",
  "navbar",
  "menu",
  "sidebar",
  "widget-area",
  "footer",
  "site-footer",
  "comment",
  "comments",
  "comments-area",
  "comment-list",
  "comment-respond",
  "disqus",
  "share",
  "sharer",
  "social-share",
  "share-buttons",
  "sharedaddy",
  "related",
  "related-posts",
  "related-articles",
  "recommended",
  "suggeriti",
  "newsletter",
  "newsletter-box",
  "newsletter-signup",
  "newsletter-widget",
  "subscribe-box",
  "cookie",
  "cookie-banner",
  "cookie-consent",
  "consent",
  "popup",
  "modal",
  "promo",
  "advert",
  "advertisement",
  "ads",
  "adsense",
  "adsbygoogle",
  "ad-slot",
  "ad-banner",
  "ad-container",
  "breadcrumb",
  "breadcrumbs",
  "pagination",
  "post-navigation",
  "outbrain",
  "taboola",
  "author-bio",
]);

function hasNoiseToken(el: Element): boolean {
  const rawTokens = `${typeof el.className === "string" ? el.className : ""} ${el.id || ""}`
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (rawTokens.length === 0) return false;
  // Never treat content/layout wrapper tokens ("has-sidebar", "comments-open", "post-content") as noise
  if (
    rawTokens.some((tok) =>
      /^(article|post|entry|story|content|main|markdown|single|page|site-content|primary|container|wrapper|layout)/.test(
        tok,
      ) ||
      /^(has|with|no|without|is)-/.test(tok) ||
      /-(open|closed|enabled|disabled|wrapper|layout|template)$/.test(tok),
    )
  ) {
    return false;
  }
  return rawTokens.some((tok) => EXACT_NOISE_CLASS_TOKENS.has(tok));
}

/**
 * Extracts the main readable article body from a full webpage HTML document
 * (Readability-style container scoring + hidden/ad/metadata removal + table & image support).
 */
export function extractReadableArticleFromHtml(
  rawHtml: string,
  articleUrl: string,
  articleTitle?: string,
  knownAuthor?: string,
): { blocks: RssReaderBlock[]; heroImage: string; author: string } {
  if (typeof DOMParser === "undefined" || !rawHtml.trim()) {
    return { blocks: [], heroImage: "", author: "" };
  }
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");

  const baseTagHref = doc.querySelector("base[href]")?.getAttribute("href") || "";
  const effectiveBaseUrl =
    (baseTagHref ? safeExternalHttpUrl(baseTagHref, articleUrl) : "") || articleUrl;

  const detectedAuthor = knownAuthor?.trim() || detectPageAuthor(doc);
  const jsonLdBody = extractJsonLdArticleBody(doc);

  const ogImage = safeExternalHttpUrl(
    doc
      .querySelector('meta[property="og:image"], meta[name="twitter:image"]')
      ?.getAttribute("content") || "",
    effectiveBaseUrl,
  );

  promoteNoscriptImages(doc.body);
  removeHiddenAndAdNodes(doc.body);

  doc
    .querySelectorAll(
      "nav, footer, aside, header nav, [role='navigation'], [role='banner'], [role='contentinfo']",
    )
    .forEach((el) => {
      if (
        el.querySelector(
          "article, main, [role='main'], [itemprop='articleBody'], .entry-content, .post-content, .article-body, .story-body",
        )
      ) {
        return;
      }
      el.remove();
    });

  // Remove social share links & containers composed purely of share actions
  doc
    .querySelectorAll(
      'a[href*="facebook.com/sharer"], a[href*="twitter.com/intent"], a[href*="x.com/intent"], a[href^="whatsapp://"], a[href*="t.me/share"], a[href*="linkedin.com/share"]',
    )
    .forEach((el) => el.remove());

  for (const el of [...doc.body.querySelectorAll("div, section, ul, aside, header, form")]) {
    const tag = el.tagName.toLowerCase();
    if (tag === "article" || tag === "main") continue;
    if (!hasNoiseToken(el)) continue;
    // Never delete an ancestor of the main article container, main heading, or substantial prose
    if (
      el.querySelector(
        "article, main, [role='main'], [itemprop='articleBody'], .entry-content, .post-content, .article-body, .article-content, .story-body, .markdown-body, h1",
      )
    ) {
      continue;
    }
    const pCount = el.querySelectorAll("p").length;
    const proseLen = (el.textContent ?? "").trim().length;
    if (pCount >= 3 || proseLen >= 550) continue;
    el.remove();
  }

  const PRIORITY_SELECTORS = [
    "article.markdown-body",
    ".markdown-body",
    "[itemprop='articleBody']",
    "article .post-content",
    "article .entry-content",
    "article .article-body",
    "article .article-content",
    "article .story-content",
    "article .story-body",
    ".post-content",
    ".entry-content",
    ".article-body",
    ".article-content",
    ".story-content",
    ".story-body",
    "article",
    "main",
    "[role='main']",
  ];

  const candidates = new Set<Element>();
  for (const sel of PRIORITY_SELECTORS) {
    doc.body.querySelectorAll(sel).forEach((el) => candidates.add(el));
  }
  for (const p of [...doc.body.querySelectorAll("p")]) {
    if (p.parentElement) candidates.add(p.parentElement);
    if (p.parentElement?.parentElement) candidates.add(p.parentElement.parentElement);
  }

  const scoreElement = (el: Element): number => {
    const pTextLen = [...el.querySelectorAll("p, pre, blockquote, table")]
      .reduce((acc, node) => acc + (node.textContent ?? "").trim().length, 0);
    const totalLen = (el.textContent ?? "").trim().length;
    if (totalLen < 120) return -1;
    const linkLen = [...el.querySelectorAll("a")]
      .reduce((acc, a) => acc + (a.textContent ?? "").trim().length, 0);
    const linkDensity = totalLen > 0 ? linkLen / totalLen : 0;
    if (linkDensity > 0.58) return -1;
    const tag = el.tagName.toLowerCase();
    const bonus = el.matches(
      "[itemprop='articleBody'], .post-content, .entry-content, .article-body, .article-content, .story-content, .story-body, .markdown-body",
    )
      ? 650
      : tag === "article"
        ? 450
        : tag === "main"
          ? 250
          : 0;
    return (pTextLen > 0 ? pTextLen * 1.4 : totalLen * 0.6) * (1 - linkDensity * 0.8) + bonus;
  };

  let bestEl: Element = doc.body;
  let bestScore = -1;
  for (const cand of candidates) {
    const s = scoreElement(cand);
    if (s > bestScore) {
      bestScore = s;
      bestEl = cand;
    }
  }

  // If bestEl starts with pre-H1 header tags/breadcrumbs/newsletter prompts before the post's <h1>,
  // prune non-hero elements before <h1> so tag clouds, signup boxes, and "Go back" links don't pollute the body.
  const firstH1 = bestEl.querySelector("h1");
  if (firstH1 && bestEl.contains(firstH1)) {
    const normH1 = normalizeTitleForCompare(cleanHeadingText(firstH1.textContent ?? ""));
    const normTitle = articleTitle ? normalizeTitleForCompare(articleTitle) : "";
    const titleMatches =
      !normTitle ||
      normH1 === normTitle ||
      normTitle.includes(normH1) ||
      normH1.includes(normTitle);
    if (titleMatches) {
      for (const child of [...bestEl.children]) {
        if (child === firstH1 || child.contains(firstH1)) {
          firstH1.remove();
          break;
        }
        const heroImg = child.tagName.toLowerCase() === "img" ? child : child.querySelector("img");
        const heroCandidate = heroImg ? extractImageCandidateAttr(heroImg) : "";
        const resolvedHero = heroCandidate
          ? resolveWithSlugBundleSupport(heroCandidate, effectiveBaseUrl).primary
          : "";
        if (
          resolvedHero &&
          !isLikelyAvatarOrBadgeUrl(resolvedHero) &&
          (child.textContent ?? "").trim().length < 60
        ) {
          continue;
        }
        child.remove();
      }
    }
  }

  const extracted = extractBlocksFromRoot(bestEl, effectiveBaseUrl, 280);
  let cleanedBlocks = cleanExtractedArticleBlocks(
    extracted.blocks,
    detectedAuthor,
    articleTitle,
  );

  // Fallback to JSON-LD articleBody if DOM extraction produced little/no prose
  if (readerBlocksCharLength(cleanedBlocks) < 140 && jsonLdBody.length >= 140) {
    const paragraphs = jsonLdBody
      .split(/\n{2,}|\r\n\r\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const fallbackBlocks: RssReaderBlock[] = [];
    if (ogImage && !isLikelyAvatarOrBadgeUrl(ogImage)) {
      fallbackBlocks.push({ kind: "image", url: ogImage, alt: "" });
    }
    for (const p of paragraphs) {
      fallbackBlocks.push({ kind: "paragraph", text: p });
    }
    cleanedBlocks = cleanExtractedArticleBlocks(fallbackBlocks, detectedAuthor, articleTitle);
  }

  return {
    blocks: cleanedBlocks,
    heroImage: extracted.firstImage || ogImage,
    author: detectedAuthor,
  };
}

export function readerBlocksCharLength(blocks: RssReaderBlock[]): number {
  let total = 0;
  for (const b of blocks) {
    if ("text" in b) total += b.text.length;
    else if (b.kind === "list") total += b.items.join(" ").length;
    else if (b.kind === "table") {
      total += b.headers.join(" ").length;
      for (const r of b.rows) total += r.join(" ").length;
    }
  }
  return total;
}

export function articleNeedsFullExtraction(article: RssArticle): boolean {
  if (!article.url || /\.(?:pdf|mp4|mp3|zip|dmg|exe|deb)(?:\?|$)/i.test(article.url)) {
    return false;
  }
  if (
    article.fullBlocks &&
    article.fullBlocks.length > 0 &&
    article.extractorVersion === CURRENT_EXTRACTOR_VERSION
  ) {
    return false;
  }
  return readerBlocksCharLength(article.blocks) < 900;
}

function directChildText(parent: Element, localNames: string[]): string {
  for (const child of [...parent.children]) {
    const name = (child.localName || child.tagName).toLowerCase();
    const full = child.tagName.toLowerCase();
    if (localNames.includes(name) || localNames.includes(full)) {
      const val = (child.textContent ?? "").trim();
      if (val) return val;
    }
  }
  return "";
}

function directChildRichHtml(parent: Element, localNames: string[]): string {
  for (const child of [...parent.children]) {
    const name = (child.localName || child.tagName).toLowerCase();
    const full = child.tagName.toLowerCase();
    if (localNames.includes(name) || localNames.includes(full)) {
      if (child.children.length > 0 && typeof XMLSerializer !== "undefined") {
        const ser = new XMLSerializer();
        const inner = [...child.childNodes].map((n) => ser.serializeToString(n)).join("");
        if (inner.trim()) return inner.trim();
      }
      const val = (child.textContent ?? "").trim();
      if (val) return val;
    }
  }
  return "";
}

const NAMED_XML_ENTITIES: Record<string, string> = {
  nbsp: "&#160;",
  mdash: "&#8212;",
  ndash: "&#8211;",
  rsquo: "&#8217;",
  lsquo: "&#8216;",
  ldquo: "&#8220;",
  rdquo: "&#8221;",
  hellip: "&#8230;",
  copy: "&#169;",
  reg: "&#174;",
  trade: "&#8482;",
  euro: "&#8364;",
  pound: "&#163;",
  yen: "&#165;",
  bull: "&#8226;",
  middot: "&#183;",
  rarr: "&#8594;",
  larr: "&#8592;",
  laquo: "&#171;",
  raquo: "&#187;",
};

function repairXmlForDomParser(rawXml: string): string {
  const parts = rawXml.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/&([a-zA-Z]+);/g, (full, name: string) => {
        const lower = name.toLowerCase();
        if (lower === "amp" || lower === "lt" || lower === "gt" || lower === "quot" || lower === "apos") {
          return full;
        }
        return NAMED_XML_ENTITIES[lower] ?? full;
      })
      .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
  }
  return parts.join("");
}

function findMediaImage(item: Element, baseUrl: string): string {
  for (const child of [...item.children]) {
    const full = child.tagName.toLowerCase();
    const local = (child.localName || "").toLowerCase();
    if (local === "enclosure") {
      const type = (child.getAttribute("type") || "").toLowerCase();
      const url = safeExternalHttpUrl(child.getAttribute("url") || "", baseUrl);
      if (url && (type.startsWith("image/") || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(url))) {
        return url;
      }
    }
    if (full === "media:thumbnail" || full === "media:content" || local === "thumbnail") {
      const medium = (child.getAttribute("medium") || "").toLowerCase();
      const type = (child.getAttribute("type") || "").toLowerCase();
      const url = safeExternalHttpUrl(child.getAttribute("url") || "", baseUrl);
      if (
        url &&
        (full === "media:thumbnail" ||
          medium === "image" ||
          type.startsWith("image/") ||
          /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(url))
      ) {
        return url;
      }
    }
  }
  return "";
}

export function discoverFeedUrlFromHtml(html: string, baseUrl: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const link of [...doc.querySelectorAll("link[rel]")]) {
    const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (!rel.includes("alternate")) continue;
    const type = (link.getAttribute("type") || "").toLowerCase();
    if (
      type.includes("rss") ||
      type.includes("atom") ||
      type.includes("feed+json") ||
      type.includes("xml")
    ) {
      const href = safeExternalHttpUrl(link.getAttribute("href") || "", baseUrl);
      if (href) return href;
    }
  }
  return null;
}

export function parseFeedDocument(raw: string, feedUrl: string): ParsedFeedResult {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("Feed response was empty.");

  // 1. JSON Feed 1.0 / 1.1
  if (trimmed.startsWith("{")) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid JSON feed format.");
    }
    if (
      typeof json.version === "string" &&
      json.version.toLowerCase().includes("jsonfeed.org") &&
      Array.isArray(json.items)
    ) {
      const siteUrl =
        typeof json.home_page_url === "string"
          ? safeExternalHttpUrl(json.home_page_url, feedUrl)
          : "";
      const iconUrl =
        typeof json.icon === "string"
          ? safeExternalHttpUrl(json.icon, feedUrl)
          : typeof json.favicon === "string"
            ? safeExternalHttpUrl(json.favicon, feedUrl)
            : "";
      const title =
        typeof json.title === "string" && json.title.trim()
          ? json.title.trim().slice(0, 120)
          : hostnameLabel(siteUrl || feedUrl);

      const items: Omit<RssArticle, "id" | "feedId">[] = [];
      for (const rawItem of json.items.slice(0, MAX_ITEMS_PER_FEED)) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const entry = rawItem as Record<string, unknown>;
        const itemUrl =
          typeof entry.url === "string"
            ? safeExternalHttpUrl(entry.url, siteUrl || feedUrl)
            : typeof entry.external_url === "string"
              ? safeExternalHttpUrl(entry.external_url, siteUrl || feedUrl)
              : "";
        const htmlBody =
          typeof entry.content_html === "string" && entry.content_html.trim()
            ? entry.content_html
            : typeof entry.content_text === "string" && entry.content_text.trim()
              ? `<p>${entry.content_text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`
              : typeof entry.summary === "string"
                ? `<p>${entry.summary.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`
                : "";
        const agg = parseAggregatorMetadata(htmlBody, itemUrl || siteUrl || feedUrl);
        const parsedBody = htmlToReaderBlocks(
          agg.remainingHtml,
          agg.articleUrl || itemUrl || siteUrl || feedUrl,
        );
        const rawTitle =
          typeof entry.title === "string" && entry.title.trim()
            ? decodeHtmlText(entry.title)
            : parsedBody.summary.slice(0, 90) || "Untitled entry";
        const guid =
          typeof entry.id === "string" && entry.id.trim()
            ? entry.id.trim()
            : itemUrl || `${rawTitle}-${String(entry.date_published ?? "")}`;
        let author = "";
        if (Array.isArray(entry.authors) && entry.authors[0] && typeof entry.authors[0] === "object") {
          const a0 = entry.authors[0] as Record<string, unknown>;
          if (typeof a0.name === "string") author = a0.name.trim();
        } else if (entry.author && typeof entry.author === "object") {
          const a0 = entry.author as Record<string, unknown>;
          if (typeof a0.name === "string") author = a0.name.trim();
        }
        const directImg =
          typeof entry.image === "string"
            ? safeExternalHttpUrl(entry.image, itemUrl || siteUrl || feedUrl)
            : typeof entry.banner_image === "string"
              ? safeExternalHttpUrl(entry.banner_image, itemUrl || siteUrl || feedUrl)
              : "";
        items.push({
          guid: guid.slice(0, 300),
          title: rawTitle.slice(0, 300),
          url: agg.articleUrl || itemUrl,
          ...(agg.commentsUrl ? { commentsUrl: agg.commentsUrl } : {}),
          ...(agg.points !== undefined ? { points: agg.points } : {}),
          ...(agg.commentCount !== undefined ? { commentCount: agg.commentCount } : {}),
          author: author.slice(0, 140),
          publishedAt: normalizeDateString(
            typeof entry.date_published === "string"
              ? entry.date_published
              : typeof entry.date_modified === "string"
                ? entry.date_modified
                : "",
          ),
          summary:
            typeof entry.summary === "string" && entry.summary.trim() && !agg.isStub
              ? decodeHtmlText(entry.summary).slice(0, 320)
              : parsedBody.summary,
          blocks: parsedBody.blocks,
          imageUrl: directImg || parsedBody.firstImage,
          categories: Array.isArray(entry.tags)
            ? entry.tags.filter((t): t is string => typeof t === "string").slice(0, 8)
            : [],
        });
      }

      return { title, siteUrl, feedUrl, iconUrl, items };
    }
    throw new Error("Unsupported JSON format (expected JSON Feed).");
  }

  // 2. XML: RSS 2.0, RDF 1.0, or Atom 1.0 (with HTML-entity repair fallback)
  if (typeof DOMParser === "undefined") {
    throw new Error("XML parser unavailable in this environment.");
  }
  let xml = new DOMParser().parseFromString(trimmed, "application/xml");
  if (xml.querySelector("parsererror")) {
    xml = new DOMParser().parseFromString(repairXmlForDomParser(trimmed), "application/xml");
  }
  const rootName = (xml.documentElement?.localName || xml.documentElement?.tagName || "").toLowerCase();

  if (!rootName || rootName === "parsererror" || xml.querySelector("parsererror")) {
    throw new Error("This URL doesn't contain a valid RSS, Atom, or JSON feed.");
  }

  // Atom 1.0 (<feed>)
  if (rootName === "feed") {
    const feedEl = xml.documentElement;
    const rawTitle = directChildText(feedEl, ["title"]);
    let siteUrl = "";
    for (const link of [...feedEl.children].filter(
      (c) => (c.localName || c.tagName).toLowerCase() === "link",
    )) {
      const rel = (link.getAttribute("rel") || "alternate").toLowerCase();
      const href = safeExternalHttpUrl(link.getAttribute("href") || "", feedUrl);
      if (href && (rel === "alternate" || !siteUrl)) {
        siteUrl = href;
        if (rel === "alternate") break;
      }
    }
    const iconUrl = safeExternalHttpUrl(
      directChildText(feedEl, ["icon"]) || directChildText(feedEl, ["logo"]),
      siteUrl || feedUrl,
    );
    const title = decodeHtmlText(rawTitle) || hostnameLabel(siteUrl || feedUrl);

    const entries = [...feedEl.children].filter(
      (c) => (c.localName || c.tagName).toLowerCase() === "entry",
    );
    const items: Omit<RssArticle, "id" | "feedId">[] = entries
      .slice(0, MAX_ITEMS_PER_FEED)
      .map((entry) => {
        let entryUrl = "";
        let commentsUrl = "";
        for (const link of [...entry.children].filter(
          (c) => (c.localName || c.tagName).toLowerCase() === "link",
        )) {
          const rel = (link.getAttribute("rel") || "alternate").toLowerCase();
          const href = safeExternalHttpUrl(link.getAttribute("href") || "", siteUrl || feedUrl);
          if (!href) continue;
          if (rel === "replies") {
            commentsUrl = href;
          } else if (rel === "alternate" || !entryUrl) {
            entryUrl = href;
          }
        }
        const contentRaw =
          directChildRichHtml(entry, ["content"]) || directChildRichHtml(entry, ["summary"]);
        const summaryRaw = directChildRichHtml(entry, ["summary"]);
        const agg = parseAggregatorMetadata(contentRaw, entryUrl || siteUrl || feedUrl);
        const finalUrl = agg.articleUrl || entryUrl;
        const finalComments = agg.commentsUrl || commentsUrl;
        const parsedBody = htmlToReaderBlocks(
          agg.remainingHtml,
          finalUrl || siteUrl || feedUrl,
        );
        const entryTitle =
          decodeHtmlText(directChildText(entry, ["title"])) ||
          parsedBody.summary.slice(0, 90) ||
          "Untitled entry";
        const guid =
          directChildText(entry, ["id"]) ||
          finalUrl ||
          `${entryTitle}-${directChildText(entry, ["published", "updated"])}`;
        const authorEl = [...entry.children].find(
          (c) => (c.localName || c.tagName).toLowerCase() === "author",
        );
        const author = authorEl
          ? decodeHtmlText(directChildText(authorEl, ["name"]) || authorEl.textContent || "")
          : "";
        const categories = [...entry.children]
          .filter((c) => (c.localName || c.tagName).toLowerCase() === "category")
          .map((c) => (c.getAttribute("label") || c.getAttribute("term") || c.textContent || "").trim())
          .filter(Boolean)
          .slice(0, 8);
        const mediaImg = findMediaImage(entry, finalUrl || siteUrl || feedUrl);

        return {
          guid: guid.slice(0, 300),
          title: entryTitle.slice(0, 300),
          url: finalUrl,
          ...(finalComments ? { commentsUrl: finalComments } : {}),
          ...(agg.points !== undefined ? { points: agg.points } : {}),
          ...(agg.commentCount !== undefined ? { commentCount: agg.commentCount } : {}),
          author: author.slice(0, 140),
          publishedAt: normalizeDateString(
            directChildText(entry, ["published"]) || directChildText(entry, ["updated"]),
          ),
          summary:
            summaryRaw && !agg.isStub
              ? decodeHtmlText(summaryRaw).slice(0, 320)
              : parsedBody.summary,
          blocks: parsedBody.blocks,
          imageUrl: mediaImg || parsedBody.firstImage,
          categories,
        };
      });

    return { title: title.slice(0, 120), siteUrl, feedUrl, iconUrl, items };
  }

  // RSS 2.0 / RSS 1.0 (RDF)
  const channel = [...xml.getElementsByTagName("channel")][0] ?? xml.documentElement;
  const rawTitle = directChildText(channel, ["title"]);
  const siteUrl = safeExternalHttpUrl(directChildText(channel, ["link"]), feedUrl);
  const imageEl = [...channel.children].find(
    (c) => (c.localName || c.tagName).toLowerCase() === "image",
  );
  const iconUrl = imageEl
    ? safeExternalHttpUrl(directChildText(imageEl, ["url"]), siteUrl || feedUrl)
    : "";
  const title = decodeHtmlText(rawTitle) || hostnameLabel(siteUrl || feedUrl);

  const rawItems = [...xml.getElementsByTagName("item")];
  if (rawItems.length === 0 && rootName !== "rss" && rootName !== "rdf") {
    throw new Error("Unrecognized XML document (expected RSS or Atom feed).");
  }

  const items: Omit<RssArticle, "id" | "feedId">[] = rawItems
    .slice(0, MAX_ITEMS_PER_FEED)
    .map((item) => {
      const itemLink = safeExternalHttpUrl(directChildText(item, ["link"]), siteUrl || feedUrl);
      const itemCommentsTag = safeExternalHttpUrl(
        directChildText(item, ["comments"]),
        siteUrl || feedUrl,
      );
      const encoded = directChildRichHtml(item, ["encoded", "content:encoded"]);
      const description = directChildRichHtml(item, ["description"]);
      const bodySource =
        encoded.length >= description.length ? encoded || description : description;
      const agg = parseAggregatorMetadata(bodySource, itemLink || siteUrl || feedUrl);
      const finalUrl = agg.articleUrl || itemLink;
      const finalComments = agg.commentsUrl || itemCommentsTag;
      const parsedBody = htmlToReaderBlocks(
        agg.remainingHtml,
        finalUrl || siteUrl || feedUrl,
      );
      const itemTitle =
        decodeHtmlText(directChildText(item, ["title"])) ||
        parsedBody.summary.slice(0, 90) ||
        "Untitled item";
      const guid =
        directChildText(item, ["guid"]) ||
        finalUrl ||
        `${itemTitle}-${directChildText(item, ["pubdate", "date", "dc:date"])}`;
      const author = decodeHtmlText(
        directChildText(item, ["creator", "dc:creator", "author"]),
      );
      const pubRaw = directChildText(item, ["pubdate", "date", "dc:date", "published"]);
      const categories = [...item.children]
        .filter((c) => (c.localName || c.tagName).toLowerCase() === "category")
        .map((c) => decodeHtmlText(c.textContent || ""))
        .filter(Boolean)
        .slice(0, 8);
      const mediaImg = findMediaImage(item, finalUrl || siteUrl || feedUrl);

      return {
        guid: guid.slice(0, 300),
        title: itemTitle.slice(0, 300),
        url: finalUrl,
        ...(finalComments ? { commentsUrl: finalComments } : {}),
        ...(agg.points !== undefined ? { points: agg.points } : {}),
        ...(agg.commentCount !== undefined ? { commentCount: agg.commentCount } : {}),
        author: author.slice(0, 140),
        publishedAt: normalizeDateString(pubRaw),
        summary:
          description && !agg.isStub
            ? decodeHtmlText(description).slice(0, 320) || parsedBody.summary
            : parsedBody.summary,
        blocks: parsedBody.blocks,
        imageUrl: mediaImg || parsedBody.firstImage,
        categories,
      };
    });

  return { title: title.slice(0, 120), siteUrl, feedUrl, iconUrl, items };
}

export function hostnameLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "") || "Feed";
  } catch {
    return "Feed";
  }
}

export function isDesktopTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

interface DesktopFetchedRssResponse {
  finalUrl: string;
  contentType: string;
  body: string;
  bodyGzipBase64?: string;
}

async function decodeDesktopRssBody(res: DesktopFetchedRssResponse): Promise<string> {
  if (res.body || !res.bodyGzipBase64) return res.body;
  if (typeof DecompressionStream !== "function" || typeof atob !== "function") {
    return res.body;
  }
  try {
    const bin = atob(res.bodyGzipBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  } catch {
    return res.body;
  }
}

export async function fetchAndParseFeed(rawUrl: string): Promise<ParsedFeedResult> {
  const normalized = normalizeFeedUrl(rawUrl);
  if (!normalized) {
    throw new Error("Enter a valid http:// or https:// feed address.");
  }

  if (isDesktopTauriRuntime()) {
    try {
      const res = await invoke<DesktopFetchedRssResponse>("fetch_rss_feed", {
        url: normalized,
      });
      const text = await decodeDesktopRssBody(res);
      const base = res.finalUrl || normalized;
      if (
        res.contentType.includes("text/html") &&
        !text.trimStart().startsWith("<rss") &&
        !text.trimStart().startsWith("<?xml") &&
        !text.trimStart().startsWith("<feed")
      ) {
        const discovered = discoverFeedUrlFromHtml(text, base);
        if (discovered && discovered !== base) {
          const second = await invoke<DesktopFetchedRssResponse>("fetch_rss_feed", {
            url: discovered,
          });
          return parseFeedDocument(
            await decodeDesktopRssBody(second),
            second.finalUrl || discovered,
          );
        }
      }
      return parseFeedDocument(text, base);
    } catch (err) {
      throw new Error(rssErrorMessage(err, "Couldn't refresh feed."));
    }
  }

  try {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(normalized, {
        headers: {
          Accept:
            "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9, text/html;q=0.5",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Feed returned HTTP ${response.status}.`);
      }
      const text = await response.text();
      const ctype = (response.headers.get("content-type") || "").toLowerCase();
      if (
        ctype.includes("text/html") &&
        !text.trimStart().startsWith("<rss") &&
        !text.trimStart().startsWith("<?xml")
      ) {
        const discovered = discoverFeedUrlFromHtml(text, response.url || normalized);
        if (discovered && discovered !== normalized) {
          const second = await fetch(discovered, { signal: controller.signal });
          if (second.ok) {
            return parseFeedDocument(await second.text(), second.url || discovered);
          }
        }
      }
      return parseFeedDocument(text, response.url || normalized);
    } finally {
      globalThis.clearTimeout(timer);
    }
  } catch (err) {
    const msg = rssErrorMessage(err, "Couldn't load that feed.");
    if (/failed to fetch|networkerror|load failed|cors/i.test(msg)) {
      throw new Error(
        "This site blocks cross-origin feed requests in the browser preview. In the Comet desktop app, all public RSS/Atom feeds load directly without CORS restrictions.",
      );
    }
    throw new Error(msg);
  }
}

export async function fetchFullArticleContent(
  articleUrl: string,
  articleTitle?: string,
  knownAuthor?: string,
): Promise<{ blocks: RssReaderBlock[]; heroImage: string; author: string }> {
  const safeUrl = safeExternalHttpUrl(articleUrl);
  if (!safeUrl) throw new Error("Invalid article URL.");

  let html = "";
  let finalUrl = safeUrl;

  if (isDesktopTauriRuntime()) {
    try {
      const res = await invoke<DesktopFetchedRssResponse>("fetch_rss_article", {
        url: safeUrl,
      });
      html = await decodeDesktopRssBody(res);
      finalUrl = res.finalUrl || safeUrl;
    } catch (err) {
      throw new Error(rssErrorMessage(err, "Couldn't load full article."));
    }
  } else {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), 14000);
    try {
      const response = await fetch(safeUrl, {
        headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
      finalUrl = response.url || safeUrl;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  return extractReadableArticleFromHtml(html, finalUrl, articleTitle, knownAuthor);
}

export async function fetchProxiedRssImage(
  imageUrl: string,
  refererUrl?: string,
): Promise<string> {
  if (!isDesktopTauriRuntime()) return "";
  const safeImg = safeExternalHttpUrl(imageUrl);
  if (!safeImg) return "";
  try {
    return await invoke<string>("fetch_rss_image", {
      url: safeImg,
      referer: refererUrl ? safeExternalHttpUrl(refererUrl) || null : null,
    });
  } catch {
    return "";
  }
}

export function mergeFetchedArticles(
  feedId: string,
  existing: RssArticle[],
  incoming: Omit<RssArticle, "id" | "feedId">[],
  savedIds: Set<string>,
): RssArticle[] {
  const otherFeeds = existing.filter((a) => a.feedId !== feedId);
  const existingById = new Map(
    existing.filter((a) => a.feedId === feedId).map((a) => [a.id, a]),
  );

  for (const item of incoming) {
    const id = `${feedId}::${item.guid || item.url || item.title}`;
    const previous = existingById.get(id);
    const keepFull =
      previous?.fullBlocks &&
      previous.fullBlocks.length > 0 &&
      previous.extractorVersion === CURRENT_EXTRACTOR_VERSION;
    existingById.set(id, {
      ...item,
      id,
      feedId,
      author: item.author || previous?.author || "",
      ...(keepFull
        ? {
            fullBlocks: previous.fullBlocks,
            extractorVersion: CURRENT_EXTRACTOR_VERSION,
          }
        : {}),
      imageUrl: item.imageUrl || previous?.imageUrl || "",
    });
  }

  const combinedForFeed = [...existingById.values()].sort((a, b) =>
    compareArticleDates(b.publishedAt, a.publishedAt),
  );
  const keptForFeed: RssArticle[] = [];
  let regularCount = 0;
  for (const art of combinedForFeed) {
    if (savedIds.has(art.id)) {
      keptForFeed.push(art);
    } else if (regularCount < MAX_ITEMS_PER_FEED) {
      keptForFeed.push(art);
      regularCount += 1;
    }
  }

  return [...otherFeeds, ...keptForFeed].sort((a, b) =>
    compareArticleDates(b.publishedAt, a.publishedAt),
  );
}

export interface OpmlFeedEntry {
  name: string;
  url: string;
  siteUrl: string;
}

export function parseOpmlFeeds(opmlXml: string): OpmlFeedEntry[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(opmlXml, "application/xml");
  if (doc.querySelector("parsererror")) return [];
  const seen = new Set<string>();
  const out: OpmlFeedEntry[] = [];
  for (const outline of [...doc.querySelectorAll("outline[xmlUrl], outline[xmlurl]")]) {
    const rawUrl = outline.getAttribute("xmlUrl") || outline.getAttribute("xmlurl") || "";
    const url = normalizeFeedUrl(rawUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const name = (
      outline.getAttribute("title") ||
      outline.getAttribute("text") ||
      hostnameLabel(url)
    )
      .trim()
      .slice(0, 120);
    const siteUrl = safeExternalHttpUrl(
      outline.getAttribute("htmlUrl") || outline.getAttribute("htmlurl") || "",
      url,
    );
    out.push({ name: name || hostnameLabel(url), url, siteUrl });
  }
  return out;
}

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function exportOpmlFeeds(feeds: RssFeed[], workspaceName: string): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>${escapeXml(`Comet RSS — ${workspaceName}`)}</title>`,
    "  </head>",
    "  <body>",
  ];
  for (const feed of feeds) {
    const attrs = [
      'type="rss"',
      `text="${escapeXml(feed.name)}"`,
      `title="${escapeXml(feed.name)}"`,
      `xmlUrl="${escapeXml(feed.url)}"`,
      ...(feed.siteUrl ? [`htmlUrl="${escapeXml(feed.siteUrl)}"`] : []),
    ];
    lines.push(`    <outline ${attrs.join(" ")} />`);
  }
  lines.push("  </body>", "</opml>");
  return lines.join("\n");
}

interface SavePickerWritable {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
}

interface SavePickerHandle {
  name?: string;
  createWritable: () => Promise<SavePickerWritable>;
}

export async function saveOpmlWithDialog(
  feeds: RssFeed[],
  workspaceName: string,
): Promise<string | null> {
  const xml = exportOpmlFeeds(feeds, workspaceName);
  const suggestedName = "comet-feeds.opml";

  if (isDesktopTauriRuntime()) {
    try {
      return await invoke<string | null>("export_rss_opml", {
        opml: xml,
        suggestedName,
      });
    } catch (err) {
      throw new Error(rssErrorMessage(err, "Couldn't export OPML file."));
    }
  }

  const winWithPicker = window as Window & {
    showSaveFilePicker?: (opts: unknown) => Promise<SavePickerHandle>;
  };
  if (typeof winWithPicker.showSaveFilePicker === "function") {
    try {
      const handle = await winWithPicker.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: "OPML feed list",
            accept: { "text/x-opml": [".opml", ".xml"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(xml);
      await writable.close();
      return handle.name || suggestedName;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return null;
      }
      throw new Error(rssErrorMessage(err, "Couldn't export OPML file."));
    }
  }

  const url = URL.createObjectURL(new Blob([xml], { type: "text/x-opml;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return suggestedName;
}

export async function resizeIconFileToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Choose an image smaller than 8 MB.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Couldn't decode that image."));
      el.src = objectUrl;
    });
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable.");
    const scale = Math.max(
      size / Math.max(1, img.naturalWidth),
      size / Math.max(1, img.naturalHeight),
    );
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);
    const webp = canvas.toDataURL("image/webp", 0.86);
    if (isValidCustomIconImageUrl(webp)) return webp;
    const png = canvas.toDataURL("image/png");
    if (isValidCustomIconImageUrl(png)) return png;
    throw new Error("Icon image is too complex to store inline.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
