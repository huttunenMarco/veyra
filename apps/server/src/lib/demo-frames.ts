import sharp from 'sharp';

/**
 * Synthetic demo camera. Renders a simple scene whose contents change over time
 * so sensors, state transitions and automations can be exercised without hardware.
 * Frames are always marked with a visible "DEMO" watermark and stored with source=demo.
 */
export type DemoScene = 'warehouse' | 'garage' | 'production';

const W = 1280;
const H = 720;

function cycle(periodMinutes: number, offsetMinutes = 0, now = Date.now()): boolean {
  return Math.floor((now / 60_000 + offsetMinutes) / periodMinutes) % 2 === 0;
}

function truck(x: number, y: number, color: string): string {
  return `
    <g transform="translate(${x},${y})">
      <rect x="0" y="40" width="250" height="230" rx="8" fill="${color}" stroke="#222" stroke-width="4"/>
      <rect x="20" y="0" width="210" height="60" rx="10" fill="#334155"/>
      <rect x="45" y="12" width="160" height="36" rx="4" fill="#93c5fd"/>
      <circle cx="45" cy="285" r="26" fill="#111"/><circle cx="205" cy="285" r="26" fill="#111"/>
      <text x="125" y="170" font-size="34" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">CARGO</text>
    </g>`;
}

function warehouse(now: number): string {
  const dock1 = cycle(3, 0, now);
  const dock2 = cycle(4, 1, now);
  return `
    <rect width="${W}" height="${H}" fill="#9ca3af"/>
    <rect y="0" width="${W}" height="260" fill="#6b7280"/>
    ${[0, 1].map((i) => {
      const x = 170 + i * 520;
      return `<rect x="${x}" y="70" width="340" height="190" fill="#374151" stroke="#1f2937" stroke-width="6"/>
        <text x="${x + 170}" y="55" font-size="30" font-family="Arial" font-weight="bold" fill="#fde047" text-anchor="middle">KAJ ${i + 1}</text>
        <rect x="${x}" y="260" width="340" height="16" fill="#facc15"/>`;
    }).join('')}
    <rect y="276" width="${W}" height="${H - 276}" fill="#a1a1aa"/>
    ${[0, 1].map((i) => `<rect x="${170 + i * 520}" y="300" width="340" height="400" fill="none" stroke="#fef08a" stroke-width="6" stroke-dasharray="30 18"/>`).join('')}
    ${dock1 ? truck(215, 330, '#dc2626') : ''}
    ${dock2 ? truck(735, 330, '#2563eb') : ''}
    <rect x="1060" y="560" width="90" height="70" fill="#a16207"/><rect x="1060" y="630" width="90" height="12" fill="#713f12"/>`;
}

function garage(now: number): string {
  const open = cycle(5, 2, now);
  return `
    <rect width="${W}" height="${H}" fill="#cbd5e1"/>
    <rect x="300" y="120" width="680" height="500" fill="#475569"/>
    ${open
      ? `<rect x="330" y="150" width="620" height="60" fill="#94a3b8"/><rect x="330" y="210" width="620" height="410" fill="#0f172a"/>
         <text x="640" y="430" font-size="40" font-family="Arial" fill="#334155" text-anchor="middle">ÖPPEN</text>`
      : Array.from({ length: 8 }, (_, i) => `<rect x="330" y="${150 + i * 59}" width="620" height="55" fill="#e2e8f0" stroke="#94a3b8" stroke-width="3"/>`).join('')}
    <rect y="620" width="${W}" height="100" fill="#64748b"/>`;
}

function production(now: number): string {
  const count = Math.floor(now / 120_000) % 7;
  const pallets = Array.from({ length: count }, (_, i) => {
    const x = 180 + (i % 4) * 230;
    const y = 300 + Math.floor(i / 4) * 190;
    return `<g transform="translate(${x},${y})"><rect width="180" height="110" fill="#d97706" stroke="#78350f" stroke-width="4"/>
      <rect y="110" width="180" height="22" fill="#92400e"/><line x1="0" y1="55" x2="180" y2="55" stroke="#78350f" stroke-width="3"/></g>`;
  }).join('');
  return `
    <rect width="${W}" height="${H}" fill="#e5e7eb"/>
    <rect x="140" y="260" width="1000" height="420" fill="#d1d5db" stroke="#16a34a" stroke-width="6" stroke-dasharray="24 14"/>
    <text x="640" y="240" font-size="30" font-family="Arial" font-weight="bold" fill="#166534" text-anchor="middle">UPPSTÄLLNINGSYTA PALLAR</text>
    ${pallets}`;
}

export async function renderDemoFrame(scene: DemoScene, now = Date.now()): Promise<Buffer> {
  const body = scene === 'warehouse' ? warehouse(now) : scene === 'garage' ? garage(now) : production(now);
  // Occasionally simulate poor conditions (low light) to exercise uncertainty handling.
  const dim = Math.floor(now / 60_000) % 11 === 10;
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${body}
    ${dim ? `<rect width="${W}" height="${H}" fill="#000" opacity="0.72"/>` : ''}
    <rect x="16" y="16" width="250" height="44" rx="6" fill="#000" opacity="0.55"/>
    <text x="30" y="47" font-size="24" font-family="Courier New, monospace" fill="#fff">${stamp}</text>
    <rect x="${W - 180}" y="16" width="164" height="44" rx="6" fill="#7c3aed"/>
    <text x="${W - 98}" y="47" font-size="24" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">DEMO</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}
