import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  discoverFeedUrlFromHtml,
  exportOpmlFeeds,
  extractReadableArticleFromHtml,
  normalizeFeedUrl,
  parseFeedDocument,
  parseOpmlFeeds,
  readRssState,
  rssErrorMessage,
  STARTER_RSS_FEEDS,
} from '../src/utils/rss.ts';
import { RssView } from '../src/RssView.tsx';

console.log('\nRSS reader & custom feeds');
let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    console.error(`  FAIL ${name}`);
    failures += 1;
  }
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
dom.window.HTMLElement.prototype.attachEvent = function (name, listener) {
  this.addEventListener(name.replace(/^on/, ''), listener);
};
dom.window.HTMLElement.prototype.detachEvent = function (name, listener) {
  this.removeEventListener(name.replace(/^on/, ''), listener);
};
const prevGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  DOMParser: globalThis.DOMParser,
  XMLSerializer: globalThis.XMLSerializer,
  Node: globalThis.Node,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  SVGElement: globalThis.SVGElement,
  HTMLInputElement: globalThis.HTMLInputElement,
  MouseEvent: globalThis.MouseEvent,
  KeyboardEvent: globalThis.KeyboardEvent,
  PointerEvent: globalThis.PointerEvent,
  navigator: globalThis.navigator,
  fetch: globalThis.fetch,
};

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
if (!dom.window.PointerEvent) {
  dom.window.PointerEvent = dom.window.MouseEvent;
}
globalThis.PointerEvent = dom.window.PointerEvent;

// 1. Sidebar placement & full-screen viewport lock
const appSrc = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const cssSrc = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const calNavIdx = appSrc.indexOf('showOverview("calendar")');
const rssNavIdx = appSrc.indexOf('showOverview("rss")');
const passNavIdx = appSrc.indexOf('showOverview("passwords")');
check(
  'RSS navigation item is placed directly below Calendar in the primary sidebar',
  calNavIdx > 0 && rssNavIdx > calNavIdx && passNavIdx > rssNavIdx,
);
check(
  'RSS view locks outer workspace-scroll overflow on desktop/full-screen so only inner panes scroll',
  appSrc.includes('workspaceView === "rss" ? " rss-viewport" : ""') &&
    cssSrc.includes('.workspace-scroll.rss-viewport') &&
    cssSrc.includes('overflow: hidden;'),
);

// 2. Starter feeds exclude Tauri Releases and Rust Releases
check(
  'starter RSS feeds exclude Tauri Releases and Rust Releases',
  STARTER_RSS_FEEDS.length > 0 &&
    !STARTER_RSS_FEEDS.some((f) => /tauri|rust/i.test(f.name)),
);

// 3. RSS 2.0 (including HTML named entities & bare ampersands), Atom 1.0, JSON Feed 1.1, XSS sanitization
const sampleRssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Orbit R&D &mdash; Engineering</title>
    <link>https://engineering.example.com</link>
    <image><url>https://engineering.example.com/logo.png</url></image>
    <item>
      <title>Shipping Comet RSS &nbsp; Reader</title>
      <link>https://engineering.example.com/posts/comet-rss</link>
      <guid>post-001</guid>
      <dc:creator>Marco</dc:creator>
      <pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate>
      <category>Release</category>
      <description>Short summary of the release.</description>
      <content:encoded><![CDATA[
        <h2>Highlights</h2>
        <p>${'Fast local RSS reading inside Comet with full post rendering. '.repeat(20)}</p>
        <script>window.__hacked = true;</script>
        <iframe src="https://evil.example.com"></iframe>
        <ul><li>Custom names</li><li>Custom icons</li></ul>
      ]]></content:encoded>
    </item>
  </channel>
