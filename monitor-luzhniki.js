// --- Luzhniki Monitor vFinal (fast & robust) ---
import playwright from 'playwright';
import fetch from 'node-fetch';
import proxyChain from 'proxy-chain';
import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';

const { chromium } = playwright;
const { HttpProxyAgent }  = httpProxyAgentPkg;
const { HttpsProxyAgent } = httpsProxyAgentPkg;
const { SocksProxyAgent } = socksProxyAgentPkg;

const TARGET_URL   = 'https://tennis.luzhniki.ru/';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_LIST   = (process.env.PROXY_LIST || '').trim();

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- proxy utils ----------
function parseProxyLine(line) {
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('socks5://')) return s;
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) return 'http://' + s;
  return s;
}
function buildFetchAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
    return proxyUrl.startsWith('https://')
      ? new HttpsProxyAgent(proxyUrl)
      : new HttpProxyAgent(proxyUrl);
  }
  if (proxyUrl.startsWith('socks5://')) return new SocksProxyAgent(proxyUrl);
}
async function testProxyReachable(proxyUrl) {
  const agent = buildFetchAgent(proxyUrl);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch('https://ifconfig.me/all.json', { agent, signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    return j.ip_addr || 'ok';
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ---------- telegram ----------
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('TG creds missing; printing message:\n' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('Telegram error ' + r.status + ' ' + body);
  }
}

// ---------- browser ----------
async function launchBrowserWithProxy(rawProxy) {
  let browserProxy = null;
  if (rawProxy) {
    browserProxy = rawProxy.startsWith('socks5://')
      ? await proxyChain.anonymizeProxy(rawProxy)
      : rawProxy;
  }
  const browser = await chromium.launch({
    headless: true,
    proxy: browserProxy ? { server: browserProxy } : undefined,
  });
  return { browser, browserProxy };
}

// ---------- helpers ----------
async function clickThroughWizard(page) {
  const banner = page.locator('text=Аренда теннисных кортов').first();
  await banner.waitFor({ timeout: 20000 });
  await banner.click({ timeout: 4000 });
  log('✅ Клик по баннеру «Аренда теннисных кортов»');

  await page.waitForSelector('text=Аренда крытых кортов', { timeout: 20000 });
  await page.locator('text=Аренда крытых кортов').first().click({ timeout: 4000 });
  log('✅ Клик по карточке «Аренда крытых кортов»');

  const contBtn = page.locator('button:has-text("Продолжить")').first();
  if (await contBtn.isVisible().catch(() => false)) {
    await contBtn.click({ timeout: 5000 });
  } else {
    await page.locator('text=Продолжить').first().click({ timeout: 5000 }).catch(() => {});
  }
  log('✅ Нажали «Продолжить»');

  await page.waitForTimeout(800);
}

async function waitTimesAppear(page, timeoutMs = 3500) {
  return page.waitForFunction((ms) => {
    const re = /^\s*\d{1,2}:\d{2}\s*$/;
    const hasIn = (root) => {
      if (!root) return false;
      const nodes = root.querySelectorAll('[class^="time-slot-module__slot___"], [class*="time-slot-module__slot___"]');
      for (const n of nodes) if (re.test((n.textContent || '').trim())) return true;
      return false;
    };
    const root2 = document.querySelector('ul:nth-child(2)');
    const root4 = document.querySelector('ul:nth-child(4)');
    return hasIn(root2) || hasIn(root4) || re.test(document.body.innerText || '');
  }, timeoutMs, timeoutMs).catch(() => {});
}

async function collectTimesForCurrentDay(page) {
  await page.waitForTimeout(150);
  await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.4)));
  await waitTimesAppear(page, 3500);

  const times = await page.evaluate(() => {
    const acc = new Set();
    const re = /^\s*(\d{1,2}):(\d{2})\s*$/;

    const pull = (root) => {
      if (!root) return;
      root.querySelectorAll('[class^="time-slot-module__slot___"], [class*="time-slot-module__slot___"]')
        .forEach(el => {
          const t = (el.textContent || '').trim();
          const m = t.match(re);
          if (m) acc.add(m[1].padStart(2, '0') + ':' + m[2]);
        });
    };

    pull(document.querySelector('ul:nth-child(2)'));
    pull(document.querySelector('ul:nth-child(4)'));

    if (acc.size === 0) {
      document.querySelectorAll('button, span, div, li').forEach(el => {
        const m = (el.textContent || '').trim().match(re);
        if (m) acc.add(m[1].padStart(2, '0') + ':' + m[2]);
      });
    }
    return Array.from(acc).sort();
  });

  return times;
}

// ---------- scraper ----------
async function scrapeAll(page) {
  await clickThroughWizard(page);

  const dayCandidates = await page.locator('button:nth-child(n), [role="button"]').all();
  log('📅 Найдено кнопок-дней:', dayCandidates.length);

  const result = {};
  const clicked = [];

  // ограничимся первыми 10 днями, чтобы быстро прийти к результату
  const limit = Math.min(10, dayCandidates.length);

  for (let i = 0; i < limit; i++) {
    const el = dayCandidates[i];

    let label = (await el.innerText().catch(() => '')).trim();
    if (!/^\d{1,2}$/.test(label)) {
      try {
        const childText = (await el.locator('div, span').first().innerText().catch(() => '')).trim();
        if (/^\d{1,2}$/.test(childText)) label = childText;
      } catch {}
    }
    if (!/^\d{1,2}$/.test(label)) continue;

    clicked.push(label);

    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);

    const times = await collectTimesForCurrentDay(page);
    if (times.length) {
      result[label] = times;
      log(`⏰ День ${label}:`, times);
    }
  }

  return { result, clicked };
}

// ---------- entry ----------
async function main() {
  const start = Date.now();

  let chosenProxy = null;
  if (PROXY_LIST) {
    const lines = PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
    for (const p of lines) {
      try { await testProxyReachable(p); chosenProxy = p; break; }
      catch { /* try next */ }
    }
  }

  const { browser, browserProxy } = await launchBrowserWithProxy(chosenProxy);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
  const page = await ctx.newPage();

  log('🌐 Открываем сайт:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const { result, clicked } = await scrapeAll(page);

  let text = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
  const dayKeys = Object.keys(result).sort((a,b)=>parseInt(a)-parseInt(b));
  if (!dayKeys.length) {
    text += '(ничего не найдено)\n';
    if (clicked.length) text += `Проверены дни: ${clicked.join(', ')}\n`;
    text += '\n';
  } else {
    for (const d of dayKeys) text += `📅 ${d}\n${result[d].join(', ')}\n\n`;
  }
  text += 'https://tennis.luzhniki.ru/#courts';

  await sendTelegram(text);
  log('✅ Сообщение отправлено.');

  await ctx.close();
  await browser.close();
  if (browserProxy?.startsWith('http://127.0.0.1:')) {
    try { await proxyChain.closeAnonymizedProxy(browserProxy, true); } catch {}
  }
  log('⏱ Время выполнения:', ((Date.now() - start) / 1000).toFixed(1) + 's');
}

await main();
