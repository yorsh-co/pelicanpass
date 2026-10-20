/** How far the map can be enlarged, as a multiple of its fitted size. */
const MAX_SCALE = 4;

/** How much a trackpad pinch's `deltaY` moves the scale, exponentially. */
const WHEEL_ZOOM_RATE = 0.01;

/** A point in the frame's own coordinates. */
interface Point {
  x: number;
  y: number;
}

/** What `setupMapZoom` hands back. */
export interface MapZoomController {
  /** Returns the map to its fitted size and position. */
  reset: () => void;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * The range an offset may take on one axis.
 *
 * A map larger than the frame may move until its far edge meets the frame's,
 * and no further. One that is smaller stays against the near edge, where it
 * sits unzoomed, rather than drifting about inside the frame.
 */
const clampOffset = (offset: number, frame: number, content: number): number =>
  clamp(offset, Math.min(0, frame - content), 0);

/**
 * Pinch-zooms and pans the map inside its frame, and nothing else.
 *
 * The frame carries `touch-action: none`, so the browser leaves the gesture to
 * this: with it, a pinch would zoom the whole screen. Pointer Events rather than
 * Touch Events, so one path serves touch, pen and a mouse drag.
 *
 * The transform is `translate(x, y) scale(s)` from the image's top-left corner,
 * so a point `u` on the unscaled image is drawn at `x + s * u`. Every gesture
 * records the image point under the fingers when it starts and keeps that point
 * under them, which is what makes the map zoom towards the pinch rather than
 * towards a corner, and pan when both fingers move together.
 *
 * @param frame - The clipping element the gesture is read from.
 * @param image - The map, transformed inside it.
 * @returns A controller whose `reset` fits the map again.
 */
export const setupMapZoom = (
  frame: HTMLElement,
  image: HTMLElement,
): MapZoomController => {
  let scale = 1;
  let x = 0;
  let y = 0;

  const pointers = new Map<number, Point>();

  // The gesture's baseline, retaken whenever a finger lands or lifts, so the
  // fingers left down carry on from where the map is instead of jumping.
  let startDistance = 0;
  let startScale = 1;
  let anchor: Point = { x: 0, y: 0 };

  let frameRequest = 0;

  const toFrame = (event: PointerEvent | WheelEvent): Point => {
    const box = frame.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const centre = (): Point => {
    const points = [...pointers.values()];
    const sum = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), {
      x: 0,
      y: 0,
    });
    return { x: sum.x / points.length, y: sum.y / points.length };
  };

  const spread = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const render = (): void => {
    frameRequest = 0;
    image.style.transform = `translate(${String(x)}px, ${String(y)}px) scale(${String(scale)})`;
  };

  // `offsetWidth` and `offsetHeight` ignore transforms, so they are the fitted
  // size the scale multiplies.
  const place = (nextScale: number, focus: Point, point: Point): void => {
    scale = clamp(nextScale, 1, MAX_SCALE);

    x = clampOffset(
      focus.x - scale * point.x,
      frame.clientWidth,
      image.offsetWidth * scale,
    );
    y = clampOffset(
      focus.y - scale * point.y,
      frame.clientHeight,
      image.offsetHeight * scale,
    );

    if (!frameRequest) frameRequest = requestAnimationFrame(render);
  };

  const rebase = (): void => {
    if (pointers.size === 0) return;

    const focus = centre();
    anchor = { x: (focus.x - x) / scale, y: (focus.y - y) / scale };
    startDistance = spread();
    startScale = scale;
  };

  frame.addEventListener('pointerdown', (event) => {
    frame.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, toFrame(event));
    image.classList.add('is-gesturing');
    rebase();
  });

  frame.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;

    pointers.set(event.pointerId, toFrame(event));

    // One finger on the fitted map has nothing to move.
    if (pointers.size === 1 && scale === 1) return;

    const nextScale =
      pointers.size > 1 && startDistance > 0
        ? startScale * (spread() / startDistance)
        : scale;

    place(nextScale, centre(), anchor);
  });

  const release = (event: PointerEvent): void => {
    if (!pointers.delete(event.pointerId)) return;

    if (pointers.size === 0) image.classList.remove('is-gesturing');
    else rebase();
  };

  frame.addEventListener('pointerup', release);
  frame.addEventListener('pointercancel', release);

  // A trackpad pinch arrives as a wheel event with `ctrlKey` set, and zooms the
  // page unless it is cancelled, which a passive listener cannot do.
  frame.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;

      event.preventDefault();

      const focus = toFrame(event);
      const point = { x: (focus.x - x) / scale, y: (focus.y - y) / scale };

      place(scale * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE), focus, point);
    },
    { passive: false },
  );

  // Safari's own pinch events, which older iOS versions act on whatever
  // `touch-action` says.
  const cancel = (event: Event): void => {
    event.preventDefault();
  };

  frame.addEventListener('gesturestart', cancel);
  frame.addEventListener('gesturechange', cancel);

  return {
    reset: () => {
      pointers.clear();
      image.classList.remove('is-gesturing');

      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;

      scale = 1;
      x = 0;
      y = 0;
      image.style.transform = '';
    },
  };
};
