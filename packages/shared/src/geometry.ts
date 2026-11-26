import { z } from 'zod';

/**
 * Zone geometry is stored in normalized coordinates (0..1) relative to the
 * source image, so it stays valid regardless of display size or camera
 * resolution. The union is discriminated on `type` so polygons can be added later.
 */
export const rectangleGeometrySchema = z.object({
  type: z.literal('rectangle'),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});

export const zoneGeometrySchema = z.discriminatedUnion('type', [rectangleGeometrySchema]);

export type RectangleGeometry = z.infer<typeof rectangleGeometrySchema>;
export type ZoneGeometry = z.infer<typeof zoneGeometrySchema>;

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Clamp a rectangle so it lies fully inside the unit square. Returns null if nothing remains. */
export function clampRectangle(rect: Omit<RectangleGeometry, 'type'>): RectangleGeometry | null {
  const x1 = clamp01(rect.x);
  const y1 = clamp01(rect.y);
  const x2 = clamp01(rect.x + rect.width);
  const y2 = clamp01(rect.y + rect.height);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { type: 'rectangle', x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Convert display-space pixels into normalized geometry, given the rendered image size. */
export function normalizeRect(
  px: PixelRect,
  displayed: { width: number; height: number },
): RectangleGeometry | null {
  if (displayed.width <= 0 || displayed.height <= 0) return null;
  // Konva can report negative width/height when a shape is flipped while resizing.
  const left = px.width < 0 ? px.left + px.width : px.left;
  const top = px.height < 0 ? px.top + px.height : px.top;
  return clampRectangle({
    x: left / displayed.width,
    y: top / displayed.height,
    width: Math.abs(px.width) / displayed.width,
    height: Math.abs(px.height) / displayed.height,
  });
}

/** Map normalized geometry onto a concrete image size (e.g. the captured frame for cropping). */
export function toPixelRect(geometry: ZoneGeometry, image: { width: number; height: number }): PixelRect | null {
  const rect = clampRectangle(geometry);
  if (!rect) return null;
  const left = Math.floor(rect.x * image.width);
  const top = Math.floor(rect.y * image.height);
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * image.width));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * image.height));
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) return null;
  return { left, top, width, height };
}

/** Fit an image into a container preserving aspect ratio (contain). Offsets describe the letterbox. */
export function fitContain(
  image: { width: number; height: number },
  container: { width: number; height: number },
): { width: number; height: number; offsetX: number; offsetY: number; scale: number } {
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { width, height, scale, offsetX: (container.width - width) / 2, offsetY: (container.height - height) / 2 };
}
