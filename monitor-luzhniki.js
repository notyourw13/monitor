// --- Luzhniki Monitor — rotation + diff-only notify (HTML formatting, 2025-12 DOM) ---
import playwright from 'playwright';
import fetch from 'node-fetch';
import proxyChain from 'proxy-chain';
import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';
import fs from 'fs/promises';
import path from 'path';

const { chromium } = playwright;
const { HttpProxyAgent }  = httpProxyAgentPkg;
const { HttpsProxyAgent } = httpsProxyAgentPkg;
const { SocksProxyAgent } = socksProxyAgentPkg;

const TARGET_URL   = 'https://tennis.luzhniki.ru/';
const COURTS_URL   = 'https://tennis.luzhniki.ru/#courts';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_LIST_ENV = (process.env.PROXY_LIST || '').trim();

const STATE_DIR  = 'state';
const STATE_FILE = path.join(STATE_DIR, 'snapshot.json');

const WEEKDAY_RU = ['вс','пн','вт','ср','чт','пт','сб']; // Date.getDay()

// Новый корневой контейнер сетки слотов
const WRAP_SEL =
  '[class^="time-slots-module__wrapper___"],[class*="time-slots-module__wrapper___"],' +
  '[class^="time-slots-module__wrapper__"],[class*="time-slots-module__wrapper__"]';

// Селекторы «ячейки слота» в новой разметке
const SLOT_CELL_SEL =
  // новая «plural» ветка:
  'li[class*="time-slots-module__slot"] ' +
  // а внутри неё группа/контейнер с отдельными «пузырьками» времени:
  ', [class*="time-slot-group-module__timeSlotGroup"], [class*="time-slot-group-module__timeSlotGroupContainer"] ' +
  // плюс оставим старые резервные варианты:
  ', [class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
  '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"],' +
  '[class*="slotDesktopWidth"]';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- proxy utils ----------
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
function shuffle(arr) {
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// ---------- telegram ----------
async function sendTelegram(text, html = false) {
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
          parse_mode: html ? 'HTML' : undefined,
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

function normTime(txt) {
  const m = txt.match(TIMES_RE);
  if (!m) return null;
  return `${m[1].padStart(2,'0')}:${m[2]}`;
}

// Гарантируем отрисовку новой сетки (WRAP + списки слотов)
async function ensureSlotsRendered(page) {
  // ждём корневой wrapper
  await page.waitForSelector(WRAP_SEL, { timeout: 10000 }).catch(()=>{});
  // ждём хотя бы один список слотов (ul)
  await page.waitForSelector(`${WRAP_SEL} ul[class*="time-slots-module__slots"]`, { timeout: 8000 }).catch(()=>{});

  // лёгкая «раскачка» UI
  await page.evaluate(()=>window.scrollTo({ top: 0, behavior: 'instant' })).catch(()=>{});
  await page.waitForTimeout(120);

  // кликнем заголовки «Утро/Вечер», если интерактивны
  for (const title of ['Утро','Вечер']) {
    const h = page.locator(`${WRAP_SEL} h3:has-text("${title}")`).first();
    if (await h.isVisible().catch(()=>false)) {
      await h.scrollIntoViewIfNeeded().catch(()=>{});
      await h.click({ timeout: 300 }).catch(()=>{});
      await page.waitForTimeout(120);
    }
  }

  // чуть-чуть прокрутим
  await page.evaluate(()=>window.scrollBy(0, Math.round(window.innerHeight*0.35))).catch(()=>{});
  await page.waitForTimeout(250);
}

// Сбор таймов под новую разметку с несколькими методами
async function collectTimesCombined(page) {
  const out = new Set();

  // A) Под контейнером WRAP — любые узлы с текстом HH:MM
  {
    const container = page.locator(WRAP_SEL).first();
    const els = await container.locator('text=/\\b\\d{1,2}:\\d{2}\\b/').all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const n = normTime(t);
      if (n) out.add(n);
    }
  }

  // B) Ячейки/группы слотов
  {
    const els = await page.locator(`${WRAP_SEL} ${SLOT_CELL_SEL}`).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      // такие innerText часто содержат «07:00 7 000 ₽» — вытащим время регэкспом
      const n = normTime(t);
      if (n) out.add(n);
    }
  }

  // C) Внутри списков ul.time-slots-module__slots …
  {
    const els = await page.locator(`${WRAP_SEL} ul[class*="time-slots-module__slots"] >> text=/\\b\\d{1,2}:\\d{2}\\b/`).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const n = normTime(t);
      if (n) out.add(n);
    }
  }

  // D) Резерв — поиск по всему модалке «строгих» узлов-времени
  if (out.size === 0) {
    const els = await page.locator('text=/^\\s*\\d{1,2}:\\d{2}\\s*$/').all().catch(()=>[]);
    for (const el of els) {
      // фильтруем только те, что лежат внутри WRAP
      const ok = await el.evaluate((node, sel) => {
        let p = node.parentElement;
        while (p) { if (p.matches?.(sel)) return true; p = p.parentElement; }
        return false;
      }, WRAP_SEL).catch(()=>false);
      if (!ok) continue;
      const t = (await el.innerText().catch(()=> '')).trim();
      const n = normTime(t);
      if (n) out.add(n);
    }
  }

  return Array.from(out).sort((a,b)=>a.localeCompare(b));
}

