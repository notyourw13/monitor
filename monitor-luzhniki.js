// --- Luzhniki Monitor — full schedule with inline diffs + failure alert ---
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
const PROXY_LIST   = (process.env.PROXY_LIST || '').trim();

const STATE_DIR  = '.cache';
const STATE_FILE = path.join(STATE_DIR, 'luzhniki-state.json');

const SLOT_SEL =
  '[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
  '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]';

const TIMES_RE = /\b(\d{1,2}):(\d{2})\b/;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- utils ----------
const htmlEscape = (s) =>
  String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;');

const padTime = (h, m) => `${String(h).padStart(2,'0')}:${m}`;

// ---------- proxy ----------
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

// ---------- telegram ----------
async function sendTelegram(textHtml) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('TG creds missing; printing message (HTML):\n' + textHtml);
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
          text: textHtml,
          parse_mode: 'HTML',
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
    await fs.mkdir(STATE_DIR, { recursive: true }).catch(()=>{});
    await fs.writeFile(path.join(STATE_DIR, `art-${tag}.html`), await page.content(), 'utf8');
    await page.screenshot({ path: path.join(STATE_DIR, `art-${tag}.png`), fullPage: true });
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

// ---------- slots ----------
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

  // 1) универсальные time-slot-модули
  {
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // 2) явные контейнеры утро/вечер
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

  // 3) фильтр по наличию «:мм»
  {
    const els = await page.locator(SLOT_SEL).filter({ hasText: /:\d{2}/ }).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // 4) ширина для десктопа
  {
    const els = await page.locator('[class*="slotDesktopWidth"]').all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // повтор после лёгкого скролла, если пусто
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

// ---------- scrape ----------
async function clickDayWithRetries(page, d) {
  await d.btn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(()=>{});
  await d.btn.click({ timeout: 1200 }).catch(()=>{});
  for (let i=0; i<8; i++) {
    const selected = await getSelectedDayLabel(page);
    if (selected === d.label) return true;
    if (i === 2) await d.btn.click({ timeout: 800, force: true }).catch(()=>{});
    if (i === 5) await d.btn.evaluate(el => el.click()).catch(()=>{});
    await page.waitForTimeout(120);
  }
  return false;
}

async function scrapeAll(page) {
  await clickThroughWizard(page);
  const days = await findDayButtons(page);
  log('📅 Дни (кликабельные):', days.map(d=>d.label).join(', '));

  const result = {};
  for (const d of days) {
    const ok = await clickDayWithRetries(page, d);
    if (!ok) { log(`↷ Пропускаем день ${d.label} — не выделился`); continue; }

    await ensureSlotsRendered(page);
    await page.waitForTimeout(600);

    const times = await collectTimesCombined(page);
    result[d.label] = times; // даже если пусто — фиксируем состояние дня
  }
  return result; // { '10': ['07:00','22:00'], ... }
}

// ---------- state (load/save) ----------
async function loadPrevState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { ts: 0, data: {} };
  }
}
async function saveState(data) {
  await fs.mkdir(STATE_DIR, { recursive: true }).catch(()=>{});
  const payload = { ts: Date.now(), data };
  await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

// ---------- diff helpers ----------
function calcDayDiff(prevArr = [], currArr = []) {
  const prev = new Set(prevArr);
  const curr = new Set(currArr);
  const added = [...curr].filter(t => !prev.has(t));
  const removed = [...prev].filter(t => !curr.has(t));
  const unchanged = [...curr].filter(t => prev.has(t));
  return { added: new Set(added), removed: new Set(removed), unchanged: new Set(unchanged) };
}

// ---------- formatting (FULL schedule with inline marks) ----------
function formatFullWithInlineDiff(prevData, currData) {
  const currDays = Object.keys(currData).map(Number).sort((a,b)=>a-b).map(String);
  const goneDays = Object.keys(prevData).filter(d => !(d in currData)).map(Number).sort((a,b)=>a-b).map(String);

  let out = '🎾 <b>ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ</b>\n\n';

  // Основной блок: все текущие дни (с пометкой добавленных и пропавших таймов)
  for (const day of currDays) {
    const { added, removed, unchanged } = calcDayDiff(prevData[day], currData[day]);

    // Объединяем для рендера: (curr ∪ removed)
    const union = new Set([...currData[day], ...removed]);
    const ordered = [...union].sort((a,b)=>a.localeCompare(b));

    const pieces = ordered.map(t => {
      if (added.has(t))     return `<u><b>${htmlEscape(t)}</b></u>`; // новое
      if (removed.has(t))   return `<s>${htmlEscape(t)}</s>`;        // исчезло
      if (unchanged.has(t)) return htmlEscape(t);                    // было и осталось
      return htmlEscape(t);
    });

    out += `📅 <b>${htmlEscape(day)}</b>\n  ${pieces.join(', ')}\n\n`;
  }

  // Отдельный блок: полностью исчезнувшие дни
  if (goneDays.length) {
    out += '❌ <b>Исчезнувшие дни</b>\n';
    for (const day of goneDays) {
      const prevTimes = (prevData[day] || []).slice().sort((a,b)=>a.localeCompare(b));
      const struck = prevTimes.length ? prevTimes.map(t => `<s>${htmlEscape(t)}</s>`).join(', ') : '<s>—</s>';
      out += `  • ${htmlEscape(day)}: ${struck}\n`;
    }
    out += '\n';
  }

  out += htmlEscape(COURTS_URL);
  return out;
}

// ---------- main ----------
async function main() {
  const start = Date.now();

  // выбираем рабочий прокси (если указан)
  let chosen = null;
  if (PROXY_LIST) {
    for (const p of PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean)) {
      try { await testProxyReachable(p); chosen = p; break; } catch {}
    }
  }

  const prev = await loadPrevState();

  const { browser, server } = await launchBrowserWithProxy(chosen);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  const page = await ctx.newPage();

  try {
    log('🌐 Открываем сайт:', TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const currData = await scrapeAll(page);

    // Формируем «полный расклад с пометками изменений»
    const msg = formatFullWithInlineDiff(prev.data || {}, currData);

    // Сохраняем состояние всегда
    await saveState(currData);

    await sendTelegram(msg);
    log('✅ Сообщение отправлено');

  } catch (e) {
    await dump(page, 'fatal');
    const errMsg =
      '❌ <b>Монитор сломался</b>\n' +
      `<code>${htmlEscape(String(e && e.stack ? e.stack : e))}</code>\n\n` +
      htmlEscape(COURTS_URL);
    await sendTelegram(errMsg);
    throw e;
  } finally {
    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
    if (server?.startsWith('http://127.0.0.1:')) {
      try { await proxyChain.closeAnonymizedProxy(server, true); } catch {}
    }
    log('⏱ Время выполнения:', ((Date.now() - start) / 1000).toFixed(1) + 's');
  }
}

await main();
