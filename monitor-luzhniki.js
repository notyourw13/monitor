// --- Luzhniki Monitor — 10 способов извлечь слоты для калибровки ---
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
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_LIST   = (process.env.PROXY_LIST || '').trim();

const SLOT_SEL =
  '[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
  '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]';

const log = (...a) => console.log(new Date().toISOString(), ...a);

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
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('TG creds missing; printing:\n' + text);
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error('Telegram ' + r.status + ' ' + (await r.text().catch(()=>'')));
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

// ---------- wizard ----------
async function clickThroughWizard(page) {
  await page.locator('text=Аренда теннисных кортов').first().click({ timeout: 20000 });
  log('✅ Баннер');
  await page.locator('text=Аренда крытых кортов').first().click({ timeout: 20000 });
  log('✅ Крытые');
  const cont = page.locator('button:has-text("Продолжить")').first();
  if (await cont.isVisible().catch(() => false)) await cont.click({ timeout: 5000 });
  else await page.locator('text=Продолжить').first().click({ timeout: 5000 }).catch(() => {});
  log('✅ Продолжить');
  await page.waitForTimeout(500);
}

// ---------- days ----------
async function findDayButtons(page) {
  const divs = page.locator('button div:nth-child(2)');
  const cnt = await divs.count().catch(() => 0);
  const list = [];
  for (let i = 0; i < cnt; i++) {
    const d = divs.nth(i);
    const txt = (await d.innerText().catch(() => '')).trim();
    if (!/^\d{1,2}$/.test(txt)) continue;
    const btn = d.locator('xpath=ancestor::button[1]');
    if (!(await btn.isVisible().catch(()=>false)) || !(await btn.isEnabled().catch(()=>false))) continue;
    const bb = await btn.boundingBox().catch(()=>null);
    if (!bb) continue;
    list.push({ label: txt, btn, x: bb.x });
  }
  list.sort((a,b)=>a.x-b.x);
  return list;
}
async function getSelectedDayLabel(page) {
  const sel = page.locator('button[class*="Selected"] div:nth-child(2)').first();
  const t = (await sel.innerText().catch(()=> '')).trim();
  return /^\d{1,2}$/.test(t) ? t : '';
}

// ---------- helpers ----------
const norm = (arr) => Array.from(new Set(arr)).sort((a,b)=>a.localeCompare(b));
const TIMES_RE = /\b(\d{1,2}):(\d{2})\b/;

function padTime(hh, mm) {
  return `${String(hh).padStart(2,'0')}:${mm}`;
}

// ---------- 10 стратегий ----------
async function strategy1_SLOT_SEL(page) {
  // Прямой селектор классов слотов
  const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
  const out = [];
  for (const el of els) {
    const t = (await el.innerText().catch(()=> '')).trim();
    const m = t.match(TIMES_RE);
    if (m) out.push(padTime(m[1], m[2]));
  }
  return norm(out);
}

async function strategy2_scopedSections(page) {
  // Секционно: внутри контейнеров, где есть заголовок «Утро»/«Вечер»
  return await page.evaluate((SLOT_SEL_ARG) => {
    const uniq = new Set();
    const re = /\b(\d{1,2}):(\d{2})\b/;
    const sections = [];
    [...document.querySelectorAll('body *')].forEach(el => {
      const txt = (el.textContent||'').trim();
      if (/^(Утро|Вечер)\s*$/i.test(txt)) {
        const box = el.closest('*');
        if (box && !sections.includes(box)) sections.push(box);
      }
    });
    for (const sec of sections) {
      sec.querySelectorAll(SLOT_SEL_ARG).forEach(slot => {
        const t = (slot.textContent||'').trim();
        const m = t.match(re);
        if (m) uniq.add(`${String(m[1]).padStart(2,'0')}:${m[2]}`);
      });
    }
    return Array.from(uniq).sort((a,b)=>a.localeCompare(b));
  }, SLOT_SEL);
}

