// 1) Навигация по «мастеру» + обход дней и сбор слотов
async function scrapeWizard(page) {
  // ждём первый экран с карточками
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });

  // иногда текст матчится не строго, поэтому берём contains
  const card = page.locator('xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]').first();
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.click();

  // кнопка «Продолжить»
  const continueBtn = page.locator('xpath=//button[contains(normalize-space(.),"Продолжить")]').first();
  await continueBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await continueBtn.click();

  // ждём появления календаря/разделов
  // (на некоторых версиях сначала виден заголовок месяца, на некоторых — сразу «Утро/Вечер»)
  await page.waitForTimeout(800);
  await page.waitForSelector('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер") or contains(@class,"calendar")]', { timeout: 30_000 }).catch(()=>{});

  // найдём все «кнопки дней» — кнопки/элементы, чей видимый текст = 1–2 цифры
  const dayLocs = await page.locator('xpath=//*[self::button or @role="button" or contains(@class,"day")][normalize-space(string()) and not(.//button)][string-length(normalize-space(string()))<=2]').all();
  const days = [];
  for (const loc of dayLocs) {
    const t = (await loc.innerText().catch(()=> '')).trim();
    if (/^\d{1,2}$/.test(t)) days.push(loc);
  }

  // если ничего не нашли — попробуем хотя бы один видимый «button»
  if (days.length === 0) {
    const anyBtn = page.locator('button').first();
    if (await anyBtn.isVisible().catch(()=>false)) days.push(anyBtn);
  }

  const out = []; // {date, times[]}
  for (let i = 0; i < days.length; i++) {
    const dBtn = days[i];

    // вытащим метадату даты (если есть) до клика
    const isoBefore = await getISODateFromButton(page, dBtn).catch(()=>null);

    await dBtn.scrollIntoViewIfNeeded().catch(()=>{});
    await dBtn.click({ timeout: 5_000 }).catch(()=>{});
    await page.waitForTimeout(500); // дебаунс после клика

    // чипы времени — любые видимые «HH:MM»
    const times = await page.$$eval('*', nodes =>
      Array.from(nodes)
        .map(n => (n.textContent || '').trim())
        .filter(t => /^\d{1,2}:\d{2}$/.test(t))
        .map(t => {
          const m = t.match(/^(\d{1,2}):(\d{2})$/);
          return m ? `${m[1].padStart(2,'0')}:${m[2]}` : t;
        })
    );

    const uniqTimes = Array.from(new Set(times)).sort();

    // определим дату текущего выбранного дня:
    // 1) aria-label/дата у активной кнопки
    // 2) отрисованная «шапка»/выбранная дата в календаре
    // 3) fallback: текущая дата в Мск
    let iso = await getISODateFromActiveDay(page).catch(()=>null);
    if (!iso) iso = isoBefore;
    if (!iso) iso = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).toISOString().slice(0,10);

    out.push({ date: iso, times: uniqTimes });
  }

  // агрегируем по дате (если один день встречается несколько раз)
  const by = new Map();
  for (const row of out) {
    if (!by.has(row.date)) by.set(row.date, new Set());
    for (const t of row.times) by.get(row.date).add(t);
  }
  const agg = Array.from(by.entries()).map(([date, set]) => ({ date, times: Array.from(set).sort() }));
  return agg;
}

// Вспомогалки для извлечения выбранной даты
async function getISODateFromButton(page, btn) {
  // пытаемся достать из aria-label или data-* у самой кнопки
  const handle = await btn.elementHandle();
  if (!handle) return null;
  const info = await page.evaluate(el => {
    const a = el.getAttribute('aria-label') || '';
    const d = el.getAttribute('data-date') || el.getAttribute('data-day') || '';
    return { a, d, text: (el.textContent||'').trim() };
  }, handle);
  const isoFromAria = parseDateFromString(info.a);
  if (isoFromAria) return isoFromAria;
  const isoFromData = parseDateFromString(info.d);
  if (isoFromData) return isoFromData;
  return null;
}

