// --- Luzhniki Monitor vFinal (robust slots) ---
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

// ---------- scraping ----------
async function scrapeSlots(page) {
  log('⌛ Ждём появление карточки «Аренда крытых кортов»');
  await page.waitForSelector('text=Аренда крытых кортов', { timeout: 20000 });
  await page.locator('text=Аренда крытых кортов').first().click({ timeout: 3000 });
  log('✅ Клик по карточке «Аренда крытых кортов»');

  // «Продолжить»
  const contBtn = page.locator('button:has-text("Продолжить")').first();
  if (await contBtn.isVisible().catch(() => false)) {
    await contBtn.click({ timeout: 5000 });
  } else {
    await page.locator('text=Продолжить').first().click({ timeout: 5000 }).catch(() => {});
  }
  log('✅ Нажали «Продолжить»');

  // небольшой дожидатель календаря
  await page.waitForTimeout(1200);

  // Берём побольше кандидатов на дни и фильтруем по «чистому числу»
  const dayButtons = await page.locator('button:nth-child(n), [role="button"]').all();
  log('📅 Найдено кнопок-дней:', dayButtons.length);

  const result = {};

  for (let i = 0; i < dayButtons.length; i++) {
    const btn = dayButtons[i];
    const label = (await btn.innerText().catch(() => '')).trim();
    if (!/^\d{1,2}$/.test(label)) continue;

    log('🗓 День', label, '— кликаем');
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 3000 }).catch(() => {});
    // календарь подгружает куски — даём времени дорисоваться
    await page.waitForTimeout(800);

    // слегка проскроллим, чтобы подгрузились «Вечер» и т.п.
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.5)));
    await page.waitForTimeout(200);

    // ждём появления хотя бы одного HH:MM (до 3.5с)
    await page.waitForFunction(() => {
      const re = /^\s*\d{1,2}:\d{2}\s*$/;
      // элементы c CSS-модульными классами слотов
      const els = document.querySelectorAll('[class^="time-slot-module__slot__"], [class*="time-slot-module__slot__"]');
      for (const el of els) if (re.test(el.textContent || '')) return true;
      // fallback: любой текст HH:MM в документе
      return re.test(document.body.innerText || '');
    }, { timeout: 3500 }).catch(() => {});

    // собираем времена: и по классам, и по текстовому паттерну
    const times = await page.evaluate(() => {
      const acc = new Set();
      const re = /^\s*(\d{1,2}):(\d{2})\s*$/;

      // 1) CSS-модульные слоты
      document.querySelectorAll('[class^="time-slot-module__slot__"], [class*="time-slot-module__slot__"]')
        .forEach(el => {
          const t = (el.textContent || '').trim();
          const m = t.match(re);
          if (m) acc.add(m[1].padStart(2, '0') + ':' + m[2]);
        });

      // 2) Текстовые узлы HH:MM на всякий случай
      // (берём не весь body.innerText, а элементы, чтобы не поймать мусор)
      document.querySelectorAll('button, span, div, li')
        .forEach(el => {
          const t = (el.textContent || '').trim();
          const m = t.match(re);
          if (m) acc.add(m[1].padStart(2, '0') + ':' + m[2]);
        });

      return Array.from(acc).sort();
    });

    if (times.length) {
      result[label] = times;
      log(`⏰ День ${label}:`, times);
    }
  }

  return result;
}

// ---------- main ----------
async function main() {
  const start = Date.now();

  // прокси
  let chosenProxy = null;
  if (PROXY_LIST) {
    const lines = PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
    for (const p of lines) {
      try { await testProxyReachable(p); chosenProxy = p; break; }
      catch { /* попробуем следующий */ }
    }
  }

  const { browser, browserProxy } = await launchBrowserWithProxy(chosenProxy);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  log('🌐 Открываем сайт:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // баннер на главной
  const banner = page.locator('text=Аренда теннисных кортов').first();
  await banner.waitFor({ timeout: 15000 });
  await banner.click({ timeout: 3000 });
  log('✅ Клик по баннеру «Аренда теннисных кортов»');

  const all = await scrapeSlots(page);

  // сообщение
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
