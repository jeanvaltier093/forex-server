'use strict';
const express = require('express');
const fetch = require('node-fetch');
const app = express();
 
const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY;
const JBIN_KEY   = process.env.JBIN_KEY;
const JBIN_ID    = process.env.JBIN_ID;
const PORT       = process.env.PORT || 3000;
 
if (!TWELVE_KEY || !JBIN_KEY || !JBIN_ID) {
  console.error('Variables manquantes');
  process.exit(1);
}
 
let activeTrades   = [];
let history        = [];
let lastSignalTime = {};
 
const PAIRS = [
  'EUR/USD','GBP/USD','USD/JPY','USD/CHF',
  'AUD/USD','NZD/USD','USD/CAD','EUR/GBP'
];
const ANTI_CLUSTER = 24 * 60 * 60 * 1000;
 
// ─── JSONBIN ──────────────────────────────────────────────────────────────────
async function loadCloud() {
  try {
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JBIN_ID}/latest`, {
      headers: { 'X-Master-Key': JBIN_KEY }
    });
    const d = await r.json();
    if (d.record) {
      activeTrades   = d.record.activeTrades   || [];
      history        = d.record.history        || [];
      lastSignalTime = d.record.lastSignalTime || {};
      console.log(`☁️  Cloud chargé — ${activeTrades.length} actifs, ${history.length} historique`);
    }
  } catch (e) { console.error('loadCloud:', e.message); }
}
 
async function syncCloud() {
  try {
    await fetch(`https://api.jsonbin.io/v3/b/${JBIN_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JBIN_KEY },
      body: JSON.stringify({ activeTrades, history, lastSignalTime })
    });
    console.log('☁️  Cloud sauvegardé');
  } catch (e) { console.error('syncCloud:', e.message); }
}
 
// ─── MARCHÉ OUVERT ? ─────────────────────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const parisOffset = isDST(now) ? 2 : 1;
  const utcHour = now.getUTCHours();
  const parisHour = (utcHour + parisOffset) % 24;
  const utcDay = now.getUTCDay();
  const parisDay = parisHour < utcHour ? (utcDay + 1) % 7 : utcDay;
  if (parisDay === 6) return false;
  if (parisDay === 0 && parisHour < 23) return false;
  if (parisDay === 5 && parisHour >= 23) return false;
  if (parisDay === 1 && parisHour < 1) return false;
  return true;
}
 
// ─── INDICATEURS ─────────────────────────────────────────────────────────────
function calcEMA(d, p) {
  if (d.length <= p) return d.map(() => d[d.length-1]);
  const k = 2/(p+1); let e = d.slice(0,p).reduce((a,b)=>a+b,0)/p;
  const r = [e];
  for (let i = p; i < d.length; i++) { e = d[i]*k + e*(1-k); r.push(e); }
  return r;
}
function calcATR(h, l, c, p=14) {
  const tr = [];
  for (let i=1; i<c.length; i++) tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return tr.length ? tr.slice(-p).reduce((a,b)=>a+b,0)/Math.min(p,tr.length) : 0.001;
}
function calcOBV(c) {
  let obv=0, obv10=0;
  for (let i=1; i<c.length; i++) { const b=Math.abs(c[i]-c[i-1])*10000; obv += c[i]>c[i-1]?b:-b; }
  for (let i=Math.max(1,c.length-10); i<c.length; i++) { const b=Math.abs(c[i]-c[i-1])*10000; obv10 += c[i]>c[i-1]?b:-b; }
  return { rising: obv10>0, value: Math.round(obv) };
}
function calcADX(h, l, c, p=14) {
  const tr=[],pm=[],mm=[];
  for (let i=1; i<c.length; i++) {
    tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
    const u=h[i]-h[i-1], dv=l[i-1]-l[i];
    pm.push(u>dv&&u>0?u:0); mm.push(dv>u&&dv>0?dv:0);
  }
  const sT=tr.slice(-p).reduce((a,b)=>a+b,0)||1;
  const sP=pm.slice(-p).reduce((a,b)=>a+b,0);
  const sM=mm.slice(-p).reduce((a,b)=>a+b,0);
  const pDI=(sP/sT)*100, mDI=(sM/sT)*100;
  return { adx: Math.abs(pDI-mDI)/(pDI+mDI+0.0001)*100, bull: pDI>mDI };
}
function calcCCI(h, l, c, p=20) {
  const tp = []; for (let i=0; i<c.length; i++) tp.push((h[i]+l[i]+c[i])/3);
  const sl=tp.slice(-p), m=sl.reduce((a,b)=>a+b,0)/p;
  const md=sl.reduce((a,b)=>a+Math.abs(b-m),0)/p;
  return md===0?0:(tp[tp.length-1]-m)/(0.015*md);
}
function calcMACDFull(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const ml = ema12.slice(ema12.length - ema26.length).map((v, i) => v - ema26[i]);
  const sl = calcEMA(ml, 9);
  const hist = ml.slice(ml.length - sl.length).map((v, i) => v - sl[i]);
  const c3 = closes.slice(0, -3);
  const e12p = calcEMA(c3, 12), e26p = calcEMA(c3, 26);
  const mlp = e12p.slice(e12p.length - e26p.length).map((v, i) => v - e26p[i]);
  return {
    macdLine:      ml[ml.length - 1],
    prevMacdLine:  mlp[mlp.length - 1],
    histogram:     hist[hist.length - 1],
    prevHistogram: hist.length > 1 ? hist[hist.length - 2] : hist[0]
  };
}
 
