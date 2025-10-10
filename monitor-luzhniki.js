// --- Luzhniki Monitor vFinal ---
// Автоматически открывает сайт Лужники → Аренда теннисных кортов → Крытые → Продолжить → календарь
// Собирает доступные часы (07:00, 22:00 и т.п.) по всем видимым дням и шлёт в Telegram

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

const TARGET_URL = 'https://tennis.luzhniki.ru/';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_LIST   = (process.env.PROXY_LIST || '').trim();
const DEBUG = process.env.DEBUG === '1';

// simple logger
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
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
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
    if (rawProxy.startsWith('socks5://')) {
      browserProxy = await proxyChain.anonymizeProxy(rawProxy);
    } else {
      browserProxy = rawProxy;
    }
  }
  const browser = await chromium.launch({
    headless: true,
    proxy: browserProxy ? { server: browserProxy } : undefined,
  });
  return { browser, browserProxy };
}

// ---------- scraping ----------
async function scrapeSlots(page) {
  log('⌛ Ждём появление карточки «Аренда крытых кортов»');
  await page.waitForSelector('text=Аренда крытых кортов', { timeout: 20000 });
  const card = page.locator('text=Аренда крытых кортов').first();
  await card.scrollIntoViewIfNeeded();
  await card.click({ timeout: 3000 });
  log('✅ Клик по карточке «Аренда крытых кортов»');

  // ждём и нажимаем "Продолжить"
  const contBtn = page.locator('button:has-text("Продолжить")').first();
  if (await contBtn.isVisible().catch(() => false)) {
    await contBtn.click({ timeout: 5000 });
    log('✅ Нажали «Продолжить»');
  } else {
    const altBtn = page.locator('text=Продолжить').first();
    await altBtn.waitFor({ timeout: 15000 });
    await altBtn.click({ timeout: 5000 }).catch(() => {});
    log('✅ Нажали альтернативную «Продолжить»');
  }

  // ждём календарь
  await page.waitForSelector('text=Октябрь, text=Ноябрь, text=Декабрь', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // кнопки-дни
  const dayButtons = await page.locator('button:nth-child(n)').all();
  log('📅 Найдено кнопок-дней:', dayButtons.length);

  const result = {};

  for (let i = 0; i < dayButtons.length; i++) {
    const b = dayButtons[i];
    const label = (await b.innerText().catch(() => '')).trim();
    if (!/^\d{1,2}$/.test(label)) continue;

    log('🗓 День', label, '- кликаем');
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(700);

    // теперь ищем слоты времени
    const timeNodes = await page.locator('ul:nth-child(2) .time-slot-module__slot__vBkE2').all();
    const times = [];
    for (const t of timeNodes) {
      const txt = (await t.innerText().catch(() => '')).trim();
      if (/^\d{1,2}:\d{2}$/.test(txt)) times.push(txt.padStart(5, '0'));
    }
    if (times.length) {
      result[label] = [...new Set(times)].sort();
      log(`⏰ День ${label}:`, result[label]);
    }
  }

  return result;
}

// ---------- main ----------
async function main() {
  const start = Date.now();
  let chosenProxy = null;
  if (PROXY_LIST) {
    const lines = PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
    for (const p of lines) {
      try {
        const ip = await testProxyReachable(p);
        log('SOCKS5 OK, IP:', ip);
        chosenProxy = p;
        break;
      } catch (e) {
        log('Proxy failed:', p);
      }
    }
  }

  const { browser, browserProxy } = await launchBrowserWithProxy(chosenProxy);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  log('🌐 Открываем сайт:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // на главной жмём баннер
  const banner = page.locator('text=Аренда теннисных кортов').first();
  await banner.waitFor({ timeout: 15000 });
  await banner.click({ timeout: 3000 });
  log('✅ Клик по баннеру «Аренда теннисных кортов»');

  const all = await scrapeSlots(page);

  let text = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
  const dayKeys = Object.keys(all);
  if (dayKeys.length === 0) {
    text += '(ничего не найдено)\n\n';
  } else {
    for (const d of dayKeys) {
      text += `📅 ${d}\n${all[d].join(', ')}\n\n`;
    }
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
