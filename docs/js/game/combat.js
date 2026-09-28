// ===== Combate: disparos hitscan/proyectiles, cosecha de materiales, loot, cofres =====
import {V3,M4,clamp} from './math.js';
import {raycastWorld,rayCapsule,stepProjectile} from './physics.js';
import {WEAPONS} from './gamedata.js';

export class Combat{
  constructor(game){
    this.game=game;this.projectiles=[];this.particles=[];this.tracers=[];this.dmgNums=[];
  }
  /* ---------- DISPARO PRINCIPAL ---------- */
  fire(shooter,time,forceAim){
    const w=shooter.wstats;if(!w)return;
    if(shooter.reloading>0)return;
    const cd=60/w.rpm;
    if(time-shooter.lastShot<cd)return;
    const it=shooter.weapon;
    // melee / pico
    if(w.melee){this._meleeHit(shooter,time);shooter.lastShot=time;return;}
    if(it.ammo!==undefined&&it.ammo<=0){shooter.startReload(time);return;}
    shooter.lastShot=time;
    if(it.ammo!==undefined&&it.ammo!==Infinity)it.ammo--;
    if(it.ammo===0)shooter.startReload(time);
    const g=this.game;
    g.audio.shot(w.id);
    // flash de partículas en fogón
    const eye=[shooter.pos[0],shooter.pos[1]+1.55,shooter.pos[2]];
    const dir=forceAim||this._aimDir(shooter,w);
    this._muzzle(shooter,eye,dir,w);
    // retroceso visual
    if(shooter.isPlayer)g.addRecoil(w.recoil);
    const pellets=w.pellets||1;
    for(let i=0;i<pellets;i++){
      const d=this._spread(dir,w.spread*(shooter.onGround?1:1.8)*(shooter.sprinting?1.6:1));
      if(w.hitscan)this._hitscan(shooter,eye,d,w,time);
      else this.projectiles.push({pos:[...eye],vel:V3.scale(d,w.bulletSpeed),grav:w.bulletGrav,owner:shooter,weapon:w,life:6});
    }
  }
  _aimDir(e,w){
    const cp=Math.cos(e.pitch);
    return [Math.sin(e.yaw)*cp,Math.sin(e.pitch),Math.cos(e.yaw)*cp];
  }
  _spread(d,s){
    const r1=(Math.random()*2-1)*s,r2=(Math.random()*2-1)*s;
    const up=[0,1,0];let x=V3.norm(V3.cross(d,up)),y=V3.cross(x,d);
    return V3.norm(V3.add(V3.add(d,V3.scale(x,r1)),V3.scale(y,r2)));
  }
  _hitscan(shooter,origin,dir,w,time){
    const g=this.game;
    // contra personajes primero (limitado por los colliders del mundo)
    let bestT=w.range,bestEnt=null,head=false;
    for(const e of g.entities){
      if(e===shooter||!e.alive)continue;
      if(shooter.team&&e.team===shooter.team)continue;
      const hit=rayCapsule(origin,dir,e.pos,0.45,1.8,bestT);
      if(hit){bestT=hit.t;bestEnt=e;head=hit.head;}
    }
    const worldHit=raycastWorld(origin,dir,bestT,g.world.colliders,this._harvestSpheres());
    if(bestEnt&&(!worldHit||bestT<worldHit.t)){
      // impacto en personaje
      let dmg=w.dmg*(head?2.4:1);
      const distF=clamp(1-bestT/w.range*0.35,0.6,1);
      dmg=Math.round(dmg*distF);
      const dealt=bestEnt.damage(dmg,shooter,head?'headshot':'body');
      this._spawnParticles(V3.add(origin,V3.scale(dir,bestT)),head?[1,0.85,0.2]:[0.9,0.2,0.2],10);
      if(shooter.isPlayer){
        g.onHitmarker(head);g.audio.hit(head);
        this.dmgNums.push({pos:V3.add(bestEnt.pos,[0,2.1,0]),val:dealt,crit:head,t:time});
      }
      this.tracers.push({a:V3.add(origin,V3.scale(dir,0.6)),b:V3.add(origin,V3.scale(dir,bestT)),t:time,dur:0.07});
    }else if(worldHit){
      // impacto en objeto construible/minable
      const obj=worldHit.obj;
      this.tracers.push({a:V3.add(origin,V3.scale(dir,0.6)),b:V3.add(origin,V3.scale(dir,worldHit.t)),t:time,dur:0.06});
      this._spawnParticles(V3.add(origin,V3.scale(dir,worldHit.t)),[0.7,0.65,0.5],6);
      if(obj.ref){ // construcción
        obj.ref.hp-=w.dmg;
        if(shooter.isPlayer)this.dmgNums.push({pos:V3.add(origin,V3.scale(dir,worldHit.t)),val:w.dmg,crit:false,t:time});
        if(obj.ref.hp<=0)g.destroyBuild(obj.ref);
      }else if(obj.mat&&obj.mat!=='building'&&shooter.isPlayer){
        // árboles/rocas/coches solo con pico se dañan aquí si es bala → rebote simple
      }
    }else{
      this.tracers.push({a:V3.add(origin,V3.scale(dir,0.6)),b:V3.add(origin,V3.scale(dir,w.range)),t:time,dur:0.05});
    }
  }
  _harvestSpheres(){
    // no usado para balas; reservado
    return null;
  }
  /* ---------- GOLPE DE PICO (cosecha/destrucción) ---------- */
  _meleeHit(shooter,time){
    const g=this.game;
    const eye=[shooter.pos[0],shooter.pos[1]+1.55,shooter.pos[2]];
    const dir=this._aimDir(shooter,{spread:0});
    shooter.harvestAnim=0.35;
    // ¿personaje cercano?
    let bestT=4,bestEnt=null;
    for(const e of g.entities){
      if(e===shooter||!e.alive)continue;
      if(shooter.team&&e.team===shooter.team)continue;
      const hit=rayCapsule(eye,dir,e.pos,0.5,1.8,bestT);
      if(hit){bestT=hit.t;bestEnt=e;}
    }
    if(bestEnt){
      bestEnt.damage(20,shooter,'pico');
      g.audio.hit(false);
      if(shooter.isPlayer)g.onHitmarker(false);
      return;
    }
    const hit=raycastWorld(eye,dir,4.2,g.world.colliders,null);
    if(!hit)return;
    const obj=hit.obj;
    if(obj.ref){ // estructura construida
      obj.ref.hp-=20;g.audio.harvest();
      this._spawnParticles(hit?V3.add(eye,V3.scale(dir,hit.t)):eye,[0.8,0.6,0.3],6);
      if(obj.ref.hp<=0)g.destroyBuild(obj.ref);
      return;
    }
    // buscar árbol/roco/coche cerca del punto de impacto
    const p=V3.add(eye,V3.scale(dir,hit.t));
    for(const t of g.world.trees){
      if(t.dead)continue;
      if(Math.hypot(p[0]-t.pos[0],p[2]-t.pos[2])<1.6*t.scale&&p[1]<t.pos[1]+4){
        this._harvest(t,'wood',shooter,p);return;
      }
    }
    for(const rk of g.world.rocks){
      if(rk.dead)continue;
      if(V3.dist(p,rk.pos)<rk.size+0.8){this._harvest(rk,'stone',shooter,p);return;}
    }
    for(const c of g.world.cars){
      if(c.dead)continue;
      if(V3.dist(p,c.pos)<3){this._harvest(c,'metal',shooter,p);return;}
    }
  }
  _harvest(o,mat,shooter,p){
    const amt=o.mat==='wood'?24:o.mat==='stone'?21:18;
    o.hp-=30;
    shooter.mats[mat]=Math.min(999,(shooter.mats[mat]||0)+amt);
    this.game.audio.harvest();
    this._spawnParticles(p,mat==='wood'?[0.5,0.35,0.15]:mat==='stone'?[0.6,0.6,0.6]:[0.7,0.7,0.75],8);
    if(shooter.isPlayer)this.game.onMatPickup(mat,amt);
    if(o.hp<=0){o.dead=true;this.game.audio.destroy();this._spawnParticles(o.pos,[0.5,0.4,0.2],20);}
  }
  /* ---------- COFRES / LOOT ---------- */
  nearestInteractable(pos,maxD=3){
    const g=this.game;let best=null,bd=maxD;
    for(const c of g.world.chests){
      if(c.opened)continue;
      const d=V3.dist(pos,c.pos);if(d<bd){bd=d;best={type:'chest',obj:c};}
    }
    for(const l of g.world.loot){
      if(l.taken)continue;
      const d=V3.dist(pos,l.pos);if(d<bd){bd=d;best={type:'loot',obj:l};}
    }
    return best;
  }
  openChest(chest){
    const g=this.game;chest.opened=true;g.audio.chest();
    const items=['ar','smg','shotgun','sniper','pistol','rocket','medkit','shield_big','shield_small','ammo'];
    const rar=['common','uncommon','rare','rare','epic','legendary'];
    const n=3+Math.floor(Math.random()*3);
    const out=[];
    for(let i=0;i<n;i++){
      const item=item2(items[Math.floor(Math.random()*items.length)],rar[Math.floor(Math.random()*rar.length)]);
      g.spawnLootDrop(chest.pos,item);out.push(item);
    }
    return out;
  }
  /* ---------- PARTÍCULAS Y TRAZADORES ---------- */
  _muzzle(shooter,eye,dir,w){
    this._spawnParticles(V3.add(eye,V3.scale(dir,0.8)),[1,0.8,0.3],4,0.25);
  }
  _spawnParticles(pos,color,n,life=0.5,spread=3){
    for(let i=0;i<n;i++){
      this.particles.push({pos:[...pos],vel:[(Math.random()-0.5)*spread,Math.random()*spread*0.7,(Math.random()-0.5)*spread],
        color,life:life*(0.6+Math.random()*0.8),maxLife:life,size:0.08+Math.random()*0.12});
    }
  }
  explodeAt(pos,dmg,radius,owner){
    const g=this.game;g.audio.explode();
    this._spawnParticles(pos,[1,0.55,0.15],40,1.1,10);
    this._spawnParticles(pos,[0.3,0.3,0.3],20,1.6,4);
    for(const e of g.entities){
      if(!e.alive||e===owner)continue;
      const d=V3.dist(e.pos,pos);
      if(d<radius){const f=1-d/radius;e.damage(Math.round(dmg*f*f+(owner?8:0)),owner,'explosión');}
    }
    // destruir estructuras cercanas
    for(const c of g.builds){
      if(c.hp>0&&V3.dist([ (c.min[0]+c.max[0])/2,c.min[1],(c.min[2]+c.max[2])/2 ],pos)<radius)c.hp=0;
    }
    g.pendingCleanup=true;
  }
  update(dt,time){
    // proyectiles
    for(let i=this.projectiles.length-1;i>=0;i--){
      const pr=this.projectiles[i];
      // colisión con personajes durante el vuelo
      let hitEnt=null,hitHead=false;
      for(const e of this.game.entities){
        if(e===pr.owner||!e.alive)continue;
        if(pr.owner.team&&e.team===pr.owner.team)continue;
        const h=rayCapsule(pr.pos,pr.vel,e.pos,0.45,1.8,V3.len(pr.vel)*dt+1);
        if(h){hitEnt=e;hitHead=h.head;break;}
      }
      const done=stepProjectile(pr,dt,this.game.world);
      if(hitEnt){
        const dmg=Math.round(pr.weapon.dmg*(hitHead?2.4:1));
        hitEnt.damage(dmg,pr.owner,'proj');
        if(pr.owner.isPlayer){this.game.onHitmarker(hitHead);this.game.audio.hit(hitHead);
          this.dmgNums.push({pos:V3.add(hitEnt.pos,[0,2.1,0]),val:dmg,crit:hitHead,t:time});}
        this.projectiles.splice(i,1);continue;
      }
      if(done){
        if(pr.weapon.explosive)this.explodeAt(pr.hit.pos,pr.weapon.dmg,pr.weapon.splash,pr.owner);
        else{this._spawnParticles(pr.hit.pos,[0.6,0.6,0.6],5,0.3);}
        this.projectiles.splice(i,1);continue;
      }
    }
    for(let i=this.particles.length-1;i>=0;i--){
      const p=this.particles[i];
      p.life-=dt;if(p.life<=0){this.particles.splice(i,1);continue;}
      p.vel[1]-=9*dt;
      p.pos[0]+=p.vel[0]*dt;p.pos[1]+=p.vel[1]*dt;p.pos[2]+=p.vel[2]*dt;
    }
    for(let i=this.tracers.length-1;i>=0;i--)if(time-this.tracers[i].t>this.tracers[i].dur)this.tracers.splice(i,1);
    for(let i=this.dmgNums.length-1;i>=0;i--)if(time-this.dmgNums[i].t>0.9)this.dmgNums.splice(i,1);
  }
  /* dibujar fx 3D */
  drawFx(r,p,scene,time){
    const g=this.game;
    for(const pr of this.projectiles){
      const m=M4.fromTRS(pr.pos,null,[0.12,0.12,pr.weapon.explosive?0.5:0.3]);
      r.drawMesh(r.sph,m,p,pr.weapon.explosive?[1,0.4,0.1]:[1,0.9,0.5],{emis:2.5});
    }
    for(const pt of this.particles){
      const a=pt.life/pt.maxLife;
      const m=M4.fromTRS(pt.pos,null,[pt.size*a*3,pt.size*a*3,pt.size*a*3]);
      r.drawMesh(r.sph,m,p,pt.color,{emis:a*2});
    }
    for(const tr of this.tracers){
      const mid=V3.lerp(tr.a,tr.b,0.5);
      const len=V3.dist(tr.a,tr.b);
      const yaw=Math.atan2(tr.b[0]-tr.a[0],tr.b[2]-tr.a[2]);
      const pitch=-Math.atan2(tr.b[1]-tr.a[1],Math.hypot(tr.b[0]-tr.a[0],tr.b[2]-tr.a[2]));
      let m=M4.identity();
      m=M4.translate(m,mid[0],mid[1],mid[2]);
      m=M4.rotY(m,yaw);m=M4.rotX(m,pitch);
      m=M4.scale(m,0.03,0.03,len);
      r.drawMesh(r.box,m,p,[1,0.95,0.6],{emis:3});
    }
  }
}
function item2(item,rarity){
  const w=WEAPONS[item];
  return {item,rarity,count:1,ammoReserve:w&&w.ammoType?w.mag*3:0};
}
export {item2};
