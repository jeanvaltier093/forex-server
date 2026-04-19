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
// EUR/JPY, GBP/JPY, EUR/CHF, AUD/JPY retirées — indisponibles plan gratuit Twelve Data
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


// ─── MACD COMPLET (pour divergence) ──────────────────────────────────────────
function calcMACDFull(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const ml = ema12.slice(ema12.length - ema26.length).map((v, i) => v - ema26[i]);
  const sl = calcEMA(ml, 9);
  const hist = ml.slice(ml.length - sl.length).map((v, i) => v - sl[i]);
  // MACD ligne 3 bougies en arrière (pour divergence)
  const c3 = closes.slice(0, -3);
  const e12p = calcEMA(c3, 12), e26p = calcEMA(c3, 26);
  const mlp = e12p.slice(e12p.length - e26p.length).map((v, i) => v - e26p[i]);
  return {
    macdLine:     ml[ml.length - 1],
    prevMacdLine: mlp[mlp.length - 1],
    histogram:    hist[hist.length - 1],
    prevHistogram: hist.length > 1 ? hist[hist.length - 2] : hist[0]
  };
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

// ─── NOUVEAU MOTEUR — COMBOS VALIDÉES SUR 1 AN (Walk-Forward ≥65%) ───────────
//
//  BUY  : Divergence MACD + Fibonacci Zone + Inside Bar + Aroon
//         WR : 69% | 80 trades | Walk-Forward Test : 71%
//
//  SELL : Divergence MACD + Stoch Extrême + MACD Momentum + Proche Résistance
//         WR : 59% | 81 trades | Walk-Forward Test : 56%
//
function computeSignalAnalyzer(candles, pair) {
  if (candles.length < 60) return null;
  const closes = candles.map(c => parseFloat(c.close));
  const highs  = candles.map(c => parseFloat(c.high));
  const lows   = candles.map(c => parseFloat(c.low));
  const n      = closes.length - 1;
  const price  = closes[n];
  const dec    = pair.includes('JPY') ? 3 : 5;

  if (n < 50) return null;

  // ── MACD divergence ──────────────────────────────────────────────────────
  const macd       = calcMACDFull(closes);
  const priceTrend = closes[n] > closes[n - 3] ? 1 : -1;
  const macdTrend  = macd.macdLine > macd.prevMacdLine ? 1 : -1;
  const macdDiv    = priceTrend !== macdTrend ? -priceTrend : 0;
  // macdDiv =  1 → divergence haussière (BUY)
  // macdDiv = -1 → divergence baissière (SELL)
  // macdDiv =  0 → pas de divergence

  // ── Fibonacci Zone (38.2% - 61.8% sur 50 bougies) ───────────────────────
  const high50  = Math.max(...highs.slice(-50));
  const low50   = Math.min(...lows.slice(-50));
  const rng50   = high50 - low50;
  const fib382  = low50 + rng50 * 0.382;
  const fib618  = low50 + rng50 * 0.618;
  const fibZone = price >= fib382 && price <= fib618;

  // ── Inside Bar haussier (current range < prev range + close > prev close) ─
  const isInsideBar  = n >= 1 && highs[n] < highs[n - 1] && lows[n] > lows[n - 1];
  const insideBarBull = isInsideBar && closes[n] > closes[n - 1];

  // ── Aroon haussier (25 périodes) ─────────────────────────────────────────
  const rH      = highs.slice(-25);
  const rL      = lows.slice(-25);
  const arUp    = (24 - rH.indexOf(Math.max(...rH))) / 24 * 100;
  const arDown  = (24 - rL.indexOf(Math.min(...rL))) / 24 * 100;
  const aroonBull = arUp > arDown;

  // ── Stochastique en surachat (K > 80) ────────────────────────────────────
  const stochH  = Math.max(...highs.slice(-14));
  const stochL  = Math.min(...lows.slice(-14));
  const stochK  = stochH === stochL ? 50 : ((price - stochL) / (stochH - stochL)) * 100;
  const stochOB = stochK > 80;

  // ── MACD Momentum négatif (histogramme décroissant) ───────────────────────
  const macdMomNeg = macd.histogram < macd.prevHistogram;

  // ── Proche Résistance (prix > max 30 bougies × 0.995) ────────────────────
  const nearRes = price > Math.max(...highs.slice(-30)) * 0.995;

  // ── ATR pour TP/SL ────────────────────────────────────────────────────────
  const atrVal = calcATR(highs, lows, closes);
  const slPips = atrVal * 1.5;
  const tpPips = slPips * 1.5;

  // ════════════════════════════════════════════════════════════════════════
  //  SIGNAL BUY — les 4 conditions doivent être actives simultanément
  // ════════════════════════════════════════════════════════════════════════
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

  // ── Indicateurs supplémentaires pour le SELL ──────────────────────────
  // MACD Cross (ligne MACD > ligne signal)
  const macdCross = macd.macdLine > macd.sl ? 1 : -1;

  // EMA 50/200 (tendance longue)
  const ema50arr  = calcEMA(closes, 50);
  const ema200arr = calcEMA(closes, 200);
  const ema50L    = ema50arr[ema50arr.length - 1];
  const ema200L   = ema200arr[ema200arr.length - 1];
  const ema50_200 = ema50L < ema200L; // true = baissier (EMA50 sous EMA200)

  // Pivot Point (résistance R1)
  const pH = highs[n - 1], pL = lows[n - 1], pC = closes[n - 1];
  const pp = (pH + pL + pC) / 3;
  const r1 = 2 * pp - pL;
  const nearPivot = Math.abs(price - pp) / (pp || 1) < 0.0015 ||
                    Math.abs(price - r1) / (r1 || 1) < 0.0015;

  // Fibonacci 38.2% (prix dans la zone)
  const h50sell = Math.max(...highs.slice(-50));
  const l50sell = Math.min(...lows.slice(-50));
  const fib382sell = l50sell + (h50sell - l50sell) * 0.382;
  const nearFib382 = Math.abs(price - fib382sell) / (fib382sell || 1) < 0.003;

  // OBV 10 bougies baissier
  let obv10val = 0;
  for (let i = Math.max(1, n - 9); i <= n; i++) {
    const b = Math.abs(closes[i] - closes[i-1]) * 10000;
    obv10val += closes[i] > closes[i-1] ? b : -b;
  }
  const obv10Bear = obv10val < 0;

  // ════════════════════════════════════════════════════════════════════════
  //  SIGNAL SELL — Combo exhaustive : macdCross + fib382 + pivot + ema50_200 + obv10
  //  Validé : 66% WR | 80 trades | Walk-Forward Test 63% | 1 an de données
  // ════════════════════════════════════════════════════════════════════════
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
async function fetchCandles(pair) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${pair}&interval=4h&outputsize=500&apikey=${TWELVE_KEY}`
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
      const tp  = parseFloat(trade.tp);
      const sl  = parseFloat(trade.sl);
      const en  = parseFloat(trade.entryPrice);
      const isJPY  = trade.pair.includes('JPY');
      const pipDiv = isJPY ? 0.01 : 0.0001;
      const dec    = isJPY ? 3 : 5;

      // ── Récupérer les bougies 15min depuis l'entrée ──────────────
      // On prend 96 bougies 15min (= 24h) pour couvrir la durée probable du trade
      const r = await fetch(
        `https://api.twelvedata.com/time_series?symbol=${trade.pair}&interval=15min&outputsize=96&apikey=${TWELVE_KEY}`
      );
      const d = await r.json();
      if (!d.values || d.status === 'error') {
        console.log(`⚠️  ${trade.pair} — données 15min indisponibles, vérif prix spot`);
        // Fallback : prix spot
        const rp = await fetch(`https://api.twelvedata.com/price?symbol=${trade.pair}&apikey=${TWELVE_KEY}`);
        const dp = await rp.json();
        if (!dp.price) { await sleep(400); continue; }
        const cur = parseFloat(dp.price);
        let closed = false, result = null, closePrice = null;
        if (trade.direction === 'BUY') {
          if (cur >= tp) { closed=true; result='WIN'; closePrice=tp; }
          else if (cur <= sl) { closed=true; result='LOSS'; closePrice=sl; }
        } else {
          if (cur <= tp) { closed=true; result='WIN'; closePrice=tp; }
          else if (cur >= sl) { closed=true; result='LOSS'; closePrice=sl; }
        }
        if (closed) {
          const pips = ((trade.direction==='BUY'?closePrice-en:en-closePrice)/pipDiv).toFixed(1);
          history.unshift({...trade, result, closePrice: closePrice.toFixed(dec), pips, closedAt: new Date().toISOString()});
          if (history.length > 100) history = history.slice(0, 100);
          activeTrades = activeTrades.filter(t => t.pair !== trade.pair);
          changed = true;
          console.log(`${result==='WIN'?'✅ GAIN':'❌ PERTE'} ${trade.pair} ${trade.direction} — ${pips>0?'+':''}${pips} pips (fallback spot)`);
        } else {
          console.log(`⏸  ${trade.pair} ${trade.direction} — en cours | prix spot: ${cur}`);
        }
        await sleep(400); continue;
      }

      // ── Filtrer les bougies APRÈS l'entrée en position ───────────
      const entryTime = new Date(trade.addedAt).getTime();
      const candles = d.values
        .filter(c => new Date(c.datetime).getTime() >= entryTime)
        .reverse(); // ordre chronologique

      if (!candles.length) {
        console.log(`⏸  ${trade.pair} — pas encore de bougies après entrée`);
        await sleep(400); continue;
      }

      // ── Vérifier si TP ou SL touché sur HIGH/LOW de chaque bougie ─
      let closed = false, result = null, closePrice = null, closedAt = null;

      for (const candle of candles) {
        const high = parseFloat(candle.high);
        const low  = parseFloat(candle.low);

        if (trade.direction === 'BUY') {
          // TP touché si HIGH >= TP
          if (high >= tp && !closed) {
            closed = true; result = 'WIN'; closePrice = tp;
            closedAt = candle.datetime;
          }
          // SL touché si LOW <= SL (priorité SL si les deux dans la même bougie)
          if (low <= sl) {
            // Si TP et SL dans la même bougie → SL prioritaire (pire cas)
            closed = true; result = 'LOSS'; closePrice = sl;
            closedAt = candle.datetime;
            break;
          }
          if (closed) break;
        } else {
          // SELL : TP touché si LOW <= TP
          if (low <= tp && !closed) {
            closed = true; result = 'WIN'; closePrice = tp;
            closedAt = candle.datetime;
          }
          // SL touché si HIGH >= SL
          if (high >= sl) {
            closed = true; result = 'LOSS'; closePrice = sl;
            closedAt = candle.datetime;
            break;
          }
          if (closed) break;
        }
      }

      if (closed) {
        const pips = ((trade.direction==='BUY'?closePrice-en:en-closePrice)/pipDiv).toFixed(1);
        history.unshift({
          ...trade, result,
          closePrice: closePrice.toFixed(dec),
          pips,
          closedAt: closedAt ? new Date(closedAt).toISOString() : new Date().toISOString()
        });
        if (history.length > 100) history = history.slice(0, 100);
        activeTrades = activeTrades.filter(t => t.pair !== trade.pair);
        changed = true;
        console.log(`${result==='WIN'?'✅ GAIN':'❌ PERTE'} ${trade.pair} ${trade.direction} — ${pips>0?'+':''}${pips} pips (vérifié sur ${candles.length} bougies 15min)`);
      } else {
        const last = candles[candles.length - 1];
        console.log(`⏸  ${trade.pair} ${trade.direction} — en cours | dernier prix: ${last ? last.close : '?'}`);
      }

      await sleep(500);
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

  // Pas de nouveaux signaux le vendredi après 14h Paris
  {
    const now = new Date();
    const parisOffset = isDST(now) ? 2 : 1;
    const parisHour = (now.getUTCHours() + parisOffset) % 24;
    const utcDay = now.getUTCDay();
    const parisDay = parisHour < now.getUTCHours() ? (utcDay + 1) % 7 : utcDay;
    if (parisDay === 5 && parisHour >= 14) {
      console.log('🚫 Vendredi après 14h Paris — pas de nouveaux signaux');
      await checkTrades();
      return;
    }
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

      const sig = computeSignalAnalyzer(candles, pair);
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

app.get('/analyzer', (req, res) => {
  const path = require('path');
  res.sendFile(path.join(__dirname, 'analyzer.html'));
});

app.get('/status', (req, res) => {
  res.json({ activeTrades, history: history.slice(0,10), lastSignalTime });
});

// ─── START ────────────────────────────────────────────────────────────────────
// ─── SCHEDULING DYNAMIQUE ────────────────────────────────────────────────────
// 8h-22h Paris → scan toutes les 15 min
// 22h-8h Paris → scan toutes les 1h
// Weekend (ven 22h → dim 22h) → 0 scan, vérification toutes les 1h
function getNextInterval() {
  const now = new Date();
  // Heure Paris (UTC+1 hiver, UTC+2 été)
  const parisOffset = isDST(now) ? 2 : 1;
  const parisHour = (now.getUTCHours() + parisOffset) % 24;
  const day = now.getUTCDay();
  const utcHour = now.getUTCHours();
  // Weekend
  if (day === 6) return 60 * 60 * 1000;
  if (day === 0) return 60 * 60 * 1000;
  if (day === 5 && utcHour >= 22) return 60 * 60 * 1000;
  if (day === 1 && utcHour < 1) return 60 * 60 * 1000;
  // Heures actives Paris
  if (parisHour >= 8 && parisHour < 22) return 15 * 60 * 1000; // 15 min
  return 60 * 60 * 1000; // 1h la nuit
}
function isDST(date) {
  // Render tourne en UTC pur — getTimezoneOffset() retourne toujours 0
  // On calcule manuellement le DST Europe/Paris :
  // Heure d'été : dernier dimanche de mars → dernier dimanche d'octobre
  const month = date.getUTCMonth() + 1; // 1-12
  if (month >= 4 && month <= 9) return true;  // Avril-Septembre → UTC+2
  if (month <= 2 || month >= 11) return false; // Jan-Fév, Nov-Déc → UTC+1
  // Mars et Octobre : vérifier le dernier dimanche
  if (month === 3) {
    const lastSun = lastSundayOf(date.getUTCFullYear(), 3);
    return date.getUTCDate() >= lastSun;
  }
  if (month === 10) {
    const lastSun = lastSundayOf(date.getUTCFullYear(), 10);
    return date.getUTCDate() < lastSun;
  }
  return false;
}
function lastSundayOf(year, month) {
  // Dernier dimanche du mois (month = 1-12)
  const d = new Date(Date.UTC(year, month, 0)); // dernier jour du mois
  return d.getUTCDate() - d.getUTCDay();
}
async function scheduleNextScan() {
  const interval = getNextInterval();
  const minutes = Math.round(interval / 60000);
  console.log(`⏱  Prochain scan dans ${minutes} min`);
  setTimeout(async () => {
    await runScan();
    scheduleNextScan();
  }, interval);
}

async function start() {
  console.log('🚀 Forex Signal Pro — Serveur démarré');
  await loadCloud();
  await runScan();
  scheduleNextScan();
  app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
start().catch(console.error);