</rss>`;

const parsedRss = parseFeedDocument(sampleRssXml, 'https://engineering.example.com/rss.xml');
check(
  'parses RSS 2.0 feeds (repairing HTML entities & stray ampersands) and strips unsafe tags',
  parsedRss.title.includes('Orbit R&D') &&
    parsedRss.iconUrl === 'https://engineering.example.com/logo.png' &&
    parsedRss.items.length === 1 &&
    parsedRss.items[0].title === 'Shipping Comet RSS Reader' &&
    parsedRss.items[0].author === 'Marco' &&
    parsedRss.items[0].blocks.some((b) => b.kind === 'heading' && b.text === 'Highlights') &&
    parsedRss.items[0].blocks.some((b) => b.kind === 'list' && b.items.includes('Custom icons')) &&
    !JSON.stringify(parsedRss).includes('__hacked') &&
    !JSON.stringify(parsedRss).includes('evil.example.com'),
);

// 4. Hacker News / link-aggregator stub parsing + full webpage Readability extraction
const sampleHnRssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Hacker News: Front Page</title>
    <link>https://news.ycombinator.com/</link>
    <item>
      <title>Designing Local-First Software</title>
      <link>https://journal.example.org/local-first</link>
      <comments>https://news.ycombinator.com/item?id=424242</comments>
      <guid>https://news.ycombinator.com/item?id=424242</guid>
      <pubDate>Tue, 10 Nov 2026 11:00:00 GMT</pubDate>
      <description><![CDATA[
        <p>Article URL: <a href="https://journal.example.org/local-first">https://journal.example.org/local-first</a></p>
        <p>Comments URL: <a href="https://news.ycombinator.com/item?id=424242">https://news.ycombinator.com/item?id=424242</a></p>
        <p>Points: 318</p>
        <p># Comments: 142</p>
      ]]></description>
    </item>
  </channel>
</rss>`;

const parsedHn = parseFeedDocument(sampleHnRssXml, 'https://hnrss.org/frontpage');
check(
  'strips raw "Article URL" / "Comments URL" boilerplate from Hacker News items into clean metadata',
  parsedHn.items.length === 1 &&
    parsedHn.items[0].url === 'https://journal.example.org/local-first' &&
    parsedHn.items[0].commentsUrl === 'https://news.ycombinator.com/item?id=424242' &&
    parsedHn.items[0].points === 318 &&
    parsedHn.items[0].commentCount === 142 &&
    parsedHn.items[0].blocks.length === 0 &&
    !parsedHn.items[0].summary.includes('Article URL'),
);

const sampleFullArticleHtml = `<!doctype html>
<html>
  <head>
    <meta property="og:image" content="https://journal.example.org/hero.jpg" />
  </head>
  <body>
    <nav class="site-navbar"><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
    <article class="post-content">
      <h1>Designing Local-First Software</h1>
      <p>Local-first apps keep your data fast, private, and available offline on your own machine.</p>
      <h2>Why Ownership Matters</h2>
      <p>Even if a cloud service shuts down years from now, your plain files remain readable and yours forever.</p>
    </article>
    <aside class="sidebar-newsletter"><p>Subscribe to our newsletter</p></aside>
  </body>
</html>`;

const extractedArticle = extractReadableArticleFromHtml(
  sampleFullArticleHtml,
  'https://journal.example.org/local-first',
  'Designing Local-First Software',
);
check(
  'extracts full readable post blocks from web HTML while stripping navbars and sidebars',
  extractedArticle.heroImage === 'https://journal.example.org/hero.jpg' &&
    extractedArticle.blocks.some(
      (b) => b.kind === 'paragraph' && b.text.includes('Local-first apps keep your data fast'),
    ) &&
    extractedArticle.blocks.some(
      (b) => b.kind === 'heading' && b.text === 'Why Ownership Matters',
    ) &&
    !JSON.stringify(extractedArticle.blocks).includes('Subscribe to our newsletter'),
);

// 4b. VulnCheck slug-bundle / Next.js images + empty-top-left-header table + GitHub litedram table + MoreThanTech metadata/Ads cleanup
const tauriConf = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
);
check(
  'Comet default window width is widened for comfortable non-fullscreen RSS reading',
  tauriConf.app.windows[0].width >= 1440 && tauriConf.app.windows[0].height >= 840,
);

const vulnCheckHtml = `<!doctype html>
<html>
  <body>
    <article>
      <a href="/blog">Go back</a>
      <p>November 9, 2026</p>
      <h1>After 7-months, Glasswing Overwelms Maintainers with Underwhelming Findings</h1>
      <img src="https://ca.slack-edge.com/T02P16KHNRY-U06EPQ5RXFU-475c2549c30d-512" alt="Patrick Garrity" />
      <p><a href="https://www.linkedin.com/in/patrickmgarrity/">Patrick Garrity</a></p>
      <p>in/patrickmgarrity/</p>
      <img src="anthropic-ledger-november-update.png" alt="Anthropic November Ledger Update" />
      <p>The trend since my September update is even more telling:</p>
      <table>
        <thead>
          <tr><th></th><th>September 8</th><th>November 2</th><th>Change</th></tr>
        </thead>
        <tbody>
          <tr><td>Total findings</td><td>26,153</td><td>37,966</td><td>+11,813</td></tr>
          <tr><td>Fixed</td><td>202</td><td>217</td><td>+15</td></tr>
        </tbody>
      </table>
      <img srcset="/_next/image?url=%2Fblog%2Fanthropic-glasswing-november-update%2Fcurl-vulns-none.png&amp;w=1920&amp;q=75 2x" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Curl Vulnerabilities" />
    </article>
  </body>
</html>`;

