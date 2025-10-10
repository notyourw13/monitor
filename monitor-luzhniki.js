// --- Luzhniki Monitor (verified day selection + visible HH:MM only) ---
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

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- proxy ----------
function parseProxyLine(line){const s=line.trim();if(!s)return null;if(s.startsWith('http://')||s.startsWith('https://')||s.startsWith('socks5://'))return s;if(/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s))return'http://'+s;return s;}
function buildFetchAgent(u){if(!u)return; if(u.startsWith('https://'))return new HttpsProxyAgent(u); if(u.startsWith('http://'))return new HttpProxyAgent(u); if(u.startsWith('socks5://'))return new SocksProxyAgent(u);}
async function testProxyReachable(u){const agent=buildFetchAgent(u);const c=new AbortController();const t=setTimeout(()=>c.abort(),6000);try{const r=await fetch('https://ifconfig.me/all.json',{agent,signal:c.signal});clearTimeout(t);if(!r.ok)throw new Error('status '+r.status);const j=await r.json();return j.ip_addr||'ok';}catch(e){clearTimeout(t);throw e;}}

// ---------- telegram ----------
async function sendTelegram(text){
  if(!TG_BOT_TOKEN||!TG_CHAT_ID){log('TG creds missing; printing:\n'+text);return;}
  const r=await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:TG_CHAT_ID,text,disable_web_page_preview:true})
  });
  if(!r.ok){throw new Error('Telegram '+r.status+' '+await r.text().catch(()=>''));}
}

// ---------- artifacts ----------
async function dump(page, tag){ try{
  await fs.writeFile(`art-${tag}.html`, await page.content(), 'utf8');
  await page.screenshot({ path:`art-${tag}.png`, fullPage:true });
}catch{}}

// ---------- browser ----------
async function launchBrowserWithProxy(raw){
  let server=null;
  if(raw) server = raw.startsWith('socks5://') ? await proxyChain.anonymizeProxy(raw) : raw;
  const browser = await chromium.launch({ headless:true, proxy: server?{server}:undefined });
  return { browser, server };
}

// ---------- wizard ----------
async function clickThroughWizard(page){
  await page.locator('text=Аренда теннисных кортов').first().click({ timeout:20000 });
  log('✅ Баннер');
  await page.locator('text=Аренда крытых кортов').first().click({ timeout:20000 });
  log('✅ Крытые');
  const cont = page.locator('button:has-text("Продолжить")').first();
  if(await cont.isVisible().catch(()=>false)) await cont.click({ timeout:5000 });
  else await page.locator('text=Продолжить').first().click({ timeout:5000 }).catch(()=>{});
  log('✅ Продолжить');
  await page.waitForTimeout(600);
}

// ---------- helpers ----------
async function nudgeScroll(page){
  await page.evaluate(()=>{
    window.scrollBy(0, Math.round(window.innerHeight*0.6));
    const els=[...document.querySelectorAll('*')];
    for(const el of els){
      const cs=getComputedStyle(el);
      if((cs.overflowY==='auto'||cs.overflowY==='scroll') && el.scrollHeight>el.clientHeight){
        el.scrollTop = Math.min(el.scrollTop+300, el.scrollHeight);
      }
    }
  });
  await page.waitForTimeout(200);
}

async function waitAnyTimeVisible(page, timeout=4500){
  await page.waitForFunction(()=>{
    const re=/\b\d{1,2}:\d{2}\b/;
    const nodes=[...document.querySelectorAll('button,span,div,li,p')];
    const isVis=(el)=>{
      const cs=getComputedStyle(el);
      if(cs.display==='none'||cs.visibility==='hidden') return false;
      const rects=el.getClientRects?.(); if(!rects||rects.length===0) return false;
      const r=rects[0];
      return r.bottom>0 && r.top<window.innerHeight && r.right>0 && r.left<window.innerWidth;
    };
    for(const el of nodes){
      if(!isVis(el)) continue;
      if(re.test(el.textContent||'')) return true;
    }
    return false;
  },{timeout}).catch(()=>{});
}

