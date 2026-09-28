// ===== Tormenta que cierra: fases estáticas/encogimiento, daño por zona, anuario de partidos =====
import {V3,clamp,makeRng} from './math.js';

export class Storm{
  constructor(seed){
    this.rng=makeRng(seed||42);
    this.cx=(this.rng()*2-1)*150;this.cz=(this.rng()*2-1)*150;
    this.r=760; // cubre toda la isla
    this.phase=0; // 0 drop, luego fases
    this.state='wait'; // wait | shrink
    this.timer=25; // segundos hasta siguiente evento
    this.dps=[0.2,0.4,1,2,4,8,12]; // daño/seg por fase (escala con tiempo restante)
    this.shrinkFrom=this.r;this.shrinkTo=0;this.shrinkDur=1;this.shrinkT=0;
    this.targetCx=0;this.targetCz=0;
    this.log=[];
  }
  nextPhase(){
    if(this.r<=20)return false;
    const newR=Math.max(18,this.r*(0.45+this.rng()*0.15));
    // centro nuevo dentro del círculo actual
    const maxOff=this.r-newR;
    const a=this.rng()*Math.PI*2,rr=Math.sqrt(this.rng())*maxOff*0.9;
    this.targetCx=this.cx+Math.cos(a)*rr;
    this.targetCz=this.cz+Math.sin(a)*rr;
    this.shrinkFrom=this.r;this.shrinkTo=newR;
    this.state='shrink';
    this.shrinkDur=30-this.phase*3;this.shrinkT=0;
    this.phase++;
    return true;
  }
  update(dt,entities){
    if(this.state==='wait'){
      this.timer-=dt;
      if(this.timer<=0){
        if(this.nextPhase()){this.onShrinkStart&&this.onShrinkStart(this.phase);}
        else{this.state='done';}
      }
    }else if(this.state==='shrink'){
      this.shrinkT+=dt;
      const t=clamp(this.shrinkT/this.shrinkDur,0,1);
      const e=t*t*(3-2*t);
      this.r=this.shrinkFrom+(this.shrinkTo-this.shrinkFrom)*e;
      this.cx=this.cx+(this.targetCx-this.cx)*dt/Math.max(0.001,this.shrinkDur-this.shrinkT+dt);
      this.cz=this.cz+(this.targetCz-this.cz)*dt/Math.max(0.001,this.shrinkDur-this.shrinkT+dt);
      if(t>=1){this.state='wait';this.timer=Math.max(12,32-this.phase*3);}
    }
    // daño
    const dps=this.dps[Math.min(this.dps.length-1,this.phase)];
    for(const en of entities){
      if(!en.alive)continue;
      const d=V3.dist([en.pos[0],0,en.pos[2]],[this.cx,0,this.cz]);
      en.inStorm=d>this.r;
      if(en.inStorm){
        en.stormTick=(en.stormTick||0)+dt;
        if(en.stormTick>0.5){en.stormTick=0;en.damage(Math.max(1,Math.round(dps*0.5)),null,'tormenta');}
      }
    }
  }
  info(){
    if(this.state==='wait')return `Zona segura ${Math.ceil(this.timer)}s`;
    if(this.state==='shrink')return `⚠ LA ZONA SE ENCOGE ⚠`;
    return 'Zona final';
  }
}

/* ---- Historial persistente (GitHub Pages = localStorage) ---- */
const KEY='battleisland_v1';
export function loadProfile(){
  try{
    const raw=localStorage.getItem(KEY);
    if(raw)return JSON.parse(raw);
  }catch(e){}
  return defaultProfile();
}
export function defaultProfile(){
  return {name:'Comandante',xp:0,level:1,vb:800,skin:'onda',pickaxe:'basic',
    owned:['onda','basic'],stats:{matches:0,wins:0,kills:0,dmg:0,mats:0,builds:0,top10:0,best:99},
    passXp:0,passClaimed:[],shopSeed:Math.floor(Date.now()/86400000),history:[]};
}
export function saveProfile(p){try{localStorage.setItem(KEY,JSON.stringify(p));}catch(e){}}
export function xpForLevel(l){return 250+l*120;}
export function addXP(p,amount){
  p.xp+=amount;p.passXp+=amount;let gained=0;
  while(p.xp>=xpForLevel(p.level)){p.xp-=xpForLevel(p.level);p.level++;gained++;}
  return gained;
}
export function recordMatch(p,res){
  p.stats.matches++;p.stats.kills+=res.kills;p.stats.dmg+=res.dmg;p.stats.mats+=res.mats;p.stats.builds+=res.builds;
  if(res.place===1)p.stats.wins++;
  if(res.place<=10)p.stats.top10++;
  p.stats.best=Math.min(p.stats.best,res.place);
  p.history.unshift({date:new Date().toLocaleDateString(),place:res.place,kills:res.kills,dmg:res.dmg});
  p.history=p.history.slice(0,10);
}
