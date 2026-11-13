/* GEO Observability in 3D: the system map extruded into three.js. The interaction model (orbit, flow, explode, top view,
   a guided loop and a breakdown under the map) is the one Organized AI uses for Deal Desk's How it works.
   Needs window.THREE (r128, vendored in /vendor). GSAP is optional and only used for UI motion. */
(function(){
'use strict';
const $=s=>document.querySelector(s);
const RM=matchMedia('(prefers-reduced-motion: reduce)').matches;
const FRAMED=(()=>{ try{ return window.self!==window.top; }catch(e){ return true; } })();
const S=1/20, CX=380, CY=168, DROP=-.3;            // map units -> world units; parts off the Cloudflare slab sit lower
const P=(x,y)=>[(x-CX)*S,(y-CY)*S];               // 2D map coords -> world x,z

// ---------- the system ----------
const ORDER=['prompts','scheduler','workflow','gateway','engines','judge','store','tap','insights','portal'];
const POS={prompts:[62,248],scheduler:[200,248],workflow:[380,262],gateway:[600,248],engines:[712,248],
  judge:[300,150],store:[470,150],tap:[62,76],insights:[600,76],portal:[240,76]};
const OFF=new Set(['prompts','engines','tap']);   // outside Cloudflare: on the bare ground
const EDGE_NODE='portal';                         // the part that lights up the edge plate
// from, to, label, 2D path, how far the 3D arc rises, dashed (return path)
const EDGES={
  daily:['prompts','scheduler','every day','M94,248 L172,248',0],
  runs:['scheduler','workflow','one run each','M228,252 C280,262 320,264 352,262',0],
  ask:['workflow','gateway','ask','M408,260 C470,256 530,252 572,248',.3],
  call:['gateway','engines','official API','M628,248 L684,248',0],
  answers:['engines','workflow','answers','M708,276 C640,318 470,318 392,290',.35,true],
  score:['workflow','judge','score','M370,236 L312,176',0],
  save:['judge','store','mentions, citations','M330,150 L442,150',0],
  traffic:['tap','store','visits, conversions','M92,84 C200,122 380,128 446,140',.8],
  learn:['store','insights','every morning','M492,136 L578,92',0],
  actions:['insights','portal','insights, actions','M572,76 L268,76',.3],
  reports:['store','portal','reports','M448,138 C380,124 300,108 262,98',.2]
};
const COMP={
  prompts:{n:'01',name:'Your prompts',group:'Inputs',tag:'what you want to be found for',role:'What you track',
    b:"The questions your buyers ask AI assistants, plus your brand, your competitors, the countries you sell in and how often to check. You write them once; the system asks them for you.",
    why:"Visibility only means something against the questions that matter to your market. The prompt list is that market, written down.",
    facts:['prompts and topics','your brand and competitors','countries','daily or weekly'],
    words:[['Prompt','A question someone might type into ChatGPT or Claude, like "best CRM for small agencies".'],['Competitor set','The brands you want to be compared with in every answer.']],
    tryit:['Open the demo workspace and look at Prompts: each one is tracked across every assistant.','Open the demo','../app/']},
  scheduler:{n:'02',name:'Scheduler and queue',group:'Cloudflare',tag:'turns the list into work',role:'Plans the pass',
    b:"Every morning a timer plans the pass: every prompt, on every assistant, in every country. Each combination becomes one run on a queue, and a live counter shows the pass filling up.",
    why:"Hundreds of small jobs are easier to run, retry and count than one big one. A queue lets them flow at a steady pace.",
    facts:['a timer each day','one run per combination','retries, then a dead-letter queue','live progress'],
    words:[['Queue','A waiting line for work. Jobs are picked up in order, and a failed one can be tried again.'],['Dead-letter queue','Where a job goes after it fails too many times, so it can be looked at instead of lost.']],
    tryit:['In the demo, open Setup and press Run now to watch a pass fill up live.','Open the demo','../app/']},
  workflow:{n:'03',name:'Run workflow',group:'Cloudflare Workflows',tag:'one prompt, one assistant, one day',role:'Does one run',
    b:"Each run is its own small workflow: check the workspace is active and within budget, ask the assistant, keep the raw answer, then score it. Every step is saved, so a hiccup retries one step instead of starting over.",
    why:"Assistants are slow and sometimes fail. Saving each step means one bad answer never costs a whole pass.",
    facts:['saved step by step','safe to retry','budget check first'],
    words:[['Workflow','A list of steps Cloudflare runs in order and remembers, even if something restarts in the middle.'],['Idempotent','Safe to run twice: doing it again gives the same result, not a duplicate.']],
    tryit:['In the demo, open Chats and pick any answer: it came from exactly one run.','Open the demo','../app/']},
  gateway:{n:'04',name:'AI Gateway',group:'Cloudflare',tag:'one door to every assistant',role:'Logs every call',
    b:"Every question to an assistant goes through Cloudflare AI Gateway. It records the cost, the time it took and who it was for, and can cap spending.",
    why:"One door means one place to see what tracking costs, spot a slow provider and prove what an answer was.",
    facts:['logs every call','cost and latency','spend limits','tagged by client and prompt'],
    words:[['AI Gateway',"Cloudflare's checkpoint for AI calls: logs, costs and limits in one place."],['Latency','How long an answer took to come back.']],
    tryit:['In the demo, open Usage to see what each assistant cost and how fast it answered.','Open the demo','../app/']},
  engines:{n:'05',name:'AI assistants',group:'Outside Cloudflare',tag:'ChatGPT, Claude, Gemini, Perplexity',role:'Where buyers ask',
    b:"The assistants your buyers use. Each is asked through its official API with web search on, so the answer looks like what a person would see, sources included.",
    why:"You can't improve what you can't see. Asking every assistant the same questions shows where you're named, and where a competitor is named instead.",
    facts:['ChatGPT','Claude','Gemini','Perplexity'],
    words:[['Official API','The supported way for software to ask a model a question. No screen scraping, no fake accounts.'],['Web search','The assistant looks things up before it answers, and lists the pages it used.']],
    tryit:['In the demo, filter the dashboard by assistant to compare how each one talks about the brand.','Open the demo','../app/']},
  judge:{n:'06',name:'Scoring',group:'Workers AI',tag:'who was named, where, and how',role:'Reads every answer',
    b:"Each answer is read twice. Exact matching finds which brands are named and in what order. A small AI judge on Cloudflare then reads the tone, spots new competitors and checks claims against the facts you set.",
    why:"Counts need to be stable from day to day, so the numbers come from matching. The judge adds what matching can't: tone and accuracy.",
    facts:['visibility','share of voice','position','sentiment','citations'],
    words:[['Share of voice','Your mentions out of all tracked brands’ mentions in the same answers.'],['Citation','A web page the assistant lists as a source for its answer.']],
    tryit:['In the demo, open any chat: the brands named are highlighted in order, with the sources underneath.','Open the demo','../app/']},
  store:{n:'07',name:'The store',group:'D1 · R2 · Analytics Engine',tag:'every answer, kept',role:'Remembers it all',
    b:"Scores and rollups go into a database, raw answers into object storage, and time series into Analytics Engine. Visits and conversions from your website land here too, joined to the pages the answers cite.",
    why:"Trends need history, and trust needs the original answer. Keeping both means every number can be traced back to the words behind it.",
    facts:['scores and rollups','raw answers','time series','one workspace per client'],
    words:[['D1',"Cloudflare's database. Here it holds the scores, the prompts and the workspaces."],['R2',"Cloudflare's file storage. Here it keeps every raw answer exactly as it came back."]],
    tryit:['In the demo, open Sources to see which pages assistants lean on, and which feed answers that skip you.','Open the demo','../app/']},
  tap:{n:'08',name:'Your website',group:'Outside Cloudflare',tag:'where answers send people',role:'What happens next',
    b:"A small edge tap on your site's Cloudflare zone, or a one-line script on any site, records AI crawlers and visits that come from an assistant. Conversions from your own tracking can be sent in too.",
    why:"Being named is the start. This shows whether assistants read your pages, send visitors and turn into revenue.",
    facts:['AI crawlers','AI-referred visits','server-side conversions','no log pipeline'],
    words:[['Crawler','A program that reads web pages, here the ones AI companies use to read your site.'],['Referral','A visit that arrives from a link, here a link inside an AI answer.']],
    tryit:['In the demo, open My website to see crawler hits, AI visits and conversions per page.','Open the demo','../app/']},
  insights:{n:'09',name:'Insights and actions',group:'Cloudflare Workflows',tag:'what to do about it',role:'Says what to do',
    b:"Each morning the night's results are compared with the past. What changed is written up in a few sentences, with the evidence, and turned into a short, ranked list of actions and content briefs.",
    why:"A dashboard tells you what happened. A ranked list tells you what to do first.",
    facts:['written from evidence','ranked actions','content briefs'],
    words:[['Insight','A plain sentence about a real change, like "Claude stopped citing your pricing page".'],['Brief','An outline for a page that would close a gap assistants show.']],
    tryit:['In the demo, open Actions to see the ranked list and a content brief.','Open the demo','../app/']},
  portal:{n:'10',name:'Portal, API and MCP',group:'Cloudflare edge',tag:'how you and your clients see it',role:'The front door',
    b:"One Worker serves everything people touch: the client portal, sign-in by email link, read-only share links, a REST API, and an MCP server so an AI assistant can read the results too.",
    why:"Agencies, clients and their own tools all need the same numbers. One front door keeps each workspace separate and every view consistent.",
    facts:['client portal','share links','REST API','MCP server'],
    words:[['Worker','A small program that runs on Cloudflare’s network, close to whoever is asking.'],['MCP','A standard way for AI assistants to use outside tools and data.']],
    tryit:['Open the demo workspace, or read how to connect the API and MCP in the docs.','Read the docs','../docs/']}
};
const TOUR=[
  {sel:'prompts',n:['prompts','scheduler'],e:['daily'],t:'Your prompts, brands and competitors are set; the timer starts a pass each day.'},
  {sel:'scheduler',n:['scheduler','workflow'],e:['runs'],t:'Every prompt × assistant × country becomes one run on the queue.'},
  {sel:'gateway',n:['workflow','gateway','engines'],e:['ask','call'],t:'The run asks each assistant through AI Gateway, which logs cost and time.'},
  {sel:'engines',n:['engines','workflow'],e:['answers'],t:'The answer comes back with its sources, and the raw text is kept.'},
  {sel:'judge',n:['workflow','judge'],e:['score'],t:'Scoring finds who is named, in what order, with which sources and tone.'},
  {sel:'store',n:['judge','store','tap'],e:['save','traffic'],t:'Results land in the store, next to crawler hits, AI visits and conversions from your site.'},
  {sel:'insights',n:['store','insights'],e:['learn'],t:'Each morning, what changed is written up and turned into ranked actions.'},
  {sel:'portal',n:['store','insights','portal'],e:['actions','reports'],t:'You and your clients see it in the portal, the API, or an assistant over MCP.'}
];
const IDLE='Prompts → queue → one run per assistant → AI Gateway → answers → scoring → the store → insights → the portal. Your website feeds the store from the side.';
// label: [long text, short text, x, y, anchor] in map coords; LABELS_P is the phone (portrait) placement
const LABELS={prompts:['Your prompts','Prompts',62,288],scheduler:['Scheduler','Queue',200,288],workflow:['Run workflow','Run',380,304],
  gateway:['AI Gateway','Gateway',586,288],engines:['AI assistants','Assistants',724,288],judge:['Scoring','Scoring',300,190],
  store:['The store','Store',470,190],tap:['Your website','Website',62,116],insights:['Insights','Insights',600,116],portal:['Portal · API · MCP','Portal',240,116]};
const LABELS_P={tap:[62,36,'start'],portal:[240,36,'start'],insights:[600,36,'start'],judge:[300,190,'end'],store:[470,190,'end'],
  prompts:[62,288,'end'],scheduler:[200,288,'end'],workflow:[380,304,'end'],gateway:[600,288,'end'],engines:[712,288,'end']};
const GLABELS={base:['Cloudflare',389,334,'middle',400,336,'rot'],edge:['Your Worker',330,44,'middle',330,20,'rot']};
// ---------- page ----------
const stage=$('.d3-stage'), labelsEl=$('.d3-labels'), cap=$('.d3-cap'), capB=cap.querySelector('b'), capTxt=cap.querySelector('.txt'),
  frameEl=$('.d3-frame'), sheet=$('.d3-sheet'), pickEl=$('.d3-pick'), navEl=$('.d3-nav'), bar=$('.d3-bar'), tip=$('.d3-tip');
const btn=a=>bar.querySelector(`[data-a="${a}"]`);
const narrowMQ=matchMedia('(max-width:760px)');
const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const anim=t=>window.gsap&&!RM?t():null;
let selected='prompts', selLayer=-1, focus=null, hover=null, exploded=false, gl=null;
const nameOf=id=>COMP[id].name;
if(matchMedia('(pointer:coarse)').matches) tip.textContent='Swipe sideways to orbit · two fingers to zoom and tilt · tap any part or its name';

const shortOf=id=>LABELS[id]?LABELS[id][1]:COMP[id].name;
function goLink(label,href){ return `<a class="d3-go" href="${esc(href)}" target="_top">${esc(label)} →</a>`; }
// The breakdown is its own section under the map: what the part is, why it's there, how to try it, what it talks to.
function renderDetail(){
  const C0=COMP[selected], i=ORDER.indexOf(selected);
  const prev=ORDER[(i-1+ORDER.length)%ORDER.length], next=ORDER[(i+1)%ORDER.length];
  const conn=Object.entries(EDGES).filter(([,v])=>v[0]===selected||v[1]===selected);
  const [text,label,href]=C0.tryit;
  sheet.innerHTML=`<div class="sh-top">
      <div><div class="sh-cap">// component breakdown</div>
        <div class="sh-title"><span class="sh-num" aria-hidden="true">${C0.n}</span><h2>${esc(C0.name)}</h2></div>
        <div class="sh-sub">${esc(C0.group)} · ${esc(C0.tag)}</div></div>
      <div class="sh-acts">
        <button type="button" class="d3-ghost" data-n="${prev}" aria-label="Previous part: ${esc(nameOf(prev))}">‹ ${esc(shortOf(prev))}</button>
        <button type="button" class="d3-ghost" data-n="${next}" aria-label="Next part: ${esc(nameOf(next))}">${esc(shortOf(next))} ›</button>
        <button type="button" class="d3-ghost" data-go="map">Back to the map ↑</button>
      </div></div>
    <div class="sh-grid">
      <div class="sh-col sh-main">
        <h4>What it is</h4><p class="sh-lede">${esc(C0.b)}</p>
        <h4>Why it's here</h4><p class="sh-why">${esc(C0.why)}</p>
      </div>
      <div class="sh-col">
        <div class="d3-try"><h4>Try it</h4><p>${esc(text)}</p>${goLink(label,href)}</div>
        <h4>At a glance</h4><div class="d3-chips"><span class="acc">${esc(C0.group)}</span>${C0.facts.map(c=>`<span>${esc(c)}</span>`).join('')}</div>
      </div>
      <div class="sh-col">
        <h4>Connects to</h4><div class="sh-links">${conn.map(([,v])=>{ const out=v[0]===selected, o=out?v[1]:v[0];
          return `<button type="button" data-n="${o}" aria-label="${out?'Sends to':'Comes from'} ${esc(nameOf(o))}: ${esc(v[2])}"><span class="dir" aria-hidden="true">${out?'→':'←'}</span><b>${esc(nameOf(o))}</b><small>${out?'Out':'In'}: ${esc(v[2])}</small></button>`; }).join('')}</div>
        <h4>Words to know</h4><dl class="d3-words">${C0.words.map(([w,d])=>`<dt>${esc(w)}</dt><dd>${esc(d)}</dd>`).join('')}</dl>
      </div>
    </div>
    <nav class="sh-index" aria-label="All ten parts">${ORDER.map(id=>`<button type="button" data-n="${id}" aria-current="${id===selected}"><i>${COMP[id].n}</i>${esc(COMP[id].name)}</button>`).join('')}</nav>`;
}
// The chip on the map says what's selected and leads down to its breakdown.
function renderPick(){
  const C0=COMP[selected];
  pickEl.innerHTML=`<span class="pn" aria-hidden="true">${C0.n}</span><span class="pt"><b>${esc(C0.name)}</b><span>${esc(C0.role)} · ${esc(C0.group)}</span></span><button type="button" class="d3-go" data-go="sheet">Read the breakdown ↓</button>`;
}
function renderNav(){
  if(!navEl.children.length){
    navEl.innerHTML=ORDER.map(id=>{ const C0=COMP[id]; return `<button type="button" class="d3-tab" role="tab" data-n="${id}" aria-selected="false" tabindex="-1"><div class="ti">Component ${C0.n}</div><div class="tn">${esc(C0.name)}</div><div class="tr">${esc(C0.role)}</div></button>`; }).join('');
  }
  navEl.querySelectorAll('.d3-tab').forEach(b=>{ const on=b.dataset.n===selected; b.setAttribute('aria-selected',on); b.tabIndex=on?0:-1; });
  const a=navEl.querySelector('[aria-selected="true"]');
  if(a){ const left=a.offsetLeft-navEl.clientWidth/2+a.offsetWidth/2; try{ navEl.scrollTo({left,behavior:RM?'auto':'smooth'}); }catch(e){ navEl.scrollLeft=left; } }
}
// Embedded, the page grows to its full height and the parent page does the scrolling, so ask the parent to scroll.
function scrollToEl(el){
  if(FRAMED){ try{ window.parent.postMessage({type:'dd:scroll',y:Math.max(0,el.getBoundingClientRect().top+window.scrollY-6)},'*'); }catch(e){} }
  else el.scrollIntoView({behavior:RM?'auto':'smooth',block:'start'});
}
function select(id,keep){
  if(!COMP[id]) return;
  if(!keep){ stopTour(); if(!FRAMED){ try{ history.replaceState(null,'','#'+id); }catch(e){} } }
  selected=id;
  renderDetail(); renderPick(); renderNav();
  if(gl) gl.applyFocus();
  requestAnimationFrame(layoutHud);
  anim(()=>{ gsap.fromTo(sheet.querySelectorAll('.sh-top,.sh-col,.sh-index'),{opacity:0,y:8},{opacity:1,y:0,duration:.32,stagger:.04,ease:'power2.out',overwrite:true});
    gsap.fromTo(pickEl,{opacity:.5},{opacity:1,duration:.3,overwrite:true}); });
}
function setExploded(v){ exploded=v; btn('explode').setAttribute('aria-pressed',v); }
function setCap(label,text,touring){
  capB.textContent=label; capTxt.textContent=text; cap.classList.toggle('touring',!!touring);
  anim(()=>gsap.fromTo(capTxt,{opacity:0,x:6},{opacity:1,x:0,duration:.3,ease:'power2.out',overwrite:true}));
}


function onPanelClick(e){ const b=e.target.closest('button,a'); if(!b) return;
  if(b.dataset.n){ setExploded(false); select(b.dataset.n); if(b.closest('.d3-sheet')) scrollToEl(sheet); }
  else if(b.dataset.tab){ try{ window.parent.postMessage({type:'dd:tab',tab:b.dataset.tab},'*'); }catch(err){} }
  else if(b.dataset.go==='sheet') scrollToEl(sheet);
  else if(b.dataset.go==='map') scrollToEl(stage); }
sheet.addEventListener('click',onPanelClick);
pickEl.addEventListener('click',onPanelClick);
navEl.addEventListener('click',e=>{ const b=e.target.closest('.d3-tab'); if(b){ setExploded(false); select(b.dataset.n); } });
navEl.addEventListener('keydown',e=>{
  const i=ORDER.indexOf(selected); let j=null;
  if(e.key==='ArrowRight'||e.key==='ArrowDown') j=(i+1)%ORDER.length;
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp') j=(i-1+ORDER.length)%ORDER.length;
  else if(e.key==='Home') j=0; else if(e.key==='End') j=ORDER.length-1;
  if(j===null) return;
  e.preventDefault(); setExploded(false); select(ORDER[j]); const a=navEl.querySelector('[aria-selected="true"]'); if(a) a.focus({preventScroll:true});
});

// ---------- tour ----------
let tourI=-1, tourTimer=null;
function step(i){
  tourI=(i+TOUR.length)%TOUR.length; const s=TOUR[tourI];
  focus=s; select(s.sel,true);
  setCap(`Step ${tourI+1} / ${TOUR.length}`,s.t,true);
  clearTimeout(tourTimer); tourTimer=setTimeout(()=>step(tourI+1),RM?6500:4800);
}
function startTour(){ setExploded(false); btn('tour').setAttribute('aria-pressed','true'); btn('tour').textContent='Stop'; step(0); }
function stopTour(){ if(tourI<0) return; clearTimeout(tourTimer); tourI=-1; focus=null; if(gl) gl.applyFocus();
  btn('tour').setAttribute('aria-pressed','false'); btn('tour').textContent='Run the loop'; setCap('Loop',IDLE,false); }
cap.addEventListener('click',e=>{ const b=e.target.closest('[data-s]'); if(b&&tourI>=0) step(tourI+(+b.dataset.s)); });

// ---------- controls ----------
let flow=!RM, spin=!RM;
function layoutHud(){ if(gl) gl.layout(); }
bar.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; const a=b.dataset.a;
  if(a==='tour') tourI<0?startTour():stopTour();
  if(a==='flow'){ flow=!flow; b.setAttribute('aria-pressed',flow); }
  if(a==='spin'){ spin=!spin; b.setAttribute('aria-pressed',spin); }
  if(a==='explode') setExploded(!exploded);
  if(gl) gl.control(a,b);
});

