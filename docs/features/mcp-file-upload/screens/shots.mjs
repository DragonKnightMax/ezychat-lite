// Screens of the composer upload states (design docs/features/mcp-file-upload/design.md).
// node shots.mjs <port> <dataDir> <outDir> <filesDir>

import { createRequire } from 'node:module';
const require = createRequire('/home/user/ezychat-lite/package.json');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');
const [port, dataDir, out, files] = process.argv.slice(2);
const B = `http://127.0.0.1:${port}`;
const H = { origin: B, 'content-type': 'application/json' };
let cookie = '';
async function call(path, body, method = 'POST') {
  const r = await fetch(B + path, { method, headers: { ...H, cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
await call('/api/setup/admin', { username: 'aisyah', displayName: 'Aisyah', password: 'demo-pass-123' }).catch(() => {});
await call('/api/auth/login', { username: 'aisyah', password: 'demo-pass-123' });
await call('/api/dev/fake-incoming', { chatJid: '60123450001@s.whatsapp.net', text: 'Can you send the catalogue and the demo video?', senderName: 'Farah Aziz' });
const api =
  (await call('/api/dev/fake-api-inbox', { name: 'Shop (Business API)' }).catch(() => null)) ??
  (await call('/api/inboxes', undefined, 'GET')).inboxes.find((i) => i.name === 'Shop (Business API)');
if (api) await call('/api/dev/fake-incoming', { inboxId: api.id, chatJid: '60123450002@s.whatsapp.net', text: 'Please send a photo of the shelf', senderName: 'Daniel Lee' });
// the tunnel address the app was opened through (a named tunnel's hostname)
const db = new Database(`${dataDir}/app.db`);
db.prepare("INSERT INTO settings (key, value) VALUES ('named_tunnel_hostname', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify('inbox.example.com'));
db.close();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--host-resolver-rules=MAP inbox.example.com 127.0.0.1', '--unsafely-treat-insecure-origin-as-secure=http://inbox.example.com:' + port] });
for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 360, height: 760 }]]) {
  for (const host of (process.env.ONLY_LOCAL ? [B] : process.env.ONLY_TUNNEL ? [`http://inbox.example.com:${port}`] : [B, `http://inbox.example.com:${port}`])) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.goto(host + '/login');
    await page.getByLabel(/username/i).fill('aisyah');
    await page.locator('input[name=password]').fill('demo-pass-123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/inbox|chats|\/$/, { timeout: 15000 }).catch(() => {});
    await page.getByText('Farah Aziz').first().click();
    await page.waitForTimeout(800);
    const attach = page.locator('input[type=file]').first();
    if (host === B) {
      // 1. uploading progress: upload throttled to 2 MB/s
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 2 * 1024 * 1024 });
      await attach.setInputFiles(`${files}/catalogue.pdf`);
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: /^send/i }).last().click();
      await page.getByTestId('uploading-progress').waitFor({ timeout: 10000 });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${out}/01-uploading-${label}.png` });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.getByTestId('uploading-progress').waitFor({ state: 'detached', timeout: 60000 });
      // 2. a video above the linked phone's video limit goes as a file
      await attach.setInputFiles(`${files}/demo-70mb.mp4`);
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: /^send/i }).last().click();
      await page.getByText(/goes as a file/).first().waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${out}/02-sent-as-file-${label}.png` });
      await page.waitForTimeout(4000);
      // 3. above the Business API number's image limit (5 MB)
      if (api) {
        await page.goto(host + '/');
        await page.getByText('Daniel Lee').first().click();
        await page.waitForTimeout(800);
        await page.locator('input[type=file]').first().setInputFiles(`${files}/shelf-6mb.png`);
        await page.getByText(/larger than 5/).first().waitFor({ timeout: 10000 });
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `${out}/03-over-whatsapp-limit-${label}.png` });
      }
    } else {
      // 4. through the internet address: over 100 MB is refused before uploading
      await attach.setInputFiles(`${files}/price-list-120mb.pdf`);
      await page.getByText(/Through the internet address/).first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${out}/04-tunnel-limit-${label}.png` });
    }
    await ctx.close();
  }
}
await browser.close();
console.log('done');
