'use strict';

// ══════════════════════════════════════════════════════════════════
// FOREX DEEP ANALYSIS — RECHERCHE EXHAUSTIVE VRAIE CÔTÉ SERVEUR
// Teste TOUTES les combinaisons de 2, 3 et 4 signaux parmi les 148
// Lance via : GET /deep-analysis?key=TON_API_KEY&outputsize=2200&mt=80
// Résultats : GET /deep-results
// ══════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

// ─── ÉTAT GLOBAL ─────────────────────────────────────────────────
let jobStatus = { running: false, progress: 0, phase: '', detail: '', startedAt: null, finishedAt: null };
let jobResults = null;

// ─── UTILITAIRES ─────────────────────────────────────────────────
const ema = (d, p) => {
  if (d.length <= p) return d.map(() => d[d.length-1]);
  const k = 2/(p+1); let e = d.slice(0,p).reduce((a,b)=>a+b,0)/p;
  const r = [e];
  for (let i = p; i < d.length; i++) { e = d[i]*k + e*(1-k); r.push(e); }
  return r;
};
const atrFn = (h, l, c, p=14) => {
  const tr = [];
  for (let i=1; i<c.length; i++) tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return tr.length ? tr.slice(-p).reduce((a,b)=>a+b,0)/Math.min(p,tr.length) : 0.001;
};
const rsiFn = (d, p=14) => {
  if (d.length < p+2) return 50;
  let g=0, l2=0;
  for (let i=1; i<=p; i++) { const dv=d[i]-d[i-1]; dv>0?g+=dv:l2-=dv; }
  let ag=g/p, al=l2/p, v=50;
  for (let i=p; i<d.length; i++) {
    if (i>p) { const dv=d[i]-d[i-1]; ag=(ag*(p-1)+Math.max(dv,0))/p; al=(al*(p-1)+Math.max(-dv,0))/p; }
    v = 100-100/(1+(al===0?100:ag/al));
  }
  return v;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── 148 SIGNAUX ─────────────────────────────────────────────────
function computeAllSignals(C, H, L, O, idx) {
  if (idx < 60 || C.length < 61) return null;
  const c=C.slice(0,idx+1), h=H.slice(0,idx+1), l=L.slice(0,idx+1), o=O.slice(0,idx+1);
  const n=c.length-1, price=c[n];
  const s={};

  // EMA
  const e8=ema(c,8),e13=ema(c,13),e20=ema(c,20),e34=ema(c,34),e50=ema(c,50),e100=ema(c,100),e200=ema(c,200);
  const [e8l,e13l,e20l,e34l,e50l,e100l,e200l]=[e8,e13,e20,e34,e50,e100,e200].map(x=>x[x.length-1]);
  const em9=ema(c,9),em21=ema(c,21);
  const e9l=em9[em9.length-1],em21l=em21[em21.length-1];
  s.ema8_20=e8l>e20l?1:-1; s.ema13_34=e13l>e34l?1:-1; s.ema20_50=e20l>e50l?1:-1; s.ema50_200=e50l>e200l?1:-1;
  s.priceE20=price>e20l?1:-1; s.priceE50=price>e50l?1:-1; s.priceE100=price>e100l?1:-1; s.priceE200=price>e200l?1:-1;
  s.priceE9=price>e9l?1:-1; s.priceE21=price>em21l?1:-1; s.ema9_21=e9l>em21l?1:-1; s.ema21_50=em21l>e50l?1:-1;
  if(c.length>40){const w1=ema(c,10),w2=ema(c,20);const raw=w1.slice(w1.length-w2.length).map((v,i)=>2*v-w2[i]);const hull=ema(raw,4);s.hullMA=hull[hull.length-1]>hull[hull.length-2]?1:-1;}else{s.hullMA=0}

  // RSI
  const rsi14=rsiFn(c,14),rsi7=rsiFn(c,7),rsi21=rsiFn(c,21);
  s.rsi14Ext=rsi14<30?1:rsi14>70?-1:0; s.rsi7Ext=rsi7<25?1:rsi7>75?-1:0; s.rsi21Ext=rsi21<35?1:rsi21>65?-1:0;
  s.rsi14Mid=rsi14>50?1:-1; s.rsi7Mid=rsi7>50?1:-1;
  if(n>=5){const rp=rsiFn(c.slice(0,-3),14);s.rsiDiv=((price>c[n-3]?1:-1)!==(rsi14>rp?1:-1))?-(price>c[n-3]?1:-1):0;}else{s.rsiDiv=0}

  // MACD
  const mf=()=>{const e12=ema(c,12),e26=ema(c,26);const ml=e12.slice(e12.length-e26.length).map((v,i)=>v-e26[i]);const sl=ema(ml,9);const h2=ml.slice(ml.length-sl.length).map((v,i)=>v-sl[i]);return{h:h2[h2.length-1],ph:h2.length>1?h2[h2.length-2]:0,ml:ml[ml.length-1],sl:sl[sl.length-1]};};
  const mv=mf();
  s.macdCross=mv.ml>mv.sl?1:-1; s.macdHist=mv.h>0?1:-1; s.macdMom=mv.h>mv.ph?1:-1; s.macdZero=mv.ml>0?1:-1;
  if(n>=5){const cc2=c.slice(0,-3);const e12=ema(cc2,12),e26=ema(cc2,26);const ml=e12.slice(e12.length-e26.length).map((v,i)=>v-e26[i]);const mvp={ml:ml[ml.length-1]};s.macdDiv=((price>c[n-3]?1:-1)!==(mv.ml>mvp.ml?1:-1))?-(price>c[n-3]?1:-1):0;}else{s.macdDiv=0}

  // Stochastique
  const stf=()=>{const k=[];for(let i=13;i<c.length;i++){const hh=Math.max(...h.slice(i-13,i+1)),ll=Math.min(...l.slice(i-13,i+1));k.push(hh===ll?50:((c[i]-ll)/(hh-ll))*100)}const d=[];for(let i=2;i<k.length;i++)d.push((k[i]+k[i-1]+k[i-2])/3);return{k:k[k.length-1],d:d[d.length-1],pk:k.length>1?k[k.length-2]:50};};
  const sv=stf();
  s.stochKD=sv.k>sv.d?1:-1; s.stochExt=sv.k<20?1:sv.k>80?-1:0; s.stochMom=sv.k>sv.pk?1:-1;
  s.stochOS=sv.k<25&&sv.k>sv.d?1:0; s.stochOB=sv.k>75&&sv.k<sv.d?-1:0;

  // Stoch RSI
  if(c.length>20){const rv=[];for(let i=3;i<c.length;i++)rv.push(rsiFn(c.slice(0,i+1),14));const rMn=Math.min(...rv.slice(-14)),rMx=Math.max(...rv.slice(-14));const sr=rMx===rMn?50:((rv[rv.length-1]-rMn)/(rMx-rMn))*100;s.stochRSIExt=sr<20?1:sr>80?-1:0;s.stochRSIMid=sr>50?1:-1;}else{s.stochRSIExt=0;s.stochRSIMid=0}

  // ADX + Aroon
  const af2=()=>{const tr=[],pm=[],mm=[];for(let i=1;i<c.length;i++){tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));const u=h[i]-h[i-1],d=l[i-1]-l[i];pm.push(u>d&&u>0?u:0);mm.push(d>u&&d>0?d:0)}const sT=tr.slice(-14).reduce((a,b)=>a+b,0)||1;const sP=pm.slice(-14).reduce((a,b)=>a+b,0);const sM=mm.slice(-14).reduce((a,b)=>a+b,0);const pDI=(sP/sT)*100,mDI=(sM/sT)*100;return{v:Math.abs(pDI-mDI)/(pDI+mDI+.0001)*100,bull:pDI>mDI};};
  const av=af2();
  s.adxDir=av.v>20?(av.bull?1:-1):0; s.adxStrong=av.v>25?(av.bull?1:-1):0; s.adxVStrong=av.v>30?(av.bull?1:-1):0;
  if(n>=25){const rH=h.slice(-25),rL=l.slice(-25);const arU=(24-rH.indexOf(Math.max(...rH)))/24*100;const arD=(24-rL.indexOf(Math.min(...rL)))/24*100;s.aroon=arU>arD?1:-1;s.aroonExt=arU>70&&arD<30?1:arD>70&&arU<30?-1:0;}else{s.aroon=0;s.aroonExt=0}

  // CCI, Williams, Bollinger, Keltner
  const ccf=()=>{const tp=[];for(let i=0;i<c.length;i++)tp.push((h[i]+l[i]+c[i])/3);const sl=tp.slice(-20),m=sl.reduce((a,b)=>a+b,0)/20,md=sl.reduce((a,b)=>a+Math.abs(b-m),0)/20;return md===0?0:(tp[tp.length-1]-m)/(0.015*md);};
  const cv=ccf();
  s.cciExt=cv<-100?1:cv>100?-1:0; s.cciMid=cv>0?1:-1; s.cciStrong=cv<-150?1:cv>150?-1:0;
  const hh14=Math.max(...h.slice(-14)),ll14=Math.min(...l.slice(-14));
  const wrv=hh14===ll14?-50:((hh14-price)/(hh14-ll14))*-100;
  s.wr=wrv<-80?1:wrv>-20?-1:0; s.wrMid=wrv>-50?1:-1;
  const bbs=c.slice(-20),bbm=bbs.reduce((a,b)=>a+b,0)/20;
  const bbstd=Math.sqrt(bbs.reduce((a,b)=>a+(b-bbm)**2,0)/20);
  const bbu=bbm+2*bbstd,bbl=bbm-2*bbstd;
  s.bbPos=price<bbl?1:price>bbu?-1:price>bbm?1:-1;
  s.bbExt=price<bbl?1:price>bbu?-1:0; s.bbSqueeze=4*bbstd/(bbm||1)<0.015?1:0;
  const atrV=atrFn(h,l,c);
  const kcU=e20l+2*atrV,kcL=e20l-2*atrV;
  s.keltner=price<kcL?1:price>kcU?-1:price>e20l?1:-1; s.keltnerExt=price<kcL?1:price>kcU?-1:0;

  // OBV, Force Index, Parabolic SAR
  let obv=0,obv10=0,obv20=0;
  for(let i=1;i<c.length;i++){const b=Math.abs(c[i]-c[i-1])*10000;obv+=c[i]>c[i-1]?b:-b;}
  for(let i=Math.max(1,n-9);i<=n;i++){const b=Math.abs(c[i]-c[i-1])*10000;obv10+=c[i]>c[i-1]?b:-b;}
  for(let i=Math.max(1,n-19);i<=n;i++){const b=Math.abs(c[i]-c[i-1])*10000;obv20+=c[i]>c[i-1]?b:-b;}
  s.obvDir=obv>0?1:-1; s.obv10=obv10>0?1:-1; s.obv20=obv20>0?1:-1;
  if(n>=2){const fi=(c[n]-c[n-1])*Math.abs(c[n]-c[n-1])*10000,fip=(c[n-1]-c[n-2])*Math.abs(c[n-1]-c[n-2])*10000;s.forceIdx=fi>0&&fi>fip?1:fi<0&&fi<fip?-1:0;}else{s.forceIdx=0}
  const psarFn=()=>{const af0=0.02,afM=0.2;let bull=true,sr=l[0]||0,ep=h[0]||0,af=af0;for(let i=1;i<c.length;i++){sr=sr+af*(ep-sr);if(bull){if(h[i]>ep){ep=h[i];af=Math.min(af+af0,afM)}if(c[i]<sr){bull=false;sr=ep;ep=l[i];af=af0}}else{if(l[i]<ep){ep=l[i];af=Math.min(af+af0,afM)}if(c[i]>sr){bull=true;sr=ep;ep=h[i];af=af0}}}return bull;};
  s.psar=psarFn()?1:-1;

  // Momentum, Chande, Ultimate, TRIX, Vortex, DPO, Mass, Ichimoku
  if(n>=10)s.mom10=((price-c[n-10])/c[n-10]*100)>0.3?1:((price-c[n-10])/c[n-10]*100)<-0.3?-1:0;else s.mom10=0;
  if(n>=5)s.mom5=((price-c[n-5])/c[n-5]*100)>0.2?1:((price-c[n-5])/c[n-5]*100)<-0.2?-1:0;else s.mom5=0;
  if(n>=14)s.roc14=((price-c[n-14])/c[n-14]*100)>0.4?1:((price-c[n-14])/c[n-14]*100)<-0.4?-1:0;else s.roc14=0;
  if(n>=14){let up=0,dn=0;for(let i=n-13;i<=n;i++){const d=c[i]-c[i-1];d>0?up+=d:dn-=d;}const cm=(up-dn)/(up+dn+0.0001)*100;s.chande=cm>10?1:cm<-10?-1:0;s.chandeExt=cm>30?1:cm<-30?-1:0;}else{s.chande=0;s.chandeExt=0}
  if(n>=28){const uoFn=(p2)=>{let bp=0,tr2=0;for(let i=n-p2+1;i<=n;i++){const tR=Math.max(h[i],c[i-1])-Math.min(l[i],c[i-1]);tr2+=tR;bp+=c[i]-Math.min(l[i],c[i-1]);}return tr2?bp/tr2:0.5};const uo=100*((4*uoFn(7)+2*uoFn(14)+uoFn(28))/7);s.ultOsc=uo<30?1:uo>70?-1:0;}else{s.ultOsc=0}
  if(c.length>45){const t1=ema(c,15),t2=ema(t1,15),t3=ema(t2,15);const tr=t3.length>1?((t3[t3.length-1]-t3[t3.length-2])/(t3[t3.length-2]||1))*10000:0;s.trix=tr>0?1:-1;s.trixMom=t3.length>2&&tr>((t3[t3.length-2]-t3[t3.length-3])/(t3[t3.length-3]||1))*10000?1:-1;}else{s.trix=0;s.trixMom=0}
  if(n>=14){let vp=0,vm=0,tr2=0;for(let i=n-13;i<=n;i++){vp+=Math.abs(h[i]-l[i-1]);vm+=Math.abs(l[i]-h[i-1]);tr2+=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));}s.vortex=tr2?(vp>vm?1:-1):0;s.vortexStr=tr2&&Math.abs(vp-vm)/tr2>0.05?(vp>vm?1:-1):0;}else{s.vortex=0;s.vortexStr=0}
  if(c.length>22){const eo=ema(c.slice(0,-11),20);s.dpo=price-eo[eo.length-1]>0?1:-1;}else{s.dpo=0}
  if(n>=25){let mi=0;const ranges=h.slice(-25).map((hv,i)=>hv-l[l.length-25+i]);const em9b=ema(ranges,9),em99=ema(em9b,9);em9b.slice(-em99.length).forEach((v,i)=>{if(em99[i])mi+=v/em99[i];});s.massIdx=mi>27?-1:mi<26.5?1:0;}else{s.massIdx=0}
  if(h.length>=52){const tk=(Math.max(...h.slice(-9))+Math.min(...l.slice(-9)))/2;const kj=(Math.max(...h.slice(-26))+Math.min(...l.slice(-26)))/2;const spA=(tk+kj)/2;const spB=(Math.max(...h.slice(-52))+Math.min(...l.slice(-52)))/2;s.ichiTK=tk>kj?1:-1;s.ichiCloud=price>Math.max(spA,spB)?1:price<Math.min(spA,spB)?-1:0;s.ichiPrice=price>tk&&price>kj?1:price<tk&&price<kj?-1:0;}else{s.ichiTK=0;s.ichiCloud=0;s.ichiPrice=0}

  // Fibonacci, Pivot Points, Elder Ray
  if(n>=50){const hh=Math.max(...h.slice(-50)),ll=Math.min(...l.slice(-50));const rng=hh-ll;const f382=ll+rng*0.382,f500=ll+rng*0.5,f618=ll+rng*0.618;const near=(p2,t)=>Math.abs(p2-t)/(t||1)<0.002;s.fib382=near(price,f382)?(price>c[n-1]?1:-1):0;s.fib500=near(price,f500)?(price>c[n-1]?1:-1):0;s.fib618=near(price,f618)?(price>c[n-1]?1:-1):0;s.fibZone=(price>=f382&&price<=f618)?1:0;}else{s.fib382=0;s.fib500=0;s.fib618=0;s.fibZone=0}
  if(n>=1){const pH=h[n-1],pL=l[n-1],pC=c[n-1];const pp=(pH+pL+pC)/3;const r1=2*pp-pL,s1=2*pp-pH,r2=pp+(pH-pL),s2=pp-(pH-pL);const near=(p2,t)=>Math.abs(p2-t)/(t||1)<0.0015;s.pivot=near(price,pp)?(price>c[n-1]?1:-1):price>r1?-1:price<s1?1:0;s.pivotR1=near(price,r1)?-1:0;s.pivotS1=near(price,s1)?1:0;s.pivotR2=near(price,r2)?-1:0;s.pivotS2=near(price,s2)?1:0;s.abovePP=price>pp?1:-1;}else{s.pivot=0;s.pivotR1=0;s.pivotS1=0;s.pivotR2=0;s.pivotS2=0;s.abovePP=0}
  const e13l2=ema(c,13);const e13last=e13l2[e13l2.length-1];
  s.elderBull=h[n]-e13last>0?1:-1; s.elderBear=l[n]-e13last>0?1:-1;

  // Patterns bougies (20)
  if(n>=2){
    const[co,ch,cl,cc2]=[o[n],h[n],l[n],c[n]];
    const[po,ph,pl,pc]=[o[n-1],h[n-1],l[n-1],c[n-1]];
    const[ppo,pph,ppl,ppc]=[o[n-2],h[n-2],l[n-2],c[n-2]];
    const body=Math.abs(cc2-co),pBody=Math.abs(pc-po)||0.0001;
    const uw=ch-Math.max(co,cc2),lw=Math.min(co,cc2)-cl,tr3=ch-cl||0.0001;
    const bull=cc2>co,bear=cc2<co,pBull=pc>po,pBear=pc<po,ppBull=ppc>ppo;
    s.doji=body/tr3<0.1?(cc2>pc?1:-1):0; s.hammer=lw>body*2&&uw<body*0.5&&pBear?1:0;
    s.shootStar=uw>body*2&&lw<body*0.5&&pBull?-1:0;
    s.bullEngulf=pBear&&bull&&co<pc&&cc2>po?1:0; s.bearEngulf=pBull&&bear&&co>pc&&cc2<po?-1:0;
    s.bullHarami=pBear&&bull&&co>pl&&cc2<ph&&body<pBody*0.6?1:0; s.bearHarami=pBull&&bear&&co<ph&&cc2>pl&&body<pBody*0.6?-1:0;
    s.piercing=pBear&&bull&&co<pl&&cc2>(po+pc)/2?1:0; s.darkCloud=pBull&&bear&&co>ph&&cc2<(po+pc)/2?-1:0;
    s.bullMaru=bull&&uw<body*0.05&&lw<body*0.05?1:0; s.bearMaru=bear&&uw<body*0.05&&lw<body*0.05?-1:0;
    s.spinning=body/tr3<0.3&&uw>body&&lw>body?(cc2>pc?1:-1):0;
    s.bullPin=lw>tr3*0.6&&body<tr3*0.3?1:0; s.bearPin=uw>tr3*0.6&&body<tr3*0.3?-1:0;
    s.insideBar=ch<ph&&cl>pl?(cc2>pc?1:-1):0; s.outsideBar=ch>ph&&cl<pl?(cc2>pc?1:-1):0;
    s.mornStar=ppc>ppo&&Math.abs(pc-po)<Math.abs(ppc-ppo)*0.3&&bull&&cc2>(ppc+ppo)/2?1:0;
    s.evenStar=ppc<ppo&&Math.abs(pc-po)<Math.abs(ppc-ppo)*0.3&&bear&&cc2<(ppc+ppo)/2?-1:0;
    s.tweezBot=Math.abs(cl-pl)<tr3*0.05&&pBear&&bull?1:0; s.tweezTop=Math.abs(ch-ph)<tr3*0.05&&pBull&&bear?-1:0;
    // Patterns avancés
    const bd=body,pb=pBody,ppb=Math.abs(ppc-ppo)||0.0001;
    s.threeWS=pBull&&bull&&ppBull&&co>po&&cc2>pc&&bd>pb*0.7&&pb>ppb*0.7?1:0;
    s.threeBCs=!pBull&&!bull&&!ppBull&&co<po&&cc2<pc&&bd>pb*0.7&&pb>ppb*0.7?-1:0;
    s.beltHoldBull=bull&&Math.min(co,cc2)-cl<tr3*0.05&&cc2-co>tr3*0.7&&pBear?1:0;
    s.beltHoldBear=bear&&ch-Math.max(co,cc2)<tr3*0.05&&co-cc2>tr3*0.7&&pBull?-1:0;
    s.kickerBull=pBear&&bull&&co>ppo?1:0; s.kickerBear=ppBull&&bear&&co<ppo?-1:0;
  }else{['doji','hammer','shootStar','bullEngulf','bearEngulf','bullHarami','bearHarami','piercing','darkCloud','bullMaru','bearMaru','spinning','bullPin','bearPin','insideBar','outsideBar','mornStar','evenStar','tweezBot','tweezTop','threeWS','threeBCs','beltHoldBull','beltHoldBear','kickerBull','kickerBear'].forEach(k=>s[k]=0)}

  // Patterns prix
  const rH=h.slice(-20),rL=l.slice(-20);
  const maxH=Math.max(...rH),minL=Math.min(...rL);
  s.dblTop=rH.filter(x=>Math.abs(x-maxH)/maxH<0.003).length>=2&&price<maxH*0.995?-1:0;
  s.dblBot=rL.filter(x=>Math.abs(x-minL)/(minL||1)<0.003).length>=2&&price>minL*1.005?1:0;
  s.hhhl=n>=2&&h[n]>h[n-1]&&l[n]>l[n-1]?1:0; s.llhl=n>=2&&h[n]<h[n-1]&&l[n]<l[n-1]?-1:0;
  s.nearSup=price<Math.min(...l.slice(-30))*1.005?1:0; s.nearRes=price>Math.max(...h.slice(-30))*0.995?-1:0;
  if(n>=21){const rgH=Math.max(...h.slice(-21,-1)),rgL=Math.min(...l.slice(-21,-1));s.brkUp=price>rgH?1:0;s.brkDn=price<rgL?-1:0;}else{s.brkUp=0;s.brkDn=0}
  s.consolidation=(maxH-minL)/(minL||1)<0.005?1:0; s.atrHigh=atrV>atrFn(h,l,c,50)*1.3?1:0; s.atrLow=atrV<atrFn(h,l,c,50)*0.7?1:0;

  // Nouveaux signaux ULTRA
  if(n>=1){const haC=(o[n]+h[n]+l[n]+c[n])/4,haO=(o[n-1]+c[n-1])/2;s.heikenDir=haC>haO?1:-1;s.heikenStrong=haC>haO&&Math.min(haC,haO)>=l[n]?1:haC<haO&&Math.max(haC,haO)<=h[n]?-1:0;}else{s.heikenDir=0;s.heikenStrong=0}
  if(n>=34){const mp=[];for(let i=0;i<c.length;i++)mp.push((h[i]+l[i])/2);const s5=mp.slice(-5).reduce((a,b)=>a+b,0)/5,s34=mp.slice(-34).reduce((a,b)=>a+b,0)/34,ao=s5-s34,aop=n>=35?((mp.slice(-6,-1).reduce((a,b)=>a+b,0)/5)-(mp.slice(-35,-1).reduce((a,b)=>a+b,0)/34)):0;s.aoDir=ao>0?1:-1;s.aoMom=ao>aop?1:-1;s.aoZeroCross=ao>0&&aop<=0?1:ao<0&&aop>=0?-1:0;}else{s.aoDir=0;s.aoMom=0;s.aoZeroCross=0}
  if(n>=20){let cn=0,cd=0;for(let i=n-19;i<=n;i++){const rg=h[i]-l[i]||0.0001,mfm=((c[i]-l[i])-(h[i]-c[i]))/rg,vl=Math.abs(c[i]-c[i-1])*10000;cn+=mfm*vl;cd+=vl;}const cmfv=cd?cn/cd:0;s.cmfDir=cmfv>0?1:-1;s.cmfStrong=Math.abs(cmfv)>0.1?(cmfv>0?1:-1):0;}else{s.cmfDir=0;s.cmfStrong=0}
  {let adl=0;for(let i=1;i<c.length;i++){const rg=h[i]-l[i]||0.0001;adl+=((c[i]-l[i])-(h[i]-c[i]))/rg*Math.abs(c[i]-c[i-1])*10000;}s.adDir=adl>0?1:-1;}
  if(n>=10){const a10=atrFn(h,l,c,10);s.superUp=price>((h[n]+l[n])/2)-3*a10?1:0;s.superDn=price<((h[n]+l[n])/2)+3*a10?-1:0;}else{s.superUp=0;s.superDn=0}
  if(c.length>15){const jw=ema(c,13),te=ema(c,8),li=ema(c,5);const jl=jw[jw.length-1],tl=te[te.length-1],ll2=li[li.length-1];s.alligatorBull=ll2>tl&&tl>jl?1:ll2<tl&&tl<jl?-1:0;}else{s.alligatorBull=0}
  if(n>=20){const h10=Math.max(...h.slice(-10)),h20=Math.max(...h.slice(-20,-10)),l10=Math.min(...l.slice(-10)),l20=Math.min(...l.slice(-20,-10));s.triangleAsc=l10>l20&&Math.abs(h10-h20)/h20<0.003?1:0;s.triangleDes=h10<h20&&Math.abs(l10-l20)/(l20||1)<0.003?-1:0;s.wedgeUp=h10>h20&&l10>l20&&(h10-h20)<(l10-l20)*1.5?1:0;s.wedgeDn=h10<h20&&l10<l20&&(h20-h10)<(l20-l10)*1.5?-1:0;const sho=(h10-h20)/h20,sl2=(l10-l20)/(l20||1);s.channelUp=sho>0.002&&sl2>0.002&&Math.abs(sho-sl2)<0.005?1:0;s.channelDn=sho<-0.002&&sl2<-0.002&&Math.abs(sho-sl2)<0.005?-1:0;if(n>=50){const pm=h.slice(-40,-20),pl2=h.slice(-60,-40),pr=h.slice(-20);const pk=Math.max(...pm),pkl=Math.max(...pl2),pkr=Math.max(...pr);s.headShoulder=pk>pkl&&pk>pkr&&Math.abs(pkl-pkr)/pkl<0.05?-1:0;s.headShoulderInv=Math.min(...pm)<Math.min(...pl2)&&Math.min(...pm)<Math.min(...pr)?1:0;}else{s.headShoulder=0;s.headShoulderInv=0}}else{['triangleAsc','triangleDes','wedgeUp','wedgeDn','channelUp','channelDn','headShoulder','headShoulderInv'].forEach(k=>s[k]=0)}
  if(n>=15){const swH=Math.max(...h.slice(-15,-1)),swL=Math.min(...l.slice(-15,-1));s.smcBOS=price>swH?1:price<swL?-1:0;const ph2=Math.max(...h.slice(-15,-7)),pl2b=Math.min(...l.slice(-15,-7)),rh2=Math.max(...h.slice(-7,-1)),rl2=Math.min(...l.slice(-7,-1));s.smcCHoCH=(rh2<ph2&&rl2<pl2b)&&price>rh2?1:(rh2>ph2&&rl2>pl2b)&&price<rl2?-1:0;let ob1=0,ob2=0;for(let i=n-2;i>=Math.max(2,n-15);i--){if(!ob1&&c[i]<o[i]&&c[i+1]-c[i]>atrV*1.5){const zh=Math.max(o[i],c[i]),zl=Math.min(o[i],c[i]);if(price>=zl*0.999&&price<=zh*1.001)ob1=1;}if(!ob2&&c[i]>o[i]&&c[i]-c[i+1]>atrV*1.5){const zh=Math.max(o[i],c[i]),zl=Math.min(o[i],c[i]);if(price>=zl*0.999&&price<=zh*1.001)ob2=-1;}}s.smcOBBull=ob1;s.smcOBBear=ob2;}else{s.smcBOS=0;s.smcCHoCH=0;s.smcOBBull=0;s.smcOBBear=0}
  if(n>=3){s.smcFVGBull=h[n-2]<l[n]&&price>=h[n-2]&&price<=l[n]?1:0;s.smcFVGBear=l[n-2]>h[n]&&price<=l[n-2]&&price>=h[n]?-1:0;}else{s.smcFVGBull=0;s.smcFVGBear=0}
  if(c.length>20){const r3=rsiFn(c,3);let sk=0;for(let i=c.length-1;i>Math.max(0,c.length-15);i--){if(!sk)sk=c[i]>c[i-1]?1:-1;else if(sk>0&&c[i]>c[i-1])sk++;else if(sk<0&&c[i]<c[i-1])sk--;else break;}const cr=(r3+(sk>0?Math.min(sk*15,100):Math.max(sk*15,-100))+rsiFn(c,100))/3;s.connorsExt=cr<20?1:cr>80?-1:0;}else{s.connorsExt=0}
  if(n>=10){let nu=0,de=0;for(let i=Math.max(1,n-9);i<=n;i++){nu+=c[i]-o[i];de+=h[i]-l[i]||0.0001}s.rviDir=de?nu/de>0?1:-1:0;}else{s.rviDir=0}
  if(n>=1){const bd2=Math.abs(c[n]-o[n]),tr5=h[n]-l[n]||0.0001;s.strongBody=bd2/tr5>0.7?(c[n]>o[n]?1:-1):0;s.weakBody=bd2/tr5<0.25?(c[n]>c[n-1]?1:-1):0;}else{s.strongBody=0;s.weakBody=0}

  return { s, atrV, price };
}

