// ===== App: lobby 3D, menús (tienda/pase/ajustes), cola de partida, HUD DOM, minimapa, victoria/derrota =====
import {Game} from './main.js';
import {Renderer} from './game/renderer.js';
import {World,POIS,isWater,terrainHeight} from './game/world.js';
import {M4,V3,clamp,lerp} from './game/math.js';
import {SKINS,PICKAXES,RARITY,PASS_TIERS,WEAPONS,CONSUMABLES} from './game/gamedata.js';
import {loadProfile,saveProfile,defaultProfile,xpForLevel,addXP,recordMatch} from './game/storm.js';
import {AudioEngine} from './game/audio.js';

const $=id=>document.getElementById(id);
const profile=loadProfile();
const uiAudio=new AudioEngine();

/* ============ LOBBY 3D DE FONDO ============ */
class LobbyScene{
  constructor(canvas){
    this.canvas=canvas;
    try{this.renderer=new Renderer(canvas);}catch(e){this.failed=true;return;}
    this.renderer.settings.shadows=false;this.renderer.settings.bloom=true;
    this.world=new World(this.renderer.gl);
    this.t=0;
    this.resize();window.addEventListener('resize',()=>this.resize());
    this.loop=this.loop.bind(this);this.running=true;
    requestAnimationFrame(this.loop);
  }
  resize(){const dpr=Math.min(devicePixelRatio||1,1.5);
    this.renderer.resize(innerWidth*dpr*0.8,innerHeight*dpr*0.8);}
  loop(){
    if(!this.running)return;
    this.t+=1/60;
    const a=this.t*0.05;
    const r=260,el=0.42;
    const cam=[Math.cos(a)*r,Math.max(terrainHeight(Math.cos(a)*r,Math.sin(a)*r),2)+70,Math.sin(a)*r];
    const sunDir=V3.norm([0.5,0.65,0.3]);
    const proj=M4.persp(1.0,this.renderer.vw/this.renderer.vh,0.5,2000);
    const view=M4.lookAt(cam,[0,20,0],[0,1,0]);
    const scene={proj,view,camPos:cam,time:this.t,hour:17,
      sunDir,sunColor:[1.15,0.85,0.6],skyTint:[0.5,0.65,0.95],groundTint:[0.25,0.22,0.18],
      fogColor:[0.62,0.68,0.82],fogDensity:0.0011,shadows:false,shadowTex:this.renderer.depthTex,
      shadowMats:this.renderer.shadowMats,cascadeEnds:this.renderer.cascadeEnds,waterY:0,exposure:1.15,
      storm:{cx:0,cz:0,r:2000}};
    this.renderer.render(scene,this.world);
    requestAnimationFrame(this.loop);
  }
  stop(){this.running=false;}
}
let lobby=null;

/* ============ NAVEGACIÓN ============ */
const screens=['mainMenu','wardrobeScreen','shopScreen','passScreen','statsScreen','settingsScreen','queueScreen','deathScreen','victoryScreen','resultsScreen'];
function show(id){for(const s of screens)$(s).classList.toggle('hidden',s!==id);$('hud').classList.add('hidden');}
function backButtons(){document.querySelectorAll('.backBtn').forEach(b=>b.onclick=()=>{uiAudio.click();show(b.dataset.back);renderAll();});}