// ─── MOTEUR SIGNAUX ───────────────────────────────────────────────────────────
function computeSignalAnalyzer(candles, pair) {
  if (candles.length < 60) return null;
  const closes = candles.map(c => parseFloat(c.close));
  const highs  = candles.map(c => parseFloat(c.high));
  const lows   = candles.map(c => parseFloat(c.low));
  const n      = closes.length - 1;
  const price  = closes[n];
  const dec    = pair.includes('JPY') ? 3 : 5;
  if (n < 50) return null;
 
  const macd       = calcMACDFull(closes);
  const priceTrend = closes[n] > closes[n - 3] ? 1 : -1;
  const macdTrend  = macd.macdLine > macd.prevMacdLine ? 1 : -1;
  const macdDiv    = priceTrend !== macdTrend ? -priceTrend : 0;
 
  const high50  = Math.max(...highs.slice(-50));
  const low50   = Math.min(...lows.slice(-50));
  const rng50   = high50 - low50;
  const fib382  = low50 + rng50 * 0.382;
  const fib618  = low50 + rng50 * 0.618;
  const fibZone = price >= fib382 && price <= fib618;
 
  const isInsideBar   = n >= 1 && highs[n] < highs[n-1] && lows[n] > lows[n-1];
  const insideBarBull = isInsideBar && closes[n] > closes[n-1];
 
  const rH = highs.slice(-25), rL = lows.slice(-25);
  const arUp   = (24 - rH.indexOf(Math.max(...rH))) / 24 * 100;
  const arDown = (24 - rL.indexOf(Math.min(...rL))) / 24 * 100;
  const aroonBull = arUp > arDown;
 
  const stochH = Math.max(...highs.slice(-14));
  const stochL = Math.min(...lows.slice(-14));
  const stochK = stochH === stochL ? 50 : ((price - stochL) / (stochH - stochL)) * 100;
 
  const macdMomNeg = macd.histogram < macd.prevHistogram;
  const nearRes    = price > Math.max(...highs.slice(-30)) * 0.995;
 
  const atrVal = calcATR(highs, lows, closes);
  const slPips = atrVal * 1.5;
  const tpPips = slPips * 1.5;
 
  if (macdDiv === 1 && fibZone && insideBarBull && aroonBull) {
    return {
      pair, direction: 'BUY',
      entryPrice: price.toFixed(dec),
      sl: (price - slPips).toFixed(dec),
      tp: (price + tpPips).toFixed(dec),
      reliability: 69,
      reasons: [
        'Divergence MACD haussière (prix ↓, MACD ↑)',
        'Prix en zone Fibonacci 38.2%-61.8%',
        'Inside Bar haussier (indécision → rupture)',
        'Aroon haussier confirmé',
        'Combo backtestée 69% / 80 trades / WF Test 71%'
      ],
      engine: 'ANALYZER',
      timestamp: new Date().toISOString()
    };
  }
 
  const macdCross = macd.histogram > 0 ? 1 : -1;
  const ema50arr  = calcEMA(closes, 50);
  const ema200arr = calcEMA(closes, 200);
  const ema50_200 = ema50arr[ema50arr.length-1] < ema200arr[ema200arr.length-1];
 
  const pH = highs[n-1], pL = lows[n-1], pC = closes[n-1];
  const pp = (pH + pL + pC) / 3;
  const r1 = 2 * pp - pL;
  const nearPivot = Math.abs(price-pp)/(pp||1) < 0.0015 || Math.abs(price-r1)/(r1||1) < 0.0015;
 
  const h50s = Math.max(...highs.slice(-50));
  const l50s = Math.min(...lows.slice(-50));
  const fib382sell = l50s + (h50s - l50s) * 0.382;
  const nearFib382 = Math.abs(price - fib382sell) / (fib382sell||1) < 0.003;
 
  let obv10val = 0;
  for (let i = Math.max(1, n-9); i <= n; i++) {
    const b = Math.abs(closes[i] - closes[i-1]) * 10000;
    obv10val += closes[i] > closes[i-1] ? b : -b;
  }
  const obv10Bear = obv10val < 0;
 
  if (macdCross === -1 && nearFib382 && nearPivot && ema50_200 && obv10Bear) {
    return {
      pair, direction: 'SELL',
      entryPrice: price.toFixed(dec),
      sl: (price + slPips).toFixed(dec),
      tp: (price - tpPips).toFixed(dec),
      reliability: 66,
      reasons: [
        'MACD Cross baissier (ligne MACD < signal)',
        'Prix proche Fibonacci 38.2%',
        'Prix proche Pivot Point',
        'EMA50 sous EMA200 (tendance baissière)',
        'Combo exhaustive 66% / 80 trades / WF Test 63%'
      ],
      engine: 'ANALYZER',
      timestamp: new Date().toISOString()
    };
  }
 
  return null;
}
 