const extractedVuln = extractReadableArticleFromHtml(
  vulnCheckHtml,
  'https://www.vulncheck.com/blog/anthropic-glasswing-november-update',
  'After 7-months, Glasswing Overwelms Maintainers with Underwhelming Findings',
);
const vulnTable = extractedVuln.blocks.find((b) => b.kind === 'table');
const vulnImages = extractedVuln.blocks.filter((b) => b.kind === 'image');
check(
  'resolves slug-bundle and Next.js _next/image URLs and preserves comparison tables with empty top-left header cells',
  vulnImages.some(
    (img) =>
      img.url ===
      'https://www.vulncheck.com/blog/anthropic-glasswing-november-update/anthropic-ledger-november-update.png',
  ) &&
    vulnImages.some(
      (img) =>
        img.url ===
        'https://www.vulncheck.com/blog/anthropic-glasswing-november-update/curl-vulns-none.png',
    ) &&
    Boolean(vulnTable) &&
    vulnTable.headers.length === 4 &&
    vulnTable.headers[0] === '' &&
    vulnTable.headers[1] === 'September 8' &&
    vulnTable.rows[0][0] === 'Total findings' &&
    vulnTable.rows[0][3] === '+11,813',
);

const litedramHtml = `<!doctype html>
<html>
  <body>
    <article class="markdown-body entry-content">
      <div class="markdown-heading"><h2>The signals {#iface-signals}</h2><a class="anchor" href="#the-signals">Permalink</a></div>
      <p>A DRAM interface has two halves: command/address and bidirectional data lanes with strobes.</p>
      <markdown-accessiblity-table>
        <table>
          <thead><tr><th>Signal</th><th>Direction</th><th>Role</th></tr></thead>
          <tbody>
            <tr><td>CK, CK#</td><td>To the DRAM</td><td>Differential clock</td></tr>
            <tr><td>DQS, DQS#</td><td>Both</td><td>Data strobe</td></tr>
          </tbody>
        </table>
      </markdown-accessiblity-table>
    </article>
  </body>
</html>`;

const extractedLitedram = extractReadableArticleFromHtml(
  litedramHtml,
  'https://github.com/enjoy-digital/litedram/blob/master/doc/manual/03_dram_interface.md',
);
check(
  'parses GitHub markdown-accessiblity-table elements and strips heading {#id} and permalink anchors',
  extractedLitedram.blocks.some((b) => b.kind === 'heading' && b.text === 'The signals') &&
    extractedLitedram.blocks.some(
      (b) =>
        b.kind === 'table' &&
        b.headers[0] === 'Signal' &&
        b.rows.length === 2 &&
        b.rows[0][0] === 'CK, CK#',
    ),
);

const moreThanTechHtml = `<!doctype html>
<html>
  <body>
    <article>
      <img src="https://morethantech.it/images/publications/5156/f1123cd4-890e-4a2c-b81a-b0505c1baba2.jpeg" alt="Thumbnail" />
      <div><a href="/autori/30_alessandro-trezzi"><img src="https://morethantech.it/images/users/alexrnr841.jpeg" />Alessandro Trezzi</a></div>
      <h1>AMD si definisce ufficialmente un'azienda ''data center-first''</h1>
      <p>Ieri alle 7:40</p>
      <span class="hidden">/pubblicazioni/5156_amd-si-definisce-ufficialmente-unazienda-data-centerfirst</span>
      <p>Alessandro Trezzi</p>
      <p>/autori/30_alessandro-trezzi</p>
      <p>1794296406097</p>
      <p>A confermarlo è stata la CEO Lisa Su durante un'intervista a Yahoo Finance, nella quale ha definito apertamente l'azienda una realtà "data center first", sottolineando quanto la domanda di potenza di calcolo stia accelerando.</p>
      <div>Ads</div>
      <p>I numeri spiegano questa direzione: nel terzo trimestre del 2026 la divisione Data Center ha generato 8,55 miliardi di dollari.</p>
      <p>Fonte: <a href="https://www.tweaktown.com">TweakTown</a></p>
      <div>Ads</div>
      <h3>Condividi</h3>
      <p><a href="https://www.facebook.com/sharer.php?u=x">Condividi su Facebook</a></p>
      <h3>Suggeriti</h3>
      <p>Altro articolo correlato</p>
    </article>
  </body>
</html>`;

