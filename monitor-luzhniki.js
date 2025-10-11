// --- Luzhniki Monitor — diffs only + error/heartbeat notify ---
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

// Поведение уведомлений
const ALWAYS_NOTIFY        = process.env.ALWAYS_NOTIFY === '1';   // форсить сообщение всегда
const HEARTBEAT_MIN        = Number(process.env.HEARTBEAT_MIN || '0'); // «пульс» в минутах (0 — выключен)
const DEBUG_LOG_HTML       = process.env.DEBUG_HTML === '1';      // сохранять art-*.html/png чаще

// Путь к состоянию (кэшируем в Actions)
const STATE_DIR  = '.cache';
const STATE_FILE = path.join(STATE_DIR, 'luzhniki-state.json');

const SLOT_SEL =
  '[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
  '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]';

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- proxy ---------------- */
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

/* ---------------- telegram ---------------- */
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
          parse_mode: 'HTML',              // чтобы работали <b>, <u>, <s>
          disable_web_page_preview: true,
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        log('⚠️ Telegram error for', id, r.status, body);
      }
    } catch (e) {
      log('⚠️ Telegram exception for', id, e.message);
    }
  }
}

/* ---------------- artifacts ---------------- */
async function dump(page, tag) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(`art-${tag}.html`, await page.content(), 'utf8');
    await page.screenshot({ path: `art-${tag}.png`, fullPage: true });
  } catch {}
}

/* ---------------- browser ---------------- */
async function launchBrowserWithProxy(raw) {
  let server = null;
  if (raw) server = raw.startsWith('socks5://') ? await proxyChain.anonymizeProxy(raw) : raw;
  const browser = await chromium.launch({ headless: true, proxy: server ? { server } : undefined });
  return { browser, server };
}

/* ---------------- wizard (robust) ---------------- */
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
      log('➡️ Уже календарь');
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

/* ---------------- days ---------------- */
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

/* ---------------- slots helpers ---------------- */
const TIMES_RE = /\b(\d{1,2}):(\d{2})\b/;
const pad = n => String(n).padStart(2,'0');

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
      if (m) out.add(`${pad(m[1])}:${m[2]}`);
    }
  }

  // 4) ul:nth-child(2/4)+slot
  {
    for (const sel of ['ul:nth-child(2) '+SLOT_SEL, 'ul:nth-child(4) '+SLOT_SEL]) {
      const els = await page.locator(sel).all().catch(()=>[]);
      for (const el of els) {
        const t = (await el.innerText().catch(()=> '')).trim();
        const m = t.match(TIMES_RE);
        if (m) out.add(`${pad(m[1])}:${m[2]}`);
      }
    }
  }

  // 5) locator.filter(hasText)
  {
    const els = await page.locator(SLOT_SEL).filter({ hasText: /:\d{2}/ }).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(`${pad(m[1])}:${m[2]}`);
    }
  }

  // 7) slotDesktopWidth
  {
    const els = await page.locator('[class*="slotDesktopWidth"]').all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(`${pad(m[1])}:${m[2]}`);
    }
  }

  if (out.size === 0) {
    await page.evaluate(()=>window.scrollBy(0, Math.round(window.innerHeight*0.4))).catch(()=>{});
    await page.waitForTimeout(150);
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(`${pad(m[1])}:${m[2]}`);
    }
  }

  return Array.from(out).sort((a,b)=>a.localeCompare(b));
}

/* ---------------- scraping ---------------- */
async function scrapeAll(page) {
  await clickThroughWizard(page);
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
      result[d.label] = times;
    } else if (DEBUG_LOG_HTML) {
      await dump(page, `day-${d.label}`);
    }
  }
  return result;
}

/* ---------------- state & diff ---------------- */
async function loadState() {
  try {
    const s = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(s);
  } catch {
    return { lastNotifyAt: 0, data: {} };
  }
}
async function saveState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function asMap(arr) { const m = new Map(); for (const k of Object.keys(arr||{})) m.set(k, new Set(arr[k])); return m; }
function diffStates(prevData, currData) {
  const prev = asMap(prevData);
  const curr = asMap(currData);
  const days = new Set([...prev.keys(), ...curr.keys()]);
  const changes = {};
  let hasChanges = false;

  for (const d of days) {
    const p = prev.get(d) || new Set();
    const c = curr.get(d) || new Set();
    const added = [...c].filter(t => !p.has(t)).sort();
    const removed = [...p].filter(t => !c.has(t)).sort();
    if (added.length || removed.length) {
      hasChanges = true;
      changes[d] = { added, removed, now: [...c].sort() };
    }
  }
  return { hasChanges, changes };
}