/* ============ RENDER DE PANELES ============ */
function renderPlayerCard(){
  $('playerNameLbl').textContent=profile.name+' — Nivel '+profile.level;
  const need=xpForLevel(profile.level);
  $('xpFill').style.width=(profile.xp/need*100)+'%';
  $('xpLbl').textContent=`Nv ${profile.level} · ${Math.floor(profile.xp)}/${need} XP`;
  const sk=SKINS.find(s=>s.id===profile.skin);
  $('skinLbl').textContent='Skin: '+(sk?sk.name:'—');
}
function renderWardrobe(){
  const g=$('skinGrid');g.innerHTML='';
  for(const s of SKINS){
    const owned=profile.owned.includes(s.id);
    const eq=profile.skin===s.id;
    const el=document.createElement('div');
    el.className=`item-card r-${s.rarity}${owned?' owned':''}${eq?' equipped':''}`;
    el.innerHTML=`<div class="swatch" style="background:linear-gradient(${cssRGB(s.colors.body)},${cssRGB(s.colors.legs)})"></div>
      <div class="nm">${s.name}</div><div class="pr">${owned?(eq?'EQUIPADA':'Equipar'):s.cost+' 💎'}</div>`;
    el.onclick=()=>{
      if(owned){profile.skin=s.id;}
      else if(profile.vb>=s.cost){profile.vb-=s.cost;profile.owned.push(s.id);profile.skin=s.id;}
      else return;
      saveProfile(profile);uiAudio.pickup();renderAll();};
    g.appendChild(el);
  }
  const pg=$('pickGrid');pg.innerHTML='';
  for(const p of PICKAXES){
    const owned=profile.owned.includes(p.id);
    const el=document.createElement('div');
    el.className=`item-card${owned?' owned':''}${profile.pickaxe===p.id?' equipped':''}`;
    el.innerHTML=`<div class="swatch" style="background:${cssRGB(p.color)}"></div><div class="nm">${p.name}</div>
      <div class="pr">${owned?(profile.pickaxe===p.id?'EQUIPADO':'Equipar'):p.cost+' 💎'}</div>`;
    el.onclick=()=>{if(owned)profile.pickaxe=p.id;else if(profile.vb>=p.cost){profile.vb-=p.cost;profile.owned.push(p.id);profile.pickaxe=p.id;}
      saveProfile(profile);renderAll();};
    pg.appendChild(el);
  }
}
function cssRGB(c){return `rgb(${c.map(v=>Math.round(v*255)).join(',')})`;}
function renderShop(){
  const g=$('shopGrid');g.innerHTML='';
  // tienda diaria pseudo-aleatoria por día
  let seed=Math.floor(Date.now()/86400000);
  const rnd=()=>{seed=(seed*9301+49297)%233280;return seed/233280;};
  const pool=[...SKINS.slice(1),...PICKAXES.slice(1)];
  for(let i=0;i<5;i++){
    const it=pool[Math.floor(rnd()*pool.length)];
    const price=Math.round((it.cost||300)*(0.8+rnd()*0.6)/10)*10;
    const owned=profile.owned.includes(it.id);
    const el=document.createElement('div');
    el.className=`item-card r-${it.rarity||'rare'}`;
    el.innerHTML=`<div class="swatch" style="background:linear-gradient(${it.colors?cssRGB(it.colors.body):cssRGB(it.color)},#223)"></div>
      <div class="nm">${it.name}</div><div class="pr">${owned?'ADQUIRIDO':price+' 💎'}</div>`;
    if(!owned)el.onclick=()=>{if(profile.vb>=price){profile.vb-=price;profile.owned.push(it.id);saveProfile(profile);uiAudio.chest();renderAll();}};
    g.appendChild(el);
  }
  $('vbBalance').textContent=profile.vb;
  const h=23-(new Date()).getHours(),m=59-(new Date()).getMinutes();
  $('shopTimer').textContent=`· se renueva en ${h}h ${m}m`;
}
function renderPass(){
  const t=$('passTrack');t.innerHTML='';
  const lvl=Math.floor(profile.passXp/150)+1;
  for(const tier of PASS_TIERS){
    const done=lvl>=tier.lv;
    const claimed=profile.passClaimed.includes(tier.lv);
    const el=document.createElement('div');
    el.className='pass-tier'+(done?' done':'');
    el.innerHTML=`<div class="lv">Nv ${tier.lv}</div><div>${tier.reward}</div>
      <button class="mbtn" style="padding:4px 8px;font-size:11px;margin-top:6px">${claimed?'✓ Reclamado':done?'Reclamar':'🔒'}</button>`;
    if(done&&!claimed)el.querySelector('button').onclick=()=>{
      profile.passClaimed.push(tier.lv);
      if(tier.reward.includes('Monedas'))profile.vb+=parseInt(tier.reward.match(/\d+/)[0]);
      saveProfile(profile);uiAudio.chest();renderPass();renderPlayerCard();};
    t.appendChild(el);
  }
  t.prepend(Object.assign(document.createElement('div'),{className:'pass-tier',innerHTML:`<div class="lv">Nv ${lvl}</div><div>Pase actual</div>`}));
}
function renderStats(){
  const s=profile.stats;
  $('statsBody').innerHTML=`
    Partidas jugadas<b>${s.matches}</b><br>Victorias Magnas<b>${s.wins}</b><br>Eliminaciones totales<b>${s.kills}</b><br>
    Daño total<b>${Math.round(s.dmg)}</b><br>Materiales cosechados<b>${Math.round(s.mats)}</b><br>Estructuras construidas<b>${s.builds}</b><br>
    Top 10<b>${s.top10}</b><br>Mejor puesto<b>#${s.best===99?'—':s.best}</b><br>
    <div class="panel-sub" style="margin-top:12px">Últimas partidas</div>`+
    (profile.history.length?profile.history.map(h=>`${h.date} — #${h.place} · ${h.kills} bajas · ${Math.round(h.dmg)} daño`).join('<br>'):'Aún no has jugado ninguna partida');
}
function renderSettings(){
  const st=window.__settings||(window.__settings=JSON.parse(localStorage.getItem('bi_settings')||'null')||
    {quality:'high',resScale:1,shadows:true,bloom:true,fog:true,smooth:true,vol:0.7,mus:0.6,sens:0.8,cam:'tps'});
  $('optQuality').value=st.quality;$('optRes').value=st.resScale*100;$('optResV').textContent=Math.round(st.resScale*100)+'%';
  $('optShadows').checked=st.shadows;$('optSSAO').checked=!!st.ssao;$('optBloom').checked=st.bloom;$('optFog').checked=st.fog;
  $('optSmooth').checked=st.smooth;$('optVol').value=st.vol*100;$('optVolV').textContent=Math.round(st.vol*100)+'%';
  $('optMus').value=st.mus*100;$('optMusV').textContent=Math.round(st.mus*100)+'%';
  $('optSens').value=st.sens*100;$('optSensV').textContent=st.sens.toFixed(2);
  $('optCam').value=st.cam;
  const save=()=>{localStorage.setItem('bi_settings',JSON.stringify(st));if(game)applySettings(game,st);};
  $('optQuality').onchange=e=>{st.quality=e.target.value;save();};
  $('optRes').oninput=e=>{st.resScale=e.target.value/100;$('optResV').textContent=e.target.value+'%';save();};
  $('optShadows').onchange=e=>{st.shadows=e.target.checked;save();};
  $('optSSAO').onchange=e=>{st.ssao=e.target.checked;save();};
  $('optBloom').onchange=e=>{st.bloom=e.target.checked;save();};
  $('optFog').onchange=e=>{st.fog=e.target.checked;save();};
  $('optSmooth').onchange=e=>{st.smooth=e.target.checked;if(game)game.camSmooth=st.smooth;save();};
  $('optVol').oninput=e=>{st.vol=e.target.value/100;$('optVolV').textContent=e.target.value+'%';
    (game||uiAudio).audio?.setVolumes?.(st.vol,st.mus);uiAudio.setVolumes?.(st.vol,st.mus);save();};
  $('optMus').oninput=e=>{st.mus=e.target.value/100;$('optMusV').textContent=e.target.value+'%';save();};
  $('optSens').oninput=e=>{st.sens=e.target.value/100;$('optSensV').textContent=st.sens.toFixed(2);if(game)game.sens=st.sens*0.0032;save();};
  $('optCam').onchange=e=>{st.cam=e.target.value;if(game)game.camMode=st.cam;save();};
}
function applySettings(g,st){
  g.settings.quality=st.quality;
  g.settings.shadows=st.shadows;g.settings.bloom=st.bloom;g.settings.fog=st.fog;
  g.settings.resScale=st.quality==='low'?st.resScale*0.6:st.quality==='medium'?st.resScale*0.8:st.quality==='epic'?st.resScale*1.15:st.resScale*1.3;
  if(st.quality==='ludicrous')g.settings.resScale=1.5;
  g.camSmooth=st.smooth;g.sens=st.sens*0.0032;g.camMode=st.cam;
  g.audio.setVolumes(st.vol,st.mus);
  g.renderer.resize(innerWidth*Math.min(devicePixelRatio,2),innerHeight*Math.min(devicePixelRatio,2));
}
function renderAll(){renderPlayerCard();renderWardrobe();renderShop();renderPass();renderStats();renderSettings();$('vbBalance').textContent=profile.vb;}