async function strategy3_textRegexInModal(page) {
  // По тексту «HH:MM» внутри модалки (ограничим ближайшим видимым диалогом)
  const dialog = page.locator('[role="dialog"], [class*="modal"], body').first();
  const handles = await dialog.locator('text=/\\b\\d{1,2}:\\d{2}\\b/').all().catch(()=>[]);
  const out = [];
  for (const el of handles) {
    const t = (await el.innerText().catch(()=> '')).trim();
    const m = t.match(TIMES_RE);
    if (m) out.push(padTime(m[1], m[2]));
  }
  return norm(out);
}

async function strategy4_ul2_ul4_specific(page) {
  // Что ты видел в Distill: ul:nth-child(2/4) + класс слота
  const selList = [
    'ul:nth-child(2) ' + SLOT_SEL,
    'ul:nth-child(4) ' + SLOT_SEL,
  ];
  const out = [];
  for (const sel of selList) {
    const els = await page.locator(sel).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.push(padTime(m[1], m[2]));
    }
  }
  return norm(out);
}

async function strategy5_locatorFilter(page) {
  // Playwright filter hasText
  const els = await page.locator(SLOT_SEL).filter({ hasText: /:\d{2}/ }).all().catch(()=>[]);
  const out = [];
  for (const el of els) {
    const t = (await el.innerText().catch(()=> '')).trim();
    const m = t.match(TIMES_RE);
    if (m) out.push(padTime(m[1], m[2]));
  }
  return norm(out);
}

async function strategy6_innerHTMLRegex(page) {
  // Грубый парсинг из HTML модалки
  const html = await page.content();
  const out = [];
  let m;
  const re = /\b(\d{1,2}):(\d{2})\b/g;
  while ((m = re.exec(html)) !== null) out.push(padTime(m[1], m[2]));
  return norm(out);
}

async function strategy7_slotDesktopWidth(page) {
  // Элементы с desktop-шириной слота
  const els = await page.locator('[class*="slotDesktopWidth"]').all().catch(()=>[]);
  const out = [];
  for (const el of els) {
    const t = (await el.innerText().catch(()=> '')).trim();
    const m = t.match(TIMES_RE);
    if (m) out.push(padTime(m[1], m[2]));
  }
  return norm(out);
}

async function strategy8_visibleInSections(page) {
  // Видимые элементы (offsetParent) в секциях «Утро/Вечер», любые узлы
  return await page.evaluate(() => {
    const uniq = new Set();
    const re = /\b(\d{1,2}):(\d{2})\b/;

    const secBoxes = [];
    [...document.querySelectorAll('body *')].forEach(el => {
      const txt = (el.textContent||'').trim();
      if (/^(Утро|Вечер)\s*$/i.test(txt)) {
        const box = el.closest('*');
        if (box && !secBoxes.includes(box)) secBoxes.push(box);
      }
    });

    for (const box of secBoxes) {
      [...box.querySelectorAll('*')].forEach(el => {
        if (!el.offsetParent) return;
        const t = (el.textContent||'').trim();
        const m = t.match(re);
        if (m) uniq.add(`${String(m[1]).padStart(2,'0')}:${m[2]}`);
      });
    }

    return Array.from(uniq).sort((a,b)=>a.localeCompare(b));
  });
}

async function strategy9_allVisibleNodes(page) {
  // Все видимые узлы в модалке, без секционного ограничения (может шуметь)
  return await page.evaluate(() => {
    const uniq = new Set();
    const re = /\b(\d{1,2}):(\d{2})\b/;
    [...document.querySelectorAll('body *')].forEach(el => {
      if (!el.offsetParent) return;
      const t = (el.textContent||'').trim();
      const m = t.match(re);
      if (m) uniq.add(`${String(m[1]).padStart(2,'0')}:${m[2]}`);
    });
    return Array.from(uniq).sort((a,b)=>a.localeCompare(b));
  });
}

