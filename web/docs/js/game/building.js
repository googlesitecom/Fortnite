// ===== Construcción estilo BR: grid 4m, paredes/rampas/suelos/techos, edición, reparación, turbo-build =====
import {M4,V3,clamp} from './math.js';
import {GRID} from './world.js';

export const BUILD_TYPES={
  wall:{name:'Pared',matCost:10,key:'KeyZ'},
  ramp:{name:'Rampa',matCost:10,key:'KeyX'},
  floor:{name:'Suelo',matCost:10,key:'KeyC'},
  roof:{name:'Techo',matCost:10,key:'KeyV'},
};
export const MAT_COLORS={wood:[0.55,0.38,0.2],stone:[0.55,0.55,0.57],metal:[0.62,0.66,0.72]};
const HP={wood:140,stone:190,metal:260};

export class BuildSystem{
  constructor(game){
    this.game=game;this.builds=[];this.key='wood';this.mode=false;
    this.editTarget=null;this.editStart=null;this.turbo=false;this.turboCooldown=0;
    game.world.buildMeshCb=(r,p,scene,depth)=>this.draw(r,p,scene,depth);
  }
  setMaterial(m){this.key=m;}
  /* alinear a la cuadrícula */
  _snap(p,norm){
    let x=Math.round(p[0]/GRID)*GRID,z=Math.round(p[2]/GRID)*GRID;
    // si la normal es lateral, desplazar media celda hacia afuera
    if(Math.abs(norm[0])>0.5)x+=Math.sign(norm[0])*GRID/2*0;
    return [x,z];
  }
  cellOf(pos){return [Math.floor((pos[0]+1000)/GRID),Math.floor((pos[2]+1000)/GRID)];}
  find(type,cx,cz,y){
    return this.builds.find(b=>b.type===type&&b.cx===cx&&b.cz===cz&&Math.abs(b.y-y)<0.5&&b.hp>0);
  }
  preview(shooter,type){
    const eye=[shooter.pos[0],shooter.pos[1]+1.55,shooter.pos[2]];
    const cp=Math.cos(shooter.pitch);
    const dir=[Math.sin(shooter.yaw)*cp,Math.sin(shooter.pitch),Math.cos(shooter.yaw)*cp];
    // objetivo: punto frente al jugador proyectado; o superficie raycast
    let base=[shooter.pos[0]+dir[0]*6,shooter.pos[1]+dir[1]*6,shooter.pos[2]+dir[2]*6];
    // snap vertical a múltiplos de GRID (niveles)
    const lvl=Math.round(base[1]/GRID)*GRID;
    const [cx,cz]=this.cellOf(base.map((v,i)=>i===1?lvl:v));
    // si miramos una estructura existente cerca → editar
    return {type,cx,cz,y:lvl,valid:true,pos:[cx*GRID/GRID*GRID,lvl,cz]};
  }
  place(shooter,type){
    if(this.turboCooldown>0&&!this.turbo)return false;
    const pv=this.preview(shooter,type);
    if(!pv)return false;
    if(this.find(type,pv.cx,pv.cz,pv.y))return false;
    const cost=BUILD_TYPES[type].matCost*(this.turbo?0.75:1);
    if(shooter.mats[this.key]<cost)return false;
    shooter.mats[this.key]-=cost;
    const b=this._make(type,pv.cx,pv.y,pv.cz,this.key,shooter);
    this.game.audio.place();
    if(this.turbo)this.turboCooldown=0.08;
    return b;
  }
  _make(type,cx,y,cz,mat,owner){
    const half=GRID/2;
    let min,max;
    const th=0.3;
    if(type==='wall'){
      // orientar según facing del dueño
      const yaw=owner?owner.yaw:0;
      const horiz=Math.abs(Math.sin(yaw))>Math.abs(Math.cos(yaw));
      if(horiz){min=[cx-half,y,cz-th/2];max=[cx+half,y+GRID,th/2];}
      else{min=[cx-th/2,y,cz-half];max=[cx+th/2,y+GRID,cz+half];}
    }else if(type==='floor'){min=[cx-half,y,cz-half];max=[cx+half,y+0.3,cz+half];}
    else if(type==='roof'){min=[cx-half,y+GRID-0.3,cz-half];max=[cx+half,y+GRID,cz+half];}
    else{ // rampa: caja inclinada aproximada con AABB bajo la diagonal + collider escalable
      const yaw=owner?owner.yaw:0;
      const horiz=Math.abs(Math.sin(yaw))>Math.abs(Math.cos(yaw));
      if(horiz){min=[cx-half,y,cz-half];max=[cx+half,y+GRID*0.55,cz+half];}
      else{min=[cx-half,y,cz-half];max=[cx+half,y+GRID*0.55,cz+half];}
    }
    const b={type,cx,cz,y,mat,min,max,hp:HP[mat],maxHp:HP[mat],owner:owner?owner.id:-1,ref:null,climb:type==='ramp'};
    b.ref=b;
    const col={min:b.min,max:b.max,mat,hp:b.hp,ref:b};
    b.col=col;
    this.game.world.colliders.push(col);
    if(!this.game.world._colliderGridBuilt)this.game.rebuildColliderGrid();
    this.builds.push(b);
    return b;
  }
  destroyBuild(b){
    b.hp=0;
    this.game.audio.destroy();
    const i=this.builds.indexOf(b);if(i>=0)this.builds.splice(i,1);
    const j=this.game.world.colliders.indexOf(b.col);if(j>=0)this.game.world.colliders.splice(j,1);
    this.game.rebuildColliderGrid();
  }
  repair(shooter,time){
    const near=this.nearStructure(shooter,4);
    if(!near)return false;
    const need=Math.min(20,near.maxHp-near.hp);
    if(need<=0||shooter.mats[near.mat]<5)return false;
    shooter.mats[near.mat]-=5;near.hp+=need;
    this.game.audio.place();return true;
  }
  nearStructure(shooter,dist){
    let best=null,bd=dist;
    for(const b of this.builds){
      const c=[(b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2];
      const d=V3.dist(shooter.pos,c);
      if(d<bd){bd=d;best=b;}
    }
    return best;
  }
  /* modo edición: rotar tipo en el mismo grid (pared↔rampa↔suelo↔techo) */
  editCycle(shooter){
    const b=this.nearStructure(shooter,5);
    if(!b)return null;
    const order=['wall','ramp','floor','roof'];
    const nt=order[(order.indexOf(b.type)+1)%4];
    // reemplazar
    this.destroyBuildSilent(b);
    const nb=this._make(nt,b.cx,b.y,b.cz,b.mat,{yaw:shooter.yaw});
    this.game.audio.place();
    return nb;
  }
  destroyBuildSilent(b){
    b.hp=0;
    const i=this.builds.indexOf(b);if(i>=0)this.builds.splice(i,1);
    const j=this.game.world.colliders.indexOf(b.col);if(j>=0)this.game.world.colliders.splice(j,1);
    this.game.rebuildColliderGrid();
  }
  activateTurbo(){
    this.turbo=true;this._turboEnd=this.game.time+8;
  }
  update(dt){
    if(this.turbo&&this.game.time>this._turboEnd)this.turbo=false;
    if(this.turboCooldown>0)this.turboCooldown-=dt;
  }
  draw(r,p,scene,depthPass){
    for(const b of this.builds){
      if(b.hp<=0)continue;
      const col=MAT_COLORS[b.mat];
      const dmgF=b.hp/b.maxHp;
      const cc=[col[0]*(0.5+0.5*dmgF),col[1]*(0.5+0.5*dmgF),col[2]*(0.5+0.5*dmgF)];
      const cx=(b.min[0]+b.max[0])/2,cy=(b.min[1]+b.max[1])/2,cz=(b.min[2]+b.max[2])/2;
      const sx=b.max[0]-b.min[0],sy=b.max[1]-b.min[1],sz=b.max[2]-b.min[2];
      if(b.type==='ramp'&&!depthPass){
        // dibujar como prisma inclinado usando box rotada
        const yaw=Math.abs(sx)>Math.abs(sz)?0:Math.PI/2;
        let m=M4.identity();
        m=M4.translate(m,cx,b.y+GRID*0.27,cz);
        m=M4.rotY(m,yaw);
        m=M4.rotX(m,-Math.atan2(GRID*0.55,GRID));
        m=M4.scale(m,GRID,0.25,GRID*1.42);
        r.drawMesh(r.box,m,p,cc,{rough:0.8});
      }else{
        let m=M4.identity();
        m=M4.translate(m,cx,cy,cz);
        m=M4.scale(m,sx,sy,sz);
        r.drawMesh(r.box,m,p,cc,{rough:b.mat==='metal'?0.4:0.85,metal:b.mat==='metal'?0.8:0});
      }
    }
    // previsualización
    if(this.mode&&this.game.player&&this.game.player.alive&&!depthPass){
      const pv=this.preview(this.game.player,this.curType||'wall');
      if(pv){
        const canAfford=this.game.player.mats[this.key]>=BUILD_TYPES[pv.type].matCost;
        const col=canAfford?[0.3,0.9,0.4]:[0.9,0.3,0.3];
        let m=M4.identity();
        m=M4.translate(m,pv.cx,pv.y+(pv.type==='wall'?GRID/2:pv.type==='roof'?GRID-0.15:0.15),pv.cz);
        m=M4.scale(m,pv.type==='wall'?GRID:GRID,pv.type==='wall'||pv.type==='roof'?GRID:0.3,pv.type==='wall'?0.3:GRID);
        r.drawMesh(r.box,m,p,col,{emis:0.8});
      }
    }
  }
}
