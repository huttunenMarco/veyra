import type Konva from 'konva';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Image as KImage, Layer, Rect, Stage, Text, Transformer } from 'react-konva';
import { normalizeRect, type RectangleGeometry } from '@veyra/shared';
import type { Zone } from '@/lib/types';

export interface ZoneOverlayState {
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'none' | 'alert';
}

interface Props {
  imageUrl: string | null;
  /** Source resolution of the frame. Coordinates are normalized against this, not the display size. */
  imageSize: { width: number; height: number } | null;
  zones: Zone[];
  states?: Record<string, ZoneOverlayState>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  editable?: boolean;
  drawMode?: boolean;
  onCreate?: (geometry: RectangleGeometry) => void;
  onUpdate?: (id: string, geometry: RectangleGeometry) => void;
}

interface PxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_PX = 12;
const toneColor: Record<ZoneOverlayState['tone'], string> = {
  ok: '#16a34a',
  warn: '#d97706',
  bad: '#dc2626',
  alert: '#dc2626',
  none: '#64748b',
};

function useLoadedImage(url: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!url) {
      setImg(null);
      return;
    }
    const el = new window.Image();
    el.onload = () => setImg(el);
    el.onerror = () => setFailed(true);
    el.src = url;
    return () => {
      el.onload = null;
      el.onerror = null;
    };
  }, [url]);
  return { img, failed };
}

