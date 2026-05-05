/**
 * scripts/capture-screenshots.ts
 *
 * Drives the live oss-demo stack on :8888 with a headless Chromium browser
 * and captures the screenshots referenced from README.md.
 *
 * Usage:
 *   docker compose -f apps/oss-demo/docker-compose.yml up -d
 *   pnpm screenshots
 *
 * Generates:
 *   docs/screenshots/host-login.png
 *   docs/screenshots/host-dashboard.png
 *   docs/screenshots/guest-landing.png
 *
 * Re-run any time the UI changes — the script registers a fresh test user
 * each run (timestamped email) so nothing collides.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:8888';
const OUT_DIR = resolve(process.cwd(), 'docs/screenshots');
const VIEWPORT = { width: 1280, height: 800 };
// Mobile-flavored viewport for the guest journey (it's QR/phone-first).
const MOBILE_VIEWPORT = { width: 414, height: 896 };

async function ensureHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `${BASE_URL}/api/v1/health did not respond within 30s — start the stack first ` +
      `(docker compose -f apps/oss-demo/docker-compose.yml up -d).`,
  );
}

async function registerHost(timestamp: number): Promise<{
  email: string;
  password: string;
  cookieValue: string;
  sessionId: string;
  qrSlug: string;
}> {
  const email = `screenshot-${timestamp}@opendj.test`;
  const password = 'screenshot-password-123';
  const displayName = 'Demo Host';

  const reg = await fetch(`${BASE_URL}/api/v1/auth/email/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);

  // Re-login to get a fresh, account-stamped session cookie via the same path
  // a real user would take from the login page.
  const login = await fetch(`${BASE_URL}/api/v1/auth/email/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const setCookie = login.headers.get('set-cookie');
  if (!setCookie) throw new Error('login did not set a cookie');
  const match = /__Host-opendj_session=([^;]+)/.exec(setCookie);
  if (!match || !match[1]) throw new Error(`could not parse session cookie from ${setCookie}`);
  const cookieValue = match[1];

  const sessionRes = await fetch(`${BASE_URL}/api/v1/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `__Host-opendj_session=${cookieValue}`,
    },
    body: JSON.stringify({ name: 'Friday Night Karaoke' }),
  });
  if (!sessionRes.ok) {
    throw new Error(`create session failed: ${sessionRes.status} ${await sessionRes.text()}`);
  }
  const sessionBody = (await sessionRes.json()) as {
    session: { id: string; qrSlug: string };
  };
  return {
    email,
    password,
    cookieValue,
    sessionId: sessionBody.session.id,
    qrSlug: sessionBody.session.qrSlug,
  };
}

async function newAuthedPage(browser: Browser, cookieValue: string): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  // The cookie has Secure + __Host- prefix. Playwright accepts Secure cookies
  // on http://localhost just like Chrome does in dev.
  await ctx.addCookies([
    {
      name: '__Host-opendj_session',
      value: cookieValue,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return ctx.newPage();
}

async function captureHostLogin(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/host/login`, { waitUntil: 'networkidle' });
  // Lock down "or continue with" — the flag check is async, give it a beat.
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(OUT_DIR, 'host-login.png'), fullPage: false });
  await ctx.close();
}

async function captureHostDashboard(browser: Browser, cookieValue: string): Promise<void> {
  const page = await newAuthedPage(browser, cookieValue);
  await page.goto(`${BASE_URL}/host/dashboard`, { waitUntil: 'networkidle' });
  // Provider/sessions load is async (Promise.all in refresh()) — wait for the
  // session list to render so the screenshot has real content.
  await page.waitForSelector('.session-row, .empty', { timeout: 5_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(OUT_DIR, 'host-dashboard.png'), fullPage: false });
  await page.context().close();
}

async function captureGuestLanding(browser: Browser, qrSlug: string): Promise<void> {
  const ctx = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/u/${qrSlug}`, { waitUntil: 'networkidle' });
  // Guest fingerprint + identity calls happen on mount — give them a moment.
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(OUT_DIR, 'guest-landing.png'), fullPage: false });
  await ctx.close();
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[screenshots] target: ${BASE_URL}`);

  await ensureHealth();
  console.log('[screenshots] stack is healthy');

  const ts = Date.now();
  const setup = await registerHost(ts);
  console.log(
    `[screenshots] host: ${setup.email}, session: ${setup.sessionId}, qrSlug: ${setup.qrSlug}`,
  );

  const browser = await chromium.launch();
  try {
    await captureHostLogin(browser);
    console.log('[screenshots] captured host-login.png');
    await captureHostDashboard(browser, setup.cookieValue);
    console.log('[screenshots] captured host-dashboard.png');
    await captureGuestLanding(browser, setup.qrSlug);
    console.log('[screenshots] captured guest-landing.png');
  } finally {
    await browser.close();
  }

  console.log(`[screenshots] done — wrote 3 files to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('[screenshots] failed:', err);
  process.exit(1);
});
