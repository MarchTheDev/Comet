import packageJson from "../../package.json";

export const APP_VERSION = packageJson.version;
const REPO = "MarchTheDev/Comet";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const UPDATE_PREFS_KEY = "comet:update-prefs:v1";

export type UpdatePlatform = "windows" | "linux" | "macos" | "other";
export type UpdateInstallStep = "idle" | "downloading" | "opening";

export interface UpdateAssetInfo {
  name: string;
  digest: string;
  platform: Exclude<UpdatePlatform, "other">;
}

export interface UpdateInfo {
  version: string;
  tag: string;
  url: string;
  page: string;
  notes: string;
  prerelease: boolean;
  publishedAt: string;
  installer: { name: string; digest: string } | null;
  platformAsset: UpdateAssetInfo | null;
}

export interface UpdatePreferences {
  checkOnLaunch: boolean;
  includePrereleases: boolean;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  checkOnLaunch: true,
  includePrereleases: false,
};

export function readUpdatePreferences(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null,
): UpdatePreferences {
  if (!storage) return { ...DEFAULT_UPDATE_PREFERENCES };
  try {
    const raw = storage.getItem(UPDATE_PREFS_KEY);
    if (!raw) return { ...DEFAULT_UPDATE_PREFERENCES };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_UPDATE_PREFERENCES };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      checkOnLaunch: typeof obj.checkOnLaunch === "boolean" ? obj.checkOnLaunch : true,
      includePrereleases: typeof obj.includePrereleases === "boolean" ? obj.includePrereleases : false,
    };
  } catch {
    return { ...DEFAULT_UPDATE_PREFERENCES };
  }
}

