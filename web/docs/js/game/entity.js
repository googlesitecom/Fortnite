// ===== Entidad de personaje (jugador y bots): cuerpo low-poly, animación procedural, IA =====
import {M4,V3,clamp,lerp,makeRng} from './math.js';
import {collideCapsule,raycastWorld,GRAV,GLIDE_VEL} from './physics.js';
import {WEAPONS,weaponStats,RARITY,botName} from './gamedata.js';

const BODY_COLORS=[[0.15,0.4,0.85],[0.85,0.25,0.1],[0.1,0.5,0.25],[1,0.75,0.1],[0.6,0.05,0.15],[0.6,0.85,1],[0.5,0.3,0.7],[0.9,0.5,0.2]];

export class Entity{
  constructor(game,id,name,isPlayer=false){
    this.game=game;this.id=id;this.name=name;this.isPlayer=isPlayer;
    this.pos=[0,100,0];this.vel=[0,0,0];this.yaw=0;this.pitch=0;
    this.hp=100;this.shield=0;this.alive=true;
    this.onGround=false;this.crouching=false;this.sprinting=false;
    this.inventory=[null,null,null,null,{weapon:'pickaxe',rarity:'common',ammo:Infinity,reserve:Infinity}];
    this.slot=4;
    this.ammo={light:60,medium:30,shells:12,heavy:4};
    this.mats={wood:0,stone:0,metal:0};
    this.lastShot=0;this.reloading=0;this.reloadEnd=0;
    this.gliding=false;this.inWater=false;
    this.animT=0;this.walkPhase=0;this.harvestAnim=0;this.danceT=-1;
    this.fallStart=null;this.gliderDeployedAt=null;
    this.bodyColor=BODY_COLORS[id%BODY_COLORS.length];
    // IA
    this.ai=isPlayer?null:{state:'drop',target:null,targetPos:null,nextThink:0,buildCooldown:0,strafeDir:Math.random()>0.5?1:-1,difficulty:Math.random()};
    this.ragdoll=null;
  }
  get weapon(){return this.inventory[this.slot];}
  get wstats(){const it=this.weapon;if(!it)return null;
    const base=WEAPONS[it.weapon];if(!base)return null;
    return {...weaponStats(base,it.rarity),id:it.weapon};}
  equip(i){if(this.inventory[i]){this.slot=i;this.reloading=0;}}
  addWeapon(item){
    // colocar en hueco o reemplazar slot actual si es mejor rareza
    const order=['common','uncommon','rare','epic','legendary'];
    for(let i=0;i<4;i++)if(!this.inventory[i]){this.inventory[i]={...item,reserve:item.ammoReserve||30};
      if(i>=this.slot&&this.slot===4)this.slot=i;return true;}
    const cur=this.inventory[this.slot];
    if(cur&&cur.weapon!=='pickaxe'&&order.indexOf(item.rarity)>order.indexOf(cur.rarity)){
      this.inventory[this.slot]={...item,reserve:item.ammoReserve||30};return true;}
    return false;
  }
  addItem(item){
    if(WEAPONS[item.item]&&item.item!=='pickaxe')return this.addWeapon({weapon:item.item,rarity:item.rarity});
    if(item.item==='ammo'){this.ammo.light+=24;this.ammo.medium+=18;this.ammo.shells+=4;this.ammo.heavy+=1;return true;}
    // consumibles apilables en slots vacíos
    for(let i=0;i<4;i++){const s=this.inventory[i];
      if(s&&s.weapon===item.item){s.count=(s.count||1)+1;return true;}}
    for(let i=0;i<4;i++)if(!this.inventory[i]){this.inventory[i]={weapon:item.item,rarity:item.rarity,count:1};return true;}
    return false;
  }
  /* ---------- MOVIMIENTO + FÍSICA ---------- */
  update(dt,time,input){
    if(!this.alive){if(this.ragdoll){this.ragdoll.t+=dt;}return;}
    const g=this.game,world=g.world;
    const mv=input.move; // {x,z} local -1..1
    const speedBase=this.crouching?2.6:(this.sprinting?7.6:5.2);
    let wishX=0,wishZ=0;
    const sy=Math.sin(this.yaw),cy=Math.cos(this.yaw);
    wishX=(mv.x*cy-mv.z*sy);wishZ=(-mv.x*sy-mv.z*cy);
    const wl=Math.hypot(wishX,wishZ);
    if(wl>0.01){wishX/=wl;wishZ/=wl;}
    let speed=speedBase*(this.inWater?0.55:1)*(this.gliding?1.4:1);
    const accel=this.onGround?60:12;
    const tvx=wishX*speed,tvz=wishZ*speed;
    this.vel[0]+=clamp(tvx-this.vel[0],-accel*dt,accel*dt);
    this.vel[2]+=clamp(tvz-this.vel[2],-accel*dt,accel*dt);
    // gravedad / planeo
    this.inWater=this.pos[1]+0.3<world.groundAt(this.pos[0],this.pos[2])&&world.groundAt(this.pos[0],this.pos[2])<0;
    if(this.gliding){
      this.vel[1]=lerp(this.vel[1],(this.inputDown&&this.inputDown.fast?-12:-6.5),8*dt);
      // avanzar al planear
      if(wl>0.01){this.vel[0]=lerp(this.vel[0],wishX*16,3*dt);this.vel[2]=lerp(this.vel[2],wishZ*16,3*dt);}
      else{this.vel[0]*=1-0.5*dt;this.vel[2]*=1-0.5*dt;}
    }else if(this.inWater){
      this.vel[1]+=GRAV*0.18*dt;this.vel[1]=Math.max(this.vel[1],-2.5);
      if(input.jump)this.vel[1]=3.2;
    }else{
      this.vel[1]+=GRAV*dt;
      this.vel[1]=Math.max(this.vel[1],-58);
      if(input.jump){
        if(this.onGround){this.vel[1]=8.6;g.audio.jump();}
        else if(mv.y>0.01&&!this.gliding&&this.pos[1]>world.groundAt(this.pos[0],this.pos[2])+18){
          // trepar borde si hay ledge adelante bajo
          this.vault(input);
        }
      }
    }
    // integrar
    this.pos[0]+=this.vel[0]*dt;this.pos[1]+=this.vel[1]*dt;this.pos[2]+=this.vel[2]*dt;
    // colisión con terreno (simplificado: altura mínima)
    const gh=world.groundAt(this.pos[0],this.pos[2]);
    const waterLvl=this.inWater?-1.2:gh;
    this.onGround=false;
    if(this.pos[1]<=waterLvl+0.01&&(!this.gliding||this.pos[1]<gh+0.5)){
      this.pos[1]=waterLvl;this.vel[1]=Math.max(0,this.vel[1]);this.onGround=true;
      if(this.gliding){this.gliding=false;g.onLand&&g.onLand(this);}
      if(this.fallStart!==undefined&&this.fallStart!==null){
        const fallD=this.fallStart-this.pos[1];
        if(fallD>18&&!this.inWater){const dmg=Math.floor((fallD-18)*3.2);this.damage(dmg,null,'caída');
          if(this.isPlayer&&g.onFallDamage)g.onFallDamage(dmg);}
        if(fallD>2){g.audio.land();}
        this.fallStart=null;
      }
    }
    if(this.vel[1]<-1&&!this.onGround&&this.fallStart===null)this.fallStart=this.pos[1];
    if(this.onGround)this.fallStart=null;
    // colisión con AABBs del mundo
    collideCapsule(this.pos,this.vel,nearColliders(world,this.pos),0.45,1.8);
    // límites isla
    this.pos[0]=clamp(this.pos[0],-ISLAND_LIM,ISLAND_LIM);
    this.pos[2]=clamp(this.pos[2],-ISLAND_LIM,ISLAND_LIM);
    // desplegar planeador automático
    if(!this.onGround&&this.vel[1]<-8&&this.fallStart!==null&&(this.fallStart-this.pos[1])>12&&!this.gliding&&this.pos[1]>gh+16){
      this.gliding=true;g.onGlide&&g.onGlide(this);
    }
    if(this.onGround)this.gliding=false;
    // pasos
    const hsp=Math.hypot(this.vel[0],this.vel[2]);
    if(this.onGround&&hsp>1.5){this._stepT=(this._stepT||0)+hsp*dt;
      if(this._stepT>2.4){this._stepT=0;g.audio.footstep(surfaceAt(world,this.pos));}}
    this.walkPhase+=hsp*dt*2.2;
    this.animT+=dt;
    // recarga terminada
    if(this.reloading>0&&time>this.reloadEnd){this.finishReload();}
  }
  vault(input){
    const world=this.game.world;
    const fx=Math.sin(this.yaw),fz=Math.cos(this.yaw);
    const px=this.pos[0]+fx*1.2,pz=this.pos[2]+fz*1.2;
    const h=world.groundAt(px,pz);
    if(h>this.pos[1]+0.5&&h<this.pos[1]+2.6){
      this.pos[0]=px;this.pos[2]=pz;this.pos[1]=h+0.05;this.vel[1]=4;
    }
  }
  startReload(time){
    const w=this.wstats;if(!w||w.mag===Infinity||this.reloading>0)return;
    const it=this.weapon;if(!it||it.ammo===undefined)return;
    if(it.ammo>=w.mag)return;
    const res=this.ammo[w.ammoType]||0;
    if(res<=0)return;
    this.reloading=w.reload;this.reloadEnd=time+w.reload;
    this.game.audio.reload();
  }
  finishReload(){
    const w=this.wstats,it=this.weapon;if(!w||!it)return;
    const need=w.mag-(it.ammo||0);
    const take=Math.min(need,this.ammo[w.ammoType]||0);
    it.ammo=(it.ammo||0)+take;this.ammo[w.ammoType]-=take;
    this.reloading=0;
  }
  damage(amount,from,name){
    if(!this.alive)return 0;
    let dealt=amount;
    if(this.shield>0){const s=Math.min(this.shield,amount);this.shield-=s;amount-=s;}
    this.hp-=amount;
    if(from&&from.isPlayer){this.game.onPlayerDamageDealt&&this.game.onPlayerDamageDealt(dealt);}
    if(this.hp<=0){this.die(from,name);}
    return dealt;
  }
  die(from,cause){
    this.alive=false;this.hp=0;
    this.ragdoll={t:0,vx:this.vel[0]*0.3+(Math.random()-0.5)*3,vy:3,vz:this.vel[2]*0.3+(Math.random()-0.5)*3,spin:Math.random()*4};
    this.game.onDeath(this,from,cause);
  }
  /* ---------- DIBUJO: humanoides low-poly con animación procedural ---------- */
  draw(r,p,scene,time){
    if(!this.alive&&!this.ragdoll)return;
    const gl=r.gl;
    const bob=this.onGround&&Math.hypot(this.vel[0],this.vel[2])>1?Math.sin(this.walkPhase*2)*0.06:0;
    let rotY=this.yaw+Math.PI;
    let lean=0,armSwing=Math.sin(this.walkPhase)*clamp(Math.hypot(this.vel[0],this.vel[2])/6,0,1);
    let legSwing=armSwing;
    let crouchOff=this.crouching?-0.45:0;
    let deathPitch=0,deathRoll=0,deathDrop=0;
    if(!this.alive){
      const t=clamp(this.ragdoll.t*1.6,0,1);
      deathPitch=t*Math.PI/2*0.95;deathRoll=t*0.6;deathDrop=t*0.8;
      rotY+=this.ragdoll.spin*t;
    }
    if(this.gliding){lean=-0.25;armSwing=-1.2;}
    if(this.danceT>=0){this.danceT+=1/60;armSwing=Math.sin(this.danceT*6)*1.4;legSwing=Math.sin(this.danceT*6+1)*0.5;rotY+=Math.sin(this.danceT*2)*0.4;}
    if(this.harvestAnim>0){armSwing=-1.9*Math.abs(Math.sin(this.harvestAnim*10));}
    const bc=this.bodyColor,hc=[0.95,0.82,0.68],lc=[bc[0]*0.4,bc[1]*0.4,bc[2]*0.5];
    const base=M4.identity();
    let m=M4.translate(base,this.pos[0],this.pos[1]+bob+crouchOff-deathDrop,this.pos[2]);
    m=M4.rotY(m,rotY);
    m=M4.rotX(m,deathPitch+lean*0.15);
    m=M4.rotZ(m,deathRoll);
    const H=1.8;
    // torso
    let tm=M4.translate(m,0,0.95+ (this.crouching?0.15:0),0);tm=M4.scale(tm,1,1,1);
    r.drawMesh(r.box,tmFrom(m,0,1.05,0,0.62,0.75,0.36),p,[bc[0],bc[1],bc[2]],{rough:0.6});
    // cabeza
    r.drawMesh(r.sph,mFromRot(m,0,1.68,0,0.26),p,hc,{rough:0.7});
    // brazos (swing)
    const armAng=armSwing*0.9;
    r.drawMesh(r.box,limb(m,-0.42,1.42,0,armAng),p,[bc[0]*0.8,bc[1]*0.8,bc[2]*0.8],{rough:0.6});
    r.drawMesh(r.box,limb(m,0.42,1.42,0,-armAng),p,[bc[0]*0.8,bc[1]*0.8,bc[2]*0.8],{rough:0.6});
    // piernas
    r.drawMesh(r.box,limb(m,-0.16,0.85,0,-legSwing*0.8),p,lc,{rough:0.7});
    r.drawMesh(r.box,limb(m,0.16,0.85,0,legSwing*0.8),p,lc,{rough:0.7});
    // arma en mano derecha (caja alargada)
    const w=this.wstats;
    if(w&&this.alive){
      const gunM=limb(m,0.55,1.25,0.35,-armAng*0.3-1.2);
      const gm=M4.scale(gunM,0.12,0.14,0.9);
      const off=M4.translate(gm,0,0,0.55);
      r.drawMesh(r.box,off,p,[0.15,0.15,0.18],{rough:0.35,metal:0.7});
    }
    // planeador
    if(this.gliding){
      const pm=M4.translate(m,0,1.9,0);
      r.drawMesh(r.cone,M4.rotX(M4.scale(pm,2.6,0.4,1.6),Math.PI/2+0.3),p,[0.9,0.5,0.1],{rough:0.5});
    }
    // barra de vida sobre bots
    if(!this.isPlayer&&this.alive){
      // se dibuja en HUD 2D vía proyección (ver game.js) — marcador 3D simple:
      const mk=M4.translate(m,0,2.35,0);
      r.drawMesh(r.box,M4.scale(mk,0.9*(this.hp+this.shield)/200,0.07,0.07),p,[0.2,1,0.3],{emis:1.2});
    }
  }
}
/* helpers de matrices para limbs */
function mFromRot(m,x,y,z,s){let mm=M4.translate(m,x,y,z);return M4.scale(mm,s,s,s);}
function tmFrom(m,x,y,z,sx,sy,sz){let mm=M4.translate(m,x,y,z);return M4.scale(mm,sx,sy,sz);}
function limb(m,ox,oy,oz,swing){
  let mm=M4.translate(m,ox,oy,oz);
  mm=M4.rotX(mm,swing);
  return M4.scale(mm,0.16,0.62,0.16);
}
function nearColliders(world,pos){
  // filtro rápido por distancia para no iterar todos los colliders cada frame
  if(!world._colliderGrid)_buildGrid(world);
  const cs=[];
  const gx=Math.floor(pos[0]/32),gz=Math.floor(pos[2]/32);
  for(let ix=gx-1;ix<=gx+1;ix++)for(let iz=gz-1;iz<=gz+1;iz++){
    const cell=world._colliderGrid.get(ix+','+iz);
    if(cell)cs.push(...cell);
  }
  return cs;
}
function _buildGrid(world){
  world._colliderGrid=new Map();
  for(const c of world.colliders){
    const x0=Math.floor(c.min[0]/32),x1=Math.floor(c.max[0]/32),z0=Math.floor(c.min[2]/32),z1=Math.floor(c.max[2]/32);
    for(let ix=x0;ix<=x1;ix++)for(let iz=z0;iz<=z1;iz++){
      const k=ix+','+iz;if(!world._colliderGrid.has(k))world._colliderGrid.set(k,[]);
      world._colliderGrid.get(k).push(c);
    }
  }
}
function surfaceAt(world,pos){
  const h=world.groundAt(pos[0],pos[2]);
  if(h<0.6)return 'sand';if(h>26)return 'stone';
  for(const c of world.colliders){
    if(pos[0]>c.min[0]&&pos[0]<c.max[0]&&pos[2]>c.min[2]&&pos[2]<c.max[2]&&Math.abs(pos[1]-c.min[1])<0.3)
      return c.mat==='wood'?'wood':c.mat==='building'?'stone':'grass';
  }
  return 'grass';
}

export {nearColliders,surfaceAt};
export const ISLAND_LIM=560;
