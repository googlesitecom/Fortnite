// ===== Núcleo del juego: bucle, cámara TPS/FPS, entrada pointer-lock, IA de bots, HUD/minimapa, drop inicial =====
import {Renderer} from './game/renderer.js';
import {World,ISLAND,POIS,terrainHeight,isWater,GRID} from './game/world.js';
import {M4,V3,clamp,lerp,makeRng,ISLAND_LIM} from './game/math.js';
import {Entity,nearColliders,surfaceAt} from './game/entity.js';
import {Combat,item2} from './game/combat.js';
import {BuildSystem,BUILD_TYPES} from './game/building.js';
import {Storm} from './game/storm.js';
import {WEAPONS,CONSUMABLES,RARITY,botName,weaponStats} from './game/gamedata.js';
import {AudioEngine} from './game/audio.js';
import {rayAABB as rayAABBHelper, raycastWorld} from './game/physics.js';

const BUS_SPEED=105; // m/s autobús (más rápido que el planeo)

export class Game{
  constructor(canvas,opts={}){
    this.canvas=canvas;
    this.renderer=new Renderer(canvas);
    this.audio=new AudioEngine();
    this.world=new World(this.renderer.gl);
    this.combat=new Combat(this);
    this.buildsSys=new BuildSystem(this);
    this.time=0;this.paused=false;this.over=false;
    this.camMode='tps';this.camSmooth=true;
    this.sens=0.0026;
    this.recoilPitch=0;this.shakeT=0;
    this.entities=[];this.player=null;
    this.mode=opts.mode||'solo'; // solo | duos
    this.busDone=false;this.dropPhase=false;
    this.onUI={}; // callbacks hacia main.js
    this.settings=this.renderer.settings;
    this._initInput();
  }
  /* ---------- SETUP PARTIDA ---------- */
  start(){
    this.time=0;this._lastT=performance.now()/1000;
    const rng=makeRng(Date.now()%100000);
    this.storm=new Storm(Math.floor(rng()*99999));
    this.storm.onShrinkStart=(ph)=>{this.announce(`⚠ ¡La tormenta avanza! Fase ${ph}`);this.audio.stormWarn();};
    // crear jugador + 99 bots
    this.player=new Entity(this,0,'Tú',true);
    this.player.team=this.mode==='duos'?1000:-1;
    this.entities.push(this.player);
    for(let i=1;i<100;i++){
      const b=new Entity(this,i,botName(i-1));
      b.team=this.mode==='duos'&&i%2===1?1000+Math.floor(i/2):-i;
      if(this.mode==='duos'&&i%2===1)b.partner=this.entities[i]; // par
      this.entities.push(b);
    }
    // ruta del autobús sobre la isla
    const a=rng()*Math.PI*2;
    this.busA=[Math.cos(a)*700,Math.sin(a)*700]; // [x,z]
    this.busB=[Math.cos(a+Math.PI)*700,Math.sin(a+Math.PI)*700];
    this.busT=0;this.busActive=true;
    this.aliveCount=100;this.killFeed=[];
    this.stats={kills:0,dmg:0,mats:0,builds:0};
    this.pendingCleanup=false;
    // loot mesh callback
    this.world.lootMeshCb=(r,p,scene)=>this._drawLoot(r,p,scene);
    this.world.charCb=(r,p,scene,depth)=>{for(const e of this.entities)e.draw(r,p,scene,this.time);};
    this.world.fxMeshCb=(r,p,scene)=>this.combat.drawFx(r,p,scene,this.time);
    this.rebuildColliderGrid();
    // posiciona todos en el autobús (esperando saltar)
    for(const e of this.entities){e.pos=[this.busA[0],200,this.busA[1]];e.vel=[0,0,0];e.fallStart=null;e.jumpAt=0.06+Math.random()*0.85;}
    // equipo inicial: pico + arma aleatoria (el loot del suelo mejora el arsenal)
    const starterPool=['pistol','smg','rifle','shotgun'];
    const rarPool=['common','uncommon','rare'];
    for(const e of this.entities){
      e.inventory[0]={weapon:'pickaxe',rarity:'common',ammo:Infinity,reserve:Infinity};
      const w=starterPool[Math.floor(Math.random()*starterPool.length)];
      e.inventory[1]={weapon:w,rarity:rarPool[Math.floor(Math.random()*rarPool.length)],ammo:undefined,reserve:999};
      e.slot=1;
    }
    this.announce('🚌 Autobús de combate en marcha — pulsa ESPACIO para saltar');
  }
  rebuildColliderGrid(){
    this.world._colliderGrid=null;this.world._colliderGridBuilt=true;
    nearColliders(this.world,[0,0,0]); // fuerza reconstrucción
  }
  /* ---------- ENTRADA ---------- */
  _initInput(){
    this.keys={};this.mouse={down:false,rdown:false};
    this.inputMove={x:0,z:0,y:0};
    window.addEventListener('keydown',ev=>{
      if(!this.active)return;
      this.keys[ev.code]=true;
      this._onKey(ev);
      if(['Space','KeyW','KeyA','KeyS','KeyD'].includes(ev.code))ev.preventDefault();
    });
    window.addEventListener('keyup',ev=>{this.keys[ev.code]=false;});
    this.canvas.addEventListener('mousedown',ev=>{
      if(!this.active)return;
      if(document.pointerLockElement!==this.canvas){
        try{this.canvas.requestPointerLock();}catch(e){}
        this.audio.init();
        const st=window.__settings;if(st)this.audio.setVolumes(st.vol,st.mus);return;}
      if(ev.button===0)this.mouse.down=true;
      if(ev.button===2)this.mouse.rdown=true;
    });
    window.addEventListener('mouseup',ev=>{if(ev.button===0)this.mouse.down=false;if(ev.button===2)this.mouse.rdown=false;});
    this.canvas.addEventListener('contextmenu',ev=>ev.preventDefault());
    window.addEventListener('mousemove',ev=>{
      if(document.pointerLockElement!==this.canvas||!this.active)return;
      const s=this.sens*(this.mouse.rdown&&this.player?.wstats?.scope?0.4:1);
      this.player.yaw+=ev.movementX*s;
      this.player.pitch=clamp(this.player.pitch-ev.movementY*s,-1.45,1.45);
    });
    document.addEventListener('pointerlockchange',()=>{
      if(document.pointerLockElement!==this.canvas&&this.active&&!this.over&&!this.paused){this.setPause(true);}
    });
    window.addEventListener('wheel',ev=>{
      if(!this.active||document.pointerLockElement!==this.canvas)return;
      const d=Math.sign(ev.deltaY);
      let ns=this.player.slot;
      for(let i=0;i<5;i++){ns=(ns+d+5)%5;if(this.player.inventory[ns])break;}
      this.player.equip(ns);
    });
  }
  _onKey(ev){
    const p=this.player;if(!p)return;
    if(ev.code==='Escape'){this.setPause(!this.paused);return;}
    if(this.paused)return;
    if(this.dropPhase&&(ev.code==='Space'||ev.code==='Enter')){this.deployDrop();return;}
    if(!this.busActive){
      if(ev.code==='Digit1')p.equip(0);
      if(ev.code==='Digit2')p.equip(1);
      if(ev.code==='Digit3')p.equip(2);
      if(ev.code==='Digit4')p.equip(3);
      if(ev.code==='Digit5'||ev.code==='KeyQ')p.equip(4);
      if(ev.code==='KeyF')this.interact();
      if(ev.code==='KeyR')p.startReload(this.time);
      if(ev.code==='KeyG')this.tryUseConsumable(p);
      if(ev.code==='KeyE')this.editNearby();
      if(ev.code==='KeyH')this.dance();
      // construcción
      if(this.buildsSys.mode){
        if(ev.code==='KeyZ'){this.placeBuild('wall');}
        if(ev.code==='KeyX'){this.placeBuild('ramp');}
        if(ev.code==='KeyC'){this.placeBuild('floor');}
        if(ev.code==='KeyV'){this.placeBuild('roof');}
        if(ev.code==='KeyT'){this.buildsSys.repair(p);}
        if(ev.code==='KeyB'){this.buildsSys.activateTurbo();this.announce('⚡ TURBO BUILD ⚡');}
      }else{
        if(ev.code==='KeyZ'){this.buildsSys.mode=true;this.buildsSys.curType='wall';this.showBuildHint(true);}
      }
      if(ev.code==='Tab'){this.camMode=this.camMode==='tps'?'fps':'tps';}
    }
  }
  showBuildHint(v){this.onUI.buildHint&&this.onUI.buildHint(v);}
  placeBuild(type){
    this.buildsSys.curType=type;
    const b=this.buildsSys.place(this.player,type);
    if(b)this.stats.builds++;
  }
  editNearby(){
    if(this.buildsSys.mode){this.buildsSys.editCycle(this.player);return;}
    const b=this.buildsSys.nearStructure(this.player,5);
    if(b){this.buildsSys.mode=true;this.showBuildHint(true);}
  }
  tryUseConsumable(p){
    for(let i=0;i<5;i++){
      const s=p.inventory[i];
      if(s&&WEAPONS[s.weapon]===undefined){
        const c=CONSUMABLES[s.weapon];
        if(c&&p.hp+p.shield<200){
          if(c.gives.hp)p.hp=Math.min(100,p.hp+c.gives.hp);
          if(c.gives.shield)p.shield=Math.min(100,p.shield+c.gives.shield);
          s.count--;if(s.count<=0)p.inventory[i]=null;
          this.audio.pickup();return;
        }
      }
    }
  }
  dance(){
    const p=this.player;
    p.danceT=p.danceT>=0?-1:0;
    if(p.danceT>=0)this.announce(`${p.name} hace: 🕺 ¡Baile Isla!`);
  }
  interact(){
    const it=this.combat.nearestInteractable(this.player.pos);
    if(!it)return;
    if(it.type==='chest'){
      this.combat.openChest(it.obj);
    }else{
      const l=it.obj;l.taken=true;
      const ok=this.player.addItem(item2(l.item,l.rarity));
      if(ok)this.audio.pickup();else l.taken=false;
    }
  }
  deployDrop(){
    const p=this.player;
    this.dropPhase=false;this.busActive=false;
    p.jumped=true;
    // se suelta en la posición actual del autobús (p.pos ya está sincronizada en update)
    p.pos=[p.pos[0]+(Math.random()-0.5)*6,200,p.pos[2]+(Math.random()-0.5)*6];
    p.vel=[0,-4,0];p.fallStart=200;p.gliding=true;p.gliderDeployedAt=this.time;
    this.audio&&this.audio.glide&&this.audio.glide();
    this.announce('🪂 ¡Planeador desplegado! WASD para dirigirte, ratón para mirar');
  }
  get busPos(){
    const t=clamp(this.busT,0,1);
    return [lerp(this.busA[0],this.busB[0],t),lerp(this.busA[1],this.busB[1],t)];
  }
  /* ---------- IA DE BOTS ---------- */
  updateBotAI(b,dt){
    if(!b.alive)return;
    const g=this,world=g.world;
    const ai=b.ai;ai.nextThink-=dt;
    const storm=g.storm;
    const distStorm=V3.dist([b.pos[0],0,b.pos[2]],[storm.cx,0,storm.cz])-storm.r;
    // durante el autobús: bots saltan progresivamente
    if(g.busActive){
      if(!b.jumped&&g.busT>b.jumpAt){
        b.jumped=true;const bp=g.busPos;
        b.pos=[bp[0]+(Math.random()-0.5)*14,200,bp[1]+(Math.random()-0.5)*14];
        b.vel=[0,-2,0];b.fallStart=200;
      }
      if(b.jumped){
        // rumbo al centro seguro; los bots lentos usan caída rápida para no rezagarse
        const far=V3.dist2D([b.pos[0],0,b.pos[2]],[storm.cx,0,storm.cz])>storm.r*0.7;
        b.yaw=Math.atan2(storm.cx-b.pos[0],storm.cz-b.pos[2]);
        b.inputDown={shift:false,fast:far&&b.gliding&&Math.random()<0.5};
        b.update(dt,g.time,{move:{x:0,z:b.gliding?1:0.2,jump:false},jump:false});
      }
      return;
    }
    if(ai.nextThink<=0){
      ai.nextThink=0.4+Math.random()*0.6;
      // decidir objetivo
      let target=null,bd=90;
      for(const e of g.entities){
        if(e===b||!e.alive)continue;
        if(b.team>0&&e.team===b.team)continue;
        const d=V3.dist(b.pos,e.pos);
        if(d<bd&&this._los(b,e)){bd=d;target=e;}
      }
      ai.target=target;
      if(target)ai.targetPos=[...target.pos];
      else if(!!b.inventory.some(s=>s&&WEAPONS[s.weapon])){
        // buscar loot cercano
        let bl=120,bobj=null;
        for(const l of world.loot){
          if(l.taken)continue;
          const d=V3.dist(b.pos,l.pos);if(d<bl){bl=d;bobj=l;}
        }
        if(!bobj)for(const c of world.chests){
          if(c.opened)continue;
          const d=V3.dist(b.pos,c.pos);if(d<bl){bl=d;bobj={type:'chest',pos:c.pos,opened:false};}
        }
        ai.lootGoal=bobj;
      }else ai.lootGoal=null;
    }
    // construir input
    const inp={move:{x:0,z:0},jump:false};
    let desiredYaw=b.yaw;
    if(b.inStorm||distStorm>-4){
      // correr al centro de la tormenta
      desiredYaw=Math.atan2(storm.cx-b.pos[0],storm.cz-b.pos[2]);
      inp.move.z=1;
    }else if(ai.target&&ai.target.alive){
      const tp=ai.target.pos;
      const d=V3.dist(b.pos,tp);
      const ang=Math.atan2(tp[0]-b.pos[0],tp[2]-b.pos[2]);
      desiredYaw=ang;
      // mantener distancia y strafe
      const ideal=d>40?1:(d<12?-0.4:0);
      inp.move.z=ideal;
      inp.move.x=ai.strafeDir*(0.8);
      if(Math.random()<0.01)ai.strafeDir*=-1;
      // disparar con puntería según dificultad
      const acc=0.02+(1-(ai.difficulty))*0.12;
      b.yaw=lerpAngle(b.yaw,ang+ (Math.random()-0.5)*acc,5*dt);
      b.pitch=Math.atan2((tp[1]+1.4)-(b.pos[1]+1.55),Math.hypot(tp[0]-b.pos[0],tp[2]-b.pos[2]))+ (Math.random()-0.5)*acc;
      if(d<(b.wstats?.range||30)&&this._los(b,ai.target)){
        if(!b.inventory.some(s=>s&&s.weapon&&s.weapon!=='pickaxe'&&WEAPONS[s.weapon])){
          b.equip(4); // pico si no tiene arma
        }else{
          // elegir slot con arma
          for(let i=0;i<4;i++)if(b.inventory[i]&&WEAPONS[b.inventory[i].weapon]){b.equip(i);break;}
          g.combat.fire(b,g.time);
        }
      }
      // construir protección si le disparan y está bajo
      if(b.hp<50&&ai.buildCooldown<=0&&b.mats.wood>20&&Math.random()<0.4){
        ai.buildCooldown=6+Math.random()*6;
        const yaw=ang;
        const bx=b.pos[0]-Math.sin(yaw)*GRID, bz=b.pos[2]-Math.cos(yaw)*GRID;
        g.buildsSys._make('wall',Math.round(bx/GRID)*GRID,Math.round(b.pos[1]/GRID)*GRID,Math.round(bz/GRID)*GRID,'wood',{yaw});
        b.mats.wood-=10;
      }
      ai.buildCooldown-=dt;
    }else if(ai.lootGoal){
      const lp=ai.lootGoal.pos;
      desiredYaw=Math.atan2(lp[0]-b.pos[0],lp[2]-b.pos[2]);
      inp.move.z=1;
      if(V3.dist(b.pos,lp)<2.2){
        if(ai.lootGoal.type==='chest'){world.chests.find(c=>c.pos===lp).opened=true;g.combat.openChest({pos:lp,opened:true});}
        else{ai.lootGoal.taken=true;b.addItem(item2(ai.lootGoal.item,ai.lootGoal.rarity));}
        ai.lootGoal=null;
      }
    }else{
      // vagar hacia zona segura o POI
      if(!ai.roam||V3.dist(b.pos,ai.roam)<8||Math.random()<0.002){
        const poi=POIS[Math.floor(Math.random()*POIS.length)];
        ai.roam=[poi.x+(Math.random()*2-1)*40,0,poi.z+(Math.random()*2-1)*40];
      }
      desiredYaw=Math.atan2(ai.roam[0]-b.pos[0],ai.roam[2]-b.pos[2]);
      inp.move.z=1;
    }
    b.yaw=lerpAngle(b.yaw,desiredYaw,6*dt);
    // orientar movimiento relativo al yaw deseado
    const rel=Math.atan2(inp.move.x,inp.move.z)-0;
    inp.move={x:Math.sin(rel)*Math.hypot(inp.move.x,inp.move.z),z:Math.cos(rel)*Math.hypot(inp.move.x,inp.move.z)};
    b.sprinting=inp.move.z>0.5&&b.hp>40;
    b.update(dt,g.time,inp);
    // bots cosechan materiales pasivamente cerca de árboles
    if(b.mats.wood<60&&b.onGround){
      for(const t of world.trees){
        if(t.dead)continue;
        if(V3.dist(b.pos,t.pos)<2.5){b.mats.wood+=dt*10;break;}
      }
    }
    // recarga
    if(b.weapon&&b.weapon.ammo!==undefined&&b.weapon.ammo<=0)b.startReload(g.time);
  }
  _los(a,bEnt){
    const eye=[a.pos[0],a.pos[1]+1.5,a.pos[2]];
    const d=V3.norm(V3.sub([bEnt.pos[0],bEnt.pos[1]+1.2,bEnt.pos[2]],eye));
    const dist=V3.len(V3.sub(bEnt.pos,a.pos));
    const hit=this._rayWorld(eye,d,dist);
    return !hit||hit.t>dist-0.6;
  }
  _rayWorld(ro,rd,maxD){
    return raycastWorld(ro,rd,maxD,this.world.colliders,null);
  }
  _raycastInline(ro,rd,maxD){
    // fallback inline
    let best=null;
    for(const c of this.world.colliders){
      if(c.disabled)continue;
      const t=rayAABBHelper(ro,rd,c.min,c.max);
      if(t!==null&&t<=maxD&&(!best||t<best.t))best={t,obj:c};
    }
    return best;
  }
  /* ---------- BUCLE PRINCIPAL ---------- */
  loop(){
    if(!this.running)return;
    const now=performance.now()/1000;
    let dt=Math.min(0.05,now-(this._lastT||now));this._lastT=now;
    if(!this.paused&&!this.over)this.update(dt);
    this.render();
    this._raf=requestAnimationFrame(()=>this.loop());
  }
  run(){this.running=true;this._lastT=performance.now()/1000;this.loop();}
  stop(){this.running=false;cancelAnimationFrame(this._raf);}
  setPause(v){
    this.paused=v;
    this.onUI.pause&&this.onUI.pause(v);
    if(v)document.exitPointerLock();
    else {try{this.canvas.requestPointerLock();}catch(e){}}
  }
  update(dt){
    this.time+=dt;
    const p=this.player;
    // autobús
    if(this.busActive){
      this.busT+=dt*BUS_SPEED/V3.dist2D([this.busA[0],0,this.busA[1]],[this.busB[0],0,this.busB[1]]);
      const bp=this.busPos;
      if(!this.dropPhase&&this.busT>0.06){this.dropPhase=true;this.announce('PULSA ESPACIO PARA SALTAR');}
      if(!p.jumped){p.pos=[bp[0],200,bp[1]];p.vel=[0,0,0];}
      // bots dentro/fuera
      for(const b of this.entities)if(!b.isPlayer)this.updateBotAI(b,dt);
      if(p.jumped||this.busT>=1){if(!p.jumped)this.deployDrop();}
    }else{
      // input del jugador
      const mv={x:0,z:0};
      if(this.keys.KeyW)mv.z+=1;if(this.keys.KeyS)mv.z-=1;
      if(this.keys.KeyD)mv.x+=1;if(this.keys.KeyA)mv.x-=1;
      const ml=Math.hypot(mv.x,mv.z);if(ml>0){mv.x/=ml;mv.z/=ml;}
      p.crouching=!!this.keys.ControlLeft;
      p.sprinting=!!this.keys.ShiftLeft&&mv.z>0&&!p.crouching;
      p.inputDown={shift:!!this.keys.ShiftLeft,fast:!!this.keys.ShiftLeft&&p.gliding};
      p.update(dt,this.time,{move:mv,jump:!!this.keys.Space});
      // disparo automático
      const w=p.wstats;
      if(w&&this.mouse.down){
        if(w.auto||!this._firedThisClick){this.combat.fire(p,this.time);this._firedThisClick=true;}
      }
      if(!this.mouse.down)this._firedThisClick=false;
      for(const b of this.entities)if(!b.isPlayer)this.updateBotAI(b,dt);
    }
    if(p.harvestAnim>0)p.harvestAnim-=dt;
    // tormenta
    this.storm.update(dt,this.entities);
    // combate fx
    this.combat.update(dt,this.time);
    this.buildsSys.update(dt);
    if(this.pendingCleanup){this.pendingCleanup=false;
      for(const b of [...this.buildsSys.builds])if(b.hp<=0)this.buildsSys.destroyBuildSilent(b);}
    // cuenta vivos / fin de partida
    const alive=this.entities.filter(e=>e.alive).length;
    if(alive!==this.aliveCount){this.aliveCount=alive;this.onUI.alive&&this.onUI.alive(alive);}
    // victoria por desgaste si el jugador es el último
    if(!p.alive&&!this.over){this.gameOver(false);}
    else if(alive===1&&p.alive&&!this.over){this.gameOver(true);}
    // música dinámica
    this.audio.musIntensity=clamp((100-alive)/60,0,1);
    this.audio.setStormIntensity(p.inStorm?1:0);
    // reloj día/noche lento (atardecer épico)
    this.dayT=(this.dayT||0)+dt*0.004;
  }
  onDeath(ent,from,cause){
    if(ent.isPlayer){
      this.deathPlace=this.aliveCount;
      this.onUI.playerDeath&&this.onUI.playerDeath(this.deathPlace,from);
      setTimeout(()=>{if(!this.over)this.gameOver(false,true);},2500);
    }
    if(from&&from.isPlayer&&ent!==from){
      this.stats.kills++;
      this.onUI.kill&&this.onUI.kill(ent.name);
      this.audio.kill();
      this.announce(`☠ ¡Eliminaste a ${ent.name}!`);
      // sueltas botín
      for(const s of ent.inventory){
        if(s&&WEAPONS[s.weapon]&&s.weapon!=='pickaxe')
          this.spawnLootDrop(ent.pos,item2(s.weapon,s.rarity));
      }
      for(const l of ent.worldDrops||[])this.spawnLootDrop(ent.pos,l);
    }
    // feed
    this.addKillFeed(from?from.name:'⛈ Tormenta',ent.name);
  }
  spawnLootDrop(pos,item){
    this.world.loot.push({id:Math.floor(Math.random()*1e6),pos:[pos[0],this.world.groundAt(pos[0],pos[2])+0.6,pos[2]],
      item:item.item,rarity:item.rarity,taken:false});
  }
  addKillFeed(a,b){
    this.killFeed.unshift({a,b,t:this.time});
    if(this.killFeed.length>6)this.killFeed.pop();
    this.onUI.feed&&this.onUI.feed(this.killFeed);
  }
  gameOver(win,spectator){
    this.over=true;
    if(win){this.audio.victory();}
    this.onUI.gameOver&&this.onUI.gameOver({win,kills:this.stats.kills,dmg:Math.round(this.stats.dmg),
      mats:this.stats.mats,builds:this.stats.builds,place:win?1:(this.deathPlace||this.aliveCount),time:this.time});
  }
  onHitmarker(head){this.onUI.hitmark&&this.onUI.hitmark(head);}
  onPlayerDamageDealt(d){this.stats.dmg+=d;}
  onMatPickup(mat,amt){this.stats.mats+=amt;}
  announce(txt){this.onUI.announce&&this.onUI.announce(txt);}
  /* ---------- CÁMARA Y RENDER ---------- */
  render(){
    const r=this.renderer,p=this.player;
    const fovBase=this.mouse.rdown&&p.wstats&&p.wstats.scope?0.35:1.25;
    const proj=M4.persp(fovBase,this.renderer.vw/Math.max(1,this.renderer.vh),0.1,1200);
    // sol dinámico (atardecer)
    const sunEl=0.35+Math.sin(this.dayT)*0.25;
    const sunAz=2.4+this.dayT*0.1;
    const sunDir=V3.norm([Math.cos(sunAz)*Math.cos(sunEl*1.4),Math.sin(sunEl*1.4),Math.sin(sunAz)*Math.cos(sunEl*1.4)]);
    const day=clamp(sunEl*2,0.25,1);
    const scene={
      proj,view:null,camPos:null,time:this.time,hour:18,
      sunDir,sunColor:[1*day+0.2,0.75*day,0.55*day+0.15],
      skyTint:[0.45*day+0.1,0.6*day+0.12,0.9*day+0.2],
      groundTint:[0.25*day,0.22*day,0.18*day],
      fogColor:[0.55*day+0.15,0.65*day+0.18,0.8*day+0.22],
      fogDensity:this.settings.fog?0.0016:0.0,
      shadows:!!this.settings.shadows,shadowTex:r.depthTex,shadowMats:r.shadowMats,cascadeEnds:r.cascadeEnds,
      waterY:0,exposure:0.9+day*0.35,
      storm:{cx:this.storm?this.storm.cx:0,cz:this.storm?this.storm.cz:0,r:this.storm?this.storm.r:800},
    };
    // posición de cámara
    const eyeH=p.crouching?1.15:1.55;
    const eye=[p.pos[0],p.pos[1]+eyeH,p.pos[2]];
    let camPos,target;
    const pitch=this.player.pitch-this.recoilPitch;
    const dir=[Math.sin(p.yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(p.yaw)*Math.cos(pitch)];
    if(this.busActive&&!p.jumped){
      // cámara cinematográfica siguiendo el autobús
      const bp=this.busPos;
      camPos=[bp[0]-dir[0]*30+Math.sin(this.time*0.3)*8,235,bp[1]-dir[2]*30];
      target=[bp[0],190,bp[1]];
    }else if(this.camMode==='fps'||p.gliding&&false){
      camPos=[...eye];
      target=V3.add(eye,V3.scale(dir,10));
    }else{
      // TPS orbital con colisión
      let dist=5.2;
      const hit=this._raycastInline(eye,V3.scale(dir,-1),dist+0.5);
      if(hit)dist=Math.max(1.2,hit.t-0.4);
      const desired=V3.sub(eye,V3.scale(dir,dist));
      desired[1]=Math.max(desired[1],this.world.groundAt(desired[0],desired[2])+0.6);
      if(this.camSmooth){
        this._cam=this._cam||[...desired];
        this._cam=V3.lerp(this._cam,desired,clamp(12*(this._lastDt||0.016),0,1));
        camPos=this._cam;
      }else camPos=desired;
      target=V3.add(eye,V3.scale(dir,8));
    }
    this._lastDt=this._lastDt||0.016;
    // shake por daño/recarga/explosiones
    if(this.shakeT>0){this.shakeT-=0.016;
      camPos=V3.add(camPos,[(Math.random()-0.5)*this.shakeT,(Math.random()-0.5)*this.shakeT,(Math.random()-0.5)*this.shakeT]);}
    // espectar
    if(!p.alive&&this.spectateTarget){
      const e=this.spectateTarget;
      camPos=[e.pos[0]-Math.sin(e.yaw)*6,e.pos[1]+3,e.pos[2]-Math.cos(e.yaw)*6];
      target=[e.pos[0],e.pos[1]+1.4,e.pos[2]];
    }
    scene.camPos=camPos;
    scene.view=M4.lookAt(camPos,target,[0,1,0]);
    this.scene=scene;
    this.recoilPitch=lerp(this.recoilPitch,0,8*0.016);
    r.render(scene,this.world);
    this._updateHUD();
  }
  addRecoil(n){this.recoilPitch=clamp(this.recoilPitch+n*0.012,0,0.15);this.shakeT=Math.max(this.shakeT,n*0.01);}
  _updateHUD(){
    const p=this.player;
    const ui=this.onUI;
    ui.bars&&ui.bars(p.hp,p.shield);
    ui.inv&&ui.inv(p.inventory,p.slot,p.ammo);
    ui.mats&&ui.mats(p.mats,this.buildsSys.key,this.buildsSys.mode);
    ui.storm&&ui.storm(this.storm.info(),this.storm);
    ui.compass&&ui.compass(p.yaw);
    ui.minimap&&ui.minimap(p,this.storm,this.entities);
    ui.interact&&ui.interact(!!this.combat.nearestInteractable(p.pos));
    ui.dmgNums&&ui.dmgNums(this.combat.dmgNums,this.scene);
  }
  _drawLoot(r,p,scene){
    const gl=r.gl;
    for(const l of this.world.loot){
      if(l.taken)continue;
      const dx=l.pos[0]-scene.camPos[0],dz=l.pos[2]-scene.camPos[2];
      if(dx*dx+dz*dz>140*140)continue; // solo cercanos
      const rc=RARITY[l.rarity].color;
      const bobY=Math.sin(this.time*2+l.id)*0.15;
      let m=M4.identity();m=M4.translate(m,l.pos[0],l.pos[1]+bobY,l.pos[2]);
      m=M4.rotY(m,this.time*1.5+l.id);
      m=M4.scale(m,0.5,0.5,0.5);
      r.drawMesh(r.box,m,p,rc,{emis:0.7});
      // haz de luz
      let lm=M4.identity();lm=M4.translate(lm,l.pos[0],l.pos[1]+8,l.pos[2]);
      lm=M4.scale(lm,0.35,16,0.35);
      r.drawMesh(r.box,lm,p,rc,{emis:1.4});
    }
    for(const c of this.world.chests){
      if(c.opened)continue;
      const dx=c.pos[0]-scene.camPos[0],dz=c.pos[2]-scene.camPos[2];
      if(dx*dx+dz*dz>160*160)continue;
      let m=M4.identity();m=M4.translate(m,c.pos[0],c.pos[1],c.pos[2]);
      m=M4.scale(m,1.1,0.8,0.8);
      r.drawMesh(r.box,m,p,[0.85,0.65,0.2],{rough:0.4,metal:0.6,emis:0.25});
    }
  }
}
function lerpAngle(a,b,t){
  let d=b-a;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;
  return a+d*t;
}