const extractedMtt = extractReadableArticleFromHtml(
  moreThanTechHtml,
  'https://morethantech.it/pubblicazioni/5156_amd-si-definisce-ufficialmente-unazienda-data-centerfirst',
  "AMD si definisce ufficialmente un'azienda ''data center-first''",
);
const mttJson = JSON.stringify(extractedMtt.blocks);
check(
  'strips MoreThanTech leading paths/timestamps/duplicate author, removes "Ads", and cuts off trailing Condividi/Suggeriti',
  extractedMtt.author === 'Alessandro Trezzi' &&
    extractedMtt.blocks.some(
      (b) => b.kind === 'paragraph' && b.text.startsWith('A confermarlo è stata la CEO Lisa Su'),
    ) &&
    extractedMtt.blocks.some((b) => b.kind === 'paragraph' && b.text.includes('Fonte: TweakTown')) &&
    !mttJson.includes('Ieri alle 7:40') &&
    !mttJson.includes('/pubblicazioni/5156') &&
    !mttJson.includes('/autori/30_alessandro-trezzi') &&
    !mttJson.includes('1794296406097') &&
    !extractedMtt.blocks.some((b) => 'text' in b && b.text.trim() === 'Ads') &&
    !mttJson.includes('Suggeriti'),
);

// 4f. Nieman Lab-style WordPress layout: hyphenated wrapper classes ("has-sidebar comments-open"),
// "noprint" + scroll-reveal opacity:0, pre-H1 newsletter box, curly apostrophe H1, AP timestamp, and report charts
const niemanLabHtml = `<!doctype html>
<html>
  <head>
    <meta name="author" content="Felix M. Simon">
    <meta property="og:image" content="https://www.niemanlab.org/images/BetterImagesofAI_Wilkowski.jpg">
  </head>
  <body class="single-post has-sidebar comments-open has-newsletter">
    <div id="page" class="site-wrapper with-sidebar noprint-header">
      <main id="primary" class="content-area has-sidebar">
        <article class="post type-post noprint-borders" style="opacity: 0; transition: opacity 0.3s">
          <div class="newsletter-box">
            <p>Get Nieman Lab in your inbox.</p>
          </div>
          <h1>AI is becoming an information gateway. Audiences still don’t want it making their news.</h1>
          <p><img src="/images/BetterImagesofAI_Wilkowski.jpg" alt=""></p>
          <p>(Marcin Wilkowski/ Better Images of AI/ Creative Commons)</p>
          <p>By <a href="https://www.niemanlab.org/author/fsimon/">Felix M. Simon</a></p>
          <p>Nov. 10, 2026, 11:47 a.m.</p>
          <div class="entry-content">
            <p>Generative AI use is widespread across the six countries surveyed (Argentina, Denmark, France, Japan, the UK, and the USA), driven mostly by standalone chatbots and search integrations.</p>
            <p>Weekly AI use for news jumped markedly between 2025 and 2026, doubling from 12% to 24% across all countries surveyed.</p>
            <figure>
              <img src="/images/GenAI-2026.001-e1794348224605.png" alt="Weekly GenAI use chart">
            </figure>
            <p>Audiences across countries continue to strongly prefer news produced primarily by humans rather than fully automated AI newsrooms.</p>
          </div>
        </article>
      </main>
    </div>
  </body>
</html>`;

const extractedNieman = extractReadableArticleFromHtml(
  niemanLabHtml,
  'https://www.niemanlab.org/2026/11/ai-is-becoming-an-information-gateway-audiences-still-dont-want-it-making-their-news/',
  "AI is becoming an information gateway. Audiences still don't want it making their news.",
);
const niemanJson = JSON.stringify(extractedNieman.blocks);
check(
  'extracts Nieman Lab full article & charts without deleting has-sidebar/comments-open/noprint wrappers or keeping pre-H1 newsletter/AP timestamp clutter',
  extractedNieman.author === 'Felix M. Simon' &&
    extractedNieman.blocks.some(
      (b) => b.kind === 'paragraph' && b.text.includes('Generative AI use is widespread across the six countries surveyed'),
    ) &&
    extractedNieman.blocks.some(
      (b) => b.kind === 'image' && b.url === 'https://www.niemanlab.org/images/GenAI-2026.001-e1794348224605.png',
    ) &&
    !niemanJson.includes('Get Nieman Lab in your inbox') &&
    !niemanJson.includes('Nov. 10, 2026, 11:47 a.m.') &&
    !extractedNieman.blocks.some((b) => b.kind === 'paragraph' && b.text.trim() === 'By Felix M. Simon'),
);

