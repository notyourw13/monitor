// --- Luzhniki Monitor — proxies rotation + weekday labels + robust scraping ---
import playwright from 'playwright';
import fetch from 'node-fetch';
import proxyChain from 'proxy-chain';
import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';
import fs from 'fs/promises';
import { URL as NodeURL } from 'url';

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

// ---------- proxy helpers ----------
function parseProxyLine(line) {
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('socks5://')) return s;
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) return 'http://' + s;
  return s;
}
function buildFetchAgent(u) {
  if (!u) return undefined;
  if (u.startsWith('https://')) return new HttpsProxyAgent(u);
  if (u.startsWith('http://'))  return new HttpProxyAgent(u);
  if (u.startsWith('socks5://')) return new SocksProxyAgent(u);
  return undefined;
}
function printableProxy(u) {
  if (!u) return 'без прокси';
  try {
    const p = new NodeURL(u.includes('://') ? u : 'http://' + u);
    const host = p.hostname || '';
    const port = p.port ? `:${p.port}` : '';
    const scheme = p.protocol ? p.protocol.replace(':','') : 'http';
    return `${scheme}://${host}${port}`;
  } catch {
    return u;
  }
}
async function testProxyReachable(u, timeoutMs = 5000) {
  const agent = buildFetchAgent(u);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://ifconfig.me/ip', { agent, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('status ' + r.status);
    const ip = (await r.text()).trim();
    return ip || 'ok';
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
        log('⚠️ Ошибка Telegram для', id, r.status, body);
      } else {
        log('✅ Сообщение отправлено пользователю', id);
      }
    } catch (e) {
      log('⚠️ Исключение при отправке пользователю', id, e.message);
    }
  }
}

// ---------- artifacts ----------
async function dump(page, tag) {
  try {
    await fs.writeFile(`art-${tag}.html`, await page.content(), 'utf8');
    await page.screenshot({ path: `art-${tag}.png`, fullPage: true });
  } catch {}
}

// ---------- browser ----------
async function launchBrowserWithProxy(raw) {
  let server = null;
  if (raw) server = raw.startsWith('socks5://') ? await proxyChain.anonymizeProxy(raw) : raw;
  const browser = await chromium.launch({ headless: true, proxy: server ? { server } : undefined });
  return { browser, server };
}

// ---------- wizard (robust) ----------
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

// ---------- days ----------
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

// ---------- slots helpers ----------
const TIMES_RE = /\b(\d{1,2}):(\d{2})\b/;
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
async function collectTimesCombined(page) {
  const out = new Set();

  // 1) SLOT_SEL
  {
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(`${m[1].padStart(2,'0')}:${m[2]}`);
    }
  }
  // 4) ul:nth-child(2/4)+slot
  {
    for (const sel of ['ul:nth-child(2) '+SLOT_SEL, 'ul:nth-child(4) '+SLOT_SEL]) {
      const els = await page.locator(sel).all().catch(()=>[]);
      for (const el of els) {
        const t = (await el.innerText().catch(()=> '')).trim();
        const m = t.match(TIMES_RE);
        if (m) out.add(`${m[1].padStart(2,'0')}:${m[2]}`);
      }
    }
  }
  // 5) locator.filter(hasText)
  {
    const els = await page.locator(SLOT_SEL).filter({ hasText: /:\d{2}/ }).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(`${m[1].padStart(2,'0')}:${m[2]}`);
    }
  }
  // 7) slotDesktopWidth
  {
    const els = await page.locator('[class*="slotDesktopWidth"]').all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(`${m[1].padStart(2,'0')}:${m[2]}`);
    }
  }
  if (out.size === 0) {
    await page.evaluate(()=>window.scrollBy(0, Math.round(window.innerHeight*0.4))).catch(()=>{});
    await page.waitForTimeout(150);
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(`${m[1].padStart(2,'0')}:${m[2]}`);
    }
  }
  return Array.from(out).sort((a,b)=>a.localeCompare(b));
}

// ---------- calendar month/year & weekday label ----------
const RU_MONTHS = {
  'январь':0,'февраль':1,'март':2,'апрель':3,'май':4,'июнь':5,
  'июль':6,'август':7,'сентябрь':8,'октябрь':9,'ноябрь':10,'декабрь':11,
  'января':0,'февраля':1,'марта':2,'апреля':3,'мая':4,'июня':5,'июля':6,'августа':7,'сентября':8,'октября':9,'ноября':10,'декабря':11,
};
const RU_WD = ['вс','пн','вт','ср','чт','пт','сб'];

