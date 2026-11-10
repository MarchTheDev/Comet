export interface Point { x: number; y: number }
export interface CardRect extends Point { width: number; height: number }
export interface ConnectionGeometry { from: Point; to: Point; path: string; horizontal: boolean }

/** Join the facing edges rather than forcing every line through the card sides. */
export function connectionGeometry(a: CardRect, b: CardRect): ConnectionGeometry {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  const xGap = Math.max(0, Math.abs(dx) - (a.width + b.width) / 2);
  const yGap = Math.max(0, Math.abs(dy) - (a.height + b.height) / 2);
  const horizontal = xGap === yGap ? Math.abs(dx) >= Math.abs(dy) : xGap > yGap;
  const sign = (horizontal ? dx : dy) >= 0 ? 1 : -1;
  const from = horizontal ? { x: ac.x + sign * a.width / 2, y: ac.y } : { x: ac.x, y: ac.y + sign * a.height / 2 };
  const to = horizontal ? { x: bc.x - sign * b.width / 2, y: bc.y } : { x: bc.x, y: bc.y - sign * b.height / 2 };
  const curve = Math.max(30, Math.abs(horizontal ? to.x - from.x : to.y - from.y) * .42);
  const c1 = horizontal ? { x: from.x + sign * curve, y: from.y } : { x: from.x, y: from.y + sign * curve };
  const c2 = horizontal ? { x: to.x - sign * curve, y: to.y } : { x: to.x, y: to.y - sign * curve };
  return { from, to, horizontal, path: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}` };
}