// ─── SIMULATION ────────────────────────────────────────────────
function simT(dir, entry, tp, sl, fH, fL) {
  for (let i=0; i<fH.length; i++) {
    if (dir==='BUY') { if(fH[i]>=tp) return{r:'WIN',d:i+1}; if(fL[i]<=sl) return{r:'LOSS',d:i+1}; }
    else { if(fL[i]<=tp) return{r:'WIN',d:i+1}; if(fH[i]>=sl) return{r:'LOSS',d:i+1}; }
  }
  return null;
}

// ─── EVALCOMBO ────────────────────────────────────────────────
function evalCombo(snaps, names, dir, mode, minT) {
  const ANTI = 6;
  const sorted = [...snaps].sort((a,b) => a.snapIdx - b.snapIdx);
  const lastIdx = {};
  const trades = [];
  for (const snap of sorted) {
    const {s, atrV, price, isJPY, snapIdx, pair, date, fH, fL} = snap;
    if (lastIdx[pair] !== undefined && (snapIdx - lastIdx[pair]) < ANTI) continue;
    let aligned=0, counted=0;
    for (const nm of names) {
      const v = s[nm];
      if (v===undefined || v===0) continue;
      counted++;
      if (dir==='BUY' && v>0) aligned++;
      if (dir==='SELL' && v<0) aligned++;
    }
    if (counted < names.length) continue;
    const needed = mode==='ALL' ? names.length : Math.ceil(names.length * 0.65);
    if (aligned < needed) continue;
    const pipDiv = isJPY ? 0.01 : 0.0001;
    const slP = atrV*1.5, tpP = slP*1.5;
    const entry = price;
    const res = simT(dir, entry, dir==='BUY'?entry+tpP:entry-tpP, dir==='BUY'?entry-slP:entry+slP, fH, fL);
    if (!res) continue;
    const pips = res.r==='WIN' ? tpP/pipDiv : -slP/pipDiv;
    trades.push({pair, date, dir, result:res.r, pips:parseFloat(pips.toFixed(1)), duration:res.d});
    lastIdx[pair] = snapIdx + res.d;
  }
  if (trades.length < minT) return null;
  const wins = trades.filter(t=>t.result==='WIN').length;
  const wr = Math.round(wins/trades.length*100);
  const totalPips = parseFloat(trades.reduce((a,t)=>a+t.pips,0).toFixed(1));
  return {trades, wins, total:trades.length, wr, totalPips, avgPips:parseFloat((totalPips/trades.length).toFixed(1))};
}

