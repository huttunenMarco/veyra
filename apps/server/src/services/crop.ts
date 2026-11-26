import sharp from 'sharp';
import { toPixelRect, type ZoneGeometry } from '@veyra/shared';

const MAX_SIDE = 1024;

/**
 * Crop the zone out of the frame using the *actual* image dimensions (cameras can
 * change resolution; stored frame metadata is not trusted for this).
 */
export async function cropZone(image: Buffer, geometry: ZoneGeometry | null): Promise<Buffer> {
  const img = sharp(image);
  if (geometry) {
    const meta = await img.metadata();
    const rect = toPixelRect(geometry, { width: meta.width!, height: meta.height! });
    if (!rect) throw new Error('Zonen ligger utanför bilden');
    img.extract(rect);
  }
  return img.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

export async function contextImage(image: Buffer): Promise<Buffer> {
  return sharp(image).resize({ width: 768, height: 768, fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
}
