// --- Luzhniki monitor: сразу /#courts → «крытые» → «Продолжить» → слоты (proxy-chain) ---
import fs from 'fs';
import { chromium } from 'playwright';
import proxyChain from 'proxy-chain';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';

// ===== ENV =====
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_URL    = (process.env.PROXY_URL || '').trim();
const PROXY_LIST   = (process.env.PROXY_LIST || '').split(/[\n, ]+/).map(s=>s.trim()).filter(Boolean);

const COURTS_URL   = 'https://tennis.luzhniki.ru/#courts';

const LOGFILE = `run-${Date.now()}.log`;
function log(...a){ const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); try{ fs.appendFileSync(LOGFILE, line+'\n'); }catch{} }

// ===== TELEGRAM =====
async function sendTelegram(text){
  if(!TG_BOT_TOKEN || !TG_CHAT_ID){ log('TG creds missing; skip'); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview:true })
  });
  if(!r.ok){ const b = await r.text().catch(()=> ''); log('TG error', r.status, b); }
}

// ===== PROXY via proxy-chain =====
function pickProxy(){ return PROXY_URL || PROXY_LIST[0] || ''; }

async function testSocks(socksUrl){
  const agent = new SocksProxyAgent(socksUrl);
  const res = await fetch('https://api.ipify.org', { agent, timeout: 8000 });
  return (await res.text()).trim();
}

async function prepareBridge(){
  const raw = pickProxy();
  if(!raw) return { server: '', close: async()=>{} };

  if(/^socks5:/i.test(raw)){
    log('SOCKS5 upstream:', raw.replace(/\/\/[^@]+@/,'//***:***@'));
    const ip = await testSocks(raw);
    log('SOCKS5 OK, IP:', ip);
    const http = await proxyChain.anonymizeProxy(raw);
    log('HTTP bridge:', http);
    return { server: http, close: ()=> proxyChain.closeAnonymizedProxy(http, true) };
  }

  if(/^https?:\/\//i.test(raw)){
    log('HTTP(S) proxy:', raw.replace(/\/\/[^@]+@/,'//***:***@'));
    return { server: raw, close: async()=>{} };
  }

  return { server:'', close: async()=>{} };
}

// ===== ARTЕFACTS =====
async function snap(page, tag){
  try{ await page.screenshot({ path:`art-${tag}.png`, fullPage:true }); }catch{}
  try{ const html = await page.content(); await fs.promises.writeFile(`art-${tag}.html`, html); }catch{}
}
async function dumpOnError(page, tag){ try{ await page.waitForTimeout(200); await snap(page, tag); }catch{} }

function moscowTodayISO(){
  const now = new Date(new Date().toLocaleString('en-US', { timeZone:'Europe/Moscow' }));
  return now.toISOString().slice(0,10);
}

// ====== UI helpers на /#courts ======

/** Находим и раскрываем карточку «Аренда крытых кортов» */
async function openCoveredCard(page){
  // ждём появления текста «Аренда крытых кортов»
  await page.waitForSelector('xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]', { timeout: 20000 });
  // сам блок карточки
  const card = page.locator('xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]/ancestor::*[self::section or self::div][1]').first();

  if (await card.isVisible().catch(()=>false)) {
    // если есть плюс/минус справа — кликаем по нему для раскрытия
    const toggler = card.locator('xpath=.//button | .//div[@role="button"] | .//span[contains(.,"+") or contains(.,"−") or contains(.,"-")]').first();
    try { await toggler.click({ timeout: 1500 }); } catch {}
    await card.click({ timeout: 2000 }).catch(()=>{}); // клик по самому блоку тоже ок
    await page.waitForTimeout(300);
    await snap(page,'covered-open');
    return true;
  }
  return false;
}

