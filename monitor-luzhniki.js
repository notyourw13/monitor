// --- Luzhniki monitor v2 ---
// Полный проход: "Аренда крытых кортов" → "Продолжить" → кликаем дни календаря → собираем чипы времени.
// Включён Playwright tracing + скрины/HTML на фейлах/пустоте. SOCKS5 через proxy-chain.

import fs from 'fs';
import { chromium, devices } from 'playwright';
import proxyChain from 'proxy-chain';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import TelegramBot from 'node-telegram-bot-api';

const URL = 'https://tennis.luzhniki.ru/#courts';
const DESKTOP = devices['Desktop Chrome'];
const LOGFILE = `run-${Date.now()}.log`;

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch {}
}

function env(name, fallback) { return (process.env[name] ?? fallback ?? '').toString().trim(); }
function pickFromList(listStr) {
  if (!listStr) return null;
  const a = listStr.split(/[, \n\r]+/).map(s=>s.trim()).filter(Boolean);
  return a.length ? a[Math.floor(Math.random()*a.length)] : null;
}

async function prepareBrowserProxy() {
  const raw = env('PROXY_URL') || pickFromList(env('PROXY_LIST'));
  if (!raw) throw new Error('PROXY_URL/PROXY_LIST пуст');

  if (/^socks5:/i.test(raw)) {
    log('Проверяем SOCKS5 upstream:', maskCreds(raw));
    try {
      const agent = new SocksProxyAgent(raw);
      const r = await fetch('https://ifconfig.me', { agent, timeout: 10_000 });
      if (!r.ok) throw new Error(`status ${r.status}`);
      log('SOCKS5 работает, IP:', await r.text());
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
    if (url.username || url.password) { url.username='***'; url.password='***'; }
    return url.toString();
  } catch { return u.replace(/\/\/[^@]+@/,'//***:***@'); }
}

async function sendTelegram(text) {
  const token = env('TG_BOT_TOKEN');
  const chat = env('TG_CHAT_ID');
  if (!token || !chat) { log('TG creds missing; skip send'); return; }
  const bot = new TelegramBot(token);
  await bot.sendMessage(chat, text, { disable_web_page_preview: true });
}

async function gotoWithRetries(page, url, attempts=3) {
  let last;
  for (let i=1;i<=attempts;i++){
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      // Cloudflare/anti-bot детект
      const html = await page.content();
      if (/Checking your browser|cloudflare|attention required/i.test(html)) {
        log('Обнаружен антибот экран, ждём ещё…');
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(()=>{});
        await page.waitForTimeout(4000);
      }
      await page.waitForSelector('xpath=//*[contains(normalize-space(.),"Аренда") and contains(normalize-space(.),"кортов")]', { timeout: 30_000 });
      return;
    } catch(e){ last=e; log(`[goto retry ${i}] ${e.message}`); await page.waitForTimeout(5000); }
  }
  throw last;
}

async function dumpArtifacts(page, tag='fail') {
  try { await page.screenshot({ path: `art-${tag}.png`, fullPage: true }); } catch {}
  try { await fs.promises.writeFile(`art-${tag}.html`, await page.content()); } catch {}
}

// === wizard ===
async function clickCoveredCard(page) {
  // варианты: карточка, иконка "+", или кнопка внутри карточки
  const candidates = [
    'xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]//button',
    'xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]',
    'xpath=//button[contains(normalize-space(.),"+")]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(()=>false)) {
      await loc.scrollIntoViewIfNeeded().catch(()=>{});
      await loc.click({ timeout: 5000 }).catch(()=>{});
      return true;
    }
  }
  return false;
}

async function clickContinue(page) {
  const btn = page.locator('xpath=//button[contains(normalize-space(.),"Продолжить")]').first();
  if (await btn.isVisible().catch(()=>false)) { await btn.click(); return true; }
  return false;
}

async function findCalendarRoot(page) {
  // Ищем контейнер календаря/дней
  const sels = [
    'xpath=//*[contains(@class,"calendar")]',
    'xpath=//*[@role="tablist" or contains(@class,"tabs")]',
    'xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]/..',
    'xpath=//main',
    'xpath=//*'
  ];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(()=>false)) return loc;
  }
  return page.locator('xpath=//*').first();
}