async function strategy10_followingSiblings(page) {
  // Находим заголовки «Утро/Вечер» и идём по их следующим блокам, собираем HH:MM
  return await page.evaluate((SLOT_SEL_ARG) => {
    const uniq = new Set();
    const re = /\b(\d{1,2}):(\d{2})\b/;

    const heads = [...document.querySelectorAll('body *')].filter(
      el => /^(Утро|Вечер)\s*$/i.test((el.textContent||'').trim())
    );

    for (const h of heads) {
      // контейнер под заголовком
      let c = h.parentElement;
      // safety
      for (let i=0; i<3 && c; i++) {
        // пробуем найти слоты под этим контейнером
        const slots = c.querySelectorAll(SLOT_SEL_ARG);
        if (slots.length) {
          slots.forEach(el => {
            const t = (el.textContent||'').trim();
            const m = t.match(re);
            if (m) uniq.add(`${String(m[1]).padStart(2,'0')}:${m[2]}`);
          });
          break;
        }
        c = c.nextElementSibling || c.parentElement;
      }
    }
    return Array.from(uniq).sort((a,b)=>a.localeCompare(b));
  }, SLOT_SEL);
}

// Собираем все стратегии подряд
async function collectAllStrategies(page) {
  const strategies = [
    ['Метод 1 — SLOT_SEL', strategy1_SLOT_SEL],
    ['Метод 2 — внутри секций', strategy2_scopedSections],
    ['Метод 3 — текст в модалке', strategy3_textRegexInModal],
    ['Метод 4 — ul:nth-child(2/4)+slot', strategy4_ul2_ul4_specific],
    ['Метод 5 — locator.filter(hasText)', strategy5_locatorFilter],
    ['Метод 6 — innerHTML regex', strategy6_innerHTMLRegex],
    ['Метод 7 — slotDesktopWidth', strategy7_slotDesktopWidth],
    ['Метод 8 — видимые в секциях', strategy8_visibleInSections],
    ['Метод 9 — все видимые узлы', strategy9_allVisibleNodes],
    ['Метод 10 — след. блоки от заголовков', strategy10_followingSiblings],
  ];

  const result = {};
  for (const [name, fn] of strategies) {
    try {
      const arr = await fn(page);
      result[name] = arr;
    } catch (e) {
      result[name] = [`[ошибка: ${String(e).slice(0,120)}]`];
    }
  }
  return result;
}

// ---------- scrape выбранного дня ----------
async function runOnOneDay(page) {
  await clickThroughWizard(page);

  // выбираем «первый нормальный» день (если есть — 11, иначе первый доступный)
  const days = await findDayButtons(page);
  log('📅 Кандидаты:', days.map(d=>d.label).join(', '));
  const pick = days.find(d => d.label === '11') || days[0];
  if (!pick) throw new Error('Нет кликабельных дней');

  await pick.btn.scrollIntoViewIfNeeded().catch(()=>{});
  await pick.btn.click({ timeout:1500 }).catch(()=>{});

  // ждём фактическое выделение
  for (let i=0;i<12;i++){
    const selected = await getSelectedDayLabel(page);
    if (selected === pick.label) break;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(250);

  // немного прокрутки — чтобы точно отрисовались «Утро/Вечер»
  await page.evaluate(()=>window.scrollBy(0, Math.round(window.innerHeight*0.35))).catch(()=>{});
  await page.waitForTimeout(150);

  // снимки на случай нулевого результата
  await dump(page, `selected-${pick.label}`);

  const all = await collectAllStrategies(page);
  return { day: pick.label, all };
}

// ---------- main ----------
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

  log('🌐 Открываем сайт:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  let body;
  try {
    const { day, all } = await runOnOneDay(page);

    let text = `🎾 КАЛИБРОВКА СБОРА СЛОТОВ (день ${day})\n\n`;
    for (const name of Object.keys(all)) {
      const arr = all[name];
      const line = Array.isArray(arr) ? arr.join(', ') : String(arr);
      text += `${name} [${arr.length ?? 0}]: ${line || '(пусто)'}\n`;
    }
    text += `\n${TARGET_URL}#courts`;

    body = text;
  } catch (e) {
    body = `Ошибка на шаге калибровки: ${String(e)}\n\n${TARGET_URL}#courts`;
  }

  await sendTelegram(body);
  log('✅ Сообщение отправлено.');

  await ctx.close();
  await browser.close();
  if (server?.startsWith('http://127.0.0.1:')) {
    try { await proxyChain.closeAnonymizedProxy(server, true); } catch {}
  }
  log('⏱ Время выполнения:', ((Date.now() - start) / 1000).toFixed(1) + 's');
}

await main();
