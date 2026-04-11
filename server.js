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
  'EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','NZD/USD',
  'USD/CAD','EUR/GBP','EUR/JPY','GBP/JPY','EUR/CHF','AUD/JPY'
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
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 1 && hour < 1) return false;
  return true;
}

// ─── INDICATEURS (identiques à l'appli) ──────────────────────────────────────
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

// ─── MOTEUR DE SIGNAUX (identique à l'appli) ─────────────────────────────────
function computeSignal(candles, pair) {
  if (candles.length < 60) return null;
  const closes = candles.map(c=>parseFloat(c.close));
  const highs  = candles.map(c=>parseFloat(c.high));
  const lows   = candles.map(c=>parseFloat(c.low));
  const price  = closes[closes.length-1];
  const dec    = pair.includes('JPY') ? 3 : 5;

  const obv     = calcOBV(closes);
  const adxData = calcADX(highs, lows, closes);
  const cciVal  = calcCCI(highs, lows, closes);
  const ema50   = calcEMA(closes, 50);
  const ema50L  = ema50[ema50.length-1];
  const atrVal  = calcATR(highs, lows, closes);

  const s_obv   = obv.rising ? 1 : -1;
  const s_adx   = adxData.adx > 25 ? (adxData.bull ? 1 : -1) : 0;
  const s_cci   = cciVal > 100 ? -1 : cciVal < -100 ? 1 : 0;
  const s_price = price > ema50L ? 1 : -1;
  const sellScore = s_obv + s_adx + s_cci + s_price;

  const b_obv = !obv.rising ? 1 : 0;
  const b_adx = adxData.adx > 25 && !adxData.bull ? 1 : 0;
  const buyScore = b_obv + b_adx;

  let direction=null, reliability=0, reasons=[];

  if (sellScore >= 3) {
    direction = 'SELL';
    if (sellScore >= 4) reliability = 92;
    else if (s_obv>0 && s_adx>0 && s_price>0) reliability = 83;
    else reliability = 72;
    if (s_obv>0)   reasons.push('OBV pression achat');
    if (s_adx>0)   reasons.push('ADX fort haussier');
    if (s_cci<0)   reasons.push('CCI surchauffe');
    if (s_price>0) reasons.push('Prix > EMA50');
    reasons.push('Retournement baissier');
  } else if (buyScore >= 2) {
    direction = 'BUY';
    reliability = 62;
    if (b_obv>0) reasons.push('OBV pression vente');
    if (b_adx>0) reasons.push('ADX fort baissier');
    if (cciVal < -100) { reliability=68; reasons.push('CCI survendu'); }
    if (price < ema50L) { reliability=Math.min(72,reliability+4); reasons.push('Prix < EMA50'); }
    reasons.push('Retournement haussier');
  }

  if (!direction) return null;

  const slPips = atrVal * 1.5;
  const tpPips = slPips * 1.5;
  const sl = direction==='BUY' ? price-slPips : price+slPips;
  const tp = direction==='BUY' ? price+tpPips : price-tpPips;

  return {
    pair, direction,
    entryPrice: price.toFixed(dec),
    sl: sl.toFixed(dec), tp: tp.toFixed(dec),
    reliability: Math.min(95, reliability),
    reasons: reasons.slice(0,5),
    obvDisplay: (obv.rising?'↑':'↓')+' '+Math.round(obv.value/1000)+'K',
    adxDisplay: adxData.adx.toFixed(1)+' '+(adxData.bull?'▲':'▼'),
    cciDisplay: cciVal.toFixed(0),
    timestamp: new Date().toISOString()
  };
}

