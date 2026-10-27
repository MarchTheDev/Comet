/** Public GitHub release checks: drafts/prereleases are not offered. */
export interface UpdateInfo { version: string; page: string; installer: { name: string; digest: string } | null }
const repository = "https://github.com/MarchTheDev/Comet";
const api = "https://api.github.com/repos/MarchTheDev/Comet/releases?per_page=30";
function versionParts(value: string): number[] | null {
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) return null;
  return value.split(".").map(Number);
}
export function newerVersion(a: string, b: string): boolean {
  const left = versionParts(a), right = versionParts(b); if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}
export function newestUpdate(value: unknown, current: string): UpdateInfo | null {
  if (!Array.isArray(value)) return null;
  let best: UpdateInfo | null = null;
  for (const release of value) {
    if (!release || typeof release !== "object" || release.draft || release.prerelease || typeof release.tag_name !== "string") continue;
    const version = release.tag_name.replace(/^v/, "");
    if (!newerVersion(version, best?.version ?? current)) continue;
    const filename = `Comet-${version}-windows_setup.exe`;
    const asset = Array.isArray(release.assets) ? release.assets.find((item: { name?: unknown; digest?: unknown; browser_download_url?: unknown }) => item && item.name === filename && typeof item.digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(item.digest) && item.browser_download_url === `${repository}/releases/download/v${version}/${filename}`) : null;
    best = { version, page: `${repository}/releases/tag/v${version}`, installer: asset ? { name: filename, digest: asset.digest.toLowerCase().slice(7) } : null };
  }
  return best;
}
export async function checkUpdates(current: string, signal?: AbortSignal): Promise<UpdateInfo | null> {
  const response = await fetch(api, { headers: { Accept: "application/vnd.github+json" }, signal, credentials: "omit" });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
  return newestUpdate(await response.json(), current);
}