// 5. Atom xhtml content, JSON Feed, feed discovery, OPML, and Tauri plain-string error formatting
const sampleAtomXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Systems Weekly</title>
  <link rel="alternate" href="https://systems.example.org/"/>
  <icon>https://systems.example.org/favicon.ico</icon>
  <entry>
    <title>Zero-Copy Parsing</title>
    <link href="https://systems.example.org/zero-copy"/>
    <id>tag:systems.example.org,2026:zero-copy</id>
    <updated>2026-11-01T12:00:00Z</updated>
    <author><name>Ada</name></author>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><h2>Overview</h2><p>Zero-copy slices avoid allocations.</p></div></content>
  </entry>
</feed>`;

const parsedAtom = parseFeedDocument(sampleAtomXml, 'https://systems.example.org/feed.xml');
check(
  'parses Atom 1.0 feeds including inline type="xhtml" structured blocks',
  parsedAtom.title === 'Systems Weekly' &&
    parsedAtom.items.length === 1 &&
    parsedAtom.items[0].blocks.some((b) => b.kind === 'heading' && b.text === 'Overview') &&
    parsedAtom.items[0].blocks.some(
      (b) => b.kind === 'paragraph' && b.text.includes('Zero-copy slices'),
    ) &&
    rssErrorMessage('Feed returned HTTP 503.') === 'Feed returned HTTP 503.',
);

const sampleJsonFeed = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Design Notes',
  home_page_url: 'https://design.example.org',
  icon: 'https://design.example.org/icon.png',
  items: [
    {
      id: 'dn-1',
      url: 'https://design.example.org/typography',
      title: 'Calm Typography',
      content_html: '<p>Readable line lengths make feeds pleasant.</p>',
      date_published: '2026-11-09T09:30:00Z',
      authors: [{ name: 'Elena' }],
    },
  ],
});
const parsedJson = parseFeedDocument(sampleJsonFeed, 'https://design.example.org/feed.json');
const discovered = discoverFeedUrlFromHtml(
  '<html><head><link rel="alternate" type="application/rss+xml" href="/blog/rss.xml"></head></html>',
  'https://example.org/about',
);
const opmlXml = exportOpmlFeeds(
  [
    {
      id: 'f1',
      name: 'My Custom Feed Name',
      url: 'https://systems.example.org/feed.xml',
      siteUrl: 'https://systems.example.org/',
      feedIconUrl: '',
      icon: { kind: 'emoji', value: '🚀' },
      color: '#d97757',
      lastFetchedAt: '',
      lastError: '',
    },
  ],
  'Personal',
);
const reimported = parseOpmlFeeds(opmlXml);
check(
  'supports JSON Feed 1.1, HTML feed discovery, and OPML 2.0 round-trip',
  parsedJson.title === 'Design Notes' &&
    discovered === 'https://example.org/blog/rss.xml' &&
    normalizeFeedUrl('feed://example.org/rss.xml') === 'https://example.org/rss.xml' &&
    reimported.length === 1 &&
    reimported[0].name === 'My Custom Feed Name',
);

// 6. Interactive RssView UI: custom feed add/edit, auto full-post loading for HN stubs, no Save-as-note button, and Export save picker
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes('hnrss.org')) {
    return {
      ok: true,
      status: 200,
      url: 'https://hnrss.org/frontpage',
      headers: { get: () => 'application/rss+xml' },
      text: async () => sampleHnRssXml,
    };
  }
  if (href.includes('journal.example.org/local-first')) {
    return {
      ok: true,
      status: 200,
      url: 'https://journal.example.org/local-first',
      headers: { get: () => 'text/html' },
      text: async () => sampleFullArticleHtml,
    };
  }
  return {
    ok: true,
    status: 200,
    url: 'https://engineering.example.com/rss.xml',
    headers: { get: () => 'application/rss+xml' },
    text: async () => sampleRssXml,
  };
};

let savedPickerPayload = '';
dom.window.showSaveFilePicker = async (opts) => ({
  name: opts?.suggestedName ?? 'comet-feeds.opml',
  createWritable: async () => ({
    write: async (data) => {
      savedPickerPayload = String(data);
    },
    close: async () => {},
  }),
});

const root = createRoot(document.getElementById('root'));
await act(async () => {
  root.render(
    React.createElement(RssView, {
      vault: '/vault/alpha',
      name: 'Alpha',
    }),
  );
});

const setReactInput = (input, value) => {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  const propEvt = new dom.window.Event('propertychange', { bubbles: true });
  Object.defineProperty(propEvt, 'propertyName', { value: 'value' });
  input.dispatchEvent(propEvt);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

// Subscribe to Hacker News feed with custom name & emoji icon
const addBtn = [...document.querySelectorAll('.rss-heading-actions button')].find((b) =>
  b.textContent.includes('Add feed'),
);
await act(async () => addBtn.click());

const urlInput = document.querySelector('#rss-feed-url');
const nameInput = document.querySelector('#rss-feed-name');
await act(async () => {
  setReactInput(urlInput, 'https://hnrss.org/frontpage');
  setReactInput(nameInput, 'HN Top Stories');
});
const emojiTab = [...document.querySelectorAll('.rss-icon-mode-tabs button')].find(
  (b) => b.textContent.trim() === 'Emoji',
);
await act(async () => emojiTab.click());
const rocketBtn = [...document.querySelectorAll('.rss-emoji-picker button')].find(
  (b) => b.textContent.trim() === '🚀',
);
await act(async () => rocketBtn.click());

const modalForm = document.querySelector('.rss-feed-modal');
await act(async () => {
  modalForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));
});

const readerText = document.querySelector('.rss-reader-body')?.textContent ?? '';
const readerButtonsText = [...document.querySelectorAll('.rss-reader-actions button')]
  .map((b) => b.textContent.trim())
  .join(' | ');

check(
  'automatically loads and renders full article post for Hacker News items, and omits Excerpt, Comments, and Save as note buttons',
  readerText.includes('Local-first apps keep your data fast, private, and available offline') &&
    readerText.includes('Why Ownership Matters') &&
    !readerText.includes('Article URL:') &&
    !readerText.includes('Comments URL:') &&
    readerButtonsText.includes('Open original') &&
    !readerButtonsText.includes('Comments') &&
    !readerButtonsText.includes('Excerpt') &&
    !readerButtonsText.includes('Full post') &&
    !readerButtonsText.includes('Save as note'),
);

// Edit the feed's name and switch its icon to a custom preset icon
const editFeedBtn = document.querySelector('button[aria-label="Edit HN Top Stories"]');
await act(async () => editFeedBtn.click());
const editNameInput = document.querySelector('#rss-feed-name');
await act(async () => {
  setReactInput(editNameInput, 'Renamed HN Feed');
});
const presetTab = [...document.querySelectorAll('.rss-icon-mode-tabs button')].find(
  (b) => b.textContent.trim() === 'Icon',
);
await act(async () => presetTab.click());
const terminalPresetBtn = document.querySelector('button[aria-label="Use terminal icon"]');
await act(async () => terminalPresetBtn.click());
const editModalForm = document.querySelector('.rss-feed-modal');
await act(async () => {
  editModalForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
});

const storedAfterEdit = readRssState('/vault/alpha');
const otherVaultState = readRssState('/vault/beta');
check(
  'edits custom feed name & icon in place and scopes subscriptions per workspace',
  storedAfterEdit.state.feeds[0].name === 'Renamed HN Feed' &&
    storedAfterEdit.state.feeds[0].icon.kind === 'preset' &&
    storedAfterEdit.state.feeds[0].icon.preset === 'terminal' &&
    otherVaultState.state.feeds.length === 0,
);

// Export OPML prompts for save location via save file picker
const exportBtn = [...document.querySelectorAll('.rss-heading-actions button')].find((b) =>
  b.textContent.includes('Export'),
);
await act(async () => {
  exportBtn.click();
  await new Promise((r) => setTimeout(r, 20));
});
check(
  'Export button opens the file save picker dialog to choose export destination',
  savedPickerPayload.includes('<opml version="2.0">') &&
    savedPickerPayload.includes('Renamed HN Feed'),
);

await act(async () => root.unmount());
dom.window.close();
delete globalThis.IS_REACT_ACT_ENVIRONMENT;
for (const [k, v] of Object.entries(prevGlobals)) {
  if (k === 'navigator') {
    Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true });
  } else if (v === undefined) {
    delete globalThis[k];
  } else {
    globalThis[k] = v;
  }
}

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
