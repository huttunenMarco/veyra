import { expect, test } from '@playwright/test';

const uid = Date.now().toString(36);

test('camera → zone → sensor → automation → event → delivery → REST API', async ({ page, request }) => {
  // 1. No login: the app opens straight to the dashboard
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Översikt' })).toBeVisible();

  // A simulated webhook connection to deliver to
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Lägg till Webhook' }).click();
  await page.getByLabel('Namn').fill(`E2E webhook ${uid}`);
  await page.getByPlaceholder('https://example.com/hooks/veyra').fill('https://example.com/e2e');
  await page.getByRole('combobox').last().selectOption('simulated');
  await page.getByRole('button', { name: 'Spara' }).click();
  await expect(page.getByText(`E2E webhook ${uid}`)).toBeVisible();

  // 2. Add a demo camera
  await page.goto('/cameras/new');
  await page.getByRole('button', { name: /Demokamera/ }).click();
  await page.getByPlaceholder('t.ex. Lagerkamera 1').fill(`E2E kamera ${uid}`);
  await page.getByRole('button', { name: 'Skapa kamera' }).click();

  // 3. Camera page opens; fetch an image
  await expect(page.getByRole('heading', { name: `E2E kamera ${uid}` })).toBeVisible();
  await page.getByRole('button', { name: 'Hämta bild' }).first().click();
  await expect(page.getByRole('heading', { name: 'Anslutningen fungerar' })).toBeVisible();
  await page.getByRole('button', { name: 'Rita zoner' }).click();

  // 4–5. Draw a zone (auto-saved)
  const canvas = page.locator('canvas').last();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.9, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByText('Zonen skapades')).toBeVisible();
  const nameInput = page.getByLabel('Namn');
  await nameInput.fill('Lastkaj 2');
  await nameInput.press('Enter');
  await expect(page.getByRole('button', { name: /Lastkaj 2/ })).toBeVisible();

  // 6. Create an AI sensor for the zone
  await page.getByRole('button', { name: 'Lägg till sensor' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('t.ex. Lastkaj 2 beläggning').fill(`Kaj ${uid}`);
  await dialog.locator('textarea').first().fill('Kontrollera om en lastbil står vid kajen. Om en lastbil står där: occupied. Annars: available.');
  await dialog.getByRole('button', { name: 'Föreslå från instruktion' }).click();
  await expect(dialog.locator('code', { hasText: 'occupied' })).toBeVisible();
  await expect(dialog.locator('code', { hasText: 'available' })).toBeVisible();
  // Test analysis before saving
  await dialog.getByRole('button', { name: 'Testa på senaste bild' }).click();
  await expect(dialog.getByText(/mock|gpt/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Skapa sensor' }).click();
  await expect(page.getByText('Sensorn skapades')).toBeVisible();

  // 7. Run an analysis
  await page.getByRole('button', { name: 'Analysera nu' }).click();
  await expect(page.getByText(/sensorer analyserade/)).toBeVisible();

  // 8. Create a state-change automation
  await page.goto('/automations');
  await page.getByRole('button', { name: 'Skapa automatisering' }).first().click();
  const ad = page.getByRole('dialog');
  await ad.getByPlaceholder('Lastkaj 2 blev ledig').fill(`Regel ${uid}`);
  const sensorSelect = ad.locator('select').nth(1);
  const sensorValue = await sensorSelect.locator('option', { hasText: `Kaj ${uid}` }).getAttribute('value');
  await sensorSelect.selectOption(sensorValue!);
  await ad.locator('select').nth(2).selectOption('"occupied"');
  await ad.locator('select').nth(3).selectOption('"available"');
  const addSelect = ad.locator('select', { has: page.locator('option', { hasText: 'Lägg till åtgärd…' }) });
  const connValue = await addSelect.locator('option', { hasText: `E2E webhook ${uid}` }).getAttribute('value');
  await addSelect.selectOption(connValue!);
  await ad.getByRole('button', { name: 'Lägg till', exact: true }).click();
  await ad.getByRole('button', { name: 'Skapa automatisering' }).click();
  await expect(page.getByText(`Regel ${uid}`)).toBeVisible();

  // 9. Trigger a simulated state transition (2 confirmations each, the sensor default)
  await page.goto('/sensors');
  await page.getByRole('link', { name: `Kaj ${uid}` }).click();
  const sim = page.locator('select').last();
  const confirm = page.getByRole('button', { name: 'Säker observation' });
  await sim.selectOption('occupied');
  for (let i = 0; i < 2; i++) {
    await confirm.click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator('div.text-3xl', { hasText: 'Upptagen' })).toBeVisible();
  await sim.selectOption('available');
  for (let i = 0; i < 2; i++) {
    await confirm.click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator('div.text-3xl', { hasText: 'Ledig' })).toBeVisible();

  // 10–11. Event exists and its delivery was recorded (worker processes the queue)
  await page.goto('/events');
  const row = page.locator('button', { hasText: `Kaj ${uid}` }).filter({ hasText: 'Ledig' }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText(/Webhook: levererad \(sim\.\)/)).toBeVisible({ timeout: 30_000 });

  // 12. Read the state through the REST API (no key needed on the local network)
  const sensors = await request.get('/api/v1/sensors');
  const sensor = (await sensors.json()).data.find((x: { name: string }) => x.name === `Kaj ${uid}`);
  const state = await request.get(`/api/v1/sensors/${sensor.id}/state`);
  expect(state.ok()).toBeTruthy();
  expect(await state.json()).toMatchObject({ value: 'available', valueLabel: 'Ledig', status: 'confirmed' });
  // Changes require the CSRF header
  expect((await request.post(`/api/v1/sensors/${sensor.id}/analyze`)).status()).toBe(403);
});