// ---------- 3D ----------
function initGL(){
  const T=window.THREE; if(!T) throw new Error('three.js did not load');
  const css=()=>{ const c=getComputedStyle(document.documentElement); const g=(k,d)=>c.getPropertyValue(k).trim()||d;
    return {panel:g('--panel','#141412'),mute:g('--mute','#9b978a'),line:g('--line','#2a2822'),ink:g('--ink','#f4f2ea'),hl:g('--hl','#F5D528'),brand:g('--brand','#F5D528'),pulse:g('--pulse','#b9f0c8'),bad:g('--bad','#f27c7c')}; };
  let C=css();
  const col=h=>new T.Color(h);

  let W=stage.clientWidth||800, H=stage.clientHeight||500;
  const renderer=new T.WebGLRenderer({antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2)); renderer.setSize(W,H);
  stage.insertBefore(renderer.domElement,labelsEl);
  const camera=new T.OrthographicCamera(-1,1,1,-1,.1,300);
  const scene=new T.Scene();
  scene.add(new T.AmbientLight(0xffffff,.75));
  const sun=new T.DirectionalLight(0xffffff,.55); sun.position.set(-8,20,14); scene.add(sun);
  const root=new T.Group(); scene.add(root);

  // A portrait stage (phones) turns the map a quarter turn so the inputs sit at the top and Jev at the bottom.
  let portrait=W/H<.9;
  const HOME_L={yaw:-.32,pitch:.78}, HOME_P={yaw:Math.PI/2-.14,pitch:1}, home=()=>portrait?HOME_P:HOME_L, PMIN=.34, PMAX=1.5;
  const Z0=()=>portrait?1:W<640?1.05:.92;   // the map has the full stage width now, so it starts a little further out
  let yaw=home().yaw, pitch=home().pitch, tYaw=yaw, tPitch=pitch, zoom=Z0(), tZoom=zoom;
  // cs scales the map, fc is where its centre sits (fraction of the stage width), vs lifts it above the strip
  let HW=20, HH=10, cs=1, tCs=1, fc=.5, tFc=.5, vs=0, tVs=0, HWa=20.5, HWp=10.6, fitAll=0;
  function frustum(){ const z=zoom*cs, shift=(1-2*fc)*HW/z, lift=vs*HH/z; camera.left=-HW+shift; camera.right=HW+shift; camera.top=HH-lift; camera.bottom=-HH-lift; camera.zoom=z; camera.updateProjectionMatrix(); }
  // The map has the stage to itself now (the breakdown lives under it), so it only lifts clear of the strip of parts.
  function layout(){ W=stage.clientWidth||W; H=stage.clientHeight||H; const wide=!narrowMQ.matches;
    tCs=1; tFc=.5; tVs = wide ? (navEl.offsetHeight+16)/H : 0; }
  function fit(){ const aspect=W/H; HWa=Math.max(20.5,9.6*aspect); HWp=Math.max(10.6,18*aspect); applyFit(); }
  function applyFit(){ HW=portrait?HWp+(HWa-HWp)*fitAll:HWa; HH=HW/(W/H); frustum(); }
  function place(){ const r=60, cp=Math.cos(pitch); camera.position.set(Math.sin(yaw)*cp*r,Math.sin(pitch)*r,Math.cos(yaw)*cp*r); camera.lookAt(0,.4,0); }
  fit(); place();

  // ---------- materials (recoloured on theme change) ----------
  const M={solid:[],outline:[],ln:[],ac:[],faint:[],hot:[],pulse:[],bad:[],edge:[],dash:[],pk:[],slab:[],slabLine:[]};
  const solidMat=()=>{ const m=new T.MeshLambertMaterial({color:col(C.panel),transparent:true,opacity:.96}); M.solid.push(m); return m; };
  const outMat=()=>{ const m=new T.LineBasicMaterial({color:col(C.mute),transparent:true}); M.outline.push(m); return m; };
  const nodes={}, clickable=[], movers=[], anims=[];
  function node(id){ if(!nodes[id]){ const g=new T.Group(); g.userData.id=id; root.add(g); nodes[id]={g,outs:[],lns:[],acs:[],solids:[]}; } return nodes[id]; }
  function mat(kind,id){ let m;
    if(kind==='hot'){ m=new T.MeshBasicMaterial({color:col(C.hl)}); M.hot.push(m); }
    else if(kind==='faint'){ m=new T.MeshBasicMaterial({color:col(C.line)}); M.faint.push(m); }
    else if(kind==='pulse'){ m=new T.MeshBasicMaterial({color:col(C.pulse),transparent:true,opacity:.9}); M.pulse.push(m); }
    else if(kind==='bad'){ m=new T.MeshBasicMaterial({color:col(C.bad)}); M.bad.push(m); }
    else if(kind==='ln'){ m=new T.MeshBasicMaterial({color:col(C.mute)}); M.ln.push(m); nodes[id].lns.push(m); }
    else { m=new T.MeshBasicMaterial({color:col(C.mute)}); M.ac.push(m); nodes[id].acs.push(m); }
    return m; }
  // a solid part with a line-art outline
  function part(id,geo,x,y,z,rot,parent){
    const n=node(id), s=solidMat(), o=outMat();
    const mesh=new T.Mesh(geo,s); mesh.position.set(x,y,z); if(rot) mesh.rotation.set(rot[0]||0,rot[1]||0,rot[2]||0);
    mesh.userData.id=id; (parent||n.g).add(mesh); clickable.push(mesh); n.solids.push(s);
    const e=new T.LineSegments(new T.EdgesGeometry(geo,28),o); e.position.copy(mesh.position); e.rotation.copy(mesh.rotation); (parent||n.g).add(e); n.outs.push(o); mesh.userData.edge=e;
    return mesh; }
  function mesh(id,geo,kind,parent,x,y,z,rot){ const m=new T.Mesh(geo,mat(kind,id)); m.position.set(x||0,y||0,z||0); if(rot) m.rotation.set(rot[0]||0,rot[1]||0,rot[2]||0); m.userData.id=id; (parent||nodes[id].g).add(m); clickable.push(m); return m; }
  function stroke(id,pts,r,parent){ const curve=new T.CatmullRomCurve3(pts.map(p=>new T.Vector3(...p)),false,'catmullrom',0);
    return mesh(id,new T.TubeGeometry(curve,Math.max(8,pts.length*6),r||.03,6,false),'ln',parent); }
  function dot(id,x,y,z,r,kind,parent){ return mesh(id,new T.SphereGeometry(r,16,12),kind||'ac',parent,x,y,z); }
  // a layer group: explode moves it by `off`; picking its layer card pulls it out further
  function lg(id,layer,pos,off,parent){ const g=new T.Group(); g.position.set(...(pos||[0,0,0])); (parent||nodes[id].g).add(g);
    movers.push({o:g,id,layer,home:g.position.clone(),off:new T.Vector3(...(off||[0,0,0]))}); return g; }
  function comp(id){ const n=node(id), [x,z]=P(...POS[id]); n.g.position.set(x,OFF.has(id)?DROP:0,z); return n.g; }
  const extrude=(shape,depth)=>new T.ExtrudeGeometry(shape,{depth,bevelEnabled:false,curveSegments:32});
  function flat(shape,h){ const g=extrude(shape,h); g.rotateX(Math.PI/2); g.translate(0,h,0); return g; }   // plan shape lying on the ground, top at y=h
  function rr(w,d,r){ const x=-w/2,z=-d/2,s=new T.Shape(); s.moveTo(x+r,z); s.lineTo(x+w-r,z); s.quadraticCurveTo(x+w,z,x+w,z+r); s.lineTo(x+w,z+d-r); s.quadraticCurveTo(x+w,z+d,x+w-r,z+d); s.lineTo(x+r,z+d); s.quadraticCurveTo(x,z+d,x,z+d-r); s.lineTo(x,z+r); s.quadraticCurveTo(x,z,x+r,z); return s; }
  const poly=(pts,k=S)=>{ const s=new T.Shape(); pts.forEach(([a,b],i)=>i?s.lineTo(a*k,b*k):s.moveTo(a*k,b*k)); s.closePath(); return s; };

  // ---------- ground: grid, the Cloudflare slab, the edge plate ----------
  // white vertex colours, tinted by the material colour, so a theme change can recolour the grid
  const grid=new T.GridHelper(52,52,0xffffff,0xffffff); grid.material.color.set(C.line); grid.position.set(0,DROP-.01,0); grid.material.transparent=true; grid.material.opacity=.35; root.add(grid);
  { const [x,z]=P(390,166); const geo=flat(rr(524*S,304*S,.5),.26); geo.translate(0,-.27,0);
    const sm=new T.MeshLambertMaterial({color:col(C.panel)}); M.slab.push(sm); const m=new T.Mesh(geo,sm); m.position.set(x,0,z); root.add(m);
    const lm=new T.LineBasicMaterial({color:col(C.line)}); M.slabLine.push(lm); const e=new T.LineSegments(new T.EdgesGeometry(geo,28),lm); e.position.copy(m.position); root.add(e); }
  const plate={};
  { const pts=[[138,166],[160,30],[505,30],[527,166],[505,304],[160,304]].map(([x,y])=>P(x,y));
    const sh=new T.Shape(); pts.forEach(([x,z],i)=>i?sh.lineTo(x,z):sh.moveTo(x,z)); sh.closePath();
    const geo=flat(sh,.05);
    plate.fill=new T.MeshBasicMaterial({color:col(C.brand),transparent:true,opacity:.03,depthWrite:false}); root.add(new T.Mesh(geo,plate.fill));
    plate.line=new T.LineBasicMaterial({color:col(C.line)}); root.add(new T.LineSegments(new T.EdgesGeometry(geo,28),plate.line)); }

  // ---------- the ten parts ----------
  // 01 Your prompts: a tray (topics), a stack of prompt cards with text lines, and a clock (the schedule)
  { comp('prompts');
    const tray=lg('prompts',2,[0,0,0],[0,-.35,0]); part('prompts',flat(rr(56*S,42*S,.16),.16),0,0,0,null,tray);
    for(let i=0;i<3;i++){ const c=lg('prompts',0,[(i-1)*.07,.16+i*.11,(1-i)*.05],[0,.25+i*.32,0]); c.rotation.y=(i-1)*.1;
      part('prompts',flat(rr(44*S,30*S,.08),.06),0,0,0,null,c);
      if(i===2) [[-.32,.6],[-.08,.3],[.16,.5]].forEach(([dz,x1])=>stroke('prompts',[[-.75,.075,dz],[x1,.075,dz]],.025,c)); }
    const clk=lg('prompts',1,[.75,1.15,-.35],[0,.6,0]); const face=new T.Group(); face.rotation.x=-.5; clk.add(face);
    part('prompts',new T.CylinderGeometry(.32,.32,.08,32),0,0,0,[Math.PI/2,0,0],face);
    const hand=new T.Group(); hand.position.z=.05; face.add(hand); mesh('prompts',new T.BoxGeometry(.04,.22,.03),'hot',hand,0,.1,0);
    anims.push(t=>{ hand.rotation.z=-t*1.2; }); }
  // 02 Scheduler and queue: a conveyor (the queue) carrying run cards, and a progress bar filling above it
  { comp('scheduler');
    const belt=lg('scheduler',0,[0,0,0],[0,-.3,0]); part('scheduler',flat(rr(58*S,26*S,.14),.18),0,0,0,null,belt);
    [-.3,.3].forEach(dz=>stroke('scheduler',[[-1.35,.19,dz],[1.35,.19,dz]],.018,belt));
    const cards=lg('scheduler',1,[0,.2,0],[0,.45,0]); const boxes=[];
    for(let i=0;i<4;i++){ const g=new T.Group(); cards.add(g); part('scheduler',new T.BoxGeometry(.38,.22,.5),0,.11,0,null,g); boxes.push(g); }
    anims.push(t=>boxes.forEach((g,i)=>{ const u=((t*.18+i/4)%1); g.position.x=-1.15+u*2.3; g.scale.setScalar(Math.min(1,Math.min(u,1-u)*9)); }));
    const bar=lg('scheduler',2,[0,1.1,-.45],[0,.6,0]);
    part('scheduler',new T.BoxGeometry(2.2,.2,.14),0,0,0,null,bar);
    const fill=mesh('scheduler',new T.BoxGeometry(1,.12,.16),'hot',bar,0,0,.02); fill.geometry.translate(.5,0,0); fill.position.x=-1.05;
    anims.push(t=>{ fill.scale.x=.05+((t*.12)%1)*2.05; }); }
  // 03 Run workflow: four steps rising (check, ask, keep, score) and a marker climbing them
  { comp('workflow');
    const base=lg('workflow',-1,[0,0,0],[0,-.35,0]); part('workflow',flat(rr(62*S,36*S,.16),.16),0,0,0,null,base);
    const steps=lg('workflow',0,[0,.16,0],[0,.45,0]);
    [0,1,2,3].forEach(i=>{ const h=.18+i*.22; const g=new T.BoxGeometry(.6,h,.9); g.translate(0,h/2,0); part('workflow',g,-1.0+i*.66,0,0,null,steps); });
    const mk=lg('workflow',1,[0,.16,0],[0,.8,0]); const m=dot('workflow',0,0,0,.13,'hot',mk);
    anims.push(t=>{ const u=(t*.25)%1, i=Math.min(3,Math.floor(u*4)); m.position.set(-1.0+i*.66+(u*4-i-.5)*.5,.18+i*.22+.16,0); }); }
  // 04 AI Gateway: an arch on a base with log lines, and a coin turning above it (cost)
  { comp('gateway');
    const base=lg('gateway',2,[0,0,0],[0,-.35,0]); part('gateway',flat(rr(54*S,40*S,.16),.22),0,0,0,null,base);
    [-.5,0,.5].forEach(dz=>stroke('gateway',[[-1.05,.235,dz],[1.05,.235,dz]],.022,base));
    const arch=lg('gateway',1,[0,.22,-.25],[0,.55,0]);
    const a=new T.Shape(); a.moveTo(-17*S,0); a.lineTo(-17*S,14*S); a.absarc(0,14*S,17*S,Math.PI,0,true); a.lineTo(17*S,0); a.lineTo(10*S,0); a.lineTo(10*S,14*S); a.absarc(0,14*S,10*S,0,Math.PI,false); a.lineTo(-10*S,0); a.closePath();
    const ag=extrude(a,.32); ag.translate(0,0,-.16); part('gateway',ag,0,0,0,null,arch);
    const coin=lg('gateway',0,[0,1.95,-.25],[0,.6,.4]); const cs=new T.Group(); coin.add(cs);
    part('gateway',new T.CylinderGeometry(.24,.24,.06,32),0,0,0,[Math.PI/2,0,0],cs);
    anims.push(t=>{ cs.rotation.y=t*1.1; }); }
  // 05 AI assistants: four different shapes on a plinth, one per assistant, each breathing
  { comp('engines');
    const base=lg('engines',-1,[0,0,0],[0,-.35,0]); part('engines',flat(rr(40*S,52*S,.16),.2),0,0,0,null,base);
    const shapes=[new T.BoxGeometry(.42,.42,.42),new T.CylinderGeometry(.23,.23,.46,28),new T.IcosahedronGeometry(.27,0),new T.OctahedronGeometry(.3,0)];
    const spots=[[-.45,-.58],[.45,-.58],[-.45,.58],[.45,.58]];
    shapes.forEach((g,i)=>{ const l=lg('engines',Math.min(i,2),[spots[i][0],.6,spots[i][1]],[0,.35+i*.15,0]); const s=new T.Group(); l.add(s);
      part('engines',g,0,0,0,null,s); anims.push(t=>{ s.position.y=Math.sin(t*1.3+i*1.6)*.1; s.rotation.y=t*.4+i; }); }); }
  // 06 Scoring: a balance (the judge) whose beam tips, over a base of highlighted lines (mentions in order)
  { comp('judge');
    const base=lg('judge',2,[0,0,0],[0,-.35,0]); part('judge',flat(rr(54*S,36*S,.16),.2),0,0,0,null,base);
    [[-.45,.9],[-.05,.4],[.35,.7]].forEach(([dz,len])=>{ stroke('judge',[[-1.1,.215,dz],[-1.1+len*2,.215,dz]],.022,base); });
    dot('judge',-1.1,.25,-.45,.07,'hot',base);
    const post=lg('judge',0,[0,.2,0],[0,.3,0]); part('judge',new T.CylinderGeometry(.06,.1,1.3,16),0,.65,0,null,post);
    const beam=lg('judge',1,[0,1.42,0],[0,.6,0]); const b=new T.Group(); beam.add(b);
    part('judge',new T.BoxGeometry(2.1,.07,.1),0,0,0,null,b);
    [-1,1].forEach(sg=>{ const pan=new T.Group(); pan.position.x=sg*.98; b.add(pan); stroke('judge',[[0,0,0],[0,-.42,0]],.015,pan);
      part('judge',new T.CylinderGeometry(.28,.2,.06,24),0,-.45,0,null,pan); anims.push(()=>{ pan.rotation.z=-b.rotation.z; }); });
    anims.push(t=>{ b.rotation.z=Math.sin(t*.8)*.16; }); }
  // 07 The store: database drums (scores), a box of answers (raw text) and a small time series
  { comp('store'); const R=17*S;
    for(let i=0;i<3;i++){ const d=lg('store',0,[-.55,.15+i*.34,0],[0,.15+i*.3,0]); part('store',new T.CylinderGeometry(R,R,.28,40),0,0,0,null,d); }
    const bucket=lg('store',1,[.75,0,-.35],[.4,.5,0]); part('store',new T.BoxGeometry(.8,.62,.8),0,.31,0,null,bucket);
    part('store',new T.BoxGeometry(.86,.06,.86),0,.65,0,null,bucket);
    const ts=lg('store',2,[.75,0,.6],[.4,.45,.3]); const cols=[];
    for(let k=0;k<5;k++){ const g=new T.BoxGeometry(.12,1,.12); g.translate(0,.5,0); cols.push(part('store',g,-.32+k*.16,0,0,null,ts)); }
    const setCols=t=>cols.forEach((m,k)=>{ const h=.15+.55*(.5+.5*Math.sin(t*.9+k*.9)); m.scale.y=h; m.userData.edge.scale.y=h; });
    setCols(0); anims.push(setCols); }
  // 08 Your website: a browser window, an antenna sending pulses (the edge tap), and a cart (conversions)
  { comp('tap');
    const win=lg('tap',0,[0,0,0],[0,.3,0]); const sc=new T.Group(); sc.rotation.x=-.18; win.add(sc);
    part('tap',new T.BoxGeometry(46*S,30*S,.1),0,15*S,0,null,sc); stroke('tap',[[-1.05,1.25,.06],[1.05,1.25,.06]],.02,sc);
    [-.98,-.86,-.74].forEach(x=>dot('tap',x,1.36,.06,.035,'ac',sc));
    [[.9,1.2],[.65,.7],[.4,.95]].forEach(([y,len])=>stroke('tap',[[-.9,y,.06],[-.9+len,y,.06]],.022,sc));
    const ant=lg('tap',1,[.85,0,.75],[.3,.5,.3]); part('tap',new T.CylinderGeometry(.03,.05,.9,10),0,.45,0,null,ant); dot('tap',0,.95,0,.08,'hot',ant);
    const rings=[0,1].map(i=>{ const r=mesh('tap',new T.TorusGeometry(.2,.015,6,40),'pulse',ant,0,.95,0,[Math.PI/2,0,0]); return r; });
    anims.push(t=>rings.forEach((r,i)=>{ const u=(t*.5+i*.5)%1; r.scale.setScalar(1+u*2.4); r.material.opacity=.9*(1-u); }));
    const cart=lg('tap',2,[-.9,0,.75],[-.3,.5,.3]); part('tap',new T.BoxGeometry(.5,.28,.34),0,.3,0,null,cart);
    [-.17,.17].forEach(x=>mesh('tap',new T.TorusGeometry(.07,.025,6,16),'ac',cart,x,.08,.18)); }
  // 09 Insights and actions: a rising line over bars (what changed) and a stack of ranked action cards
  { comp('insights');
    const base=lg('insights',-1,[0,0,0],[0,-.35,0]); part('insights',flat(rr(56*S,38*S,.16),.18),0,0,0,null,base);
    const chart=lg('insights',0,[-.45,.18,0],[0,.45,0]);
    [.25,.45,.35,.7].forEach((h,k)=>{ const g=new T.BoxGeometry(.2,h,.2); g.translate(0,h/2,0); part('insights',g,-.42+k*.28,0,0,null,chart); });
    stroke('insights',[[-.42,.42,.15],[-.14,.62,.15],[.14,.55,.15],[.42,.98,.15]],.025,chart);
    const cards=lg('insights',1,[.75,.18,0],[0,.6,.3]);
    [.62,.5,.38].forEach((w,k)=>{ part('insights',flat(rr(w*1.5,.36,.05),.06),0,k*.12,0,null,cards); if(k===2) dot('insights',-w*.6,k*.12+.1,0,.06,'hot',cards); });
    const spark=lg('insights',2,[.75,1.05,0],[0,.6,0]); const ss=new T.Group(); spark.add(ss);
    const st=new T.Shape(); for(let i=0;i<8;i++){ const a=i*Math.PI/4+Math.PI/2, r=i%2?.07:.24; i?st.lineTo(Math.cos(a)*r,Math.sin(a)*r):st.moveTo(Math.cos(a)*r,Math.sin(a)*r); } st.closePath();
    const sg=extrude(st,.08); sg.translate(0,0,-.04); part('insights',sg,0,0,0,null,ss);
    anims.push(t=>{ ss.rotation.y=t*.9; }); }
  // 10 Portal, API and MCP: a laptop with a dashboard (portal), a terminal (API) and a connector plug (MCP)
  { comp('portal');
    const lap=lg('portal',0,[.15,0,.3],[0,.35,.2]); part('portal',flat(rr(40*S,24*S,.08),.08),0,0,0,null,lap);
    const sc=new T.Group(); sc.position.set(0,.08,-.6); sc.rotation.x=-.22; lap.add(sc);
    part('portal',new T.BoxGeometry(38*S,24*S,.07),0,12*S,0,null,sc); stroke('portal',[[-.8,1.0,.045],[.8,1.0,.045]],.02,sc);
    [[-.6,.35],[-.3,.55],[0,.45],[.3,.75],[.6,.62]].forEach(([x,h])=>{ const g=new T.BoxGeometry(.16,h,.04); g.translate(0,h/2,0); const m=mesh('portal',g,'ac',sc,x,.12,.05); });
    const term=lg('portal',1,[-.95,0,-.5],[-.35,.5,0]); part('portal',new T.BoxGeometry(22*S,17*S,.08),0,8.5*S+.02,0,null,term);
    stroke('portal',[[-.36,.66,.05],[-.24,.56,.05],[-.36,.46,.05]],.022,term); stroke('portal',[[-.14,.42,.05],[.14,.42,.05]],.022,term);
    const plug=lg('portal',2,[1.05,1.0,-.45],[.3,.6,0]); const ps=new T.Group(); plug.add(ps);
    part('portal',new T.BoxGeometry(.3,.22,.18),0,0,0,null,ps); [-.07,.07].forEach(x=>mesh('portal',new T.BoxGeometry(.04,.16,.04),'ac',ps,x,.18,0));
    anims.push(t=>{ ps.rotation.y=t*.8; ps.position.y=Math.sin(t*1.2)*.08; }); }
  // ---------- edges with packets ----------
  function parse(d){ const tk=d.match(/[MLC]|-?[\d.]+/g); const segs=[]; let i=0,cur=null,cmd=null;
    while(i<tk.length){ if(/[MLC]/.test(tk[i])) cmd=tk[i++];
      if(cmd==='M'){ cur=[+tk[i],+tk[i+1]]; i+=2; }
      else if(cmd==='L'){ const p=[+tk[i],+tk[i+1]]; segs.push(['L',cur,p]); cur=p; i+=2; }
      else if(cmd==='C'){ const a=[+tk[i],+tk[i+1]],b=[+tk[i+2],+tk[i+3]],p=[+tk[i+4],+tk[i+5]]; segs.push(['C',cur,a,b,p]); cur=p; i+=6; } }
    return segs; }
  function sample(segs,n){ const out=[]; segs.forEach(s=>{ for(let k=0;k<=n;k++){ const u=k/n; let x,y;
      if(s[0]==='L'){ x=s[1][0]+(s[2][0]-s[1][0])*u; y=s[1][1]+(s[2][1]-s[1][1])*u; }
      else { const [p0,p1,p2,p3]=s.slice(1),v=1-u; x=v*v*v*p0[0]+3*v*v*u*p1[0]+3*v*u*u*p2[0]+u*u*u*p3[0]; y=v*v*v*p0[1]+3*v*v*u*p1[1]+3*v*u*u*p2[1]+u*u*u*p3[1]; }
      out.push([x,y]); } }); return out; }
  const edges={};
  Object.entries(EDGES).forEach(([k,[a,b,label,d,lift,dashed]])=>{
    const pts2=sample(parse(d),24), N=pts2.length-1, ya=(OFF.has(a)?DROP:0)+.3, yb=(OFF.has(b)?DROP:0)+.3;
    const pts=pts2.map(([x,y],i)=>{ const [wx,wz]=P(x,y), u=i/N; return new T.Vector3(wx,ya+(yb-ya)*u+Math.sin(Math.PI*u)*lift,wz); });
    const curve=new T.CatmullRomCurve3(pts,false,'centripetal');
    let m,obj;
    if(dashed){ m=new T.LineDashedMaterial({color:col(C.mute),dashSize:.22,gapSize:.24,transparent:true}); obj=new T.Line(new T.BufferGeometry().setFromPoints(curve.getPoints(90)),m); obj.computeLineDistances(); M.dash.push(m); }
    else { m=new T.MeshBasicMaterial({color:col(C.hl),transparent:true}); obj=new T.Mesh(new T.TubeGeometry(curve,64,.055,6,false),m); M.edge.push(m); }
    root.add(obj);
    const pk=[], count=dashed?1:(curve.getLength()>5?2:1);
    for(let i=0;i<count;i++){ const pm=new T.MeshBasicMaterial({color:col(C.hl),transparent:true}); M.pk.push(pm); const s=new T.Mesh(new T.SphereGeometry(dashed?.11:.14,14,10),pm); s.userData.off=i/count; root.add(s); pk.push(s); }
    const el=document.createElement('div'); el.className='d3-lbl elbl'; el.textContent=label; el.setAttribute('aria-hidden','true'); labelsEl.appendChild(el);
    edges[k]={a,b,curve,mat:m,dashed,pk,lab:{el,kind:'edge',v:curve.getPoint(.5).add(new T.Vector3(0,.32,0)),cls:'d3-lbl elbl'}};
  });

  // ---------- labels (part names are buttons too) ----------
  const lab={}, labs=[];
  const lcls=anc=>(anc==='start'?' start':anc==='end'?' end':anc==='rot'?' rot':'');
  Object.entries(LABELS).forEach(([id,[txt,short,lx,ly,anc='middle']])=>{
    const el=document.createElement('button'); el.type='button'; el.tabIndex=-1; el.className='d3-lbl'; el.dataset.n=id; el.textContent=txt; el.title=`${COMP[id].name}: ${COMP[id].role}`; labelsEl.appendChild(el);
    const y=OFF.has(id)?DROP:0, [x,z]=P(lx,ly), p=LABELS_P[id], [px,pz]=p?P(p[0],p[1]):[x,z];
    const L={id,el,kind:'node',txt,short,vL:new T.Vector3(x,y,z),vP:new T.Vector3(px,y,pz),cL:'d3-lbl'+lcls(anc),cP:'d3-lbl'+lcls(p?p[2]:anc)};
    lab[id]=L; labs.push(L); });
  Object.entries(GLABELS).forEach(([id,[txt,lx,ly,anc,px,py,pa]])=>{
    const el=document.createElement('div'); el.textContent=txt; el.setAttribute('aria-hidden','true'); labelsEl.appendChild(el);
    const [x,z]=P(lx,ly), [qx,qz]=P(px,py);
    labs.push({id,el,kind:'grp',vL:new T.Vector3(x,0,z),vP:new T.Vector3(qx,0,qz),cL:'d3-lbl grp'+lcls(anc),cP:'d3-lbl grp'+lcls(pa)}); });
  Object.values(edges).forEach(e=>labs.push(e.lab));
  let shortNames=null;
  function labelMode(){ const sn=W<560; labs.forEach(L=>{ if(L.kind==='edge') return; L.v=portrait?L.vP:L.vL;
      const keep=['on','off','sel'].filter(c=>L.el.classList.contains(c)); L.el.className=(portrait?L.cP:L.cL)+(keep.length?' '+keep.join(' '):'');
      if(L.kind==='node'&&sn!==shortNames) L.el.textContent=sn?L.short:L.txt; });
    shortNames=sn; measure(); }
  function measure(){ labs.forEach(L=>{ L.w=L.el.offsetWidth; L.h=L.el.offsetHeight; }); }
  labelMode();
  if(document.fonts&&document.fonts.ready) document.fonts.ready.then(measure);
  labelsEl.addEventListener('click',e=>{ const b=e.target.closest('button.d3-lbl'); if(b){ setExploded(false); select(b.dataset.n); } });
  labelsEl.addEventListener('pointerover',e=>{ const b=e.target.closest('button.d3-lbl'); const id=b?b.dataset.n:null; if(id!==hover){ hover=id; if(!focus) applyFocus(); } });
  labelsEl.addEventListener('pointerout',e=>{ if(e.target.closest('button.d3-lbl')&&hover){ hover=null; if(!focus) applyFocus(); } });

  // ---------- highlight ----------
  function applyFocus(){
    const F=focus;
    Object.entries(nodes).forEach(([id,n])=>{
      const on=F?F.n.includes(id):(id===selected||id===hover), off=F&&!on, isSel=!F&&id===selected;
      n.outs.forEach(m=>{ m.color.set(on?C.hl:C.mute); m.opacity=off?.3:1; });
      n.lns.forEach(m=>m.color.set(on?C.hl:C.mute)); n.acs.forEach(m=>m.color.set(on?C.hl:C.mute));
      n.solids.forEach(m=>{ m.opacity=off?.45:.96; m.emissive.set(isSel?C.hl:'#000000'); m.emissiveIntensity=isSel?.16:1; });
      const L=lab[id]; if(L){ L.el.classList.toggle('on',!!on); L.el.classList.toggle('off',!!off); L.el.classList.toggle('sel',isSel||(!!F&&id===F.sel)); }
    });
    const pOn=F?F.n.includes(EDGE_NODE):(selected===EDGE_NODE||hover===EDGE_NODE);
    plate.line.color.set(pOn?C.hl:C.line); plate.fill.opacity=pOn?.07:.03;
    Object.entries(edges).forEach(([k,e])=>{
      const on=F?F.e.includes(k):true, strong=F?on:(e.a===selected||e.b===selected);
      if(e.dashed){ e.mat.color.set(on?(strong?C.hl:C.mute):C.line); e.mat.opacity=on?(strong?1:.8):.35; }
      else { e.mat.color.set(on?C.hl:C.line); e.mat.opacity=on?(strong?1:.5):.45; }
      e.pk.forEach(p=>{ p.material.opacity=strong?1:.6; });
      e.on=on; e.strong=strong; e.lab.el.classList.toggle('show',!!strong);
    });
  }
  function paint(){
    C=css();
    M.solid.forEach(m=>m.color.set(C.panel)); M.slab.forEach(m=>m.color.set(C.panel)); M.slabLine.forEach(m=>m.color.set(C.line));
    M.faint.forEach(m=>m.color.set(C.line)); M.hot.forEach(m=>m.color.set(C.hl)); M.pk.forEach(m=>m.color.set(C.hl));
    M.pulse.forEach(m=>m.color.set(C.pulse)); M.bad.forEach(m=>m.color.set(C.bad));
    plate.fill.color.set(C.brand); grid.material.color.set(C.line);
    applyFocus();
  }

  // ---------- controls ----------
  if(portrait||RM){ spin=false; } btn('spin').setAttribute('aria-pressed',spin); btn('flow').setAttribute('aria-pressed',flow);
  function control(a,b){
    if(a==='top'){ const top=b.getAttribute('aria-pressed')!=='true'; b.setAttribute('aria-pressed',top); tPitch=top?1.48:home().pitch;
      if(top){ const b0=portrait?Math.PI/2:0; tYaw=b0+Math.round((tYaw-b0)/(Math.PI*2))*Math.PI*2; spin=false; btn('spin').setAttribute('aria-pressed','false'); } }
    if(a==='reset'){ const h=home(); tYaw=h.yaw+Math.round((tYaw-h.yaw)/(Math.PI*2))*Math.PI*2; tPitch=h.pitch; tZoom=Z0(); setExploded(false); btn('top').setAttribute('aria-pressed','false'); }
    wake();
  }

  // drag to orbit (sideways only on touch, so the page still scrolls), two fingers to zoom and tilt, click or tap to select
  const ray=new T.Raycaster(), ptr=new T.Vector2(), cv=renderer.domElement; let down=null, pts=new Map(), pinch0=0, zoom0=1, midY=null;
  const ZMIN=.3, ZMAX=2.8;
  const pick=e=>{ const r=cv.getBoundingClientRect(); ptr.set(((e.clientX-r.left)/r.width)*2-1,-((e.clientY-r.top)/r.height)*2+1); ray.setFromCamera(ptr,camera); const h=ray.intersectObjects(clickable,false)[0]; return h?h.object.userData.id:null; };
  cv.addEventListener('pointerdown',e=>{ pts.set(e.pointerId,{x:e.clientX,y:e.clientY}); try{ cv.setPointerCapture(e.pointerId); }catch(err){}
    if(pts.size===2){ const [a,b]=[...pts.values()]; pinch0=Math.hypot(a.x-b.x,a.y-b.y); zoom0=tZoom; midY=(a.y+b.y)/2; down=null; }
    else down={x:e.clientX,y:e.clientY,moved:0}; });
  cv.addEventListener('pointermove',e=>{
    if(pts.has(e.pointerId)) pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pts.size>=2){ const [a,b]=[...pts.values()]; const d=Math.hypot(a.x-b.x,a.y-b.y); if(pinch0) tZoom=Math.max(ZMIN,Math.min(ZMAX,zoom0*d/pinch0));
      const my=(a.y+b.y)/2; if(midY!=null) tPitch=Math.max(PMIN,Math.min(PMAX,tPitch-(my-midY)*.005)); midY=my; return; }
    if(!down){ if(e.pointerType==='mouse'){ const id=pick(e); if(id!==hover){ hover=id; cv.style.cursor=id?'pointer':''; if(!focus) applyFocus(); } } return; }
    const dx=e.clientX-down.x, dy=e.clientY-down.y; down.moved+=Math.abs(dx)+Math.abs(dy);
    if(down.moved>4 && spin){ spin=false; btn('spin').setAttribute('aria-pressed','false'); }
    tYaw-=dx*.004; tPitch=Math.max(PMIN,Math.min(PMAX,tPitch-dy*.0035));
    if(tPitch<1.43) btn('top').setAttribute('aria-pressed','false');
    down.x=e.clientX; down.y=e.clientY; });
  const up=e=>{ const wasClick=down&&down.moved<6&&pts.size<=1; pts.delete(e.pointerId); pinch0=0; midY=null;
    if(wasClick&&e.type==='pointerup'){ const id=pick(e); if(id){ if(id!==selected) setExploded(false); select(id); } }
    if(pts.size===1){ const p=[...pts.values()][0]; down={x:p.x,y:p.y,moved:99}; } else down=null; };
  cv.addEventListener('pointerup',up); cv.addEventListener('pointercancel',up);
  cv.addEventListener('pointerleave',()=>{ if(!down&&hover){ hover=null; cv.style.cursor=''; if(!focus) applyFocus(); } });
  cv.addEventListener('wheel',e=>{ e.preventDefault(); tZoom=Math.max(ZMIN,Math.min(ZMAX,tZoom*Math.exp(-e.deltaY*.0012))); },{passive:false});
  [navEl,pickEl].forEach(x=>x.addEventListener('wheel',e=>e.stopPropagation(),{passive:true}));

  // ---------- theme + resize ----------
  new MutationObserver(paint).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','class','style']});
  ['(prefers-color-scheme: dark)','(prefers-color-scheme: light)'].forEach(q=>{ const mq=matchMedia(q); if(mq.addEventListener) mq.addEventListener('change',paint); else if(mq.addListener) mq.addListener(paint); });
  new ResizeObserver(()=>{ const w=stage.clientWidth, h=stage.clientHeight; if(!w||!h) return; W=w; H=h; renderer.setSize(W,H);
    const was=portrait; portrait=W/H<.9; fit(); layout(); labelMode();
    if(was!==portrait){ const hm=home(); tYaw=hm.yaw+Math.round((tYaw-hm.yaw)/(Math.PI*2))*Math.PI*2; tPitch=hm.pitch; tZoom=Z0(); if(portrait&&spin){ spin=false; btn('spin').setAttribute('aria-pressed','false'); } }
    wake(); }).observe(stage);
  new ResizeObserver(()=>layout()).observe(navEl);

  // ---------- loop (one requestAnimationFrame chain; it stops while the stage is off screen or the tab is hidden) ----------
  const v=new T.Vector3(); let t=0, last=performance.now(), raf=0, visible=true;
  new IntersectionObserver(es=>{ visible=es[es.length-1].isIntersecting; if(visible) wake(); }).observe(stage);
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) wake(); });
  function wake(){ if(!raf){ last=performance.now(); raf=requestAnimationFrame(frame); } }
  const k=RM?1:null;
  function placeLabels(){
    const items=[];
    labs.forEach(L=>{ v.copy(L.v); root.localToWorld(v); v.project(camera); const x=(v.x+1)/2*W, y=(-v.y+1)/2*H;
      const shown=L.kind!=='edge'||L.el.classList.contains('show');
      const c=L.el.classList, w=L.w||0, h=L.h||0, rot=c.contains('rot');
      const bw=rot?h:w, bh=rot?w:h, x0=c.contains('start')?x:c.contains('end')?x-bw:x-bw/2;
      items.push({L,x,y,x0,bw,bh,shown,pri:L.kind==='node'?(c.contains('sel')?0:1):L.kind==='grp'?2:3}); });
    items.sort((a,b)=>a.pri-b.pri);
    const placed=[];
    items.forEach(it=>{ let dy=0, ok=true;
      if(it.shown){ const tries=it.L.kind==='grp'?[0]:[0,it.bh+2,2*(it.bh+2),-(it.bh+2)]; ok=false;
        for(const d of tries){ const y0=it.y-it.bh/2+d; if(!placed.some(p=>it.x0<p.x1&&it.x0+it.bw>p.x0&&y0<p.y1&&y0+it.bh>p.y0)){ dy=d; ok=true; break; } }
        if(!ok&&it.L.kind!=='edge'){ ok=true; dy=0; }
        if(ok){ const y0=it.y-it.bh/2+dy; placed.push({x0:it.x0-2,x1:it.x0+it.bw+2,y0,y1:y0+it.bh}); } }
      it.L.el.classList.toggle('hid',it.shown&&!ok);
      it.L.el.style.left=it.x+'px'; it.L.el.style.top=(it.y+dy)+'px'; });
  }
  function frame(now){
    raf=0;
    if(!visible||document.hidden) return;
    raf=requestAnimationFrame(frame);
    const dt=Math.max(0,Math.min(.05,(now-last)/1000)); last=now; t+=dt;
    if(spin&&!down) tYaw-=dt*.066;
    yaw+=(tYaw-yaw)*(k||.08); pitch+=(tPitch-pitch)*(k||.1); zoom+=(tZoom-zoom)*(k||.075);
    const lm=k||.115;
    movers.forEach(m=>{ const on=exploded&&m.id===selected, pull=on&&m.layer===selLayer?1:0;
      const tx=m.home.x+(on?m.off.x:0)-pull*.9, ty=m.home.y+(on?m.off.y:0)+pull*.6, tz=m.home.z+(on?m.off.z:0)+pull*.6;
      m.o.position.x+=(tx-m.o.position.x)*lm; m.o.position.y+=(ty-m.o.position.y)*lm; m.o.position.z+=(tz-m.o.position.z)*lm; });
    cs+=(tCs-cs)*(k||.09); fc+=(tFc-fc)*(k||.09); vs+=(tVs-vs)*(k||.09); fitAll+=((portrait&&spin?1:0)-fitAll)*(k||.06); applyFit(); place();
    if(!RM) anims.forEach(f=>f(t));
    Object.values(edges).forEach(e=>e.pk.forEach(p=>{ p.visible=flow&&e.on!==false; if(!p.visible) return;
      const q=(t*(e.strong?.34:.2)+p.userData.off)%1; p.position.copy(e.curve.getPoint(q)); }));
    placeLabels();
    renderer.render(scene,camera);
  }
  layout(); applyFocus(); wake();
  return {applyFocus,layout,control};
}

