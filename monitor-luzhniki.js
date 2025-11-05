// --- Luzhniki Monitor — robust multi-day scrape + proxy rotation + weekday tags ---

import playwright from 'playwright';
import fetch from 'node-fetch';
import proxyChain from 'proxy-chain';
import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';
import fs from 'fs/promises';

const { chromium } = playwright;
const { HttpProxyAgent }  = httpProxyAgentPkg;
const { HttpsProxyAgent } = httpsProxyAgentPkg;
const { SocksProxyAgent } = socksProxyAgentPkg;

const TARGET_URL   = 'https://tennis.luzhniki.ru/';
const COURTS_URL   = 'https://tennis.luzhniki.ru/#courts';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_LIST   = (process.env.PROXY_LIST || '').trim();

const SLOT_SEL =
  '[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
  '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- proxy utils ----------------
function parseProxyLine(line) {
  const s = (line || '').trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('socks5://')) return s;
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) return 'http://' + s; // host:port -> http://
  return s;
}
function buildFetchAgent(u) {
  if (!u) return undefined;
  if (u.startsWith('https://')) return new HttpsProxyAgent(u);
  if (u.startsWith('http://'))  return new HttpProxyAgent(u);
  if (u.startsWith('socks5://')) return new SocksProxyAgent(u);
  return undefined;
}
async function testProxyReachable(u) {
  const agent = buildFetchAgent(u);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://ifconfig.me/all.json', { agent, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    return j.ip_addr || 'ok';
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ---------------- telegram ----------------
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('TG creds missing; printing:\n' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const ids = TG_CHAT_ID.split(',').map(s => s.trim()).filter(Boolean);

  for (const id of ids) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: id,
          text,
          disable_web_page_preview: true,
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        log('⚠️ Telegram error for', id, r.status, body);
      } else {
        log('✅ Sent to', id);
      }
    } catch (e) {
      log('⚠️ Telegram exception for', id, e.message);
    }
  }
}

// ---------------- artifacts ----------------
async function dump(page, tag) {
  try {
    await fs.writeFile(`art-${tag}.html`, await page.content(), 'utf8');
    await page.screenshot({ path: `art-${tag}.png`, fullPage: true });
  } catch {}
}

// ---------------- browser (low-level) ----------------
async function launchBrowserWithProxy(raw) {
  let server = null;
  if (raw) server = raw.startsWith('socks5://') ? await proxyChain.anonymizeProxy(raw) : raw;
  const browser = await chromium.launch({ headless: true, proxy: server ? { server } : undefined });
  return { browser, server };
}

// ---------------- UA / helpers for rotation ----------------
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];
const shortProxy = (p) =>
  p ? p.replace(/\/\/[^@]*@/, '//')             // скрыть логин:пароль
      .replace(/^socks5:\/\//,'socks5://')
      .replace(/^http:\/\//,'http://') : 'без прокси';

// Надёжный goto с ретраями и альтернативным адресом
async function gotoWithRetries(page, url, tries = 3, timeout = 45000) {
  const candidates = [url, COURTS_URL];
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    for (const u of candidates) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForTimeout(300);
        return;
      } catch (e) {
        lastErr = e;
        await page.waitForTimeout(500 + i * 500);
        await page.reload({ timeout: 10000 }).catch(() => {});
      }
    }
  }
  throw lastErr || new Error('goto failed');
}