/* ============ PARTIDA ============ */
let game=null;
function queueMatch(mode){
  uiAudio.init();uiAudio.click();
  show('queueScreen');
  let n=0;const total=mode==='duos'?48:100;
  $('queueTitle').textContent=mode==='duos'?'Buscando partida en DÚOS…':'Buscando partida SOLO…';
  const iv=setInterval(()=>{
    n+=Math.ceil(Math.random()*(total-n)/3)+1;
    $('queueCount').textContent=`Jugadores listos: ${Math.min(n,total)}/${total}`;
    if(n>=total){clearInterval(iv);setTimeout(()=>startMatch(mode),600);}
  },250);
  $('btnCancelQueue').onclick=()=>{clearInterval(iv);show('mainMenu');};
  window._cancelQueue=iv;
}
function startMatch(mode){
  show('__none__');$('hud').classList.remove('hidden');if(lobby)lobby.stop();
  if(game){game.stop();}
  game=new Game($('gameCanvas'),{mode});
  const st=window.__settings;
  applySettings(game,st);
  game.active=true;
  wireHUD(game);
  window.__dbgGame=game;
  game.start();game.run();
  try{const pl=game.canvas.requestPointerLock();if(pl&&pl.catch)pl.catch(()=>{});}catch(e){}
}
function wireHUD(g){
  const ui=g.onUI;
  ui.bars=(hp,sh)=>{$('hpFill').style.width=clamp(hp,0,100)+'%';$('hpTxt').textContent=Math.ceil(clamp(hp,0,100));
    $('shieldFill').style.width=clamp(sh,0,100)+'%';$('shieldTxt').textContent=Math.ceil(clamp(sh,0,100));};
  ui.inv=(inv,slot,ammo)=>{
    const bar=$('invBar');
    if(bar.children.length!==5){bar.innerHTML='';for(let i=0;i<5;i++){const d=document.createElement('div');d.className='slot';bar.appendChild(d);}}
    for(let i=0;i<5;i++){
      const el=bar.children[i],it=inv[i];
      el.className='slot'+(i===slot?' sel':'')+(it&&RARITY[it.rarity]?' r'+(Object.keys(RARITY).indexOf(it.rarity)+1):'');
      if(!it){el.innerHTML=`<span class="rn">${i+1}</span>`;continue;}
      const w=WEAPONS[it.weapon],c=CONSUMABLES[it.weapon];
      const icon=w?w.icon:(c?c.icon:'?');
      const am=w&&!w.melee?`${it.ammo??'—'}`:(c?`x${it.count||1}`:'');
      el.innerHTML=`<span class="rn">${i+1}</span><div class="ic">${icon}</div><div>${(w?w.name.split(' ')[0]:(c?c.name:''))}</div><span class="am">${am}</span>`;
    }
  };
  ui.mats=(m,key,mode)=>{
    $('matWood').textContent=Math.floor(m.wood);$('matStone').textContent=Math.floor(m.stone);$('matMetal').textContent=Math.floor(m.metal);
    document.querySelectorAll('.mat').forEach(el=>el.classList.toggle('sel',el.classList.contains(key)));
    $('buildHint').classList.toggle('hidden',!mode);
  };
  ui.alive=(n)=>$('aliveCount').textContent=n;
  ui.kill=(name)=>$('killCount').textContent=g.stats.kills;
  ui.storm=(info,st)=>{
    $('stormTimer').textContent=info;
    if(st.state==='shrink')$('stormTimer').style.color='#ff6b6b';else $('stormTimer').style.color='';
  };
  ui.feed=(feed)=>{
    $('killFeed').innerHTML=feed.map(f=>`<div class="kf-item${f.a==='Tú'?' me':''}">${f.a} ☠ ${f.b}</div>`).join('');
  };
  let annT=null;
  ui.announce=(txt)=>{const el=$('announce');el.textContent=txt;el.style.opacity=1;
    clearTimeout(annT);annT=setTimeout(()=>el.style.opacity=0,3000);};
  ui.hitmark=(head)=>{const hm=$('hitmark');hm.style.opacity=1;hm.style.filter=head?'hue-rotate(-40deg) brightness(1.6)':'';
    setTimeout(()=>hm.style.opacity=0,120);};
  ui.pause=(v)=>{$('pauseMenu').classList.toggle('hidden',!v);
    $('pauseStats').innerHTML=`Bajas: ${g.stats.kills} · Daño: ${Math.round(g.stats.dmg)} · Vivos: ${g.aliveCount}`;};
  ui.interact=(v)=>$('interactHint').classList.toggle('hidden',!v);
  ui.compass=(yaw)=>{
    const deg=((yaw*180/Math.PI)%360+360)%360;
    const dirs=['N','NE','E','SE','S','SO','O','NO'];
    $('compass').textContent=`◄ ${dirs[Math.round(deg/45)%8]} ${Math.round(deg)}° ►`;
  };
  ui.minimap=(p,st,ents)=>drawMinimap(p,st,ents);
  ui.dmgNums=(nums,scene)=>{
    document.querySelectorAll('.dmg-num').forEach(e=>e.remove());
    if(!scene)return;
    for(const d of nums){
      const sp=projectToScreen(d.pos,scene,g.renderer);
      if(!sp)continue;
      const el=document.createElement('div');el.className='dmg-num'+(d.crit?' crit':'');
      el.textContent=d.val;el.style.left=sp.x+'px';el.style.top=sp.y+'px';
      document.body.appendChild(el);
    }
  };
  ui.playerDeath=(place,from)=>{
    $('deathStats').innerHTML=`Puesto final<b>#${place}</b><br>Asesino<b>${from?from.name:'la tormenta'}</b><br>Bajas<b>${g.stats.kills}</b><br>Daño<b>${Math.round(g.stats.dmg)}</b>`;
    $('deathScreen').classList.remove('hidden');
    document.exitPointerLock();
  };
  ui.gameOver=(res)=>{
    if(res.win)$('victoryScreen').classList.remove('hidden');
    finishMatch(res);
  };
  $('btnResume').onclick=()=>{uiAudio.click();g.setPause(false);};
  $('btnQuit').onclick=()=>{g.paused=false;g.over=true;finishMatch({win:false,kills:g.stats.kills,dmg:g.stats.dmg,mats:g.stats.mats,builds:g.stats.builds,place:g.aliveCount,time:g.time});};
  $('btnSpectate').onclick=()=>{
    $('deathScreen').classList.add('hidden');
    const alive=game.entities.filter(e=>e.alive&&!e.isPlayer);
    if(alive.length){game.spectateTarget=alive[0];}
  };
  $('btnDeathResults').onclick=()=>{$('deathScreen').classList.add('hidden');show('resultsScreen');};
  $('btnVicResults').onclick=()=>confetti(()=>$('victoryScreen').classList.add('hidden'));
}
function projectToScreen(pos,scene,renderer){
  const vp=M4.mul(scene.proj,scene.view);
  const x=pos[0],y=pos[1],z=pos[2];
  const cx=vp[0]*x+vp[4]*y+vp[8]*z+vp[12];
  const cy=vp[1]*x+vp[5]*y+vp[9]*z+vp[13];
  const cw=vp[3]*x+vp[7]*y+vp[11]*z+vp[15];
  if(cw<=0.01)return null;
  return {x:(cx/cw*0.5+0.5)*innerWidth,y:(1-(cy/cw*0.5+0.5))*innerHeight};
}
function drawMinimap(p,st,ents){
  const c=$('minimap'),g=c.getContext('2d');
  const S=190,scale=S/(1200);
  g.clearRect(0,0,S,S);
  g.fillStyle='#0a1222';g.fillRect(0,0,S,S);
  // terreno muestreado
  if(!g._img){g._img=g.createImageData(S,S);
    for(let y=0;y<S;y++)for(let x=0;x<S;x++){
      const wx=(x-S/2)/scale,wz=(y-S/2)/scale;
      const h=worldProbe(wx,wz);
      let col=h<0?[20,60,90]:h>26?[220,225,235]:h>18?[110,105,95]:[60,110,45];
      const i=(y*S+x)*4;g._img.data[i]=col[0];g._img.data[i+1]=col[1];g._img.data[i+2]=col[2];g._img.data[i+3]=255;
    }}
  g.putImageData(g._img,0,0);
  const toMap=(wx,wz)=>[(wx-p.pos[0])*scale+S/2,(wz-p.pos[2])*scale+S/2];
  // POIs
  g.font='9px sans-serif';g.fillStyle='#cfe3ff';
  for(const poi of POIS){const[mx,my]=toMap(poi.x,poi.z);
    if(mx>-30&&mx<S+30&&my>-30&&my<S+30){g.fillText(poi.name,mx-14,my);g.fillStyle='#ffd27a';g.fillRect(mx-1,my-1,3,3);g.fillStyle='#cfe3ff';}}
  // tormenta
  const[sx,sy]=toMap(st.cx,st.cz);
  g.strokeStyle='#c77dff';g.lineWidth=2;g.beginPath();g.arc(sx,sy,st.r*scale,0,7);g.stroke();
  g.strokeStyle='rgba(199,125,255,.35)';g.setLineDash([4,4]);
  if(st.state==='shrink'){g.beginPath();g.arc(toMap(st.targetCx,st.targetCz)[0],toMap(st.targetCx,st.targetCz)[1],st.shrinkTo*scale,0,7);g.stroke();}
  g.setLineDash([]);
  // entidades cercanas (enemigos rojos, aliados verdes)
  for(const e of ents){
    if(e===p||!e.alive)continue;
    const d=V3.dist(e.pos,p.pos);if(d>220)continue;
    const[mx,my]=toMap(e.pos[0],e.pos[2]);
    g.fillStyle=e.team>0&&e.team===p.team?'#37d67a':'#ff5b5b';
    g.fillRect(mx-2,my-2,4,4);
  }
  // jugador flecha
  g.save();g.translate(S/2,S/2);g.rotate(-p.yaw+Math.PI);
  g.fillStyle='#fff';g.beginPath();g.moveTo(0,-6);g.lineTo(4,5);g.lineTo(-4,5);g.fill();g.restore();
}
let _worldProbe=null;
function worldProbe(x,z){
  if(!_worldProbe)_worldProbe=new World(new Renderer(document.createElement('canvas')).gl);
  return _worldProbe.groundAt(x,z);
}
function finishMatch(res){
  game.stop();game.active=false;
  document.exitPointerLock();
  $('hud').classList.add('hidden');
  for(const s of ['deathScreen','victoryScreen'])$(s).classList.add('hidden');
  if(!lobby){try{lobby=new LobbyScene($('lobbyCanvas'));}catch(e){}}else lobby.running=true;
  recordMatch(profile,res);
  const xpGain=Math.round(res.kills*60+res.dmg*0.25+res.mats*0.3+res.builds*2+(res.win?900:Math.max(0,(100-res.place)*6)));
  const lvls=addXP(profile,xpGain);
  profile.vb+=Math.round(res.kills*15+(res.win?100:0));
  saveProfile(profile);
  $('resultsBody').innerHTML=`${res.win?'¡VICTORIA MAGNA! 🏆':'Derrota'}<b>#${res.place}</b><br>
    Eliminaciones<b>${res.kills}</b><br>Daño causado<b>${Math.round(res.dmg)}</b><br>
    Materiales<b>${Math.round(res.mats)}</b><br>Construcciones<b>${res.builds}</b><br>Duración<b>${Math.floor(res.time/60)}m ${Math.floor(res.time%60)}s</b>`;
  $('resultsXP').innerHTML=`+${xpGain} XP ${lvls>0?`· ¡SUBISTE A NIVEL ${profile.level}! 🎉`:''}`;
  show('resultsScreen');
  renderAll();
}
function confetti(cb){
  const c=$('confettiCanvas');c.width=innerWidth;c.height=innerHeight;
  const g=c.getContext('2d');const ps=[];
  for(let i=0;i<220;i++)ps.push({x:Math.random()*c.width,y:-Math.random()*c.height,vy:2+Math.random()*4,vx:(Math.random()-0.5)*2,
    col:['#ffd27a','#ff5b5b','#37d67a','#3f8cff','#c77dff'][i%5],s:4+Math.random()*6,r:Math.random()*6});
  let t=0;
  const anim=()=>{
    g.clearRect(0,0,c.width,c.height);t++;
    for(const p of ps){p.y+=p.vy;p.x+=p.vx+Math.sin(t*0.05+p.r);
      g.save();g.translate(p.x,p.y);g.rotate(p.r+p.y*0.05);g.fillStyle=p.col;g.fillRect(-p.s/2,-p.s/2,p.s,p.s*0.6);g.restore();}
    if(t<150)requestAnimationFrame(anim);else cb&&cb();
  };
  anim();
}