export function saveUpdatePreferences(
  prefs: UpdatePreferences,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      UPDATE_PREFS_KEY,
      JSON.stringify({
        checkOnLaunch: Boolean(prefs.checkOnLaunch),
        includePrereleases: Boolean(prefs.includePrereleases),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function detectUpdatePlatform(
  ua: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): UpdatePlatform {
  if (/windows/i.test(ua)) return "windows";
  if (/macintosh|mac os x/i.test(ua)) return "macos";
  if (/linux/i.test(ua) && !/android/i.test(ua)) return "linux";
  return "other";
}

const cleanVersion = (tag: string) => tag.trim().replace(/^v/i, "");

const validParts = (version: string): number[] | null => {
  const parts = version.split(".");
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((part) => !/^\d{1,6}$/.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  return numbers.length === 2 ? [...numbers, 0] : numbers;
};

const validPrereleaseParts = (
  version: string,
): { core: number[]; pre: string | null } | null => {
  const dash = version.indexOf("-");
  if (dash < 0) {
    const core = validParts(version);
    return core ? { core, pre: null } : null;
  }
  const coreStr = version.slice(0, dash);
  const preStr = version.slice(dash + 1);
  const core = validParts(coreStr);
  if (!core || !preStr || preStr.length > 32 || preStr.includes("..") || !/^[A-Za-z0-9.-]+$/.test(preStr)) {
    return null;
  }
  return { core, pre: preStr };
};

export function newerVersion(candidate: string, current = APP_VERSION): boolean {
  const a = validParts(candidate);
  const b = validParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function newerReleaseVersion(
  candidate: string,
  current = APP_VERSION,
  includePrereleases = false,
): boolean {
  if (!includePrereleases) return newerVersion(candidate, current);
  const a = validPrereleaseParts(candidate);
  const b = validPrereleaseParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (a.pre === null && b.pre !== null) return true;
  if (a.pre !== null && b.pre === null) return false;
  if (a.pre !== null && b.pre !== null) return a.pre > b.pre;
  return false;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const validAsset = (
  asset: unknown,
  tag: string,
): { name: string; digest: string } | null => {
  if (!isObject(asset) || typeof asset.name !== "string") return null;
  const name = asset.name;
  if (
    !name ||
    name.length > 140 ||
    name.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    asset.browser_download_url !== `https://github.com/${REPO}/releases/download/${tag}/${name}`
  ) {
    return null;
  }
  const digest =
    typeof asset.digest === "string"
      ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest)?.[1].toLowerCase() ?? ""
      : "";
  return digest ? { name, digest } : null;
};

export function pickPlatformAsset(
  assets: unknown[],
  tag: string,
  version: string,
  platform: UpdatePlatform,
): UpdateAssetInfo | null {
  if (platform === "other") return null;
  const verified = assets
    .map((item) => validAsset(item, tag))
    .filter((item): item is { name: string; digest: string } => Boolean(item));
  if (!verified.length) return null;

  const matchOrder: RegExp[] =
    platform === "windows"
      ? [
          new RegExp(`^Comet-${version.replace(/\./g, "\\.")}-windows-setup\\.exe$`, "i"),
          /-setup\.exe$/i,
          /\.msi$/i,
          /\.exe$/i,
        ]
      : platform === "linux"
        ? [/_amd64\.deb$/i, /\.deb$/i, /\.AppImage$/i, /\.x86_64\.rpm$/i, /\.rpm$/i]
        : [/\.dmg$/i];

  for (const pattern of matchOrder) {
    const hit = verified.find((item) => pattern.test(item.name));
    if (hit) return { ...hit, platform };
  }
  return null;
}

export function newestUpdate(
  value: unknown,
  current = APP_VERSION,
  options?: { includePrereleases?: boolean; platform?: UpdatePlatform },
): UpdateInfo | null {
  if (!Array.isArray(value)) return null;
  const includePrereleases = Boolean(options?.includePrereleases);
  const platform = options?.platform ?? detectUpdatePlatform();
  let best: UpdateInfo | null = null;

  for (const item of value) {
    if (!isObject(item) || item.draft === true) continue;
    const isPre = item.prerelease === true;
    if (isPre && !includePrereleases) continue;
    if (typeof item.tag_name !== "string") continue;
    const rawTag = item.tag_name.trim();
    const version = cleanVersion(rawTag);
    const compareTarget = best?.version ?? current;
    if (!newerReleaseVersion(version, compareTarget, includePrereleases)) continue;

    const assets = Array.isArray(item.assets) ? item.assets : [];
    const expectedTag = rawTag.startsWith("v") || rawTag.startsWith("V") ? rawTag : `v${version}`;
    const windowsSetupName = `Comet-${version}-windows-setup.exe`;
    const winAsset = assets
      .map((asset) => validAsset(asset, expectedTag))
      .find((asset) => asset?.name === windowsSetupName) ?? null;
    const platformAsset = pickPlatformAsset(assets, expectedTag, version, platform);

    const releaseUrl =
      typeof item.html_url === "string" &&
      item.html_url.startsWith(`https://github.com/${REPO}/releases/tag/`)
        ? item.html_url
        : RELEASES_URL;

    best = {
      version,
      tag: expectedTag,
      url: releaseUrl,
      page: releaseUrl,
      notes: typeof item.body === "string" ? item.body.trim().slice(0, 600) : "",
      prerelease: isPre,
      publishedAt: typeof item.published_at === "string" ? item.published_at : "",
      installer: winAsset,
      platformAsset,
    };
  }
  return best;
}

export async function checkForUpdates(
  current = APP_VERSION,
  options?: { includePrereleases?: boolean; platform?: UpdatePlatform; signal?: AbortSignal },
): Promise<UpdateInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=25`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Couldn't check GitHub releases right now.");
    return newestUpdate(await response.json(), current, options);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export function checkUpdates(
  current = APP_VERSION,
  signalOrOptions?: AbortSignal | { includePrereleases?: boolean; platform?: UpdatePlatform; signal?: AbortSignal },
): Promise<UpdateInfo | null> {
  if (signalOrOptions && "aborted" in signalOrOptions) {
    return checkForUpdates(current, { signal: signalOrOptions });
  }
  return checkForUpdates(current, signalOrOptions);
}
