import {
  siAirbnb, siAliexpress, siAnthropic, siApple, siBitwarden, siBluesky,
  siBookingdotcom, siClaude, siCloudflare, siDiscord, siDropbox, siDuolingo,
  siEbay, siEtsy, siFacebook, siFigma, siGithub, siGitlab, siGmail, siGoogle,
  siIcloud, siInstagram, siMastodon, siNetflix, siNotion, siPaypal, siPinterest,
  siPlaystation, siProton, siReddit, siRevolut, siShopify, siSignal, siSnapchat,
  siSpotify, siStackoverflow, siSteam, siTelegram, siTiktok, siTrello, siTuta,
  siTwitch, siUber, siWhatsapp, siWikipedia, siWise, siX, siYoutube, siZoom,
  type SimpleIcon,
} from "simple-icons";
import { faviconUrl, siteIconHost } from "./passwords";

// Locally bundled, so these work offline and need no external request. The
// explicit host list avoids guessing that unrelated sites share a brand.
const brands: Array<[string[], SimpleIcon]> = [
  [["gmail.com", "mail.google.com"], siGmail], [["youtube.com", "youtu.be"], siYoutube],
  [["google.com"], siGoogle], [["icloud.com"], siIcloud], [["apple.com"], siApple],
  [["spotify.com"], siSpotify], [["netflix.com"], siNetflix], [["instagram.com"], siInstagram],
  [["facebook.com", "fb.com"], siFacebook], [["x.com", "twitter.com"], siX],
  [["github.com"], siGithub], [["gitlab.com"], siGitlab], [["discord.com", "discord.gg"], siDiscord],
  [["reddit.com"], siReddit], [["tiktok.com"], siTiktok], [["pinterest.com"], siPinterest],
  [["twitch.tv"], siTwitch], [["paypal.com"], siPaypal], [["ebay.com"], siEbay],
  [["notion.so", "notion.com"], siNotion], [["dropbox.com"], siDropbox], [["cloudflare.com"], siCloudflare],
  [["telegram.org", "t.me"], siTelegram], [["uber.com"], siUber], [["zoom.us"], siZoom],
  [["bitwarden.com"], siBitwarden], [["proton.me", "protonmail.com"], siProton], [["figma.com"], siFigma],
  [["stackoverflow.com"], siStackoverflow], [["steampowered.com", "steamcommunity.com"], siSteam],
  [["airbnb.com"], siAirbnb], [["wikipedia.org"], siWikipedia], [["anthropic.com"], siAnthropic],
  [["claude.ai"], siClaude], [["trello.com"], siTrello], [["tuta.com", "tutanota.com"], siTuta],
  [["revolut.com"], siRevolut], [["wise.com"], siWise], [["playstation.com"], siPlaystation],
  [["booking.com"], siBookingdotcom], [["aliexpress.com"], siAliexpress], [["shopify.com"], siShopify],
  [["signal.org"], siSignal], [["whatsapp.com"], siWhatsapp], [["snapchat.com"], siSnapchat],
  [["joinmastodon.org"], siMastodon], [["bsky.app"], siBluesky], [["etsy.com"], siEtsy],
  [["duolingo.com"], siDuolingo],
];

export type SiteIconSource =
  | { kind: "local"; icon: SimpleIcon }
  | { kind: "brandfetch" | "duckduckgo" | "google"; url: string; referrerPolicy: "origin" | "no-referrer" };

// This identifier is public, project-owned configuration, not a user secret.
// In tests or source builds import.meta.env may be absent.
const configuredClientId = import.meta.env?.VITE_BRANDFETCH_CLIENT_ID ?? "";

/** Ordered fallbacks; only the hostname from the website is included. */
export function siteIconSources(website: string, clientId = configuredClientId): SiteIconSource[] {
  const host = siteIconHost(website); if (!host) return [];
  const sources: SiteIconSource[] = [];
  // Brandfetch requires a client ID and an origin-bearing Referer, and must be
  // hotlinked. A 404 explicitly lets the next provider/local icon take over.
  if (/^[a-zA-Z0-9_-]{1,200}$/.test(clientId)) {
    sources.push({ kind: "brandfetch", url: `https://cdn.brandfetch.io/domain/${encodeURIComponent(host)}/w/64/h/64/fallback/404/icon?c=${encodeURIComponent(clientId)}`, referrerPolicy: "origin" });
  }
  const local = brands.find(([domains]) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`)))?.[1];
  if (local) sources.push({ kind: "local", icon: local });
  sources.push({ kind: "duckduckgo", url: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`, referrerPolicy: "no-referrer" });
  const google = faviconUrl(website);
  if (google) sources.push({ kind: "google", url: google, referrerPolicy: "no-referrer" });
  return sources;
}

export const brandfetchConfigured = /^[a-zA-Z0-9_-]{1,200}$/.test(configuredClientId);
