import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VideoPlayer } from "../MediaPlayer";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { isEmbedDismissed, setEmbedDismissed, subscribeDismissedEmbeds } from "./linkEmbeds";
import { videoLink, type VideoLink } from "./links";

const roots = new WeakMap<Node, Root>();
function player(video: VideoLink, onDismiss: () => void): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "inline-video";
  wrap.contentEditable = "false";
  wrap.addEventListener("pointerdown", (event) => event.stopPropagation());
  if (video.kind === "youtube") {
    const frame = document.createElement("iframe");
    frame.title = `YouTube video ${video.id}`;
    frame.src = `https://www.youtube-nocookie.com/embed/${video.id}`;
    frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    wrap.appendChild(frame);
  } else {
    const inner = document.createElement("div");
    wrap.appendChild(inner);
    const root = createRoot(inner);
    roots.set(wrap, root);
    root.render(createElement(VideoPlayer, { url: video.url, name: "Linked video" }));
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "comet-link-embed-dismiss inline-video-dismiss";
  dismiss.setAttribute("aria-label", "Remove video preview");
  dismiss.title = "Remove embed";
  dismiss.textContent = "×";
  dismiss.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  });
  wrap.appendChild(dismiss);
  return wrap;
}

function decorations(doc: ProseMirrorNode, getScope: () => string, refresh: () => void): DecorationSet {
  const widgets: Decoration[] = [];
  const counts = new Map<string, number>();
  const scope = getScope();
  const add = (pos: number, url: string) => {
    if (widgets.length >= 50) return;
    if (isEmbedDismissed(scope, url)) return;
    const link = videoLink(url);
    if (!link) return;
    const identity = link.kind === "youtube" ? `youtube:${link.id}` : `video:${link.url}`;
    const occurrence = counts.get(identity) ?? 0;
    counts.set(identity, occurrence + 1);
    widgets.push(
      Decoration.widget(
        pos,
        () =>
          player(link, () => {
            setEmbedDismissed(getScope(), url, true);
            refresh();
          }),
        {
          key: `${scope}:${identity}:${occurrence}`,
          side: 1,
          marks: [],
          ignoreSelection: true,
          destroy: (node) => {
            const root = roots.get(node);
            if (root) {
              roots.delete(node);
              queueMicrotask(() => root.unmount());
            }
          },
        },
      ),
    );
  };
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isTextblock) return;
    let pendingUrl = "";
    let pendingEnd = 0;
    const flush = () => {
      if (pendingUrl) add(pendingEnd, pendingUrl);
      pendingUrl = "";
    };
    node.forEach((child, offset) => {
      const href = child.marks.find((mark) => mark.type.name === "link")?.attrs.href;
      if (typeof href === "string") {
        if (pendingUrl && pendingUrl !== href) flush();
        pendingUrl = href;
        pendingEnd = pos + 1 + offset + child.nodeSize;
      } else {
        flush();
        if (!child.isText || !child.text) return;
        const matcher = /(?<!<)https?:\/\/[^\s<>()\]]+/gi;
        for (const match of child.text.matchAll(matcher)) {
          const url = match[0].replace(/[.,!?]+$/, "");
          add(pos + 1 + offset + (match.index ?? 0) + url.length, url);
        }
      }
    });
    flush();
    return false;
  });
  return DecorationSet.create(doc, widgets);
}

const videoKey = new PluginKey<DecorationSet>("cometVideoEmbeds");

export interface VideoEmbedsOptions {
  getScope?: () => string;
}

/** Widgets are editor decorations, not document nodes: the Markdown remains
 * untouched, and stable keys preserve the iframe while unrelated text changes. */
export const VideoEmbeds = Extension.create<VideoEmbedsOptions>({
  name: "cometVideoEmbeds",
  addOptions() {
    return {
      getScope: () => "__note__",
    };
  },
  addProseMirrorPlugins() {
    const getScope = () => this.options.getScope?.() ?? "__note__";
    const editor = this.editor;
    const refresh = () => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(videoKey, true).setMeta("addToHistory", false));
    };
    return [
      new Plugin({
        key: videoKey,
        state: {
          init: (_, state) => decorations(state.doc, getScope, refresh),
          apply: (transaction, old) =>
            transaction.docChanged || Boolean(transaction.getMeta(videoKey))
              ? decorations(transaction.doc, getScope, refresh)
              : old.map(transaction.mapping, transaction.doc),
        },
        props: { decorations: (state) => videoKey.getState(state) ?? null },
        view: () => {
          const unsubscribe = subscribeDismissedEmbeds(refresh);
          return {
            destroy() {
              unsubscribe();
            },
          };
        },
      }),
    ];
  },
});
