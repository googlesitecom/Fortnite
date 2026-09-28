// ===== Física propia: gravedad, cápsula vs AABBs, raycasting, proyectiles balísticos =====
import {V3,clamp} from './math.js';

export const GRAV=-24;           // m/s² (arcade, más rápido que real)
export const TERM_VEL=-55;      // caída terminal sin planeador
export const GLIDE_VEL=-7;      // planeador desplegado
const PLAYER_R=0.45,PLAYER_H=1.8;

/* Colisión cápsula (posición = pies) contra lista de AABBs.
   Resuelve penetración empujando al eje de mínima intrusión. */
export function collideCapsule(pos,vel,colliders,radius,height){
  const r=radius||PLAYER_R,h=height||PLAYER_H;
  let onGround=false,groundY=null,groundNormal=null,hitSomething=false;
  for(const c of colliders){
    if(c.disabled)continue;
    const min=c.min,max=c.max;
    // expandir AABB por radio en x/z, y tratar como caja + altura jugador
    const px=pos[0],py=pos[1],pz=pos[2];
    if(px+r<min[0]||px-r>max[0])continue;
    if(pz+r<min[2]||pz-r>max[2])continue;
    if(py+h<min[1]||py>max[1])continue;
    // penetration depths
    const dxp=(px+r)-min[0],dxn=max[0]-(px-r);
    const dzp=(pz+r)-min[2],dzn=max[2]-(pz-r);
    const dyp=(py+h)-min[1],dyn=max[1]-py;
    const m=Math.min(dxp,dxn,dzp,dzn,dyp,dyn);
    hitSomething=true;
    if(m===dyp&&vel[1]<=0.001){ // aterrizar encima
      pos[1]=min[1]-h-0.001;vel[1]=0;onGround=true;groundY=min[1];groundNormal=[0,1,0];
    }else if(m===dyn){pos[1]=max[1]+0.001;if(vel[1]<0)vel[1]=0;}
    else if(m===dxp){pos[0]=min[0]-r-0.001;vel[0]=Math.min(vel[0],0);}
    else if(m===dxn){pos[0]=max[0]+r+0.001;vel[0]=Math.max(vel[0],0);}
    else if(m===dzp){pos[2]=min[2]-r-0.001;vel[2]=Math.min(vel[2],0);}
    else if(m===dzn){pos[2]=max[2]+r+0.001;vel[2]=Math.max(vel[2],0);}
  }
  return {onGround,groundY,groundNormal,hitSomething};
}

