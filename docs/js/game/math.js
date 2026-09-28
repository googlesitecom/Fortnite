// ===== Battle Island — matemáticas 3D (columna-4, right-handed) =====
export const V3 = {
  create:(x=0,y=0,z=0)=>[x,y,z],
  add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],
  sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
  scale:(a,s)=>[a[0]*s,a[1]*s,a[2]*s],
  dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
  cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
  len:(a)=>Math.hypot(a[0],a[1],a[2]),
  lenSq:(a)=>a[0]*a[0]+a[1]*a[1]+a[2]*a[2],
  norm:(a)=>{const l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];},
  dist:(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]),
  dist2D:(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]),
  lerp:(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t],
};
export const M4 = {
  identity:()=>new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
  mul:(a,b)=>{ // a*b en orden de columna-primero (result = A × B)
    const o=new Float32Array(16);
    for(let c=0;c<4;c++)for(let r=0;r<4;r++){
      o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
    }
    return o;
  },
  persp:(fovY,aspect,near,far)=>{
    const f=1/Math.tan(fovY/2),nf=1/(near-far);
    return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
  },
  ortho:(l,r,b,t,n,f)=>{
    const lr=1/(l-r),bt=1/(b-t),nf=1/(n-f);
    return new Float32Array([-2*lr,0,0,0, 0,-2*bt,0,0, 0,0,2*nf,0, (l+r)*lr,(t+b)*bt,(f+n)*nf,1]);
  },
  translate:(m,x,y,z)=>{
    const o=new Float32Array(m);
    o[12]=m[0]*x+m[4]*y+m[8]*z+m[12];
    o[13]=m[1]*x+m[5]*y+m[9]*z+m[13];
    o[14]=m[2]*x+m[6]*y+m[10]*z+m[14];
    o[15]=m[3]*x+m[7]*y+m[11]*z+m[15];
    return o;
  },
  scale:(m,x,y,z)=>{const o=new Float32Array(m);
    for(let i=0;i<4;i++){o[i]=m[i]*x;o[4+i]=m[4+i]*y;o[8+i]=m[8+i]*z;}return o;},
  rotY:(m,a)=>{const c=Math.cos(a),s=Math.sin(a),o=new Float32Array(m);
    for(let i=0;i<4;i++){o[i]=m[i]*c-m[8+i]*s;o[8+i]=m[i]*s+m[8+i]*c;}return o;},
  rotX:(m,a)=>{const c=Math.cos(a),s=Math.sin(a),o=new Float32Array(m);
    for(let i=0;i<4;i++){o[4+i]=m[4+i]*c+m[8+i]*s;o[8+i]=m[8+i]*c-m[4+i]*s;}return o;},
  rotZ:(m,a)=>{const c=Math.cos(a),s=Math.sin(a),o=new Float32Array(m);
    for(let i=0;i<4;i++){o[i]=m[i]*c+m[4+i]*s;o[4+i]=m[4+i]*c-m[i]*s;}return o;},
  lookAt:(eye,center,up)=>{
    const z=V3.norm(V3.sub(eye,center));
    const x=V3.norm(V3.cross(up,z));
    const y=V3.cross(z,x);
    return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
      -V3.dot(x,eye),-V3.dot(y,eye),-V3.dot(z,eye),1]);
  },
  invert:(m)=>{
    const a00=m[0],a01=m[1],a02=m[2],a03=m[3],a10=m[4],a11=m[5],a12=m[6],a13=m[7],
          a20=m[8],a21=m[9],a22=m[10],a23=m[11],a30=m[12],a31=m[13],a32=m[14],a33=m[15];
    const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10,b03=a01*a12-a02*a11,
          b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,
          b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
    let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if(!det)return M4.identity(); det=1/det;
    return new Float32Array([
      (a11*b11-a12*b10+a13*b09)*det,(a02*b10-a01*b11-a03*b09)*det,(a31*b05-a32*b04+a33*b03)*det,(a22*b04-a21*b05-a23*b03)*det,
      (a12*b08-a10*b11-a13*b07)*det,(a00*b11-a02*b08+a03*b07)*det,(a32*b02-a30*b05-a33*b01)*det,(a20*b05-a22*b02+a23*b01)*det,
      (a10*b10-a11*b08+a13*b06)*det,(a01*b08-a00*b10-a03*b06)*det,(a30*b04-a31*b02+a33*b00)*det,(a21*b02-a20*b04-a23*b00)*det,
      (a11*b07-a10*b09-a12*b06)*det,(a00*b09-a01*b07+a02*b06)*det,(a31*b01-a30*b03-a32*b00)*det,(a20*b03-a21*b01+a22*b00)*det]);
  },
  transpose:(m)=>new Float32Array([m[0],m[4],m[8],m[12], m[1],m[5],m[9],m[13], m[2],m[6],m[10],m[14], m[3],m[7],m[11],m[15]]),
  // normal matrix (mat3 como float12 con relleno): inversa-transpuesta del modelo sin traslación
  normalMat3:(m)=>{
    const inv=M4.invert(m);
    return new Float32Array([inv[0],inv[4],inv[8], inv[1],inv[5],inv[9], inv[2],inv[6],inv[10]]);
  },
  fromTRS:(pos,rotYv,scl)=>{
    let m=M4.identity();
    m=M4.translate(m,pos[0],pos[1],pos[2]);
    if(rotYv){m=M4.rotY(m,rotYv[1]||0);m=M4.rotX(m,rotYv[0]||0);m=M4.rotZ(m,rotYv[2]||0);}
    return M4.scale(m,scl[0],scl[1],scl[2]);
  },
};
export const clamp=(v,a,b)=>v<a?a:v>b?b:v;
export const lerp=(a,b,t)=>a+(b-a)*t;
export function rand(seedFn){return seedFn();}
// PRNG determinista (mulberry32) para generar el mundo igual en todos lados
export function makeRng(seed){
  let t=seed>>>0;
  return ()=>{t+=0x6D2B79F5;let r=Math.imul(t^t>>>15,1|t);r^=r+Math.imul(r^r>>>7,61|r);
    return ((r^r>>>14)>>>0)/4294967296;};
}

export const ISLAND_LIM=560;