// ─── FETCH BOUGIES ────────────────────────────────────────────────────────────
async function fetchCandles(pair, outputsize = 500) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${pair}&interval=4h&outputsize=${outputsize}&apikey=${TWELVE_KEY}`
    );
    const d = await r.json();
    if (!d.values || d.status === 'error') return null;
    return d.values.reverse().slice(0, -1); // chronologique, retire bougie en cours
  } catch (e) { console.error(`fetchCandles ${pair}:`, e.message); return null; }
}
 
// ─── FETCH BOUGIES 30MIN ─────────────────────────────────────────────────────
async function fetchCandles30(pair) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=15min&outputsize=300&apikey=${TWELVE_KEY}`
    );
    const d = await r.json();
    if (!d.values || d.status === 'error') return null;
    return d.values.reverse().slice(0, -1);
  } catch (e) { console.error(`fetchCandles30 ${pair}:`, e.message); return null; }
}
 
// ─── VÉRIFICATION TP/SL — BOUGIES 30MIN (filtre strict post-entrée) ──────────
async function checkTrades() {
  if (!activeTrades.length) return;
  let changed = false;
 
  for (const trade of [...activeTrades]) {
    try {
      const tp     = parseFloat(trade.tp);
      const sl     = parseFloat(trade.sl);
      const en     = parseFloat(trade.entryPrice);
      const isJPY  = trade.pair.includes('JPY');
      const pipDiv = isJPY ? 0.01 : 0.0001;
      const dec    = isJPY ? 3 : 5;
 
      const entryTs = new Date(trade.addedAt || trade.timestamp).getTime();
      if (isNaN(entryTs)) { console.log(`⚠️  ${trade.pair} — date invalide`); continue; }
 
      const candles = await fetchCandles30(trade.pair);
      await sleep(600);
      if (!candles || !candles.length) { console.log(`⚠️  ${trade.pair} — bougies 15min indisponibles`); continue; }
 
      // Filtre strict : uniquement bougies dont le DÉBUT est APRÈS l'entrée
      const postEntry = candles.filter(c => new Date(c.datetime).getTime() > entryTs);
 
      if (!postEntry.length) {
        const last = candles[candles.length - 1];
        console.log(`⏸  ${trade.pair} — en attente bougie 15min post-entrée | TP: ${(Math.abs(last.close-tp)/pipDiv).toFixed(0)}p | SL: ${(Math.abs(last.close-sl)/pipDiv).toFixed(0)}p`);
        continue;
      }
 
      let closed = false, result = null, closePrice = null, closeDate = null;
 
      for (const candle of postEntry) {
        const high = parseFloat(candle.high);
        const low  = parseFloat(candle.low);
        if (trade.direction === 'BUY') {
          if (high >= tp) { closed=true; result='WIN';  closePrice=tp; closeDate=candle.datetime; break; }
          if (low  <= sl) { closed=true; result='LOSS'; closePrice=sl; closeDate=candle.datetime; break; }
        } else {
          if (low  <= tp) { closed=true; result='WIN';  closePrice=tp; closeDate=candle.datetime; break; }
          if (high >= sl) { closed=true; result='LOSS'; closePrice=sl; closeDate=candle.datetime; break; }
        }
      }
 
      if (closed) {
        const pips = ((trade.direction==='BUY'?closePrice-en:en-closePrice)/pipDiv).toFixed(1);
        console.log(`${result==='WIN'?'✅':'❌'} ${trade.pair} ${trade.direction} — ${pips>0?'+':''}${pips}p | 15min: ${closeDate}`);
        history.unshift({ ...trade, result, closePrice: closePrice.toFixed(dec), pips, closedAt: new Date(closeDate).toISOString() });
        if (history.length > 100) history = history.slice(0, 100);
        activeTrades = activeTrades.filter(t => t.pair !== trade.pair);
        changed = true;
      } else {
        const last = postEntry[postEntry.length - 1];
        console.log(`⏸  ${trade.pair} ${trade.direction} | ${last.close} | TP ${(Math.abs(last.close-tp)/pipDiv).toFixed(0)}p | SL ${(Math.abs(last.close-sl)/pipDiv).toFixed(0)}p | ${postEntry.length} bougies 15min`);
      }
 
    } catch (e) { console.error(`checkTrades ${trade.pair}:`, e.message); }
  }
  if (changed) await syncCloud();
}
 
