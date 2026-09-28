// ===== Mundo procedural: isla 1km², biomas, POIs con nombre, edificios enterables, loot =====
import {Mesh} from './renderer.js';
import {M4,V3,makeRng,clamp} from './math.js';

export const ISLAND=500;         // medio lado de la isla (metros) => 1km x 1km jugable
export const WATER_Y=0.0;
export const GRID=4;             // grid de construcción (m)

/* ---- altura del terreno (ruido determinista multi-octava) ---- */
function vnoise(x,z,seed){
  const xi=Math.floor(x),zi=Math.floor(z),xf=x-xi,zf=z-zi;
  const h=(a,b)=>{let n=a*374761393+b*668265263+seed*1274126177;n=(n^(n>>13))*1274126177;return ((n^(n>>16))>>>0)/4294967296;};
  const sx=xf*xf*(3-2*xf),sz=zf*zf*(3-2*zf);
  return h(xi,zi)*(1-sx)*(1-sz)+h(xi+1,zi)*sx*(1-sz)+h(xi,zi+1)*(1-sx)*sz+h(xi+1,zi+1)*sx*sz;
}
export function fbm(x,z){
  let v=0,a=1,f=1,tot=0;
  for(let i=0;i<5;i++){v+=a*vnoise(x*f,z*f,i*131+7);tot+=a;a*=0.5;f*=2.07;}
  return v/tot;
}
export function terrainHeight(x,z){
  const d=Math.hypot(x,z)/ISLAND;
  // cuenca central con lago + anillo de tierra + montañas al norte
  let h=fbm(x*0.008,z*0.008)*34-6;
  h+=fbm(x*0.03,z*0.03)*6;
  // isla: cae al mar en los bordes
  const fall=clamp((d-0.82)/0.28,0,1);
  h-=fall*fall*40;
  // lago central
  const lc=Math.hypot(x-20,z+10);
  if(lc<70)h=Math.min(h,-3+(lc/70)*5+fbm(x*0.05,z*0.05)*1.5);
  // montaña nevada al NE
  const mc=Math.hypot(x-300,z+340);
  if(mc<130)h+=(1-mc/130)**2*38;
  // colina mansiones al SO
  const hc=Math.hypot(x+320,z+260);
  if(hc<90)h+=(1-hc/90)**2*14;
  return h;
}
export function isWater(x,z){return terrainHeight(x,z)<WATER_Y;}

/* ---- POIs con nombre (original) ---- */
export const POIS=[
  {name:'Puerto Vigía',x:-60,z:-30,type:'harbor',r:80},
  {name:'Núcleo Central',x:20,z:10,type:'city',r:90},
  {name:'Villa Sabinas',x:-260,z:120,type:'town',r:60},
  {name:'Polígono Hierro',x:230,z:180,type:'industrial',r:70},
  {name:'Mercado Vórtice',x:120,z:-220,type:'mall',r:60},
  {name:'Granja Trigal',x:-150,z:-280,type:'farm',r:70},
  {name:'Surtidor Sol',x:300,z:-60,type:'gas',r:30},
  {name:'Campamento Alce',x:-330,z:-80,type:'camp',r:45},
  {name:'Torre Señal',x:60,z:330,type:'tower',r:35},
  {name:'Muelle Norte',x:-40,z:380,type:'dock',r:50},
  {name:'Colina Mansión',x:-320,z:260,type:'mansion',r:55},
  {name:'Ruinas Duna',x:350,z:320,type:'ruins',r:50},
];