// ─── RECHERCHE EXHAUSTIVE VRAIE ────────────────────────────────
async function runExhaustive(snaps, minT, minWR) {
  const allNames = Object.keys(snaps[0]?.s || {});
  const results = { buy: [], sell: [], startedAt: new Date().toISOString() };

  for (const dir of ['BUY', 'SELL']) {
    for (const mode of ['ALL', 'MAJ']) {
      const label = `${dir} ${mode}`;

      // Phase 1 : top 80
      jobStatus.phase = `${label} — Phase 1/4 : test individuel`;
      const singles = [];
      for (const nm of allNames) {
        const r = evalCombo(snaps, [nm], dir, mode, 1);
        if (r && r.wr >= 30) singles.push({nm, wr:r.wr, total:r.total});
      }
      singles.sort((a,b) => b.wr-a.wr || b.total-a.total);
      const pool = singles.slice(0,80).map(s=>s.nm);
      if (pool.length < 4) continue;

      // Phase 2 : toutes les paires
      jobStatus.phase = `${label} — Phase 2/4 : ${Math.floor(pool.length*(pool.length-1)/2).toLocaleString()} paires`;
      const best2 = [];
      for (let i=0; i<pool.length-1; i++) {
        for (let j=i+1; j<pool.length; j++) {
          const r = evalCombo(snaps, [pool[i],pool[j]], dir, mode, Math.max(3,minT-20));
          if (r && r.wr >= 42) best2.push({names:[pool[i],pool[j]], ...r});
        }
        if (i%10===0) await sleep(0);
      }
      best2.sort((a,b) => b.wr-a.wr || (b.total-a.total)*0.1);
      const top40 = best2.slice(0,40);

      // Phase 3 : tous les triplets parmi top 80
      const tot3 = Math.floor(pool.length*(pool.length-1)*(pool.length-2)/6);
      jobStatus.phase = `${label} — Phase 3/4 : ${tot3.toLocaleString()} triplets`;
      const best3 = []; let done3=0;
      for (let i=0; i<pool.length-2; i++) {
        for (let j=i+1; j<pool.length-1; j++) {
          for (let k=j+1; k<pool.length; k++) {
            const r = evalCombo(snaps, [pool[i],pool[j],pool[k]], dir, mode, Math.max(5,minT-15));
            if (r && r.wr >= Math.max(48, minWR-8)) {
              best3.push({names:[pool[i],pool[j],pool[k]], ...r});
              if (best3.length > 200) { best3.sort((a,b)=>b.wr-a.wr); best3.splice(200); }
            }
            done3++;
          }
        }
        if (i%5===0) {
          jobStatus.detail = `${Math.round(done3/tot3*100)}% — top: ${best3.length?best3[0].wr+'%':'—'}`;
          await sleep(0);
        }
      }
      best3.sort((a,b) => b.wr-a.wr || (b.total-a.total)*0.1);
      const top20t = best3.slice(0,20);

      // Phase 4 : TOUS les 4-uplets parmi top 80
      const tot4 = Math.floor(pool.length*(pool.length-1)*(pool.length-2)*(pool.length-3)/24);
      jobStatus.phase = `${label} — Phase 4/4 : ${tot4.toLocaleString()} 4-combos`;
      const best4 = []; let done4=0;
      for (let i=0; i<pool.length-3; i++) {
        for (let j=i+1; j<pool.length-2; j++) {
          for (let k=j+1; k<pool.length-1; k++) {
            for (let l2=k+1; l2<pool.length; l2++) {
              const r = evalCombo(snaps, [pool[i],pool[j],pool[k],pool[l2]], dir, mode, minT);
              if (r && r.wr >= minWR) {
                best4.push({names:[pool[i],pool[j],pool[k],pool[l2]], ...r});
                if (best4.length > 100) { best4.sort((a,b)=>b.wr-a.wr); best4.splice(100); }
              }
              done4++;
            }
          }
        }
        if (i%3===0) {
          jobStatus.detail = `${Math.round(done4/tot4*100)}% — top4: ${best4.length?best4[0].wr+'%':'—'}`;
          await sleep(0);
        }
      }
      best4.sort((a,b) => b.wr-a.wr || (b.total-a.total)*0.1);

      // Fusionner et enrichir les meilleurs
      const allBest = [...best4, ...top20t].sort((a,b)=>b.wr-a.wr);
      const top15 = allBest.slice(0,15);
      const enriched = [];
      for (const combo of top15) {
        let cur = {...combo};
        for (let step=0; step<1; step++) {
          let imp = false;
          for (const nm of allNames) {
            if (cur.names.includes(nm) || cur.names.length >= 5) continue;
            const r = evalCombo(snaps, [...cur.names,nm], dir, mode, minT);
            if (r && r.wr > cur.wr) { cur={names:[...cur.names,nm],...r}; imp=true; }
          }
          if (!imp) break;
        }
        if (cur.wr >= minWR) {
          // Walk-Forward
          const sorted2 = [...snaps].sort((a,b)=>a.snapIdx-b.snapIdx);
          const cut = Math.floor(sorted2.length*0.7);
          const rTrain = evalCombo(sorted2.slice(0,cut), cur.names, dir, mode, 1);
          const rTest  = evalCombo(sorted2.slice(cut),   cur.names, dir, mode, 1);
          enriched.push({
            ...cur, dir, mode,
            wfTrain: rTrain ? {wr:rTrain.wr, total:rTrain.total} : null,
            wfTest:  rTest  ? {wr:rTest.wr,  total:rTest.total}  : null,
          });
        }
      }
      enriched.sort((a,b) => b.wr-a.wr || (b.total-a.total)*0.1);
      const seen = new Set();
      const deduped = enriched.filter(r=>{const k=r.names.slice().sort().join('|');if(seen.has(k))return false;seen.add(k);return true;}).slice(0,5);
      if (dir==='BUY') results.buy.push(...deduped);
      else results.sell.push(...deduped);
    }
  }

  results.buy.sort((a,b)=>b.wr-a.wr); results.buy = results.buy.slice(0,5);
  results.sell.sort((a,b)=>b.wr-a.wr); results.sell = results.sell.slice(0,5);
  results.finishedAt = new Date().toISOString();
  return results;
}