// ─── FETCH BOUGIES ────────────────────────────────────────────────────────────
async function fetchCandles(pair) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${pair}&interval=4h&outputsize=200&apikey=${TWELVE_KEY}`
    );
    const d = await r.json();
    if (!d.values || d.status==='error') return null;
    return d.values.reverse();
  } catch (e) { console.error(`fetchCandles ${pair}:`, e.message); return null; }
}

// ─── VÉRIFICATION TP/SL ───────────────────────────────────────────────────────
async function checkTrades() {
  if (!activeTrades.length) return;
  let changed = false;
  for (const trade of [...activeTrades]) {
    try {
      const r = await fetch(`https://api.twelvedata.com/price?symbol=${trade.pair}&apikey=${TWELVE_KEY}`);
      const d = await r.json();
      if (!d.price || d.status==='error') continue;
      const cur=parseFloat(d.price), tp=parseFloat(trade.tp), sl=parseFloat(trade.sl), en=parseFloat(trade.entryPrice);
      let closed=false, result=null, closePrice=null;
      if (trade.direction==='BUY') {
        if (cur>=tp) { closed=true; result='WIN'; closePrice=tp; }
        else if (cur<=sl) { closed=true; result='LOSS'; closePrice=sl; }
      } else {
        if (cur<=tp) { closed=true; result='WIN'; closePrice=tp; }
        else if (cur>=sl) { closed=true; result='LOSS'; closePrice=sl; }
      }
      if (closed) {
        const isJPY=trade.pair.includes('JPY');
        const pipDiv=isJPY?0.01:0.0001;
        const pips=((trade.direction==='BUY'?closePrice-en:en-closePrice)/pipDiv).toFixed(1);
        history.unshift({ ...trade, result, closePrice: closePrice.toFixed(isJPY?3:5), pips, closedAt: new Date().toISOString() });
        if (history.length>100) history=history.slice(0,100);
        activeTrades = activeTrades.filter(t=>t.pair!==trade.pair);
        changed = true;
        console.log(`${result==='WIN'?'✅ GAIN':'❌ PERTE'} ${trade.pair} ${trade.direction} — ${pips>0?'+':''}${pips} pips`);
      } else {
        console.log(`⏸  ${trade.pair} ${trade.direction} — en cours | prix: ${cur}`);
      }
      await sleep(300);
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

  // Recharger le cloud d'abord pour avoir les dernières données de l'appli
  await loadCloud();

  const now = Date.now();
  const activePairs = activeTrades.map(t=>t.pair);
  let signalsFound = 0;
  let changed = false;

  for (const pair of PAIRS) {
    // Skip si trade déjà actif sur cette paire
    if (activePairs.includes(pair)) {
      console.log(`⏸  ${pair} — trade actif`);
      continue;
    }
    // Anti-clustering 24h
    if (lastSignalTime[pair] && (now - lastSignalTime[pair]) < ANTI_CLUSTER) {
      const h = Math.round((now-lastSignalTime[pair])/3600000);
      console.log(`🕐 ${pair} — signal récent (${h}h), skip`);
      continue;
    }

    try {
      const candles = await fetchCandles(pair);
      if (!candles) { console.log(`⚠️  ${pair} — données indisponibles`); continue; }

      const sig = computeSignal(candles, pair);
      if (sig) {
        console.log(`🚨 SIGNAL ${sig.direction} sur ${sig.pair} — ${sig.reliability}%`);
        activeTrades.push({ ...sig, addedAt: new Date().toISOString() });
        lastSignalTime[pair] = now;
        signalsFound++;
        changed = true;
      } else {
        console.log(`📊 ${pair} — aucun signal`);
      }
      await sleep(600);
    } catch (e) { console.error(`scan ${pair}:`, e.message); }
  }

  console.log(`✅ Scan terminé — ${signalsFound} signal(s)`);

  // Vérifier les TP/SL
  await checkTrades();

  // Sauvegarder si changements
  if (changed) await syncCloud();
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
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

app.get('/status', (req, res) => {
  res.json({ activeTrades, history: history.slice(0,10), lastSignalTime });
});

// ─── START ────────────────────────────────────────────────────────────────────
async function start() {
  console.log('🚀 Forex Signal Pro — Serveur démarré');
  await loadCloud();
  await runScan();
  setInterval(runScan, 10 * 60 * 1000);
  app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
start().catch(console.error);