async function getDayButtons(root) {
  const nodes = await root.locator('xpath=.//*[self::button or @role="button"]').all();
  const out = [];
  for (const n of nodes) {
    const t = (await n.innerText().catch(()=> '')).trim();
    if (/^\d{1,2}$/.test(t)) out.push(n);
  }
  return out;
}

async function collectTimesFromPage(page) {
  // только из секций рядом с «Утро/Вечер», чтобы не хватать мусор
  const sections = await page.locator('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]/ancestor::*[self::section or self::div][1]').all();
  const times = new Set();
  for (const s of sections) {
    const tx = await s.evaluate(el =>
      Array.from(el.querySelectorAll('*'))
        .map(n => (n.textContent || '').trim())
        .filter(t => /^\d{1,2}:\d{2}$/.test(t))
    ).catch(()=>[]);
    tx.forEach(t => {
      const m = t.match(/^(\d{1,2}):(\d{2})$/);
      times.add(m ? `${String(m[1]).padStart(2,'0')}:${m[2]}` : t);
    });
  }
  return Array.from(times).sort();
}

function moscowTodayISO() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  return now.toISOString().slice(0,10);
}

async function scrapeWizard(page) {
  // шаг 1: карточка
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
  const ok1 = await clickCoveredCard(page);
  if (!ok1) throw new Error('Не нашли карточку «Аренда крытых кортов»');

  // шаг 2: продолжить
  await page.waitForTimeout(300);
  const ok2 = await clickContinue(page);
  if (!ok2) log('Кнопка «Продолжить» не найдена — возможно, шаг объединён');

  // шаг 3: календарь
  await page.waitForTimeout(800);
  const root = await findCalendarRoot(page);
  const days = await getDayButtons(root);
  log('Найдено кнопок-дней:', days.length);
  if (!days.length) {
    // иногда дни лежат в соседней обёртке — fallback по всей странице
    const all = await getDayButtons(page.locator('xpath=//*'));
    if (all.length) days.push(...all);
  }

  const result = [];
  const isoToday = moscowTodayISO();

  // ограничим количество дней, чтобы не висеть бесконечно (например, до 14 видимых)
  for (let i = 0; i < Math.min(days.length, 14); i++) {
    const dBtn = days[i];
    const label = (await dBtn.innerText().catch(()=> '')).trim();
    await dBtn.scrollIntoViewIfNeeded().catch(()=>{});
    await dBtn.click({ timeout: 4000 }).catch(()=>{});
    await page.waitForTimeout(400);

    const times = await collectTimesFromPage(page);
    log(`День ${label}: слотов ${times.length}`);
    result.push({ date: isoToday, times });
  }

  return mergeByDate(result);
}

function mergeByDate(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.date)) by.set(r.date, new Set());
    r.times.forEach(t => by.get(r.date).add(t));
  }
  return Array.from(by.entries()).map(([date, set]) => ({
    date, times: Array.from(set).sort()
  }));
}

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

(async () => {
  let bridge, browser, context;
  const start = Date.now();

  try {
    const prepared = await prepareBrowserProxy();
    bridge = prepared;

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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    });

    // включаем трейсинг
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    const page = await context.newPage();
    page.on('console', m => log('[page]', m.type(), m.text()));

    log('Открываем', URL);
    await gotoWithRetries(page, URL, 3);

    const slots = await scrapeWizard(page);
    log('Итого слотов:', JSON.stringify(slots));

    if (!slots.length) {
      await dumpArtifacts(page, 'empty');
    }

    const text = formatSlotsByDay(slots);
    await sendTelegram(text);
    log('Отправлено в TG');

    // сохраняем trace
    await context.tracing.stop({ path: 'trace.zip' });

  } catch (e) {
    log('Ошибка:', e.message || e);
    try {
      await context?.tracing?.stop({ path: 'trace.zip' }).catch(()=>{});
      const p = context?.pages?.()[0];
      if (p) await dumpArtifacts(p, 'error');
    } catch {}
    process.exitCode = 1;
  } finally {
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
    try { await bridge?.close?.(); } catch {}
    log('Время выполнения:', Math.round((Date.now()-start)/1000)+'s');
  }
})();