/** Жмём кнопку «Продолжить» под карточками */
async function pressContinue(page){
  // ждём, она бывает не сразу в DOM
  for(let i=0;i<24;i++){
    const btn =
      page.getByRole?.('button', { name: /продолжить/i }).first?.() ??
      page.locator('xpath=//*[self::button or self::a][contains(normalize-space(.),"Продолжить")]').first();
    if (await btn.isVisible().catch(()=>false)) {
      await btn.scrollIntoViewIfNeeded().catch(()=>{});
      await btn.click({ timeout: 4000 }).catch(()=>{});
      await page.waitForTimeout(400);
      await snap(page,'continue-click');
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

/** Пытаемся собрать кнопки календаря с датами (цифрами) */
async function getDayButtonsAnywhere(page){
  const nodes = await page.locator('xpath=//*[self::button or @role="button" or self::div]').all();
  const out = [];
  for (const n of nodes){
    const t = (await n.innerText().catch(()=> '')).trim();
    if (/^\d{1,2}$/.test(t)) out.push(n);
  }
  return out;
}

/** Собираем времена из секций «Утро/Вечер» */
async function collectTimes(page){
  const sections = await page.locator('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]/ancestor::*[self::section or self::div][1]').all();
  const acc = new Set();
  for(const s of sections){
    const list = await s.evaluate(el =>
      Array.from(el.querySelectorAll('*')).map(n => (n.textContent||'').trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t))
    ).catch(()=>[]);
    list.forEach(t=>{
      const m=t.match(/^(\d{1,2}):(\d{2})$/);
      acc.add(m?`${String(m[1]).padStart(2,'0')}:${m[2]}`:t);
    });
  }
  if(!acc.size){
    const all = await page.$$eval('*', ns => Array.from(ns).map(n => (n.textContent||'').trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t))).catch(()=>[]);
    all.forEach(t=>{
      const m=t.match(/^(\d{1,2}):(\d{2})$/);
      acc.add(m?`${String(m[1]).padStart(2,'0')}:${m[2]}`:t);
    });
  }
  return Array.from(acc).sort();
}

// ===== SCRAPE PIPELINE =====
async function scrape(page){
  // 1) переходим прямо на /#courts
  await page.goto(COURTS_URL, { waitUntil:'domcontentloaded', timeout: 60000 });
  await snap(page,'courts-opened');

  // 2) кликаем «Аренда крытых кортов»
  const covered = await openCoveredCard(page);
  if (!covered) { await dumpOnError(page,'no-covered'); throw new Error('Не нашли/не раскрыли «Аренда крытых кортов»'); }

  // 3) жмём «Продолжить»
  const cont = await pressContinue(page);
  if (!cont) log('Кнопка «Продолжить» не найдена (может быть объединённый шаг)');

  // 4) ждём расписание и собираем слоты
  await page.waitForTimeout(800);
  await page.waitForSelector('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]', { timeout: 20000 }).catch(()=>{});
  await snap(page,'schedule');

  // Кнопки дней могут быть частично вне экрана — пролистаем горизонталь, если есть стрелки
  const dayButtons = await getDayButtonsAnywhere(page);
  log('Найдено кнопок-дней (грубый поиск):', dayButtons.length);

  const iso = moscowTodayISO();
  const result = [];

  if (!dayButtons.length) {
    const times = await collectTimes(page);
    result.push({ date: iso, times });
    return result;
  }

  for (let i=0; i<Math.min(dayButtons.length, 14); i++){
    const b = dayButtons[i];
    const label = (await b.innerText().catch(()=> '')).trim();
    await b.scrollIntoViewIfNeeded().catch(()=>{});
    await b.click({ timeout: 2000 }).catch(()=>{});
    await page.waitForTimeout(300);
    const times = await collectTimes(page);
    log(`День ${label||i+1}: слотов ${times.length}`);
    result.push({ date: iso, times });
  }

  // агрегируем по дате
  const by = new Map();
  for(const r of result){
    if(!by.has(r.date)) by.set(r.date, new Set());
    r.times.forEach(t => by.get(r.date).add(t));
  }
  return Array.from(by.entries()).map(([date,set])=>({ date, times: Array.from(set).sort() }));
}

function formatMessage(rows){
  if(!rows?.length || rows.every(r => !r.times?.length))
    return `ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n(ничего не найдено)\n\n${COURTS_URL}`;
  let out = 'ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n';
  for(const r of rows){
    out += `\n${r.date}:\n`;
    for(const t of r.times) out += `  ${t}\n`;
  }
  out += `\n${COURTS_URL}`;
  return out;
}

// ===== MAIN =====
(async () => {
  let bridge, browser, context;
  const start = Date.now();
  try{
    bridge = await prepareBridge();
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-dev-shm-usage'],
      proxy: bridge.server ? { server: bridge.server } : undefined
    });
    context = await browser.newContext({ locale:'ru-RU', timezoneId:'Europe/Moscow' });
    const page = await context.newPage();

    const rows = await scrape(page);
    const msg = formatMessage(rows);
    await sendTelegram(msg);
  }catch(e){
    log('Ошибка:', e.message || e);
    try{ const p = context?.pages?.()[0]; if(p) await dumpOnError(p, 'error'); }catch{}
    process.exitCode = 1;
  }finally{
    try{ await context?.close(); }catch{}
    try{ await browser?.close(); }catch{}
    try{ await bridge?.close?.(); }catch{}
    log('Время выполнения:', Math.round((Date.now()-start)/1000)+'s');
  }
})();