// Создаём контекст, открываем сайт под конкретный прокси
async function launchWithProxyAndOpen(proxyUrl) {
  const { browser, server } = await launchBrowserWithProxy(proxyUrl);
  let ctx, page;
  try {
    ctx = await browser.newContext({
      viewport: { width: 1280, height: 1500 },
      userAgent: pickUA(),
      extraHTTPHeaders: { 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' }
    });
    page = await ctx.newPage();
    await gotoWithRetries(page, TARGET_URL);
    return { browser, server, ctx, page };
  } catch (e) {
    try { await ctx?.close(); } catch {}
    try { await browser.close(); } catch {}
    throw e;
  }
}

// Перебор всех прокси в одном запуске (плюс попытка без прокси)
async function openWithBestConnectivity() {
  const rawList = (PROXY_LIST || '').split(/\r?\n/).map(parseProxyLine).filter(Boolean);
  const candidates = [...rawList, null]; // последняя попытка — без прокси
  const attemptLog = [];

  // быстрый пинг-просеиватель
  const filtered = [];
  for (const p of candidates) {
    if (!p) { filtered.push(p); continue; }
    try { await testProxyReachable(p); filtered.push(p); }
    catch (e) { attemptLog.push(`${shortProxy(p)} → недоступен (ping): ${e.message}`); }
  }

  for (const p of filtered) {
    try {
      const res = await launchWithProxyAndOpen(p);
      return { ...res, proxyNote: shortProxy(p), attemptLog };
    } catch (e) {
      attemptLog.push(`${shortProxy(p)} → ошибка открытия: ${e.message}`);
    }
  }

  throw new Error('Не удалось открыть сайт. Попытки:\n' + attemptLog.join('\n'));
}

// ---------------- wizard (robust) ----------------
async function clickThroughWizard(page) {
  const banner = page.locator('text=Аренда теннисных кортов').first();
  if (await banner.isVisible().catch(()=>false)) {
    await banner.click({ timeout: 20000 }).catch(()=>{});
    log('✅ Баннер');
    await page.waitForTimeout(300);
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const anyDay = page.locator('button div:nth-child(2)').filter({ hasText: /^\d{1,2}$/ }).first();
    if (await anyDay.isVisible().catch(()=>false)) {
      log('➡️ Уже на экране календаря');
      break;
    }

    const indoorByText = page.locator('text=/Аренда\\s+крытых\\s+кортов/i').first();
    const indoorCard =
      (await indoorByText.isVisible().catch(()=>false)) ? indoorByText :
      page.locator('[class*="card"], [role="group"], [role="button"]').filter({ hasText: /Крыт/i }).first();

    if (await indoorCard.isVisible().catch(()=>false)) {
      const plus = indoorCard.locator('xpath=ancestor::*[self::div or self::section][1]//button[contains(.,"+")]').first();
      if (await plus.isVisible().catch(()=>false)) {
        await plus.click({ timeout: 2000 }).catch(()=>{});
      } else {
        await indoorCard.click({ timeout: 3000 }).catch(()=>{});
      }
      log('✅ Крытые');
      await page.waitForTimeout(200);
    }

    const cont = page
      .locator('button:has-text("Продолжить"), [role="button"]:has-text("Продолжить"), text=/^Продолжить$/')
      .first();
    if (await cont.isVisible().catch(()=>false)) {
      await cont.click({ timeout: 5000 }).catch(()=>{});
      log('✅ Продолжить');
      await page.waitForTimeout(400);
    }

    if (!(await anyDay.isVisible().catch(()=>false))) {
      await page.goto(COURTS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
      await page.waitForTimeout(400);
    } else {
      break;
    }
  }
  await page.waitForTimeout(250);
}

// ---------------- days ----------------
async function findDayButtons(page) {
  const allBtns = page.locator('button');
  const cnt = await allBtns.count().catch(()=>0);
  const list = [];
  for (let i=0;i<cnt;i++) {
    const btn = allBtns.nth(i);
    const numDiv = btn.locator('div:nth-child(2)');
    if (!(await numDiv.count().catch(()=>0))) continue;
    const label = (await numDiv.innerText().catch(()=> '')).trim();
    if (!/^\d{1,2}$/.test(label)) continue;

    const disabled = (await btn.getAttribute('disabled').catch(()=>null)) !== null
                  || (await btn.getAttribute('aria-disabled').catch(()=>null)) === 'true';
    if (disabled) continue;

    if (!(await btn.isVisible().catch(()=>false)) || !(await btn.isEnabled().catch(()=>false))) continue;

    const bb = await btn.boundingBox().catch(()=>null);
    if (!bb) continue;

    list.push({ label, btn, x: bb.x });
  }
  list.sort((a,b)=>a.x-b.x);
  return list;
}
async function getSelectedDayLabel(page) {
  const sel = page.locator('button[class*="Selected"] div:nth-child(2)').first();
  const t = (await sel.innerText().catch(()=> '')).trim();
  return /^\d{1,2}$/.test(t) ? t : '';
}

// ---------------- slots helpers ----------------
const TIMES_RE = /\b(\d{1,2}):(\d{2})\b/;
const padTime = (h, m) => `${String(h).padStart(2,'0')}:${m}`;

// гарантируем, что сетка слотов перерисовалась
async function ensureSlotsRendered(page) {
  await page.evaluate(()=>window.scrollTo({ top: 0 }));
  await page.waitForTimeout(120);
  const toggles = [page.locator('text=/^Утро$/i').first(), page.locator('text=/^Вечер$/i').first()];
  for (const sw of toggles) {
    if (await sw.isVisible().catch(()=>false)) {
      await sw.scrollIntoViewIfNeeded().catch(()=>{});
      await sw.click({ timeout: 400 }).catch(()=>{});
      await page.waitForTimeout(120);
    }
  }
  const containerSel = 'ul[class*="time-slot"], div[class*="time-slot"]';
  for (let i = 0; i < 4; i++) {
    if (await page.locator(containerSel).first().isVisible().catch(()=>false)) break;
    await page.waitForTimeout(800);
  }
  await page.evaluate(()=>window.scrollBy(0, window.innerHeight/3)).catch(()=>{});
  await page.waitForTimeout(500);
}

// сбор слотов (объединённый метод)
async function collectTimesCombined(page) {
  const out = new Set();

  // 1) базовый класс
  {
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // 2) секции ul:nth-child(2/4)
  {
    for (const sel of ['ul:nth-child(2) '+SLOT_SEL, 'ul:nth-child(4) '+SLOT_SEL]) {
      const els = await page.locator(sel).all().catch(()=>[]);
      for (const el of els) {
        const t = (await el.innerText().catch(()=> '')).trim();
        const m = t.match(TIMES_RE);
        if (m) out.add(padTime(m[1], m[2]));
      }
    }
  }

  // 3) фильтр по тексту
  {
    const els = await page.locator(SLOT_SEL).filter({ hasText: /:\d{2}/ }).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // 4) desktop width вариант
  {
    const els = await page.locator('[class*="slotDesktopWidth"]').all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // нудж если пусто
  if (out.size === 0) {
    await page.evaluate(()=>window.scrollBy(0, Math.round(window.innerHeight*0.4))).catch(()=>{});
    await page.waitForTimeout(150);
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  return Array.from(out).sort((a,b)=>a.localeCompare(b));
}

// ---------------- calendar month/year & weekday ----------------
const MONTHS_RU = {
  'январь':0,'февраль':1,'март':2,'апрель':3,'май':4,'июнь':5,
  'июль':6,'август':7,'сентябрь':8,'октябрь':9,'ноябрь':10,'декабрь':11
};
const WD_RU = ['вс','пн','вт','ср','чт','пт','сб'];

async function inferMonthYear(page) {
  // ищем заголовок месяца (текст "Октябрь" и т.п.)
  const monthNode = page.locator('text=/январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр|ноябр|декабр/i').first();
  const txt = (await monthNode.innerText().catch(()=>'')) || '';
  const m = Object.keys(MONTHS_RU).find(k => txt.toLowerCase().includes(k));
  const month = (m != null) ? MONTHS_RU[m] : (new Date()).getMonth();
  let year = (new Date()).getFullYear();
  // если показан январь, а сейчас декабрь — возможно, это уже следующий год
  const now = new Date();
  if (now.getMonth() === 11 && month === 0) year = now.getFullYear() + 1;
  return { month, year };
}

function weekdayTag(year, month, dayNum) {
  const d = new Date(year, month, Number(dayNum));
  return WD_RU[d.getDay()];
}

// ---------------- scrape ----------------
async function scrapeAll(page) {
  await clickThroughWizard(page);

  const days = await findDayButtons(page);
  log('📅 Дни (кликабельные):', days.map(d=>d.label).join(', '));

  const result = {};
  for (const d of days) {
    await d.btn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(()=>{});
    await d.btn.click({ timeout: 1200 }).catch(()=>{});

    // ждём, чтобы день действительно стал выбранным
    for (let i=0; i<8; i++) {
      const selected = await getSelectedDayLabel(page);
      if (selected === d.label) break;
      if (i === 2) await d.btn.click({ timeout: 800, force: true }).catch(()=>{});
      if (i === 5) await d.btn.evaluate(el => el.click()).catch(()=>{});
      await page.waitForTimeout(120);
    }

    const selectedFinal = await getSelectedDayLabel(page);
    if (selectedFinal !== d.label) {
      log(`↷ Пропускаем день ${d.label} — не выделился`);
      continue;
    }

    await ensureSlotsRendered(page);
    await page.waitForTimeout(600);

    const times = await collectTimesCombined(page);
    if (times.length) {
      result[d.label] = times;
    } else {
      await dump(page, `day-${d.label}`);
    }
  }

  return result;
}

// ---------------- main ----------------
async function main() {
  const start = Date.now();

  let browser, ctx, page, server, proxyNote = 'без прокси', attemptLog = [];
  try {
    const opened = await openWithBestConnectivity();
    browser    = opened.browser;
    ctx        = opened.ctx;
    page       = opened.page;
    server     = opened.server;
    proxyNote  = opened.proxyNote;
    attemptLog = opened.attemptLog || [];
  } catch (e) {
    await sendTelegram(
      '⚠️ Лужники монитор упал\n' +
      (e && e.message ? e.message : String(e)) + '\n\n' +
      (attemptLog.length ? ('Попытки:\n' + attemptLog.join('\n') + '\n\n') : '') +
      'Прокси: без успешного подключения'
    );
    throw e;
  }

  log('🌐 Открыли сайт через:', proxyNote);

  let all = {};
  try {
    all = await scrapeAll(page);
  } catch (e) {
    await dump(page, 'fatal');
    await sendTelegram(
      '⚠️ Лужники монитор упал на этапе парсинга\n' +
      (e && e.message ? e.message : String(e)) + '\n\n' +
      'Прокси: ' + proxyNote
    );
    throw e;
  }

  // добавим теги дней недели по заголовку месяца
  const { month, year } = await inferMonthYear(page);

  // форматируем сообщение
  let text = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
  const keys = Object.keys(all).sort((a,b)=>(+a)-(+b));
  if (!keys.length) {
    text += '(ничего не найдено)\n\n';
  } else {
    for (const k of keys) {
      const wd = weekdayTag(year, month, k);
      text += `📅 ${k}, ${wd}\n  ${all[k].join(', ')}\n\n`;
    }
  }
  text += COURTS_URL + '\n\n' + 'Прокси: ' + proxyNote;

  await sendTelegram(text);
  log('✅ Сообщение отправлено.');

  await ctx.close();
  await browser.close();
  if (server?.startsWith('http://127.0.0.1:')) {
    try { await proxyChain.closeAnonymizedProxy(server, true); } catch {}
  }
  log('⏱ Время выполнения:', ((Date.now() - start) / 1000).toFixed(1) + 's');
}

await main();
