import type { Point } from "./todoGeometry";

/**
 * The connector dot on a board card follows the pointer round the card's edge,
 * so a connection can be started from whichever side is nearest instead of
 * from one fixed spot.
 *
 * The dot sits just outside the border. Kept there it never covers a card's
 * own controls: the header buttons, a scroll bar, the corner resize handles.
 */
export type ConnectorSide = "top" | "right" | "bottom" | "left";

export interface ConnectorPlacement {
  side: ConnectorSide;
  /** Centre of the dot, measured from the card's top-left outer corner. */
  x: number;
  y: number;
}

/** Matches `.todo-connect-dot` in index.css. */
export const CONNECTOR_DOT_SIZE = 21;
/** How far outside the edge the dot's centre sits. */
export const CONNECTOR_OUTSET = 7;
/** The pointer still belongs to a card this far outside it, which is the dot's outer rim. */
export const CONNECTOR_REACH = CONNECTOR_OUTSET + CONNECTOR_DOT_SIZE / 2;

const ALL_SIDES: readonly ConnectorSide[] = ["top", "right", "bottom", "left"];
/** Keeps the dot off the rounded corners and the resize handles that live there. */
const CORNER_INSET = 22;
/** A new side has to be this much nearer before the dot jumps to it. */
const SWITCH_MARGIN = 10;

const along = (value: number, length: number) => {
  const inset = Math.min(CORNER_INSET, length / 2);
  return Math.max(inset, Math.min(length - inset, value));
};

export function connectorPlacement(
  size: { width: number; height: number },
  pointer: Point,
  options: { previous?: string | null; sides?: readonly ConnectorSide[] } = {},
): ConnectorPlacement {
  const sides = options.sides?.length ? options.sides : ALL_SIDES;
  // Distance from the pointer to each edge; negative once it is past that edge.
  const distance: Record<ConnectorSide, number> = {
    top: pointer.y,
    right: size.width - pointer.x,
    bottom: size.height - pointer.y,
    left: pointer.x,
  };
  let side = sides[0];
  for (const candidate of sides) if (distance[candidate] < distance[side]) side = candidate;
  const previous = sides.find((candidate) => candidate === options.previous);
  // Without this the dot flickers between two sides along a card's diagonals.
  if (previous && distance[previous] - distance[side] <= SWITCH_MARGIN) side = previous;

  if (side === "top") return { side, x: along(pointer.x, size.width), y: -CONNECTOR_OUTSET };
  if (side === "bottom") return { side, x: along(pointer.x, size.width), y: size.height + CONNECTOR_OUTSET };
  if (side === "left") return { side, x: -CONNECTOR_OUTSET, y: along(pointer.y, size.height) };
  return { side, x: size.width + CONNECTOR_OUTSET, y: along(pointer.y, size.height) };
}

/**
 * Move each card's dot as the pointer travels over a board.
 *
 * The dot is positioned straight on the element instead of through React
 * state, so moving the mouse does not re-render a board of a thousand cards.
 * React never sets a style or a `data-side` on the dot, so it leaves these alone.
 */
export function trackConnectorDots(
  stage: HTMLElement,
  cardSelector: string,
  options: { sides?: (card: HTMLElement) => readonly ConnectorSide[] | undefined } = {},
): () => void {
  let active: HTMLElement | null = null;
  let latest: { x: number; y: number; target: EventTarget | null } | null = null;
  let frame = 0;

  const dotOf = (card: HTMLElement) => {
    for (const child of Array.from(card.children)) {
      if (child instanceof HTMLElement && child.classList.contains("todo-connect-dot")) return child;
    }
    return null;
  };
  const release = () => {
    if (active) dotOf(active)?.classList.remove("is-following");
    active = null;
  };

  const update = () => {
    frame = 0;
    if (!latest) return;
    const target = latest.target instanceof Element ? latest.target : null;
    let card = target?.closest<HTMLElement>(cardSelector) ?? null;
    if (card && !stage.contains(card)) card = null;
    // Just outside a card the pointer is over the canvas, yet still on that card's dot.
    if (!card && active?.isConnected) card = active;
    const dot = card ? dotOf(card) : null;
    if (!card || !dot) return release();

    const bounds = card.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    // Covers both the board's own zoom and the interface scale.
    const scale = width ? bounds.width / width || 1 : 1;
    const pointer = { x: (latest.x - bounds.left) / scale, y: (latest.y - bounds.top) / scale };
    if (
      pointer.x < -CONNECTOR_REACH ||
      pointer.y < -CONNECTOR_REACH ||
      pointer.x > width + CONNECTOR_REACH ||
      pointer.y > height + CONNECTOR_REACH
    ) {
      return release();
    }
    if (active !== card) {
      release();
      active = card;
    }

    // A dot hanging off the canvas's top or left edge would be cut off there.
    const allowed = (options.sides?.(card) ?? ALL_SIDES).filter(
      (side) =>
        !(side === "left" && card.offsetLeft < CONNECTOR_REACH) &&
        !(side === "top" && card.offsetTop < CONNECTOR_REACH),
    );
    const placement = connectorPlacement({ width, height }, pointer, {
      previous: dot.dataset.side,
      sides: allowed,
    });
    dot.dataset.side = placement.side;
    // `left` and `top` are measured from inside the card's border.
    dot.style.left = `${placement.x - card.clientLeft - CONNECTOR_DOT_SIZE / 2}px`;
    dot.style.top = `${placement.y - card.clientTop - CONNECTOR_DOT_SIZE / 2}px`;
    dot.style.right = "auto";
    dot.style.bottom = "auto";
    dot.classList.add("is-following");
  };

  const move = (event: PointerEvent) => {
    // A finger has no hover to follow, and a held button is a drag already in progress.
    if (event.pointerType === "touch" || event.buttons) return;
    latest = { x: event.clientX, y: event.clientY, target: event.target };
    if (frame) return;
    if (typeof window.requestAnimationFrame === "function") frame = window.requestAnimationFrame(update);
    else update();
  };
  const leave = () => {
    latest = null;
    release();
  };

  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerleave", leave);
  return () => {
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerleave", leave);
    if (frame && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
    release();
  };
}