/* ---- generadores de geometría ---- */
class Builder{
  constructor(){this.pos=[];this.nor=[];this.uv=[];this.idx=[];}
  vert(p,n,u){this.pos.push(...p);this.nor.push(...n);this.uv.push(...u);return this.pos.length/3-1;}
  quad(a,b,c,d,n){const i=this.vert(a,n,[0,0]),j=this.vert(b,n,[1,0]),k=this.vert(c,n,[1,1]),l=this.vert(d,n,[0,1]);
    this.idx.push(i,j,k,i,k,l);}
  box(cx,cy,cz,sx,sy,sz,col){ // caja centrada; col se aplica por mesh separado
    const x0=cx-sx/2,x1=cx+sx/2,y0=cy-sy/2,y1=cy+sy/2,z0=cz-sz/2,z1=cz+sz/2;
    this.quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],[0,0,1]);
    this.quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[0,0,-1]);
    this.quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[1,0,0]);
    this.quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[-1,0,0]);
    this.quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0],[0,1,0]);
    this.quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[0,-1,0]);
  }
  merge(b){const off=this.pos.length/3;
    this.pos.push(...b.pos);this.nor.push(...b.nor);this.uv.push(...b.uv);
    this.idx.push(...b.idx.map(i=>i+off));}
}
function rampGeo(w,h,d){const b=new Builder();
  // prisma inclinado simple: plano inclinado + underside
  b.quad([-w/2,0,-d/2],[w/2,0,-d/2],[w/2,h,d/2],[-w/2,h,d/2],V3.norm([-0 ,d,h]));
  b.quad([-w/2,h,d/2],[w/2,h,d/2],[w/2,0,-d/2],[-w/2,0,-d/2],V3.norm([0,-d,-h]));// underside
  return b;}