// ---------- time extraction (visible only) ----------
async function collectTimes(page, dayLabel){
  await nudgeScroll(page);
  await waitAnyTimeVisible(page, 5000);

  const times = await page.evaluate(()=>{
    const acc=new Set();
    const re=/\b(\d{1,2}):(\d{2})\b/g;
    const isVis=(el)=>{
      const cs=getComputedStyle(el);
      if(cs.display==='none'||cs.visibility==='hidden') return false;
      const rects=el.getClientRects?.(); if(!rects||rects.length===0) return false;
      const r=rects[0];
      return r.bottom>0 && r.top<window.innerHeight && r.right>0 && r.left<window.innerWidth;
    };

    // 1) слоты с модульными классами
    document.querySelectorAll(
      '[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
      '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]'
    ).forEach(el=>{
      if(!isVis(el)) return;
      const txt=(el.textContent||'');
      let m; while((m=re.exec(txt))){ acc.add(m[1].padStart(2,'0')+':'+m[2]); }
    });

    // 2) fallback — любые видимые узлы
    if(acc.size===0){
      const cand=[...document.querySelectorAll('button,span,div,li,p')];
      for(const el of cand){
        if(!isVis(el)) continue;
        const txt=(el.textContent||'');
        let m; while((m=re.exec(txt))){ acc.add(m[1].padStart(2,'0')+':'+m[2]); }
      }
    }

    return Array.from(acc).sort((a,b)=>a.localeCompare(b));
  });

  if(times.length===0){ await dump(page, `day-${dayLabel}`); }
  return times;
}

// ---------- day buttons (build list first) ----------
async function findDayButtons(page){
  // цифра — во 2-м div внутри button
  const divs = page.locator('button div:nth-child(2)');
  const cnt = await divs.count().catch(()=>0);
  const list=[];
  for(let i=0;i<cnt;i++){
    const d = divs.nth(i);
    const txt = (await d.innerText().catch(()=>''))?.trim();
    if(!/^\d{1,2}$/.test(txt)) continue;

    const btn = d.locator('xpath=ancestor::button[1]');
    const ok = await btn.isVisible().catch(()=>false);
    const enabled = await btn.isEnabled().catch(()=>false);
    if(!(ok && enabled)) continue;

    const bb = await btn.boundingBox().catch(()=>null);
    if(!bb) continue;

    list.push({ label: txt, btn, x: bb.x });
  }
  list.sort((a,b)=>a.x-b.x);
  return list;
}

// возвращает «фактически выбранный» день (цифру в кружочке)
async function getSelectedDayLabel(page){
  const sel = page.locator('button[class*="Selected"] div:nth-child(2)').first();
  const t = (await sel.innerText().catch(()=>''))?.trim();
  return /^\d{1,2}$/.test(t) ? t : '';
}

// ---------- scrape ----------
async function scrapeAll(page){
  await clickThroughWizard(page);

  const days = await findDayButtons(page);
  log('📅 Кандидаты:', days.map(d=>d.label).join(', '));

  const result = {};

  for(const d of days){
    // клик
    await d.btn.scrollIntoViewIfNeeded().catch(()=>{});
    const before = await getSelectedDayLabel(page);
    await d.btn.click({ timeout:1500 }).catch(()=>{});
    await page.waitForTimeout(220);

    // проверяем, что реально выбрался именно этот день
    const after = await getSelectedDayLabel(page);
    if(after !== d.label){
      // этот «день» не переключает выбор — считаем некликабельным
      continue;
    }

    // раскрыть «Утро/Вечер» (если есть)
    for(const name of ['Утро','Вечер']){
      const sw = page.locator(`text=${name}`).first();
      if(await sw.isVisible().catch(()=>false)){
        await sw.click({ timeout:400 }).catch(()=>{});
        await page.waitForTimeout(100);
      }
    }

    const times = await collectTimes(page, d.label);
    if(times.length) result[d.label]=times;
  }

  return result;
}

// ---------- main ----------
async function main(){
  const start=Date.now();

  let chosen=null;
  if(PROXY_LIST){
    for(const p of PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean)){
      try{ await testProxyReachable(p); chosen=p; break; }catch{}
    }
  }

  const { browser, server } = await launchBrowserWithProxy(chosen);
  const ctx = await browser.newContext({ viewport:{ width:1280, height:1600 } });
  const page = await ctx.newPage();

  log('🌐 Открываем сайт:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil:'domcontentloaded', timeout:30000 });

  const all = await scrapeAll(page);

  let text='🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
  const keys=Object.keys(all).sort((a,b)=>(+a)-(+b));
  if(!keys.length){
    text+='(ничего не найдено)\n\n';
  }else{
    for(const k of keys){
      text+=`📅 ${k}\n  ${all[k].join(', ')}\n\n`;
    }
  }
  text+='https://tennis.luzhniki.ru/#courts';

  await sendTelegram(text);
  log('✅ Сообщение отправлено.');

  await ctx.close(); await browser.close();
  if(server?.startsWith('http://127.0.0.1:')){ try{ await proxyChain.closeAnonymizedProxy(server,true);}catch{} }
  log('⏱ Время выполнения:', ((Date.now()-start)/1000).toFixed(1)+'s');
}

await main();