// ---------- start ----------
setCap('Loop',IDLE,false);
try{ gl=initGL(); }
catch(err){ gl=null; const f=document.createElement('div'); f.className='d3-fallback'; f.textContent='The 3D view needs WebGL and could not start here. The parts below still explain every piece of GEO Observability.'; stage.appendChild(f);
  ['flow','spin','explode','top','reset'].forEach(a=>{ const b=btn(a); if(b) b.disabled=true; }); }
// A part can be opened directly: /how-it-works/#judge (standalone) or ?part=judge (embedded).
const want=()=>{ const h=location.hash.slice(1), q=new URLSearchParams(location.search).get('part'); return COMP[h]?h:COMP[q]?q:null; };
const first=want();
select(first||'prompts',true);
if(first) setTimeout(()=>scrollToEl(sheet),350);
window.addEventListener('hashchange',()=>{ const id=want(); if(id&&id!==selected){ select(id,true); scrollToEl(sheet); } });
// Embedded: tell the parent page how tall this page is, so the breakdown sits in the parent's own scroll.
if(FRAMED){ let lastH=0; const app=document.querySelector('.app'), report=()=>{ const h=Math.ceil(app.getBoundingClientRect().height); if(Math.abs(h-lastH)>1){ lastH=h; try{ window.parent.postMessage({type:'dd:height',h},'*'); }catch(e){} } };
  new ResizeObserver(report).observe(app); window.addEventListener('load',report); report(); }
})();