// ─── SCAN PRINCIPAL ───────────────────────────────────────────────────────────
async function runScan() {
  console.log(`\n🔄 SCAN — ${new Date().toLocaleString('fr-FR')}`);
 
  if (!isMarketOpen()) {
    console.log('🚫 Marché fermé (weekend) — scan ignoré');
    return;
  }
 
  const now = new Date();
  const parisOffset = isDST(now) ? 2 : 1;
  const parisHour = (now.getUTCHours() + parisOffset) % 24;
  const utcDay = now.getUTCDay();
  const parisDay = parisHour < now.getUTCHours() ? (utcDay + 1) % 7 : utcDay;
  if (parisDay === 5 && parisHour >= 14) {
    console.log('🚫 Vendredi après 14h Paris — pas de nouveaux signaux');
    await loadCloud();
    await checkTrades();
    return;
  }
 
  await loadCloud();
 
  const nowMs = Date.now();
  const activePairs = activeTrades.map(t => t.pair);
  let signalsFound = 0;
  let changed = false;
 
  for (const pair of PAIRS) {
    if (activePairs.includes(pair)) {
      console.log(`⏸  ${pair} — trade actif`);
      continue;
    }
    if (lastSignalTime[pair] && (nowMs - lastSignalTime[pair]) < ANTI_CLUSTER) {
      const h = Math.round((nowMs - lastSignalTime[pair]) / 3600000);
      console.log(`🕐 ${pair} — signal récent (${h}h), skip`);
      continue;
    }
    try {
      const candles = await fetchCandles(pair);
      if (!candles) { console.log(`⚠️  ${pair} — données indisponibles`); continue; }
      const sig = computeSignalAnalyzer(candles, pair);
      if (sig) {
        console.log(`🚨 SIGNAL ${sig.direction} sur ${sig.pair} — ${sig.reliability}%`);
        activeTrades.push({ ...sig, addedAt: new Date().toISOString() });
        lastSignalTime[pair] = nowMs;
        signalsFound++;
        changed = true;
      } else {
        console.log(`📊 ${pair} — aucun signal`);
      }
      await sleep(600);
    } catch (e) { console.error(`scan ${pair}:`, e.message); }
  }
 
  console.log(`✅ Scan terminé — ${signalsFound} signal(s)`);
  await checkTrades();
  if (changed) await syncCloud();
}
 
