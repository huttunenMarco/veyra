import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropZone } from '../src/services/analysis';
import { OpenAIVisionProvider, VisionProviderError } from '../src/vision/openai';

const spec = { outputType: 'enum' as const, outputConfig: { allowedValues: ['occupied', 'available'] } };

describe('zone cropping', () => {
  it('crops the zone in source pixels regardless of resolution', async () => {
    // Left half black, right half white.
    const img = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#000' } })
      .composite([{ input: await sharp({ create: { width: 960, height: 1080, channels: 3, background: '#fff' } }).png().toBuffer(), left: 960, top: 0 }])
      .jpeg()
      .toBuffer();
    const crop = await cropZone(img, { type: 'rectangle', x: 0.5, y: 0, width: 0.5, height: 0.5 });
    const meta = await sharp(crop).metadata();
    expect(meta.width! / meta.height!).toBeCloseTo(960 / 540, 1);
    const { dominant } = await sharp(crop).stats();
    expect(dominant.r).toBeGreaterThan(200); // only the white half
  });

  it('handles zones partially outside the image and rejects zones fully outside', async () => {
    const img = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const crop = await cropZone(img, { type: 'rectangle', x: 0.9, y: 0.9, width: 0.1, height: 0.1 });
    expect((await sharp(crop).metadata()).width).toBeGreaterThan(0);
    await expect(cropZone(img, { type: 'rectangle', x: 1, y: 1, width: 0.1, height: 0.1 })).rejects.toThrow();
  });
});

describe('OpenAI vision provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('sends a strict JSON schema with the image and parses the structured output', async () => {
    const fetchMock = respond(200, {
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: '{"value":"available","status":"confirmed","reason":"Ingen lastbil syns."}' }] },
      ],
      usage: { input_tokens: 812, output_tokens: 40 },
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenAIVisionProvider('sk-test', 'gpt-test');
    const r = await p.analyze({ sensorId: 's', instruction: 'Truck?', spec, image: Buffer.from('jpg'), zoneName: 'Lastkaj 2' });
    expect(r).toMatchObject({ value: 'available', status: 'confirmed', modelId: 'gpt-test', inputTokens: 812, outputTokens: 40, simulated: false });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/responses$/);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-test');
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.text.format.schema.properties.value.enum).toEqual(['occupied', 'available', null]);
    const content = body.input[1].content;
    expect(content[1].type).toBe('input_image');
    expect(content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(content[0].text).toContain('Lastkaj 2');
  });

  it('turns out-of-schema values and refusals into unavailable, never a business value', async () => {
    vi.stubGlobal('fetch', respond(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"value":"maybe","status":"confirmed","reason":""}' }] }] }));
    const p = new OpenAIVisionProvider('sk', 'm');
    expect((await p.analyze({ sensorId: 's', instruction: 'x', spec, image: Buffer.from('') })).status).toBe('unavailable');

    vi.stubGlobal('fetch', respond(200, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }));
    const r = await p.analyze({ sensorId: 's', instruction: 'x', spec, image: Buffer.from('') });
    expect(r).toMatchObject({ value: null, status: 'unavailable' });
  });

  it('sends labeled reference images before the new image', async () => {
    const fetchMock = respond(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"value":"available","status":"confirmed","reason":"x"}' }] }] });
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenAIVisionProvider('sk', 'm');
    await p.analyze({
      sensorId: 's',
      instruction: 'Truck?',
      spec,
      image: Buffer.from('NEW'),
      examples: [
        { image: Buffer.from('EX1'), value: 'occupied', label: 'Upptagen' },
        { image: Buffer.from('EX2'), value: 'available', label: 'Ledig', note: 'tom kaj' },
      ],
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const content = JSON.parse(String(init.body)).input[1].content as Array<{ type: string; text?: string; image_url?: string }>;
    const images = content.filter((c) => c.type === 'input_image').map((c) => Buffer.from(c.image_url!.split(',')[1]!, 'base64').toString());
    expect(images).toEqual(['EX1', 'EX2', 'NEW']); // the image to evaluate comes last
    const texts = content.filter((c) => c.type === 'input_text').map((c) => c.text).join('\n');
    expect(texts).toContain('Reference 1: correct answer = "occupied" (Upptagen)');
    expect(texts).toContain('Note: tom kaj');
    expect(texts).toContain('NEW image');
  });

  it('raises on API errors', async () => {
    vi.stubGlobal('fetch', respond(401, { error: { message: 'Incorrect API key' } }));
    const p = new OpenAIVisionProvider('bad', 'm');
    await expect(p.analyze({ sensorId: 's', instruction: 'x', spec, image: Buffer.from('') })).rejects.toBeInstanceOf(VisionProviderError);
  });
});