function renderMessageFromDiff(curr, diff) {
  const dayKeys = Object.keys(curr).sort((a,b)=>(+a)-(+b));
  let text = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
  if (!dayKeys.length) {
    text += '(ничего не найдено)\n\n' + COURTS_URL;
    return text;
  }
  for (const d of dayKeys) {
    const now = curr[d] || [];
    const info = diff.changes[d] || { added: [], removed: [], now };
    const add = new Set(info.added || []);
    const rem = new Set(info.removed || []);
    // объединим времена: всё из now + удалённые (чтобы показать зачёркнутые)
    const union = Array.from(new Set([...now, ...rem])).sort((a,b)=>a.localeCompare(b));
    const line = union.map(t => {
      if (add.has(t)) return `<b><u>${t}</u></b>`;   // новое
      if (rem.has(t)) return `<s>${t}</s>`;          // пропало
      return t;                                      // было и осталось
    }).join(', ');
    text += `📅 ${d}\n  ${line || '(нет слотов)'}\n\n`;
  }
  text += COURTS_URL;
  return text;
}

/* ---------------- main ---------------- */
async function main() {
  const start = Date.now();
  let chosen = null;
  if (PROXY_LIST) {
    for (const p of PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean)) {
      try { await testProxyReachable(p); chosen = p; break; } catch {}
    }
  }

  const { browser, server } = await launchBrowserWithProxy(chosen);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  const page = await ctx.newPage();

  try {
    log('🌐 Открываем сайт:', TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const current = await scrapeAll(page);                 // { '11': ['07:00', ...], ... }
    const state   = await loadState();                     // { lastNotifyAt, data }
    const isFirst = !Object.keys(state.data || {}).length;

    // Дифф
    const diff = diffStates(state.data || {}, current);

    // Решаем, слать ли
    let shouldNotify = false;
    let reason = '';
    if (ALWAYS_NOTIFY) { shouldNotify = true; reason = 'ALWAYS_NOTIFY'; }
    else if (isFirst) { shouldNotify = true; reason = 'first run / baseline'; }
    else if (diff.hasChanges) { shouldNotify = true; reason = 'changes detected'; }
    else if (HEARTBEAT_MIN > 0) {
      const now = Date.now();
      if (now - (state.lastNotifyAt || 0) >= HEARTBEAT_MIN * 60_000) {
        shouldNotify = true; reason = `heartbeat ${HEARTBEAT_MIN}m`;
      }
    }

    if (shouldNotify) {
      const text = diff.hasChanges
        ? renderMessageFromDiff(current, diff)
        : // «без изменений»: показываем текущий расклад без выделений, + пометка
          (() => {
            let t = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
            const keys = Object.keys(current).sort((a,b)=>(+a)-(+b));
            if (!keys.length) t += '(ничего не найдено)\n\n';
            else for (const k of keys) t += `📅 ${k}\n  ${current[k].join(', ')}\n\n`;
            t += `<i>без изменений (${reason})</i>\n` + COURTS_URL;
            return t;
          })();

      await sendTelegram(text);
      state.lastNotifyAt = Date.now();
    } else {
      log('ℹ️ Без изменений — уведомление не отправляли.');
    }

    // Сохраняем новое состояние
    state.data = current;
    await saveState(state);

    await ctx.close(); await browser.close();
    if (server?.startsWith('http://127.0.0.1:')) {
      try { await proxyChain.closeAnonymizedProxy(server, true); } catch {}
    }
    log('⏱ Время выполнения:', ((Date.now() - start) / 1000).toFixed(1) + 's');
  } catch (e) {
    // Ошибка: предупредим в TG и кинем артефакты
    try {
      await dump(page, 'fatal');
      await sendTelegram(`⚠️ <b>Лужники монитор упал</b>\n<code>${String(e?.message || e)}</code>`);
    } catch {}
    throw e;
  }
}

await main();