async function getISODateFromActiveDay(page) {
  // ищем «активный/выбранный» день по классам или aria-selected
  const active = page.locator('xpath=//*[contains(@class,"active") or contains(@class,"selected") or @aria-selected="true"][normalize-space(string())]');
  if (await active.first().isVisible().catch(()=>false)) {
    const t = (await active.first().innerText().catch(()=> '')).trim();
    const aria = await active.first().getAttribute('aria-label').catch(()=>null);
    const data = await active.first().getAttribute('data-date').catch(()=>null);
    return parseDateFromString(aria) || parseDateFromString(data) || tryBuildISOFromDayNumber(t);
  }
  // fallback: ищем подпись даты где-нибудь рядом (например, «Сб, 12 октября»)
  const header = page.locator('xpath=//*[contains(@class,"date") or contains(@class,"selected-date") or contains(normalize-space(.)," октября") or contains(normalize-space(.)," ноября") or contains(normalize-space(.)," сентября")]').first();
  if (await header.isVisible().catch(()=>false)) {
    const s = (await header.innerText().catch(()=> '')).trim();
    return parseDateFromString(s);
  }
  return null;
}

function parseDateFromString(s) {
  if (!s) return null;
  // пробуем парсить форматы типа «сб, 12 октября 2025», «12.10.2025», «2025-10-12»
  s = s.trim().toLowerCase();
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = s.match(/\b(\d{1,2})[.\s/-](\d{1,2})[.\s/-](\d{2,4})\b/);
  if (dmy) {
    const d = dmy[1].padStart(2,'0');
    const m = dmy[2].padStart(2,'0');
    const y = dmy[3].length === 2 ? ('20' + dmy[3]) : dmy[3];
    return `${y}-${m}-${d}`;
  }

  const months = {
    'январ':1,'феврал':2,'март':3,'апрел':4,'ма':5,'июн':6,'июл':7,'август':8,'сентябр':9,'октябр':10,'ноябр':11,'декабр':12
  };
  const m = Object.entries(months).find(([k]) => s.includes(k));
  const day = s.match(/\b(\d{1,2})\b/);
  const year = s.match(/\b(20\d{2})\b/);
  if (m && day) {
    const mm = String(m[1]).padStart(2,'0');
    const dd = String(day[1]).padStart(2,'0');
    const yy = year ? year[1] : String(new Date().getFullYear());
    return `${yy}-${mm}-${dd}`;
  }
  return null;
}

function tryBuildISOFromDayNumber(txt) {
  if (!/^\d{1,2}$/.test(txt)) return null;
  // берём «сегодня» по Москве (если календарь показывает текущий месяц)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const dd = String(Number(txt)).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

// 2) Форматирование (совместимо с текущей рассылкой)
function formatSlotsByDay(slots) {
  if (!slots?.length) return `ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n(ничего не найдено)\n\nhttps://tennis.luzhniki.ru/#courts`;
  const fmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: '2-digit', month: 'numeric' });
  let out = 'ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n';
  for (const day of [...slots].sort((a,b)=>a.date.localeCompare(b.date))) {
    const d = new Date(day.date + 'T00:00:00+03:00');
    out += `\n${fmt.format(d)}:\n`;
    for (const t of [...(day.times||[])].sort()) out += `  ${t}\n`;
  }
  out += `\nhttps://tennis.luzhniki.ru/#courts`;
  return out;
}

// 3) В основном потоке замени участок навигации/парсинга на это:
  // ...
  log('Открываем', URL);
  await gotoWithRetries(page, URL, 3);

  const slots = await scrapeWizard(page);
  log('Найдено слотов:', JSON.stringify(slots));

  if (!slots.length) {
    await dumpArtifacts(page, 'empty'); // чтобы понять, почему пусто
  }

  const text = formatSlotsByDay(slots);
  await sendTelegram(text);
  // ...