export function ZoneEditor({ imageUrl, imageSize, zones, states = {}, selectedId, onSelect, editable, drawMode, onCreate, onUpdate }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { img, failed } = useLoadedImage(imageUrl);
  const trRef = useRef<Konva.Transformer>(null);
  const shapeRefs = useRef<Record<string, Konva.Rect>>({});
  const [drawing, setDrawing] = useState<PxRect | null>(null);
  const [live, setLive] = useState<Record<string, PxRect>>({});

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The displayed image keeps the source aspect ratio, so there is no letterboxing:
  // normalized coordinates map 1:1 to the source frame at any display size.
  const source = img ? { width: img.naturalWidth, height: img.naturalHeight } : (imageSize ?? { width: 1280, height: 720 });
  const scale = width / source.width;
  const height = Math.round(source.height * scale);
  const display = useMemo(() => ({ width, height }), [width, height]);

  const toPx = (g: RectangleGeometry): PxRect => ({ x: g.x * width, y: g.y * height, width: g.width * width, height: g.height * height });

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = selectedId && editable ? shapeRefs.current[selectedId] : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, editable, zones, width]);

  useEffect(() => setLive({}), [zones]);

  const pointer = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => e.target.getStage()?.getPointerPosition() ?? null;

  const onDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const isBackground = e.target === e.target.getStage() || e.target.name() === 'background';
    if (!isBackground) return;
    if (drawMode && editable) {
      const p = pointer(e);
      if (p) setDrawing({ x: p.x, y: p.y, width: 0, height: 0 });
    } else {
      onSelect(null);
    }
  };
  const onMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (!drawing) return;
    const p = pointer(e);
    if (p) setDrawing({ ...drawing, width: Math.min(Math.max(0, p.x), width) - drawing.x, height: Math.min(Math.max(0, p.y), height) - drawing.y });
  };
  const onUp = () => {
    if (!drawing) return;
    const d = drawing;
    setDrawing(null);
    if (Math.abs(d.width) < MIN_PX || Math.abs(d.height) < MIN_PX) return;
    const g = normalizeRect({ left: d.x, top: d.y, width: d.width, height: d.height }, display);
    if (g) onCreate?.(g);
  };

  const commit = (id: string, node: Konva.Rect) => {
    const w = node.width() * node.scaleX();
    const h = node.height() * node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    node.width(w);
    node.height(h);
    const g = normalizeRect({ left: node.x(), top: node.y(), width: w, height: h }, display);
    if (g) onUpdate?.(id, g);
  };

  const trackLive = (id: string, node: Konva.Rect) =>
    setLive((s) => ({ ...s, [id]: { x: node.x(), y: node.y(), width: node.width() * node.scaleX(), height: node.height() * node.scaleY() } }));

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden rounded-lg bg-muted" style={{ minHeight: 200 }}>
      {failed && <div className="absolute inset-0 z-10 grid place-items-center text-sm text-muted-foreground">Bilden kunde inte laddas</div>}
      {width > 0 && (
        <Stage
          width={width}
          height={height}
          onMouseDown={onDown}
          onTouchStart={onDown}
          onMouseMove={onMove}
          onTouchMove={onMove}
          onMouseUp={onUp}
          onTouchEnd={onUp}
          style={{ cursor: drawMode && editable ? 'crosshair' : 'default', touchAction: drawMode ? 'none' : 'auto' }}
        >
          <Layer>
            {img ? (
              <KImage image={img} width={width} height={height} name="background" />
            ) : (
              <Rect width={width} height={height} fill="#e5e7eb" name="background" />
            )}
          </Layer>
          <Layer>
            {zones.map((zone) => {
              if (zone.geometry.type !== 'rectangle') return null;
              const px = live[zone.id] ?? toPx(zone.geometry);
              const selected = zone.id === selectedId;
              const state = states[zone.id];
              const tone = state?.tone ?? 'none';
              const labelText = state ? `${zone.name} — ${state.label}` : zone.name;
              const fontSize = Math.max(11, Math.min(15, width / 70));
              const labelWidth = labelText.length * fontSize * 0.58 + 20;
              const labelY = px.y > fontSize + 12 ? px.y - fontSize - 10 : px.y + 4;
              return (
                <Group key={zone.id} opacity={zone.enabled ? 1 : 0.5}>
                  <Rect
                    ref={(n) => {
                      if (n) shapeRefs.current[zone.id] = n;
                    }}
                    x={px.x}
                    y={px.y}
                    width={px.width}
                    height={px.height}
                    stroke={zone.color}
                    strokeWidth={selected ? 3 : 2}
                    dash={zone.enabled ? undefined : [8, 6]}
                    fill={hexToRgba(zone.color, selected ? 0.28 : tone === 'alert' ? 0.3 : 0.14)}
                    shadowForStrokeEnabled={false}
                    draggable={editable && !drawMode}
                    onClick={() => onSelect(zone.id)}
                    onTap={() => onSelect(zone.id)}
                    onDragMove={(e) => trackLive(zone.id, e.target as Konva.Rect)}
                    onTransform={(e) => trackLive(zone.id, e.target as Konva.Rect)}
                    dragBoundFunc={(pos) => ({
                      x: Math.min(Math.max(0, pos.x), width - px.width),
                      y: Math.min(Math.max(0, pos.y), height - px.height),
                    })}
                    onDragEnd={(e) => commit(zone.id, e.target as Konva.Rect)}
                    onTransformEnd={(e) => commit(zone.id, e.target as Konva.Rect)}
                  />
                  <Group x={Math.max(0, Math.min(px.x, width - labelWidth))} y={labelY} listening={false}>
                    <Rect width={labelWidth} height={fontSize + 8} fill="rgba(15,23,42,0.82)" cornerRadius={5} />
                    <Rect x={7} y={(fontSize + 8) / 2 - 3.5} width={7} height={7} cornerRadius={4} fill={toneColor[tone]} />
                    <Text x={19} y={4} text={labelText} fontSize={fontSize} fontStyle="600" fill="#fff" fontFamily="Inter, sans-serif" />
                  </Group>
                </Group>
              );
            })}
            {drawing && (
              <Rect
                x={drawing.x}
                y={drawing.y}
                width={drawing.width}
                height={drawing.height}
                stroke="#6366f1"
                strokeWidth={2}
                dash={[6, 4]}
                fill="rgba(99,102,241,0.15)"
              />
            )}
            <Transformer
              ref={trRef}
              rotateEnabled={false}
              keepRatio={false}
              ignoreStroke
              anchorSize={9}
              anchorCornerRadius={2}
              borderStroke="#6366f1"
              anchorStroke="#6366f1"
              boundBoxFunc={(oldBox, newBox) => {
                if (newBox.width < MIN_PX || newBox.height < MIN_PX) return oldBox;
                if (newBox.x < -1 || newBox.y < -1 || newBox.x + newBox.width > width + 1 || newBox.y + newBox.height > height + 1) return oldBox;
                return newBox;
              }}
            />
          </Layer>
        </Stage>
      )}
    </div>
  );
}

function hexToRgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