// ─── FETCH DATA ────────────────────────────────────────────────
async function fetchData(apiKey, outputsize) {
  const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','NZD/USD','USD/CAD','EUR/GBP'];
  // EUR/JPY, GBP/JPY, EUR/CHF, AUD/JPY : indisponibles plan gratuit
  const snaps = [];
  for (const pair of PAIRS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${pair}&interval=4h&outputsize=${outputsize}&apikey=${apiKey}`, {signal: controller.signal});
      clearTimeout(timeout);
      const d = await r.json();
      if (!d.values || d.status==='error') { await sleep(600); continue; }
      const cv = d.values.reverse();
      const C=cv.map(c=>parseFloat(c.close)), H=cv.map(c=>parseFloat(c.high));
      const L=cv.map(c=>parseFloat(c.low)),   O=cv.map(c=>parseFloat(c.open));
      const isJPY = pair.includes('JPY');
      for (let i=215; i<C.length-2; i++) {
        const snap = computeAllSignals(C,H,L,O,i);
        if (!snap) continue;
        snap.pair=pair; snap.date=cv[i].datetime; snap.isJPY=isJPY;
        snap.snapIdx=i; snap.fH=H.slice(i+1); snap.fL=L.slice(i+1);
        snaps.push(snap);
      }
      await sleep(600);
    } catch(e) { console.error(pair, e.message); await sleep(300); }
  }
  return snaps;
}

// ─── EXPORTS ─────────────────────────────────────────────────
module.exports = {
  getStatus: () => ({ ...jobStatus, results: jobResults }),
  getResults: () => jobResults,
  start: async (apiKey, outputsize=2200, minT=80, minWR=55) => {
    if (jobStatus.running) return { error: 'Job déjà en cours' };
    jobStatus = { running:true, progress:0, phase:'Téléchargement des données...', detail:'', startedAt:new Date().toISOString(), finishedAt:null };
    jobResults = null;

    // Lancer en arrière-plan
    (async () => {
      try {
        console.log('🔬 Démarrage analyse exhaustive...');
        const snaps = await fetchData(apiKey, outputsize);
        console.log(`📊 ${snaps.length} snapshots calculés`);
        jobStatus.phase = 'Recherche exhaustive en cours...';
        const results = await runExhaustive(snaps, minT, minWR);
        jobResults = results;
        jobStatus.running = false;
        jobStatus.finishedAt = new Date().toISOString();
        jobStatus.phase = 'Terminé ✅';
        console.log('✅ Analyse terminée');
      } catch(e) {
        console.error('Erreur analyse:', e);
        jobStatus.running = false;
        jobStatus.phase = 'Erreur: ' + e.message;
      }
    })();

    return { started: true, message: 'Analyse démarrée — consultez /deep-results pour le suivi' };
  }
};