async function getCalendarContext(page) {
  // заголовок месяца где-то над лентой: обычно просто "Октябрь"
  let monthText = (await page.locator('text=/^\\s*[А-Яа-я]+\\s*$/').first().innerText().catch(()=> '')).trim().toLowerCase();
  // подстрахуемся: пробуем конкретные селекторы, если общая эвристика не сработала
  if (!RU_MONTHS.hasOwnProperty(monthText)) {
    for (const sel of ['[class*="Calendar"] h2', 'h2:has-text(/янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек/i)']) {
      const t = (await page.locator(sel).first().innerText().catch(()=> '')).trim().toLowerCase();
      if (RU_MONTHS.hasOwnProperty(t)) { monthText = t; break; }
    }
  }
  const mIdx = RU_MONTHS.hasOwnProperty(monthText) ? RU_MONTHS[monthText] : (new Date()).getMonth();
  const now = new Date();
  // если на странице месяц "меньше" текущего более чем на 6, считаем, что это следующий год (декабрь→январь кейс)
  let year = now.getFullYear();
  if (mIdx < now.getMonth() - 6) year = now.getFullYear() + 1;
  return { monthIndex: mIdx, year };
}
function dayLabelWithWeekday(dayNum, ctx) {
  const d = new Date(ctx.year, ctx.monthIndex, Number(dayNum));
  return `${dayNum}, ${RU_WD[d.getDay()]}`;
}

// ---------- scrape ----------
async function scrapeAll(page) {
  await clickThroughWizard(page);
  const ctx = await getCalendarContext(page);
  const days = await findDayButtons(page);
  log('📅 Дни (кликабельные):', days.map(d=>d.label).join(', '));

  const result = {};
  for (const d of days) {
    await d.btn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(()=>{});
    await d.btn.click({ timeout: 1200 }).catch(()=>{});
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
      result[dayLabelWithWeekday(d.label, ctx)] = times;
    } else {
      await dump(page, `day-${d.label}`);
    }
  }
  return result;
}

// ---------- main with proxy rotation & reporting ----------
async function main() {
  const start = Date.now();

  // подготовим список прокси и точку старта для ротации (меняем старт по времени)
  const proxies = PROXY_LIST
    ? PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean)
    : [];
  const rotationStart = proxies.length ? (Math.floor(Date.now() / 600000) % proxies.length) : 0; // шаг ≈10 мин

  let chosen = null;
  let chosenPrintable = 'без прокси';

  const tryOrder = [];
  if (proxies.length) {
    for (let i=0;i<proxies.length;i++) tryOrder.push(proxies[(rotationStart + i) % proxies.length]);
  }
  tryOrder.push(null); // в конце — без прокси как фоллбек

  for (const candidate of tryOrder) {
    try {
      if (candidate) {
        const ip = await testProxyReachable(candidate, 6000);
        log('🔌 Прокси OK:', printableProxy(candidate), 'IP', ip);
      } else {
        log('🔌 Попытка без прокси');
      }
      chosen = candidate;
      chosenPrintable = printableProxy(candidate);
      break;
    } catch (e) {
      log('❌ Прокси не подошёл:', printableProxy(candidate), String(e));
    }
  }

  const { browser, server } = await launchBrowserWithProxy(chosen);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  const page = await ctx.newPage();

  log('🌐 Открываем сайт:', TARGET_URL);
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    await dump(page, 'goto-fail');
    await sendTelegram(
      `⚠️ Лужники монитор упал\n${String(e)}\n\nПрокси: ${chosenPrintable}`
    );
    throw e;
  }

  let all = {};
  try {
    all = await scrapeAll(page);
  } catch (e) {
    await dump(page, 'fatal');
    await sendTelegram(
      `⚠️ Лужники монитор упал\n${String(e)}\n\nПрокси: ${chosenPrintable}`
    );
    throw e;
  }

  // форматируем сообщение
  let text = `🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n(прокси: ${chosenPrintable})\n\n`;
  const keys = Object.keys(all).sort((a,b)=>{
    // сортируем по числу дня слева от запятой
    const da = Number(a.split(',')[0].trim());
    const db = Number(b.split(',')[0].trim());
    return da - db;
  });
  if (!keys.length) {
    text += '(ничего не найдено)\n\n';
  } else {
    for (const k of keys) text += `📅 ${k}\n  ${all[k].join(', ')}\n\n`;
  }
  text += COURTS_URL;

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
