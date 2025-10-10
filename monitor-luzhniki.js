// --- Luzhniki Monitor (strict slot selector + strong visibility) ---
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
    window.scrollBy(0, Math.round(window.innerHeight*0.5));
    const els=[...document.querySelectorAll('*')];
    for(const el of els){
      const cs=getComputedStyle(el);
      if((cs.overflowY==='auto'||cs.overflowY==='scroll') && el.scrollHeight>el.clientHeight){
        el.scrollTop = Math.min(el.scrollTop+280, el.scrollHeight);
      }
    }
  });
  await page.waitForTimeout(150);
}

async function waitAnyTimeVisible(page, timeout=4500){
  await page.waitForFunction(()=>{
    const re=/\b\d{1,2}:\d{2}\b/;
    const nodes=[...document.querySelectorAll('[class*="time-slot-module__slot"]')];
    const isVis=(el)=>{
      const cs=getComputedStyle(el);
      if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0') return false;
      const rects=el.getClientRects?.(); if(!rects||rects.length===0) return false;
      const r=rects[0];
      if(!(r.bottom>0 && r.top<window.innerHeight && r.right>0 && r.left<window.innerWidth)) return false;
      if(el.closest('[aria-hidden="true"]')) return false;
      return true;
    };
    for(const el of nodes){
      if(!isVis(el)) continue;
      if(re.test(el.textContent||'')) return true;
    }
    return false;
  },{timeout}).catch(()=>{});
}

// ---------- time extraction (STRICT) ----------
async function collectTimes(page, dayLabel){
  await nudgeScroll(page);
  awa