// ---------- scrape ----------
async function scrapeAll(page) {
  await clickThroughWizard(page);
  const days = await findDayButtons(page);
  log('📅 Дни (кликабельные):', days.map(d=>d.label).join(', '));

  const result = {};
  for (const d of days) {
    await d.btn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(()=>{});
    await d.btn.click({ timeout: 1200 }).catch(()=>{});
    // ждём выделение
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
    if (times.length) result[d.label] = times;
    else await dump(page, `day-${d.label}`);
  }
  return result;
}

// ---------- state load/save ----------
async function loadPrevState() {
  try {
    const buf = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(buf);
  } catch {
    return {};
  }
}
async function saveState(obj) {
  await fs.mkdir(STATE_DIR, { recursive: true }).catch(()=>{});
  await fs.writeFile(STATE_FILE, JSON.stringify(obj), 'utf8');
}

// ---------- diff formatting ----------
function weekdayForDay(dayStr) {
  const today = new Date();
  const dNum = Number(dayStr);
  let month = today.getMonth();
  let year = today.getFullYear();
  if (dNum < today.getDate()) {
    month = (month + 1) % 12;
    if (month === 0) year += 1;
  }
  const dt = new Date(year, month, dNum);
  return WEEKDAY_RU[dt.getDay()];
}
function diffSchedules(prev, curr) {
  const allDays = Array.from(new Set([...Object.keys(prev), ...Object.keys(curr)]))
    .map(Number).sort((a,b)=>a-b).map(String);

  let hasChange = false;
  let lines = [];

  for (const d of allDays) {
    const pp = new Set(prev[d] || []);
    const cc = new Set(curr[d] || []);
    const added = [...cc].filter(x => !pp.has(x)).sort();
    const removed = [...pp].filter(x => !cc.has(x)).sort();
    const kept = [...cc].filter(x => pp.has(x)).sort();

    if (added.length || removed.length) hasChange = true;

    const wd = weekdayForDay(d);
    lines.push(`📅 ${d}, ${wd}`);

    const parts = [];
    if (kept.length)    parts.push(...kept);
    if (removed.length) parts.push(...removed.map(t => `<s>${t}</s>`));
    if (added.length)   parts.push(...added.map(t => `<u><b>${t}</b></u>`));

    lines.push(parts.length ? `  ${parts.join(', ')}` : '  (пусто)');
    lines.push('');
  }

  return { hasChange, text: lines.join('\n') };
}

// ---------- main ----------
async function main() {
  const start = Date.now();

  // ротация прокси: перемешаем список каждый запуск
  const fromEnv = PROXY_LIST_ENV
    ? PROXY_LIST_ENV.split(/\r?\n/).map(parseProxyLine).filter(Boolean)
    : [];
  const candidates = shuffle(fromEnv);

  const probeResults = [];
  let chosenProxy = null;
  for (const p of candidates) {
    try {
      const ip = await testProxyReachable(p);
      probeResults.push(`✔ ${p} (${ip})`);
      if (!chosenProxy) chosenProxy = p; // первый успешно отвечающий
    } catch (e) {
      probeResults.push(`✖ ${p} (${e.message || String(e)})`);
    }
  }

  const { browser, server } = await launchBrowserWithProxy(chosenProxy);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  const page = await ctx.newPage();

  const usedProxyNote = chosenProxy ? chosenProxy : 'без прокси';

  try {
    log('🌐 Открываем сайт:', TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const current = await scrapeAll(page);
    const prev = await loadPrevState();

    const { hasChange, text: diffText } = diffSchedules(prev, current);

    if (hasChange) {
      let msg = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ (изменения)\n\n';
      msg += diffText;
      msg += `\n${COURTS_URL}\n\nПрокси: ${usedProxyNote}\n\nПроверка прокси:\n` + (probeResults.join('\n') || '—');
      await sendTelegram(msg, true);
    } else {
      log('ℹ️ Изменений нет — уведомление не отправляем.');
    }

    await saveState(current);

    await ctx.close();
    await browser.close();
    if (server?.startsWith('http://127.0.0.1:')) {
      try { await proxyChain.closeAnonymizedProxy(server, true); } catch {}
    }

    log('⏱ Время выполнения:', ((Date.now() - start) / 1000).toFixed(1) + 's');
  } catch (e) {
    await dump(page, 'fatal');
    const err = e && e.message ? e.message : String(e);
    let msg = `⚠️ Лужники монитор упал\n${err}\n\nПрокси: ${usedProxyNote}\n\nПроверка прокси:\n` + (probeResults.join('\n') || '—');
    await sendTelegram(msg, false);
    throw e;
  }
}

await main();
