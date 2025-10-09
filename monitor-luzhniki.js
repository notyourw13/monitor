// --- Luzhniki monitor ---
// Работает в GitHub Actions. Проходит весь wizard:
// "Аренда крытых кортов" → "Продолжить" → обходит дни → собирает слоты.
// Использует SOCKS5 с авторизацией через proxy-chain (локальный HTTP-мост).

import fs from 'fs';
import { chromium, devices } from 'playwright';
import proxyChain from 'proxy-chain';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import TelegramBot from 'node-telegram-bot-api';

const URL = 'https://tennis.luzhniki.ru/#courts';
const DESKTOP = devices['Desktop Chrome'];
const LOGFILE = `run-${Date.now()}.log`;

// ----- логирование -----
function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch {}
}

// ----- env helpers -----
function env(name, fallback) {
  return (process.env[name] ?? fallback ?? '').toString().trim();
}
function pickFromList(listStr) {
  if (!listStr) return null;
  const items = listStr.split(/[, \n\r]+/).map(s => s.trim()).filter(Boolean);
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

// ----- подготовка прокси -----
async function prepareBrowserProxy() {
  const raw = env('PROXY_URL') || pickFromList(env('PROXY_LIST'));
  if (!raw) throw new Error('PROXY_URL/PROXY_LIST пуст');

  if (/^socks5:/i.test(raw)) {
    log('Проверяем SOCKS5 upstream:', maskCreds(raw));
    try {
      const agent = new SocksProxyAgent(raw);
      const r = await fetch('https://ifconfig.me', { agent, timeout: 10_000 });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const ip = await r.text();
      log('SOCKS5 работает, IP:', ip);
    } catch (e) {
      throw new Error('SOCKS5 upstream не отвечает: ' + e.message);
    }
    const httpBridge = await proxyChain.anonymizeProxy(raw);
    log('Создан локальный HTTP-мост:', httpBridge);
    return { server: httpBridge, close: () => proxyChain.closeAnonymizedProxy(httpBridge, true) };
  }

  if (/^https?:\/\//i.test(raw)) {
    log('HTTP(S) прокси задан:', maskCreds(raw));
    return { server: raw, close: async () => {} };
  }

  throw new Error('Неизвестный формат PROXY_URL');
}

function maskCreds(u) {
  try {
    const url = new URL(u);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch { return u.replace(/\/\/[^@]+@/, '//***:***@'); }
}

// ----- Telegram -----
async function sendTelegram(text) {
  const token = env('TG_BOT_TOKEN');
  const chat = env('TG_CHAT_ID');
  if (!token || !chat) {
    log('TG creds missing; skipping send');
    return;
  }
  const bot = new TelegramBot(token);
  await bot.sendMessage(chat, text, { disable_web_page_preview: true });
}

// ----- навигация и парсинг -----
async function gotoWithRetries(page, url, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      await page.waitForSelector('text=Аренда крытых кортов', { timeout: 30_000 });
      return;
    } catch (e) {
      last = e;
      log(`[goto retry ${i}] ${e.message}`);
      await page.waitForTimeout(5_000);
    }
  }
  throw last;
}

async function dumpArtifacts(page, tag='fail') {
  try { await page.screenshot({ path: `art-${tag}.png`, fullPage: true }); } catch {}
  try { await fs.promises.writeFile(`art-${tag}.html`, await page.content()); } catch {}
}

// --- Основной обход wizard ---
async function scrapeWizard(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
  const card = page.locator('xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]').first();
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.click();

  const contBtn = page.locator('xpath=//button[contains(normalize-space(.),"Продолжить")]').first();
  await contBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await contBtn.click();

  await page.waitForTimeout(1000);
  await page.waitForSelector('text=Утро,Вечер', { timeout: 30_000 }).catch(()=>{});

  // ищем кнопки дней
  const btns = await page.locator('xpath=//*[self::button or @role="button"][string-length(normalize-space(.))<=2 and string-length(normalize-space(.))>=1]').all();
  const days = [];
  for (const b of btns) {
    const t = (await b.innerText().catch(()=> '')).trim();
    if (/^\d{1,2}$/.test(t)) days.push(b);
  }
  if (days.length === 0 && btns.length) days.push(btns[0]);

  const out = [];
  for (const dBtn of days) {
    await dBtn.scrollIntoViewIfNeeded().catch(()=>{});
    await dBtn.click({ timeout: 5000 }).catch(()=>{});
    await page.waitForTimeout(500);

    const times = await page.$$eval('*', n =>
      Array.from(n)
        .map(el => (el.textContent||'').trim())
        .filter(t => /^\d{1,2}:\d{2}$/.test(t))
        .map(t => t.padStart(5,'0'))
    );
    const uniq = Array.from(new Set(times)).sort();
    const today = new Date().toISOString().slice(0,10);
    out.push({ date: today, times: uniq });
  }
  return out;
}

// ----- форматирование -----
function formatSlotsByDay(slots) {
  if (!slots?.length)
    return `ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n(ничего не найдено)\n\n${URL}`;
  const fmt = new Intl.DateTimeFormat('ru-RU', { weekday:'short', day:'2-digit', month:'numeric' });
  let out = 'ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n';
  for (const day of [...slots].sort((a,b)=>a.date.localeCompare(b.date))) {
    const d = new Date(day.date+'T00:00:00+03:00');
    out += `\n${fmt.format(d)}:\n`;
    for (const t of [...(day.times||[])].sort()) out += `  ${t}\n`;
  }
  out += `\n${URL}`;
  return out;
}

// ----- main -----
(async () => {
  let bridge, browser, context;
  const start = Date.now();

  try {
    const prepared = await prepareBrowserProxy();
    bridge = prepared;

    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

    browser = await chromium.launch({
      headless: true,
      ...DESKTOP,
      args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'],
      timeout: 120_000,
      proxy: { server: bridge.server }
    });

    context = await browser.newContext({
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      userAgent: ua
    });
    const page = await context.newPage();
    page.on('console', msg => log('[page]', msg.type(), msg.text()));

    log('Открываем', URL);
    await gotoWithRetries(page, URL, 3);

    const slots = await scrapeWizard(page);
    log('Найдено слотов:', JSON.stringify(slots));
    if (!slots.length) await dumpArtifacts(page, 'empty');

    const text = formatSlotsByDay(slots);
    await sendTelegram(text);
    log('Отправлено в Telegram.');

  } catch (e) {
    log('Ошибка:', e.message || e);
    try {
      const pages = context?.pages?.() || [];
      if (pages[0]) await dumpArtifacts(pages[0], 'error');
    } catch {}
    process.exitCode = 1;
  } finally {
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
    try { await bridge?.close?.(); } catch {}
    log('Время выполнения:', Math.round((Date.now()-start)/1000)+'s');
  }
})();