export class World{
  constructor(gl){
    this.gl=gl;this.rng=makeRng(1337);
    this.colliders=[];   // {min,max,rotY?,solid:true,mat:'wood|stone|metal|rock|building',hp?,ref?}
    this.staticDraws=[]; // {mesh,model,color,rough,metal}
    this.dynGroups={};   // grupos dibujados dinámicamente (árboles, construcciones, personajes…)
    this.loot=[];        // {id,pos,item,rarity,taken}
    this.trees=[];       // {pos,hp,mat}
    this.rocks=[];
    this.cars=[];
    this.chests=[];
    this.buildings=[];   // para drawAll filtrado
    this._buildTerrain();
    this._buildWater();
    this._buildPOIs();
    this._buildVegetation();
    this._buildLoot();
  }
  /* ---------- TERRENO ---------- */
  _buildTerrain(){
    const N=128,S=ISLAND*2/N;
    const b=new Builder();
    for(let i=0;i<N;i++)for(let j=0;j<N;j++){
      const x=-ISLAND+i*S,z=-ISLAND+j*S;
      const h=terrainHeight(x,z),hE=terrainHeight(x+S,z),hN=terrainHeight(x,z+S);
      const p00=[x,h,z],p10=[x+S,hE,z],p01=[x,h,z+S],p11=[x+S,hE,z+S];
      const n1=V3.norm(V3.cross(V3.sub(p10,p00),V3.sub(p01,p00)));
      const n2=V3.norm(V3.cross(V3.sub(p01,p11),V3.sub(p10,p11)));
      const i0=b.vert(p00,n1,[0,0]),i1=b.vert(p10,n1,[1,0]),i2=b.vert(p01,n1,[0,1]),i3=b.vert(p11,n2,[1,1]);
      b.idx.push(i0,i1,i3,i0,i3,i2);
    }
    this.terrainMesh=new Mesh(this.gl,{pos:b.pos,nor:b.nor,uv:b.uv,idx:b.idx});
  }
  drawTerrain(r,p){this.terrainMesh.bind();
    r.gl.uniformMatrix4fv(p.u.uModel,false,M4.identity());
    r.gl.drawElements(r.gl.TRIANGLES,this.terrainMesh.count,this.terrainMesh.itype,0);}
  /* ---------- AGUA ---------- */
  _buildWater(){
    const b=new Builder(),step=25;
    for(let x=-ISLAND;x<ISLAND;x+=step)for(let z=-ISLAND;z<ISLAND;z+=step){
      // solo donde hay agua cerca
      if(terrainHeight(x,z)>2&&terrainHeight(x+step,z)>2&&terrainHeight(x,z+step)>2&&terrainHeight(x+step,z+step)>2)continue;
      const y=WATER_Y;
      b.quad([x,y,z],[x+step,y,z],[x+step,y,z+step],[x,y,z+step],[0,1,0]);
    }
    this.waterMesh=new Mesh(this.gl,{pos:b.pos,nor:b.nor,uv:b.uv,idx:b.idx});
  }
  /* ---------- SUELO / ALTURA PARA GAMEPLAY ---------- */
  groundAt(x,z){return terrainHeight(x,z);}
  /* ---------- POIs ---------- */
  _addStatic(meshData,color,rough=0.85,metal=0){
    const m=new Mesh(this.gl,meshData);
    this.staticDraws.push({mesh:m,color,rough,metal});
    return m;
  }
  _colliderBox(cx,cy,cz,sx,sy,sz,mat='building',ref=null){
    this.colliders.push({min:[cx-sx/2,cy-sy/2,cz-sz/2],max:[cx+sx/2,cy+sy/2,cz+sz/2],mat,ref,hp:mat==='building'?Infinity:null});
  }
  _floor(cx,cy,cz,w,d,thick,color){const b=new Builder();b.box(cx,cy-thick/2,cz,w,thick,d);
    this._addStatic({pos:b.pos,nor:b.nor,uv:b.uv,idx:b.idx},color,0.9);}
  _wallWithDoor(b,cx,cy,cz,w,h,t,doorX,doorW,doorH){
    // segmento izq
    if(doorX-doorW/2>cx-w/2+0.01){const lw=(doorX-doorW/2)-(cx-w/2);b.box(cx-w/2+lw/2,cy,cz,lw,h,t);}
    // segmento der
    const rx=cx+w/2-(doorX+doorW/2);if(rx>0.01)b.box(cx+w/2-rx/2,cy,cz,rx,h,t);
    // dintel
    const lintelH=h-doorH;if(lintelH>0.01)b.box(doorX,cy+h/2-lintelH/2,cz,doorW,lintelH,t);
  }
  _building(cx,cz,opts={}){
    const w=opts.w||14,d=opts.d||12,floors=opts.floors||1,wallH=4,thick=0.4;
    const gy=this.groundAt(cx,cz);const base=Math.max(gy,opts.base??gy);
    const wallC=opts.wallColor||[0.75,0.72,0.66],roofC=opts.roofColor||[0.45,0.25,0.2];
    for(let f=0;f<floors;f++){
      const y0=base+f*wallH;
      const b=new Builder();
      // fachadas con puerta en planta baja (lado sur)
      if(f===0)this._wallWithDoor(b,cx,y0+wallH/2,cz+d/2,w,wallH,thick,cx,2.2,3);
      else b.box(cx,y0+wallH/2,cz+d/2,w,wallH,thick);
      b.box(cx,y0+wallH/2,cz-d/2,w,wallH,thick);
      b.box(cx-w/2,y0+wallH/2,cz,thick,wallH,d);
      b.box(cx+w/2,y0+wallH/2,cz,thick,wallH,d);
      // techo = suelo del siguiente piso
      b.box(cx,y0+wallH+thick/2,cz,w+0.6,thick,d+0.6);
      // ventanas (cuadros emisivos pequeños)
      this._addStatic({pos:b.pos,nor:b.nor,uv:b.uv,idx:b.idx},wallC,0.85);
      // colision perimetral (paredes finas)
      this._colliderBox(cx,y0+wallH/2,cz+d/2-0.2,w,wallH,0.6);
      this._colliderBox(cx,y0+wallH/2,cz-d/2+0.2,w,wallH,0.6);
      this._colliderBox(cx-w/2+0.2,y0+wallH/2,cz,0.6,wallH,d);
      this._colliderBox(cx+w/2-0.2,y0+wallH/2,cz,0.6,wallH,d);
      this._colliderBox(cx,y0+wallH+0.2,cz,w+0.6,0.4,d+0.6); // techo sólido
      if(f>0){
        // hueco de escalera: no sellar el centro — añadimos rampa exterior simple
      }
    }
    // suelo
    const fb=new Builder();fb.box(cx,base+0.15,cz,w-0.8,0.3,d-0.8);
    this._addStatic({pos:fb.pos,nor:fb.nor,uv:fb.uv,idx:fb.idx},opts.floorColor||[0.55,0.5,0.45],0.9);
    // escalera exterior (rampas) para subir pisos
    if(floors>1){
      for(let f=1;f<floors;f++){
        const rb=rampGeo(3,wallH,wallH*1.6);
        const rz=M4.rotY(M4.identity(),Math.PI);
        this._addStatic({pos:rb.pos.map((v,i)=>i%3===2?-v:v),nor:rb.nor,uv:rb.uv,idx:rb.idx},[0.6,0.6,0.62],0.7);
        // colocar manualmente vía matriz: usamos static con modelo
        this.staticDraws[this.staticDraws.length-1].model=M4.fromTRS([cx+w/2+1.8,base+f*wallH-wallH/2+0.2,cz],[0,0,0],[1,1,1]);
        this._colliderBox(cx+w/2+1.8,base+f*wallH-wallH/2+0.2,cz,3.4,wallH/2,wallH*1.6);
      }
    }
    // tejado a dos aguas
    const rg=new Builder();const ry=base+floors*wallH+thick;
    rg.quad([cx-w/2-0.5,ry,cz+d/2+0.5],[cx+w/2+0.5,ry,cz+d/2+0.5],[cx,ry+2.2,cz],[cx,ry+2.2,cz-d/2-0.5],[-1,1.2,0]);
    rg.quad([cx+w/2+0.5,ry,cz+d/2+0.5],[cx,ry+2.2,cz],[cx,ry+2.2,cz-d/2-0.5],[cx+w/2+0.5,ry,cz-d/2-0.5],[1,1.2,0]);
    rg.quad([cx,ry+2.2,cz-d/2-0.5],[cx,ry+2.2,cz],[cx-w/2-0.5,ry,cz+d/2+0.5],[cx-w/2-0.5,ry,cz-d/2-0.5],[-1,1.2,0]);
    rg.quad([cx-w/2-0.5,ry,cz-d/2-0.5],[cx-w/2-0.5,ry,cz+d/2+0.5],[cx,ry+2.2,cz],[cx,ry+2.2,cz-d/2-0.5],[-1,1.2,0]);
    this._addStatic({pos:rg.pos,nor:rg.nor,uv:rg.uv,idx:rg.idx},roofC,0.8);
    // muebles interiores simples (cajas)
    const fu=new Builder();
    fu.box(cx-w/4,base+0.9,cz-d/4,2.4,1.5,1.6);fu.box(cx+w/4,base+0.5,cz+d/4,1.2,0.9,1.2);
    this._addStatic({pos:fu.pos,nor:fu.nor,uv:fu.uv,idx:fu.idx},[0.5,0.35,0.22],0.9);
    return {cx,cz,base,w,d,floors};
  }
  _buildPOIs(){
    for(const poi of POIS){
      const R=this.rng;
      if(poi.type==='city'){
        const spots=[[-30,-20],[10,-35],[35,5],[-15,25],[25,30],[-40,5]];
        for(const [ox,oz] of spots){
          const x=poi.x+ox*1.6,z=poi.z+oz*1.6;
          if(isWater(x,z))continue;
          this._building(x,z,{w:12+R()*8,d:10+R()*6,floors:2+Math.floor(R()*3),wallColor:[0.6+R()*0.3,0.6+R()*0.25,0.62+R()*0.2]});
        }
      }else if(poi.type==='town'||poi.type==='farm'){
        for(let i=0;i<6;i++){
          const a=i*1.05,rr=22+i%2*10;
          const x=poi.x+Math.cos(a)*rr,z=poi.z+Math.sin(a)*rr;
          if(isWater(x,z))continue;
          this._building(x,z,{w:9+R()*4,d:7+R()*3,floors:R()>0.6?2:1,wallColor:[0.8,0.75,0.6],roofColor:[0.4,R()*0.2+0.2,0.15]});
        }
        if(poi.type==='farm'){ // graneros de madera minables
          for(let i=0;i<3;i++){const x=poi.x-30+i*30,z=poi.z+35;
            this._building(x,z,{w:12,d:8,floors:1,wallColor:[0.55,0.3,0.18]});}
        }
      }else if(poi.type==='industrial'){
        for(let i=0;i<4;i++){
          const x=poi.x-40+i*28,z=poi.z+(i%2)*30-15;
          if(isWater(x,z))continue;
          this._building(x,z,{w:20,d:14,floors:1,wallColor:[0.5,0.52,0.55],roofColor:[0.35,0.36,0.38]});
          // tanques metálicos
          const tb=new Builder();tb.box(x+12,3.5,z-10,4,7,4);
          this._addStatic({pos:tb.pos,nor:tb.nor,uv:tb.uv,idx:tb.idx},[0.6,0.62,0.65],0.35,0.9);
          this._colliderBox(x+12,3.5,z-10,4.4,7,4.4,'metal');
        }
        // chimeneas
        for(let i=0;i<2;i++){const cb=new Builder();cb.box(poi.x+30-i*12,10,poi.z+40,3,20,3);
          this._addStatic({pos:cb.pos,nor:cb.nor,uv:cb.uv,idx:cb.idx},[0.4,0.4,0.42],0.6,0.5);}
      }else if(poi.type==='mall'){
        this._building(poi.x,poi.z,{w:44,d:30,floors:2,wallColor:[0.7,0.75,0.8],roofColor:[0.3,0.35,0.4]});
        // estacionamiento con coches minables
        for(let i=0;i<8;i++)this._car(poi.x-24+i*6,poi.z+26+ (i%2)*7);
      }else if(poi.type==='gas'){
        this._building(poi.x,poi.z-8,{w:8,d:6,floors:1,wallColor:[0.85,0.7,0.2]});
        // marquesina
        const gb=new Builder();gb.box(poi.x+10,4.2,poi.z+6,16,0.5,10);
        for(const [ox,oz] of [[-6,-3],[6,-3],[-6,3],[6,3]])gb.box(poi.x+10+ox,2,poi.z+6+oz,0.5,4,0.5);
        this._addStatic({pos:gb.pos,nor:gb.nor,uv:gb.uv,idx:gb.idx},[0.9,0.25,0.2],0.5);
        this._colliderBox(poi.x+10,4.2,poi.z+6,16,0.6,10);
        for(const ox of [-4,4])this._car(poi.x+10+ox,poi.z+6);
      }else if(poi.type==='camp'){
        for(let i=0;i<5;i++){const a=i*2.2,x=poi.x+Math.cos(a)*18,z=poi.z+Math.sin(a)*18;
          const yb=new Builder();yb.box(x,this.groundAt(x,z)+1.4,z,4,0.4,4); // plataforma cabaña
          yb.box(x,this.groundAt(x,z)+3,z,4,3,4);
          this._addStatic({pos:yb.pos,nor:yb.nor,uv:yb.uv,idx:yb.idx},[0.5,0.36,0.22],0.95);
          this._colliderBox(x,this.groundAt(x,z)+3,z,4.2,3,4.2,'wood');}
      }else if(poi.type==='tower'){
        const x=poi.x,z=poi.z,gy=this.groundAt(x,z);
        const tb=new Builder();
        for(let s=0;s<4;s++)tb.box(x,gy+4+s*6,z,3.2-s*0.5,6,3.2-s*0.5);
        tb.box(x,gy+27,z,10,1,10);
        this._addStatic({pos:tb.pos,nor:tb.nor,uv:tb.uv,idx:tb.idx},[0.55,0.56,0.6],0.4,0.85);
        this._colliderBox(x,gy+16,z,4,32,4,'metal');
        this._colliderBox(x,gy+27,z,10,1.2,10,'metal');
      }else if(poi.type==='dock'){
        const x=poi.x,z=poi.z;
        const db=new Builder();db.box(x,WATER_Y+0.6,z+30,8,0.8,70);
        for(let i=0;i<6;i++)db.box(x-3,WATER_Y-2,z+5+i*12,0.8,6,0.8),db.box(x+3,WATER_Y-2,z+5+i*12,0.8,6,0.8);
        this._addStatic({pos:db.pos,nor:db.nor,uv:db.uv,idx:db.idx},[0.45,0.32,0.2],0.95);
        this._colliderBox(x,WATER_Y+0.6,z+30,8,1,70,'wood');
        // barco varado
        const sb=new Builder();sb.box(x+16,WATER_Y+2,z+40,6,3,16);sb.box(x+16,WATER_Y+5,z+36,4,3,6);
        this._addStatic({pos:sb.pos,nor:sb.nor,uv:sb.uv,idx:sb.idx},[0.7,0.65,0.55],0.6,0.4);
        this._colliderBox(x+16,WATER_Y+2,z+40,6.5,3.5,16.5,'metal');
      }else if(poi.type==='mansion'){
        this._building(poi.x,poi.z,{w:26,d:18,floors:2,wallColor:[0.9,0.88,0.8],roofColor:[0.25,0.3,0.35]});
        this._building(poi.x-30,poi.z+20,{w:10,d:8,floors:1,wallColor:[0.85,0.8,0.7]});
      }else if(poi.type==='ruins'){
        for(let i=0;i<7;i++){const a=i*0.9,x=poi.x+Math.cos(a)*20,z=poi.z+Math.sin(a)*20;
          const rb=new Builder();rb.box(x,this.groundAt(x,z)+(2+this.rng()*3)/2,z,5+this.rng()*4,2+this.rng()*3,0.6);
          this._addStatic({pos:rb.pos,nor:rb.nor,uv:rb.uv,idx:rb.idx},[0.6,0.58,0.5],0.95);
          this._colliderBox(x,this.groundAt(x,z)+2,z,5,4,0.8);}
      }else if(poi.type==='harbor'){
        this._building(poi.x-20,poi.z-20,{w:14,d:10,floors:2,wallColor:[0.6,0.68,0.75]});
        this._building(poi.x+15,poi.z-30,{w:12,d:10,floors:1,wallColor:[0.7,0.65,0.55]});
        const wb=new Builder();wb.box(poi.x,WATER_Y+0.5,poi.z+25,30,1,6);
        this._addStatic({pos:wb.pos,nor:wb.nor,uv:wb.uv,idx:wb.idx},[0.4,0.3,0.22],0.9);
        this._colliderBox(poi.x,WATER_Y+0.5,poi.z+25,30,1.2,6,'wood');
      }
    }
    // casas sueltas repartidas por toda la isla
    for(let i=0;i<26;i++){
      const x=(this.rng()*2-1)*ISLAND*0.85,z=(this.rng()*2-1)*ISLAND*0.85;
      if(isWater(x,z)||terrainHeight(x,z)>24)continue;
      let near=false;for(const p of POIS)if(Math.hypot(x-p.x,z-p.z)<p.r+20)near=true;
      if(near)continue;
      this._building(x,z,{w:8+this.rng()*4,d:7+this.rng()*3,floors:this.rng()>0.8?2:1,wallColor:[0.75+this.rng()*0.2,0.7+this.rng()*0.2,0.6+this.rng()*0.2]});
    }
    // rocas grandes minables dispersas
    for(let i=0;i<40;i++){
      const x=(this.rng()*2-1)*ISLAND*0.9,z=(this.rng()*2-1)*ISLAND*0.9;
      if(isWater(x,z))continue;
      const s=2+this.rng()*3,y=this.groundAt(x,z)+s*0.4;
      this.rocks.push({pos:[x,y,z],size:s,hp:120,mat:'stone'});
    }
    // más coches en ciudad
    for(let i=0;i<10;i++){const p=POIS[1];const x=p.x+(this.rng()*2-1)*70,z=p.z+(this.rng()*2-1)*70;
      if(!isWater(x,z))this._car(x,z);}
  }
  _car(x,z){
    const y=this.groundAt(x,z)+0.9;
    const rot=this.rng()*Math.PI*2;
    this.cars.push({pos:[x,y,z],rot,hp:100,mat:'metal'});
  }
  get carMeshes(){return this._carMesh||(this._carMesh=this._mkCarMesh());}
  _mkCarMesh(){
    const b=new Builder();
    b.box(0,0.55,0,2,0.9,4.4);b.box(0,1.35,-0.3,1.8,0.8,2.2);
    for(const [wx,wz] of [[-1,-1.4],[1,-1.4],[-1,1.4],[1,1.4]])b.box(wx,0.1,wz,0.5,0.7,0.7);
    return {pos:b.pos,nor:b.nor,uv:b.uv,idx:b.idx};
  }
  /* ---------- VEGETACIÓN ---------- */
  _buildVegetation(){
    // tronco + copa low-poly instanciada manualmente (listas separadas por tipo)
    const trunkB=new Builder(),leafB=new Builder();
    trunkB.box(0,1.5,0,0.7,3,0.7);
    leafB.box(0,4.2,0,3.4,2.6,3.4);leafB.box(0,6,0,2.2,1.8,2.2);
    this.trunkMesh=new Mesh(this.gl,{pos:trunkB.pos,nor:trunkB.nor,uv:trunkB.uv,idx:trunkB.idx});
    this.leafMesh=new Mesh(this.gl,{pos:leafB.pos,nor:leafB.nor,uv:leafB.uv,idx:leafB.idx});
    const rng=this.rng;
    for(let i=0;i<240;i++){
      const x=(rng()*2-1)*ISLAND*0.92,z=(rng()*2-1)*ISLAND*0.92;
      if(isWater(x,z))continue;
      const h=terrainHeight(x,z);if(h>28)continue;
      let inPOI=false;for(const p of POIS)if(Math.hypot(x-p.x,z-p.z)<p.r*0.8)inPOI=true;
      if(inPOI&&rng()>0.3)continue;
      const dens=h<6?0.9:0.55; // menos árboles en montañas
      if(rng()>dens)continue;
      this.trees.push({pos:[x,h,z],scale:0.8+rng()*0.9,hp:100,mat:'wood',sway:rng()*6.28});
    }
    // hierba alta decorativa (billboards cruzados) alrededor del jugador: la hacemos con un anillo estático denso cerca del centro de loot
    const grassB=new Builder();
    for(let i=0;i<900;i++){
      const x=(rng()*2-1)*ISLAND*0.8,z=(rng()*2-1)*ISLAND*0.8;
      const h=terrainHeight(x,z);if(h<0.5||h>20)continue;
      const s=0.5+rng()*0.7,a=rng()*Math.PI;
      // cruz de dos quads
      const dx=Math.cos(a)*s,dz=Math.sin(a)*s;
      grassB.quad([x-dx,h,z-dz],[x+dx,h,z+dz],[x+dx,h+s*2,z+dz],[x-dx,h+s*2,z-dz],[0,0,1]);
      grassB.quad([x-dz,h,z+dx],[x+dz,h,z-dx],[x+dz,h+s*2,z-dx],[x-dz,h+s*2,z+dx],[1,0,0]);
    }
    this.grassMesh=new Mesh(this.gl,{pos:grassB.pos,nor:grassB.nor,uv:grassB.uv,idx:grassB.idx});
  }
  /* ---------- LOOT ---------- */
  _buildLoot(){
    const rng=this.rng;const spots=[];
    for(const p of POIS)spots.push(p);
    let id=0;
    const rarities=['common','common','common','uncommon','uncommon','rare','rare','epic','legendary'];
    const items=['pistol','smg','ar','shotgun','sniper','rocket','medkit','shield_small','shield_big','ammo'];
    for(const p of spots){
      const n=p.type==='city'?26:p.type==='mall'?20:p.type==='industrial'?16:12;
      for(let i=0;i<n;i++){
        const a=rng()*6.28,rr=rng()*p.r;
        const x=p.x+Math.cos(a)*rr,z=p.z+Math.sin(a)*rr;
        if(isWater(x,z))continue;
        const it=items[Math.floor(rng()*items.length)];
        const ra=rarities[Math.floor(rng()*rarities.length)];
        this.loot.push({id:id++,pos:[x,this.groundAt(x,z)+0.6,z],item:it,rarity:ra,taken:false});
      }
    }
    // cofres dorados en cada POI
    for(const p of spots){
      const x=p.x+(rng()*2-1)*p.r*0.5,z=p.z+(rng()*2-1)*p.r*0.5;
      if(isWater(x,z))continue;
      this.chests.push({pos:[x,this.groundAt(x,z)+0.7,z],opened:false,lootId:id++});
    }
  }
  /* ---------- DIBUJO DINÁMICO ---------- */
  drawAll(r,p,flags,scene){
    const gl=r.gl;
    const depthPass=!!flags.depth;
    // estáticos (edificios etc.) — en depth pass también se dibujan
    for(const s of this.staticDraws){
      const model=s.model||M4.identity();
      r.drawMesh(s.mesh,model,p,s.color,{rough:s.rough,metal:s.metal});
    }
    // coches
    if(this._carGeoMesh===undefined)this._carGeoMesh=new Mesh(gl,this.carMeshes);
    for(const c of this.cars){
      if(c.dead)continue;
      const m=M4.rotY(M4.translate(M4.identity(),c.pos[0],c.pos[1],c.pos[2]),c.rot);
      r.drawMesh(this._carGeoMesh,m,p,[0.7,0.2,0.25],{rough:0.35,metal:0.8});
    }
    // rocas
    for(const rk of this.rocks){
      if(rk.dead)continue;
      const m=M4.fromTRS(rk.pos,null,[rk.size,rk.size*0.8,rk.size]);
      r.drawMesh(r.sph,m,p,[0.45,0.44,0.42],{rough:0.95});
    }
    // árboles
    for(const t of this.trees){
      if(t.dead)continue;
      const m=M4.fromTRS(t.pos,null,[t.scale,t.scale,t.scale]);
      r.drawMesh(r.trunkMesh||this.trunkMesh,m,p,[0.35,0.24,0.14],{rough:0.95});
      r.drawMesh(r.leafMesh||this.leafMesh,m,p,[0.15,0.42,0.12],{rough:0.9});
    }
    // hierba
    if(!depthPass){
      r.drawMesh(this.grassMesh,M4.identity(),p,[0.25,0.5,0.18],{rough:1});
    }
    // construcciones del jugador/bots
    if(this.buildMeshCb)this.buildMeshCb(r,p,scene,depthPass);
    // loot (haz de luz + cajita)
    if(!depthPass&&this.lootMeshCb)this.lootMeshCb(r,p,scene);
    // personajes
    if(this.charCb)this.charCb(r,p,scene,depthPass);
    // proyectiles/partículas
    if(this.fxMeshCb)this.fxMeshCb(r,p,scene);
    // previsualización de construcción
    if(this.previewCb)this.previewCb(r,p,scene);
  }
}
