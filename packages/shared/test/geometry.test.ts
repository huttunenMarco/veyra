import { describe, expect, it } from 'vitest';
import { clampRectangle, fitContain, normalizeRect, toPixelRect } from '../src/geometry';

const approx = (r: Record<string, number>) => ({
  type: 'rectangle',
  ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, expect.closeTo(v)])),
});

describe('geometry', () => {
  it('normalizes display pixels independent of display size', () => {
    const a = normalizeRect({ left: 100, top: 50, width: 200, height: 100 }, { width: 1000, height: 500 });
    const b = normalizeRect({ left: 50, top: 25, width: 100, height: 50 }, { width: 500, height: 250 });
    expect(a).toEqual(b);
    expect(a).toEqual(approx({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }));
  });

  it('handles negative (flipped) sizes', () => {
    expect(normalizeRect({ left: 300, top: 150, width: -200, height: -100 }, { width: 1000, height: 500 })).toEqual(approx({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }));
  });

  it('clamps zones partially outside the image', () => {
    expect(clampRectangle({ x: 0.8, y: -0.1, width: 0.5, height: 0.3 })).toEqual({
      type: 'rectangle', x: 0.8, y: 0, width: expect.closeTo(0.2), height: expect.closeTo(0.2),
    });
    expect(clampRectangle({ x: 1.2, y: 0, width: 0.1, height: 0.1 })).toBeNull();
  });

  it('maps to source image pixels regardless of resolution', () => {
    const g = { type: 'rectangle' as const, x: 0.5, y: 0.25, width: 0.5, height: 0.5 };
    expect(toPixelRect(g, { width: 1920, height: 1080 })).toEqual({ left: 960, top: 270, width: 960, height: 540 });
    expect(toPixelRect(g, { width: 640, height: 360 })).toEqual({ left: 320, top: 90, width: 320, height: 180 });
  });

  it('computes letterboxing', () => {
    const f = fitContain({ width: 1920, height: 1080 }, { width: 800, height: 800 });
    expect(f.width).toBe(800);
    expect(f.height).toBe(450);
    expect(f.offsetY).toBe(175);
  });
});
