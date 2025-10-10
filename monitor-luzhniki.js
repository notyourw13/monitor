// --- Luzhniki Monitor vFinal (slots via UL 2 & 4 + class triple underscore) ---
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

// ---------- scraping helpers ----------
async function clickThroughWizard(page) {
  // баннер на главной
  const banner = page.locator('text=Аренда теннисных кортов').first();
  await banner.waitFor({ timeout: 20000 });
  await banner.click({ timeout: 4000 });
  log('✅ Клик по баннеру «Аренда теннисных кортов»');

  // карточка "Крытые"
  await page.waitForSelector('text=Аренда крытых кортов', { timeout: 20000 });
  await page.locator('text=Аренда крытых кортов').first().click({ timeout: 4000 });
  log('✅ Клик по карточке «Аренда крытых кортов»');

  // «Продолжить»
  const contBtn = page.locator('button:has-text("Продолжить")').first();
  if (await contBtn.isVisible().catch(() => false)) {
    await contBtn.click({ timeout: 5000 });
  } else {
    await page.locator('text=Продолжить').first().click({ timeout: 5000 }).catch(() => {});
  }
  log('✅ Нажали «Продолжить»');

  await page.waitForTimeout(800);
}

// Собираем времена строго из ul:nth-child(2) и ul:nth-child(4),
// и плюс safety-слой: любые элементы с текстом HH:MM.
async function collectTimesForCurrentDay(page) {
  // ждём дорисовку
  await page.waitForTimeout(250);

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

    // именно эти два списка, как ты показал в Distill:
    pull(document.querySelector('ul:nth-child(2)'));
    pull(document.querySelector('ul:nth-child(4)'));

    // fallback: любая видимая HH:MM (если вдруг разметка поменялась)
    if (acc.size === 0) {
      document.querySelectorAll('button, span, div, li').forEach(el => {
        const t = (el.textContent || '').trim();
        const m = t.match(re);
        if (m) acc.add(m[1].padStart(2, '0') + ':' + m[2]);
      });
    }

    return Array.from(acc).sort();
  });

  return times;
}

// ---------- main scraper ----------
async function scrapeAll(page) {
  await clickThroughWizard(page);

  // небольшой скролл, чтобы оба списка (утро/вечер) попали в вьюпорт
  await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.33)));
  await page.waitForTimeout(200);

  // берём максимум кандидатов на «дни»
  const dayCandidates = await page.locator('button:nth-child(n), [role="button"]').all();
  log('📅 Найдено кнопок-дней:', dayCandidates.length);

  const result = {};

  for (let i = 0; i < dayCandidates.length; i++) {
    const el = dayCandidates[i];

    // из некоторых селекторов дни — это button, но внутри ещё div с цифрой
    // поэтому читаем текст и у button, и у ближайших детей
    let label = (await el.innerText().catch(() => '')).trim();
    if (!/^\d{1,2}$/.test(label)) {
      try {
        const childText = (await el.locator('div, span').first().innerText().catch(() => '')).trim();
        if (/^\d{1,2}$/.test(childText)) label = childText;
      } catch {}
    }
    if (!/^\d{1,2}$/.test(label)) continue;

    // кликаем день
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(600);

    // на всякий случай — докрутим страницу
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.4)));
    await page.waitForTimeout(200);

    // ждём, что появится хотя бы один HH:MM (до 3с)
    await page.waitForFunction(() => {
      const re = /^\s*\d{1,2}:\d{2}\s*$/;
      const root2 = document.querySelector('ul:nth-child(2)');
      const root4 = document.querySelector('ul:nth-child(4)');
      const has = (root) =>
        !!root && !!Array.from(root.querySelectorAll('[class^="time-slot-module__slot___"], [class*="time-slot-module__slot___"]'))
          .find(el => re.test((el.textContent || '').trim()));
      return has(root2) || has(root4) || re.test(document.body.innerText || '');
    }, { timeout: 3000 }).catch(() => {});

    const times = await collectTimesForCurrentDay(page);
    if (times.length) {
      result[label] = times;
      log(`⏰ День ${label}:`, times);
    }
  }

  return result;
}

// ---------- program entry ----------
async function main() {
  const start = Date.now();

  // pick any working proxy from PROXY_LIST
  let chosenProxy = null;
  if (PROXY_LIST) {
    const lines = PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
    for (const p of lines) {
      try { await testProxyReachable(p); chosenProxy = p; break; }
      catch { /* try next */ }
    }
  }

  const { browser, browserProxy } = await launchBrowserWithProxy(chosenProxy);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  log('🌐 Открываем сайт:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const all = await scrapeAll(page);

  let text = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
  const dayKeys = Object.keys(all);
  if (!dayKeys.length) {
    text += '(ничего не найдено)\n\n';
  } else {
    for (const d of dayKeys) text += `📅 ${d}\n${all[d].join(', ')}\n\n`;
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