/* Ray vs AABB (slab). Devuelve t o null */
export function rayAABB(ro,rd,min,max){
  let tmin=-Infinity,tmax=Infinity;
  for(let i=0;i<3;i++){
    if(Math.abs(rd[i])<1e-8){if(ro[i]<min[i]||ro[i]>max[i])return null;continue;}
    const inv=1/rd[i];
    let t1=(min[i]-ro[i])*inv,t2=(max[i]-ro[i])*inv;
    if(t1>t2){const tmp=t1;t1=t2;t2=tmp;}
    tmin=Math.max(tmin,t1);tmax=Math.min(tmax,t2);
    if(tmin>tmax)return null;
  }
  if(tmax<0)return null;
  return tmin>=0?tmin:tmax;
}
/* Raycast contra mundo: colliders + esferas (árboles/rocas) + loot no. Devuelve {t,obj,normal} */
export function raycastWorld(ro,rd,maxDist,colliders,spheres){
  let best=null;
  for(const c of colliders){
    if(c.disabled)continue;
    const t=rayAABB(ro,rd,c.min,c.max);
    if(t!==null&&t<=maxDist&&(!best||t<best.t)){
      // normal aproximada: cara más cercana al punto de impacto
      const p=[ro[0]+rd[0]*t,ro[1]+rd[1]*t,ro[2]+rd[2]*t];
      const cx=(c.min[0]+c.max[0])/2,cy=(c.min[1]+c.max[1])/2,cz=(c.min[2]+c.max[2])/2;
      const ex=(c.max[0]-c.min[0])/2,ey=(c.max[1]-c.min[1])/2,ez=(c.max[2]-c.min[2])/2;
      const dx=(p[0]-cx)/ex,dy=(p[1]-cy)/ey,dz=(p[2]-cz)/ez;
      let n=[0,1,0];
      if(Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>Math.abs(dz))n=[Math.sign(dx),0,0];
      else if(Math.abs(dy)>Math.abs(dz))n=[0,Math.sign(dy),0];
      else n=[0,0,Math.sign(dz)];
      best={t,obj:c,normal:n};
    }
  }
  if(spheres)for(const s of spheres){
    // esfera aproximada
    const oc=[s.pos[0]-ro[0],s.pos[1]-ro[1],s.pos[2]-ro[2]];
    const b=oc[0]*rd[0]+oc[1]*rd[1]+oc[2]*rd[2];
    const cc=oc[0]*oc[0]+oc[1]*oc[1]+oc[2]*oc[2]-s.r*s.r;
    const disc=b*b-cc;
    if(disc<0)continue;
    const t=b-Math.sqrt(disc);
    if(t>=0&&t<=maxDist&&(!best||t<best.t)){
      const p=[ro[0]+rd[0]*t,ro[1]+rd[1]*t,ro[2]+rd[2]*t];
      best={t,obj:s,normal:V3.norm(V3.sub(p,s.pos))};
    }
  }
  return best;
}
/* Intersección cápsula-personaje vs ray (para dar a enemigos): cilindro vertical */
export function rayCapsule(ro,rd,capPos,capR,capH,maxDist){
  // probar esfera cabeza
  const headP=[capPos[0],capPos[1]+capH*0.9,capPos[2]],headR=capR*1.15;
  const testSphere=(c,r)=>{
    const oc=[c[0]-ro[0],c[1]-ro[1],c[2]-ro[2]];
    const b=oc[0]*rd[0]+oc[1]*rd[1]+oc[2]*rd[2];
    const disc=b*b-(oc[0]*oc[0]+oc[1]*oc[1]+oc[2]*oc[2]-r*r);
    if(disc<0)return null;const t=b-Math.sqrt(disc);return t>=0&&t<=maxDist?t:null;
  };
  const th=testSphere(headP,headR);
  // cuerpo: segmento vertical + radio (cilindro infinito recortado)
  const cylT=(y0,y1)=>{
    let tmin=-Infinity,tmax=Infinity;
    // x,z slab del cilindro
    for(const ax of [0,2]){
      const d=rd[ax],o=ro[ax]-capPos[ax];
      if(Math.abs(d)<1e-8){if(o*o>capR*capR)return null;continue;}
      // resolver |o+d t|^2 = r^2 con el otro eje horizontal
      const oth=ax===0?2:0;
      const oo=ro[oth]-capPos[oth];
      const A=d*d, B=2*o*d, C=o*o+oo*oo-capR*capR;
      const disc=B*B-4*A*C;if(disc<0)return null;
      const sq=Math.sqrt(disc);
      let t1=(-B-sq)/(2*A),t2=(-B+sq)/(2*A);
      tmin=Math.max(tmin,t1);tmax=Math.min(tmax,t2);
    }
    // y slab entre y0..y1
    if(Math.abs(rd[1])<1e-8){if(ro[1]<y0||ro[1]>y1)return null;}
    else{
      const inv=1/rd[1];
      let t1=(y0-ro[1])*inv,t2=(y1-ro[1])*inv;
      if(t1>t2){const tt=t1;t1=t2;t2=tt;}
      tmin=Math.max(tmin,t1);tmax=Math.min(tmax,t2);
    }
    if(tmin>tmax||tmax<0)return null;
    return tmin>=0?tmin:tmax;
  };
  const tc=cylT(capPos[1],capPos[1]+capH*0.78);
  let t=null,head=false;
  if(th!==null)t=th;
  if(tc!==null&&(t===null||tc<t)){t=tc;head=false;}else if(th!==null)head=true;
  if(t===null||t>maxDist)return null;
  return {t,head};
}

/* Integración de proyectil con gravedad (balística) */
export function stepProjectile(pr,dt,world){
  pr.vel[1]+=GRAV*pr.grav*dt;
  const steps=Math.max(1,Math.ceil(V3.len(pr.vel)*dt/2));
  const sdt=dt/steps;
  for(let i=0;i<steps;i++){
    const p=[...pr.pos];
    pr.pos[0]+=pr.vel[0]*sdt;pr.pos[1]+=pr.vel[1]*sdt;pr.pos[2]+=pr.vel[2]*sdt;
    // colisión con terreno
    const gh=world.groundAt(pr.pos[0],pr.pos[2]);
    if(pr.pos[1]<=gh){pr.hit={type:'ground',pos:[...pr.pos]};return true;}
    // colisión con AABBs cercanos
    for(const c of world.colliders){
      if(c.disabled)continue;
      const mn=c.min,mx=c.max;
      if(pr.pos[0]>mn[0]&&pr.pos[0]<mx[0]&&pr.pos[1]>mn[1]&&pr.pos[1]<mx[1]&&pr.pos[2]>mn[2]&&pr.pos[2]<mx[2]){
        pr.hit={type:'obj',pos:[...pr.pos],obj:c};return true;}
    }
    if(pr.life!==undefined){pr.life-=sdt;if(pr.life<=0){pr.hit={type:'expire',pos:[...pr.pos]};return true;}}
  }
  return false;
}