/* ============ BOOT ============ */
window.addEventListener('DOMContentLoaded',()=>{
  try{lobby=new LobbyScene($('lobbyCanvas'));if(window.__settings&&lobby.renderer)Object.assign(lobby.renderer.settings,{shadows:false,bloom:window.__settings.bloom,fog:true});}catch(e){console.warn('Lobby 3D no disponible:',e);}
  renderAll();backButtons();
  $('btnPlay').onclick=()=>queueMatch('solo');
  $('btnDuos').onclick=()=>queueMatch('duos');
  $('btnWardrobe').onclick=()=>{uiAudio.init();uiAudio.click();show('wardrobeScreen');renderWardrobe();};
  $('btnShop').onclick=()=>{uiAudio.init();uiAudio.click();show('shopScreen');renderShop();};
  $('btnPass').onclick=()=>{uiAudio.init();uiAudio.click();show('passScreen');renderPass();};
  $('btnStats').onclick=()=>{uiAudio.init();uiAudio.click();show('statsScreen');renderStats();};
  $('btnSettings').onclick=()=>{uiAudio.init();uiAudio.click();show('settingsScreen');renderSettings();};
  $('btnBackMenu').onclick=()=>{uiAudio.click();show('mainMenu');renderAll();};
  window.addEventListener('resize',()=>{if(game&&game.active)game.renderer.resize(innerWidth*Math.min(devicePixelRatio,2),innerHeight*Math.min(devicePixelRatio,2));});
});
