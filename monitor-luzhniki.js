// --- Luzhniki Monitor — rotation + diff-only notify (HTML formatting) ---
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

const SLOT_SEL =
  '[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
  '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]';

const WEEKDAY_RU = ['вс','пн','вт','ср','чт','пт','сб']; // Date.getDay()

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

function normTime(txt) {
  const m = txt.match(TIMES_RE);
  if (!m) return null;
  return `${m[1].padStart(2,'0')}:${m[2]}`;
}

async function collectTimesCombined(page) {
  const out = new Set();

  // 1) общий селектор
  {
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const n = normTime(t);
      if (n) out.add(n);
    }
  }
  // 2) явные секции (утро/вечер) по nth-child
  {
    for (const sel of ['ul:nth-child(2) '+SLOT_SEL, 'ul:nth-child(4) '+SLOT_SEL]) {
      const els = await page.locator(sel).all().catch(()=>[]);
      for (const el of els) {
        const t = (await el.innerText().catch(()=> '')).trim();
        const n = normTime(t);
        if (n) out.add(n);
      }
    }
  }
  // 3) фильтр по наличию «:MM»
  {
    const els = await page.locator(SLOT_SEL).filter({ hasText: /:\d{2}/ }).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const n = normTime(t);
      if (n) out.add(n);
    }
  }
  // 4) desktop width класс
  {
    const els = await page.locator('[class*="slotDesktopWidth"]').all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const n = normTime(t);
      if (n) out.add(n);
    }
  }
  // страховочный повтор
  if (out.size === 0) {
    await page.evaluate(()=>window.scrollBy(0, Math.round(window.innerHeight*0.4))).catch(()=>{});
    await page.waitForTimeout(150);
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
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
function diffSchedules(prev, curr) {
  // prev/curr: { dayLabel: ['07:00','22:00'] }
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

    // подпись дня + будни
    const wd = weekdayForDay(d);
    lines.push(`📅 ${d}, ${wd}`);

    const parts = [];
    if (kept.length)   parts.push(...kept);
    if (removed.length) parts.push(...removed.map(t => `<s>${t}</s>`));
    if (added.length)   parts.push(...added.map(t => `<u><b>${t}</b></u>`));

    lines.push(parts.length ? `  ${parts.join(', ')}` : '  (пусто)');
    lines.push(''); // пустая строка
  }

  return { hasChange, text: lines.join('\n') };
}

// Вытаскиваем день недели для «числа месяца» (берём текущий/след. месяц как сейчас на сайте)
function weekdayForDay(dayStr) {
  // Пробуем вычислить относительно «сегодня» — если число меньше сегодня, считаем, что это след. месяц
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

// ---------- main ----------
async function main() {
  const start = Date.now();

  // 1) собираем список прокси и перемешиваем для ротации без памяти
  const fromEnv = PROXY_LIST_ENV
    ? PROXY_LIST_ENV.split(/\r?\n/).map(parseProxyLine).filter(Boolean)
    : [];
  const candidates = shuffle(fromEnv); // <— здесь и есть «ротация»

  // проверяем прокси и выбираем рабочий
  const probeResults = [];
  let chosenProxy = null;
  for (const p of candidates) {
    try {
      const ip = await testProxyReachable(p);
      probeResults.push(`✔ ${p} (${ip})`);
      if (!chosenProxy) chosenProxy = p;
    } catch (e) {
      probeResults.push(`✖ ${p} (${e.message || String(e)})`);
    }
  }

  const { browser, server } = await launchBrowserWithProxy(chosenProxy);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  const page = await ctx.newPage();

  let usedProxyNote = chosenProxy ? chosenProxy : 'без прокси';

  try {
    log('🌐 Открываем сайт:', TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const current = await scrapeAll(page);

    // загрузим старое состояние
    const prev = await loadPrevState();

    // дифф
    const { hasChange, text: diffText } = diffSchedules(prev, current);

    // если изменений нет — ничего не шлём
    if (!hasChange) {
      log('ℹ️ Изменений нет — уведомление не отправляем.');
    } else {
      let msg = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ (изменения)\n\n';
      msg += diffText;
      msg += `\n${COURTS_URL}\n\nПрокси: ${usedProxyNote}\n\nПроверка прокси:\n` + (probeResults.join('\n') || '—');
      await sendTelegram(msg, true /* HTML */);
    }

    // Всегда сохраняем текущее в state
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