// ─── HTTP ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    time: new Date().toISOString(),
    marketOpen: isMarketOpen(),
    activeTrades: activeTrades.length,
    history: history.length,
    pairs: PAIRS.length,
    message: 'Forex Signal Pro — Serveur 24h/24'
  });
});
app.get('/analyzer', (req, res) => {
  const path = require('path');
  res.sendFile(path.join(__dirname, 'analyzer.html'));
});
app.get('/status', (req, res) => {
  res.json({ activeTrades, history: history.slice(0, 10), lastSignalTime });
});
 
// ─── SCHEDULING ───────────────────────────────────────────────────────────────
function getNextInterval() {
  const now = new Date();
  const parisOffset = isDST(now) ? 2 : 1;
  const parisHour = (now.getUTCHours() + parisOffset) % 24;
  const day = now.getUTCDay();
  const utcHour = now.getUTCHours();
  if (day === 6) return 60 * 60 * 1000;
  if (day === 0) return 60 * 60 * 1000;
  if (day === 5 && utcHour >= 22) return 60 * 60 * 1000;
  if (day === 1 && utcHour < 1)  return 60 * 60 * 1000;
  if (parisHour >= 8 && parisHour < 22) return 15 * 60 * 1000;
  return 60 * 60 * 1000;
}
 
function isDST(date) {
  const month = date.getUTCMonth() + 1;
  if (month >= 4 && month <= 9) return true;
  if (month <= 2 || month >= 11) return false;
  if (month === 3) return date.getUTCDate() >= lastSundayOf(date.getUTCFullYear(), 3);
  if (month === 10) return date.getUTCDate() < lastSundayOf(date.getUTCFullYear(), 10);
  return false;
}
 
function lastSundayOf(year, month) {
  const d = new Date(Date.UTC(year, month, 0));
  return d.getUTCDate() - d.getUTCDay();
}
 
async function scheduleNextScan() {
  const interval = getNextInterval();
  console.log(`⏱  Prochain scan dans ${Math.round(interval / 60000)} min`);
  setTimeout(async () => { await runScan(); scheduleNextScan(); }, interval);
}
 
function startKeepAlive() {
  const targets = [
    ['RAMCE',    'https://forex-ramce.onrender.com'],
    ['NEXUS',    'https://nexus-stocks-server.onrender.com'],
    ['ULTIMATE', 'https://forex-ultimate-server.onrender.com']
  ];
  setInterval(async () => {
    for (const [name, url] of targets) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(8000) });
        console.log(`🏓 Keep-alive ${name} OK`);
      } catch(e) { console.log(`⚠ Keep-alive ${name} échoué: ${e.message}`); }
    }
  }, 10 * 60 * 1000);
  console.log('🏓 Keep-alive actif → RAMCE + ULTIMATE pingés toutes les 10 min');
}
 
async function start() {
  console.log('🚀 Forex Signal Pro — Serveur démarré');
  await loadCloud();
  await runScan();
  scheduleNextScan();
  startKeepAlive();
  app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
}
 
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
start().catch(console.error);
 
