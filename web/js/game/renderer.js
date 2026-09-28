// ===== Renderizador WebGL2 propio: PBR + CSM + post-proceso (bloom) + cielo procedural =====
import {M4,V3,clamp} from './math.js';

const compile=(gl,type,src)=>{
  const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)+"\n"+src.split('\n').map((l,i)=>(i+1)+': '+l).join('\n').slice(0,3000));
  return s;
};
export function makeProgram(gl,vs,fs){
  const p=gl.createProgram();
  gl.attachShader(p,compile(gl,gl.VERTEX_SHADER,vs));
  gl.attachShader(p,compile(gl,gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  p.u={};p.a={};
  const nu=gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);
  for(let i=0;i<nu;i++){const info=gl.getActiveUniform(p,i);p.u[info.name.replace('[0]','')]=gl.getUniformLocation(p,info.name);}
  const na=gl.getProgramParameter(p,gl.ACTIVE_ATTRIBUTES);
  for(let i=0;i<na;i++){const info=gl.getActiveAttrib(p,i);p.a[info.name]=gl.getAttribLocation(p,info.name);}
  return p;
}

/* ---------- SHADERS ---------- */
const LIGHTING_GLSL=`
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSkyTint; uniform vec3 uGroundTint;
uniform float uTime; uniform int uUseShadows; uniform sampler2D uShadowMap; uniform mat4 uShadowMat[4];
uniform float uCascadeEnds[4]; uniform vec3 uCamPos; uniform float uFogDensity; uniform vec3 uFogColor;
struct Surface{vec3 P;vec3 N;vec3 albedo;float rough;float metal;float emis;};
float distCascade(vec3 P){float d=length(P-uCamPos);return d;}
vec3 pbr(Surface s,vec3 L,vec3 Vv,vec3 C,float shadow){
  vec3 H=normalize(L+Vv);
  float NdL=max(dot(s.N,L),0.0),NdH=max(dot(s.N,H),0.0),Ndv=max(dot(s.N,Vv),1e-4),VdH=max(dot(Vv,H),0.0);
  float a=max(s.rough*s.rough,0.001);float a2=a*a;
  float D=a2/(NdH*NdH*(a2-1.0)+1.0);D=D*D/(3.14159);
  float k=a*0.5;float G=(NdL/(NdL*(1.0-k)+k))*(Ndv/(Ndv*(1.0-k)+k));
  vec3 F0=mix(vec3(0.04),s.albedo,s.metal);
  vec3 F=F0+(1.0-F0)*pow(1.0-VdH,5.0);
  vec3 spec=(D*G*max(F,0.0))/(4.0*NdL*Ndv+1e-4);
  vec3 kd=(1.0-F)*(1.0-s.metal);
  return (kd*s.albedo/3.14159+spec)*C*NdL*shadow;
}
float sampleShadow(vec3 P,vec3 N){
  if(uUseShadows==0)return 1.0;
  float d=distCascade(P);int ci=0;
  if(d>uCascadeEnds[0])ci=1; if(d>uCascadeEnds[1])ci=2; if(d>uCascadeEnds[2])ci=3;
  vec4 sp=uShadowMat[ci]*vec4(P+N*0.6,1.0);
  vec3 pc=sp.xyz/sp.w*0.5+0.5;
  if(pc.x<0.0||pc.x>1.0||pc.y<0.0||pc.y>1.0||pc.z>1.0)return 1.0;
  float bias=0.0015+0.006*(1.0-clamp(dot(N,uSunDir),0.0,1.0));
  float lit=0.0;
  for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){
    float z=texture(uShadowMap,pc.xy+vec2(float(x),float(y))/2048.0).r;
    lit+=step(z+bias,pc.z);
  }
  return lit/9.0;
}
vec3 skyIrr(Surface s){
  vec3 up=s.N;
  vec3 irr=mix(uGroundTint,uSkyTint,up.y*0.5+0.5);
  return irr*mix(0.35,1.0,s.metal*0.5+0.35);
}
vec3 shade(Surface s){
  vec3 Vv=normalize(uCamPos-s.P);
  float sh=sampleShadow(s.P,s.N);
  vec3 c=pbr(s,uSunDir,Vv,uSunColor,sh);
  c+=s.albedo*skyIrr(s)*mix(0.9,0.35,s.metal*0.4);
  c+=s.albedo*s.emis;
  // niebla atmosférica exponencial
  float dist=length(s.P-uCamPos);
  float fog=1.0-exp(-dist*uFogDensity);
  c=mix(c,uFogColor,clamp(fog,0.0,1.0));
  return c;
}`;

const SCENE_VS=`#version 300 es
layout(location=0)in vec3 aPos;layout(location=1)in vec3 aNormal;layout(location=2)in vec2 aUV;
uniform mat4 uProj,uView,uModel;uniform mat3 uNormalMat;
out vec3 vP;out vec3 vN;out vec2 vUV;
void main(){vec4 w=uModel*vec4(aPos,1.0);vP=w.xyz;vN=normalize(uNormalMat*aNormal);vUV=aUV;gl_Position=uProj*uView*w;}`;

const SCENE_FS=`#version 300 es
precision highp float;
in vec3 vP;in vec3 vN;in vec2 vUV;
uniform vec4 uColor; uniform float uRough,uMetal,uEmis; uniform int uUseTex; uniform sampler2D uTex;
${LIGHTING_GLSL}
out vec4 o;
void main(){
  Surface s;s.P=vP;s.N=normalize(vN);
  vec4 t=uUseTex==1?texture(uTex,vUV):vec4(1.0);
  s.albedo=uColor.rgb*t.rgb;s.rough=uRough;t.a*=uColor.a;
  s.metal=uMetal;s.emis=uEmis;
  o=vec4(shade(s),t.a);
}`;

const TERRAIN_FS=`#version 300 es
precision highp float;
in vec3 vP;in vec3 vN;in vec2 vUV;
uniform float uWaterY;
${LIGHTING_GLSL}
out vec4 o;
void main(){
  Surface s;s.P=vP;s.N=normalize(vN);
  float h=vP.y;
  vec3 grass=vec3(0.22,0.42,0.16),grass2=vec3(0.32,0.5,0.2),sand=vec3(0.76,0.68,0.44),
       rock=vec3(0.42,0.4,0.38),snow=vec3(0.92,0.94,0.97),swamp=vec3(0.18,0.3,0.14),desert=vec3(0.72,0.58,0.34);
  // bioma por posición (x,z) en manchas suaves
  float bm=sin(vP.x*0.004)*cos(vP.z*0.0035)+sin(vP.x*0.011+2.0)*cos(vP.z*0.009);
  vec3 col=mix(grass,grass2,clamp(sin(vP.x*0.05)*sin(vP.z*0.05)*0.5+0.5,0.0,1.0));
  if(bm>0.9)col=mix(col,desert,0.8);
  if(bm<-1.2)col=mix(col,swamp,0.7);
  float slope=1.0-abs(vN.y);
  col=mix(col,rock,clamp(slope*2.2,0.0,1.0));
  if(h<0.6)col=mix(sand,col,clamp(h/0.6,0.0,1.0));
  if(h>26.0)col=mix(col,snow,clamp((h-26.0)/8.0,0.0,1.0));
  s.albedo=col;s.rough=0.95;s.metal=0.0;s.emis=0.0;
  o=vec4(shade(s),1.0);
}`;

const WATER_VS=`#version 300 es
layout(location=0)in vec3 aPos;layout(location=1)in vec3 aNormal;layout(location=2)in vec2 aUV;
uniform mat4 uProj,uView,uModel;uniform float uTime;
out vec3 vP;out vec3 vN;
void main(){
  vec3 p=aPos;
  p.y+=sin(p.x*0.35+uTime*1.4)*0.12+cos(p.z*0.3+uTime*1.1)*0.1;
  float nx=cos(p.x*0.35+uTime*1.4)*0.35*0.12, nz=-sin(p.z*0.3+uTime*1.1)*0.3*0.1;
  vN=normalize(vec3(-nx,1.0,-nz));
  vec4 w=uModel*vec4(p,1.0);vP=w.xyz;gl_Position=uProj*uView*w;
}`;
const WATER_FS=`#version 300 es
precision highp float;
in vec3 vP;in vec3 vN;
uniform float uTime;uniform vec3 uSunDir,uSunColor,uCamPos,uFogColor;uniform float uFogDensity;
out vec4 o;
void main(){
  vec3 N=normalize(vN);vec3 V=normalize(uCamPos-vP);
  vec3 deep=vec3(0.02,0.16,0.26),shal=vec3(0.05,0.4,0.45);
  float fres=pow(1.0-max(dot(N,V),0.0),3.0);
  vec3 R=reflect(-V,N);
  float sky=pow(clamp(R.y*0.5+0.5,0.0,1.0),0.6);
  vec3 col=mix(deep,shal,clamp(0.4+R.y,0.0,1.0));
  col=mix(col,mix(vec3(0.45,0.65,0.95),vec3(0.9,0.95,1.0),sky),fres*0.9+0.15);
  // especular sol + destello
  vec3 H=normalize(uSunDir+V);
  float spec=pow(max(dot(N,H),0.0),160.0)*3.0;
  float sparkle=pow(max(dot(N,H),0.0),900.0)*8.0*(0.6+0.4*sin(vP.x*3.0+vP.z*2.7+uTime*3.0));
  col+=(spec+sparkle)*uSunColor;
  float dist=length(vP-uCamPos);
  col=mix(col,uFogColor,clamp(1.0-exp(-dist*uFogDensity),0.0,1.0));
  o=vec4(col,0.92);
}`;

const SKY_VS=`#version 300 es
layout(location=0)in vec3 aPos;uniform mat4 uProjInvView;out vec3 vRay;
void main(){vec4 p=uProjInvView*vec4(aPos.xy,1.0,1.0);vRay=p.xyz/p.w;gl_Position=vec4(aPos.xy,0.9999,1.0);}`;
const SKY_FS=`#version 300 es
precision highp float;in vec3 vRay;out vec4 o;
uniform vec3 uSunDir;uniform float uTime,uHour;
// cielo de Preethy simplificado + nubes volumétricas por raymarching (low-cost)
vec3 skyCol(vec3 d){
  float sunAmt=max(dot(d,uSunDir),0.0);
  float day=smoothstep(-0.15,0.25,uSunDir.y);
  vec3 zenith=mix(vec3(0.05,0.08,0.2),vec3(0.22,0.44,0.85),day);
  vec3 horiz=mix(vec3(0.35,0.25,0.3),vec3(0.72,0.85,0.98),day);
  // tinte atardecer
  float sunset=exp(-abs(uSunDir.y)*6.0);
  horiz=mix(horiz,vec3(1.0,0.45,0.18),sunset*0.8);
  float hz=pow(1.0-max(d.y,0.0),3.0);
  vec3 c=mix(zenith,horiz,hz);
  c+=pow(sunAmt,800.0)*vec3(1.0,0.9,0.7)*6.0*day+ pow(sunAmt,64.0)*vec3(1.0,0.6,0.3)*0.6;
  return c;
}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.1;a*=0.5;}return v;}
void main(){
  vec3 d=normalize(vRay);
  vec3 c=skyCol(d);
  if(d.y>0.02){
    // nubes: proyección sobre plano a altura 300
    float t=300.0/d.y;
    vec2 uv=d.xz*t*0.0006+vec2(uTime*0.004,0.0);
    float cl=fbm(uv*3.0);
    float cov=smoothstep(0.48,0.72,cl)*smoothstep(0.02,0.2,d.y);
    float light=clamp(dot(normalize(vec3(d.x*0.2,1.0,d.z*0.2))+uSunDir*0.9,vec3(0.0,1.0,0.0)),0.0,1.0);
    vec3 cloudC=mix(vec3(0.55,0.55,0.62),vec3(1.0,0.98,0.95),light);
    cloudC=mix(cloudC,vec3(1.0,0.7,0.5),exp(-abs(uSunDir.y)*5.0)*0.7);
    c=mix(c,cloudC,cov*0.9);
  }
  if(d.y<-0.02)c=mix(c,vec3(0.05,0.1,0.16),0.7); // "mar" lejano bajo el horizonte
  o=vec4(c,1.0);
}`;

const STORM_FS=`#version 300 es
precision highp float;
in vec3 vP;in vec3 vN;in vec2 vUV;
uniform vec3 uCenter;uniform float uRadius,uTime;
out vec4 o;
void main(){
  float ang=atan(vP.z-uCenter.z,vP.x-uCenter.x);
  float e=abs(length(vP.xz-uCenter.xz)-uRadius);
  float band=exp(-e*0.25);
  float bolts=pow(fract(sin(ang*14.0+uTime*2.0)*43758.5)*0.5+0.5*pow(abs(sin(vP.y*0.3+uTime*4.0+ang*9.0)),14.0),1.0);
  vec3 col=mix(vec3(0.25,0.1,0.6),vec3(0.6,0.35,1.0),band);
  col+=vec3(0.7,0.8,1.0)*bolts*band*2.0;
  float alpha=clamp(band*0.55+bolts*0.3,0.0,0.85);
  o=vec4(col,alpha);
}`;

const BRIGHT_FS=`#version 300 es
precision highp float;in vec2 vUV;uniform sampler2D uTex;uniform float uThresh;out vec4 o;
void main(){vec3 c=texture(uTex,vUV).rgb;float l=dot(c,vec3(0.2126,0.7152,0.0722));
o=vec4(c*smoothstep(uThresh,uThresh+0.6,l),1.0);}`;
const BLUR_FS=`#version 300 es
precision highp float;in vec2 vUV;uniform sampler2D uTex;uniform vec2 uDir;out vec4 o;
void main(){vec2 t=1.0/vec2(textureSize(uTex,0));
vec3 s=texture(uTex,vUV).rgb*0.227;
s+=texture(uTex,vUV+uDir*t*1.384).rgb*0.316;s+=texture(uTex,vUV-uDir*t*1.384).rgb*0.316;
s+=texture(uTex,vUV+uDir*t*3.23).rgb*0.07;s+=texture(uTex,vUV-uDir*t*3.23).rgb*0.07;
o=vec4(s,1.0);}`;
const COMP_FS=`#version 300 es
precision highp float;in vec2 vUV;uniform sampler2D uScene,uBloom;
uniform float uBloomStr,uExposure,uVignette,uGrain,uTime,uAberr;uniform int uDoFx;out vec4 o;
vec3 aces(vec3 x){float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 uv=vUV;
  vec3 col;
  if(uDoFx==1){
    float r=texture(uScene,uv+vec2(uAberr,0.0)).r,g=texture(uScene,uv).g,b=texture(uScene,uv-vec2(uAberr,0.0)).b;
    col=vec3(r,g,b);
  }else col=texture(uScene,uv).rgb;
  if(uBloomStr>0.0)col+=texture(uBloom,uv).rgb*uBloomStr;
  col*=uExposure;
  col=aces(col);
  col=pow(col,vec3(1.0/2.2));
  // vignette + grain
  float v=length(uv-0.5);col*=1.0-uVignette*v*v;
  col+=(hash(uv*vec2(1920.0,1080.0)+uTime)-0.5)*uGrain;
  o=vec4(col,1.0);
}`;

const FS_VS=`#version 300 es
layout(location=0)in vec2 aPos;out vec2 vUV;
void main(){vUV=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}`;

/* ---------- HELPERS GPU ---------- */
export class Mesh{
  constructor(gl,data){
    this.gl=gl;this.vao=gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this._bufs=[];
    const interleave=data.interleaved;
    if(interleave){
      // [px,py,pz,nx,ny,nz,u,v] stride 32
      const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data.verts),gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,32,0);
      gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,32,12);
      gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,2,gl.FLOAT,false,32,24);
      this._bufs.push(b);
    }else{
      const bind=(arr,loc,size)=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(arr),gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,0,0);this._bufs.push(b);};
      bind(data.pos,0,3);bind(data.nor,1,3);if(data.uv)bind(data.uv,2,2);
    }
    this.count=data.idx.length;
    const hasBig=data.idx.some(v=>v>65535);
    this.itype=hasBig?gl.UNSIGNED_INT:gl.UNSIGNED_SHORT;
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,hasBig?new Uint32Array(data.idx):new Uint16Array(data.idx),gl.STATIC_DRAW);
    this._bufs.push(ib);
    gl.bindVertexArray(null);
  }
  bind(){this.gl.bindVertexArray(this.vao);}
}
function makeFBO(gl,w,h,depth=true){
  const fb=gl.createFramebuffer(),tex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,w,h,0,gl.RGBA,gl.HALF_FLOAT,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  let rb=null;
  if(depth){rb=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,rb);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,w,h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,rb);}
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  return {fb,tex,rb,w,h,resize(nw,nh){
    gl.bindTexture(gl.TEXTURE_2D,tex);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,nw,nh,0,gl.RGBA,gl.HALF_FLOAT,null);
    if(rb){gl.bindRenderbuffer(gl.RENDERBUFFER,rb);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,nw,nh);}
    this.w=nw;this.h=nh;}};
}

/* ---------- PRIMITIVAS ---------- */
export function boxGeo(){const p=[-.5,-.5,-.5,.5,-.5,-.5,.5,.5,-.5,-.5,.5,-.5,-.5,-.5,.5,.5,-.5,.5,.5,.5,.5,-.5,.5,.5];
  const f=[[4,5,6,7],[1,0,3,2],[5,1,2,6],[0,4,7,3],[3,7,6,2],[4,0,1,5]];
  const nrm=[[0,0,-1],[0,0,1],[0,-1,0],[0,1,0],[-1,0,0],[1,0,0]];
  const pos=[],nor=[],uv=[],idx=[];let vi=0;
  f.forEach((q,fi)=>{q.forEach(v=>{pos.push(...p.slice(v*3,v*3+3));nor.push(...nrm[fi]);});
    uv.push(0,0,1,0,1,1,0,1);idx.push(vi,vi+1,vi+2,vi,vi+2,vi+3);vi+=4;});
  return {pos,nor,uv,idx};}
export function cylGeo(seg=14,r=0.5,h=1){const pos=[],nor=[],uv=[],idx=[];
  for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2,x=Math.cos(a),z=Math.sin(a);
    pos.push(x*r,-h/2,z*r,x*r,h/2,z*r);nor.push(x,0,z,x,0,z);uv.push(i/seg,0,i/seg,1);}
  for(let i=0;i<seg;i++){const b=i*2;idx.push(b,b+1,b+3,b,b+3,b+2);}
  // tapas
  let c=pos.length/3;pos.push(0,h/2,0);nor.push(0,1,0);uv.push(.5,.5);
  for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2;pos.push(Math.cos(a)*r,h/2,Math.sin(a)*r);nor.push(0,1,0);uv.push(.5+Math.cos(a)*.5,.5+Math.sin(a)*.5);}
  for(let i=0;i<seg;i++)idx.push(c,c+1+i,c+2+i);
  c=pos.length/3;pos.push(0,-h/2,0);nor.push(0,-1,0);uv.push(.5,.5);
  for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2;pos.push(Math.cos(a)*r,-h/2,Math.sin(a)*r);nor.push(0,-1,0);uv.push(.5+Math.cos(a)*.5,.5+Math.sin(a)*.5);}
  for(let i=0;i<seg;i++)idx.push(c,c+2+i,c+1+i);
  return {pos,nor,uv,idx};}
export function sphereGeo(lat=10,lon=14,r=0.5){const pos=[],nor=[],uv=[],idx=[];
  for(let i=0;i<=lat;i++){const th=i/lat*Math.PI;
    for(let j=0;j<=lon;j++){const ph=j/lon*Math.PI*2;
      const x=Math.sin(th)*Math.cos(ph),y=Math.cos(th),z=Math.sin(th)*Math.sin(ph);
      pos.push(x*r,y*r,z*r);nor.push(x,y,z);uv.push(j/lon,i/lat);}}
  for(let i=0;i<lat;i++)for(let j=0;j<lon;j++){const a=i*(lon+1)+j,b=a+lon+1;
    idx.push(a,b,a+1,a+1,b,b+1);}
  return {pos,nor,uv,idx};}
export function coneGeo(seg=12,r=0.5,h=1){const pos=[],nor=[],uv=[],idx=[];
  pos.push(0,h/2,0);nor.push(0,1,0);uv.push(.5,1);
  for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2,x=Math.cos(a),z=Math.sin(a);
    pos.push(x*r,-h/2,z*r);nor.push(x*.6,.577,z*.6);uv.push(i/seg,0);}
  for(let i=0;i<seg;i++)idx.push(0,2+i,1+i);
  let c=pos.length/3;pos.push(0,-h/2,0);nor.push(0,-1,0);uv.push(.5,.5);
  for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2;pos.push(Math.cos(a)*r,-h/2,Math.sin(a)*r);nor.push(0,-1,0);uv.push(0,0);}
  for(let i=0;i<seg;i++)idx.push(c,c+1+i,c+2+i);
  return {pos,nor,uv,idx};}

/* ---------- RENDERER ---------- */
export class Renderer{
  constructor(canvas){
    const gl=this.gl=canvas.getContext('webgl2',{antialias:false,alpha:false,powerPreference:'high-performance'});
    if(!gl)throw new Error('WebGL2 no soportado');
    gl.getExtension('EXT_color_buffer_float');gl.getExtension('OES_texture_float_linear');
    this.canvas=canvas;
    this.progScene=makeProgram(gl,SCENE_VS,SCENE_FS);
    this.progTerrain=makeProgram(gl,SCENE_VS,TERRAIN_FS);
    this.progWater=makeProgram(gl,WATER_VS,WATER_FS);
    this.progSky=makeProgram(gl,SKY_VS,SKY_FS);
    this.progStorm=makeProgram(gl,SCENE_VS,STORM_FS);
    this.progDepth=makeProgram(gl,SCENE_VS,`#version 300 es\nprecision highp float;void main(){}`);
    this.progBright=makeProgram(gl,FS_VS,BRIGHT_FS);
    this.progBlur=makeProgram(gl,FS_VS,BLUR_FS);
    this.progComp=makeProgram(gl,FS_VS,COMP_FS);
    // quad fullscreen
    this.quadVAO=gl.createVertexArray();gl.bindVertexArray(this.quadVAO);
    const qb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,qb);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.bindVertexArray(null);
    // primitivas compartidas
    this.box=new Mesh(gl,boxGeo());this.cyl=new Mesh(gl,cylGeo(16));
    this.sph=new Mesh(gl,sphereGeo());this.cone=new Mesh(gl,coneGeo());
    // sombra CSM
    this.shadowSize=2048;
    this.depthFB=gl.createFramebuffer();
    this.depthTex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,this.depthTex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,this.shadowSize,this.shadowSize,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.depthFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,this.depthTex,0);
    gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    this.shadowMats=[M4.identity(),M4.identity(),M4.identity(),M4.identity()];
    this.cascadeEnds=[30,80,200,480];
    // targets HDR
    this.sceneFBO=null;this.bloomA=null;this.bloomB=null;
    this.settings={quality:'high',resScale:1,shadows:true,bloom:true,fog:true,exposure:1.15};
    this.frame=0;
  }
  resize(w,h){
    const gl=this.gl;const s=this.settings.resScale;
    const rw=Math.max(2,Math.floor(w*s)),rh=Math.max(2,Math.floor(h*s));
    this.canvas.width=rw;this.canvas.height=rh;
    this.vw=rw;this.vh=rh;
    if(this.sceneFBO)this.sceneFBO.resize(rw,rh);else this.sceneFBO=makeFBO(gl,rw,rh);
    const bw=Math.floor(rw/2),bh=Math.floor(rh/2);
    if(this.bloomA)this.bloomA.resize(bw,bh);else{this.bloomA=makeFBO(gl,bw,bh,false);this.bloomB=makeFBO(gl,bw,bh,false);}
    gl.viewport(0,0,rw,rh);
  }
  _setCommon(p,scene){
    const gl=this.gl;
    gl.uniform3fv(p.u.uSunDir,scene.sunDir);gl.uniform3fv(p.u.uSunColor,scene.sunColor);
    gl.uniform3fv(p.u.uSkyTint,scene.skyTint);gl.uniform3fv(p.u.uGroundTint,scene.groundTint);
    gl.uniform3fv(p.u.uCamPos,scene.camPos);
    gl.uniform1f(p.u.uTime,scene.time);
    gl.uniform1f(p.u.uFogDensity,scene.fogDensity);gl.uniform3fv(p.u.uFogColor,scene.fogColor);
    gl.uniformMatrix4fv(p.u.uProj,false,scene.proj);gl.uniformMatrix4fv(p.u.uView,false,scene.view);
    if(p.u.uUseShadows){gl.uniform1i(p.u.uUseShadows,scene.shadows?1:0);
      gl.uniformMatrix4fv(p.u.uShadowMat,false,new Float32Array(scene.shadowMats.flat()));
      gl.uniform1fv(p.u.uCascadeEnds,new Float32Array(scene.cascadeEnds));
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,scene.shadowTex);gl.uniform1i(p.u.uShadowMap,1);}
    if(p.u.uWaterY)gl.uniform1f(p.u.uWaterY,scene.waterY);
  }
  drawMesh(mesh,model,p,color,opts={}){
    const gl=this.gl;
    gl.uniformMatrix4fv(p.u.uModel,false,model);
    if(p.u.uNormalMat)gl.uniformMatrix3fv(p.u.uNormalMat,false,M4.normalMat3(model));
    if(p.u.uColor)gl.uniform4fv(p.u.uColor,color);
    if(p.u.uRough!==undefined)gl.uniform1f(p.u.uRough,opts.rough??0.8);
    if(p.u.uMetal!==undefined)gl.uniform1f(p.u.uMetal,opts.metal??0.0);
    if(p.u.uEmis!==undefined)gl.uniform1f(p.u.uEmis,opts.emis??0.0);
    if(p.u.uUseTex!==undefined){
      if(opts.tex){gl.uniform1i(p.u.uUseTex,1);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,opts.tex);}
      else gl.uniform1i(p.u.uUseTex,0);
    }
    mesh.bind();
    gl.drawElements(gl.TRIANGLES,mesh.count,mesh.itype,0);
  }
  render(scene,world){
    const gl=this.gl;this.frame++;
    /* ---- paso 1: sombras CSM ---- */
    scene.shadows=scene.shadows&&this.settings.shadows;
    if(scene.shadows){
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.depthFB);
      gl.viewport(0,0,this.shadowSize,this.shadowSize);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.colorMask(false,false,false,false);
      const p=this.progDepth;gl.useProgram(p);
      gl.disable(gl.CULL_FACE);
      for(let c=0;c<4;c++){
        const ext=this.cascadeEnds[c]*(1+c*0.35);
        const eye=V3.add(scene.camPos,V3.scale(scene.sunDir,-ext*2));
        const view=M4.lookAt(eye,scene.camPos,[0,1,0]);
        const proj=M4.ortho(-ext,ext,-ext,ext,1,ext*4);
        const vp=M4.mul(proj,view);
        // snap texel
        const ts=this.shadowSize/(2*ext);
        vp[12]=Math.round(vp[12]/ts)*ts;vp[13]=Math.round(vp[13]/ts)*ts;
        this.shadowMats[c]=M4.mul(M4.fromTRS([0.5,0.5,0.5],null,[0.5,0.5,0.5]),vp);
        gl.uniformMatrix4fv(p.u.uProj,false,proj);gl.uniformMatrix4fv(p.u.uView,false,view);
        world.drawAll(this,p,{depth:true},scene);
      }
      gl.colorMask(true,true,true,true);gl.depthMask(true);
    }
    /* ---- paso 2: escena a HDR ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.sceneFBO.fb);
    gl.viewport(0,0,this.vw,this.vh);
    gl.clearColor(0.1,0.15,0.25,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);gl.depthMask(true);
    // cielo (sin depth write, al fondo)
    gl.depthMask(false);gl.disable(gl.CULL_FACE);
    {const p=this.progSky;gl.useProgram(p);
      const invPV=M4.invert(M4.mul(scene.proj,scene.view));
      gl.uniformMatrix4fv(p.u.uProjInvView,false,invPV);
      gl.uniform3fv(p.u.uSunDir,scene.sunDir);gl.uniform1f(p.u.uTime,scene.time);gl.uniform1f(p.u.uHour,scene.hour);
      gl.bindVertexArray(this.quadVAO);gl.drawArrays(gl.TRIANGLES,0,3);}
    gl.depthMask(true);
    // terreno
    gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);
    {const p=this.progTerrain;gl.useProgram(p);this._setCommon(p,scene);
      world.drawTerrain(this,p,scene);}
    // objetos estáticos + construcciones + personajes + loot
    {const p=this.progScene;gl.useProgram(p);this._setCommon(p,scene);
      world.drawAll(this,p,{},scene);}
    // agua
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
    {const p=this.progWater;gl.useProgram(p);
      gl.uniform3fv(p.u.uSunDir,scene.sunDir);gl.uniform3fv(p.u.uSunColor,scene.sunColor);
      gl.uniform3fv(p.u.uCamPos,scene.camPos);gl.uniform1f(p.u.uTime,scene.time);
      gl.uniform3fv(p.u.uFogColor,scene.fogColor);gl.uniform1f(p.u.uFogDensity,scene.fogDensity);
      gl.uniformMatrix4fv(p.u.uProj,false,scene.proj);gl.uniformMatrix4fv(p.u.uView,false,scene.view);
      gl.uniformMatrix4fv(p.u.uModel,false,M4.identity());
      world.waterMesh.bind();gl.drawElements(gl.TRIANGLES,world.waterMesh.count,world.waterMesh.itype,0);}
    // tormenta (cilindro transparente)
    {const p=this.progStorm;gl.useProgram(p);
      gl.uniformMatrix4fv(p.u.uProj,false,scene.proj);gl.uniformMatrix4fv(p.u.uView,false,scene.view);
      gl.uniformMatrix3fv(p.u.uNormalMat,false,M4.normalMat3(M4.identity()));
      gl.uniform3fv(p.u.uCenter,[scene.storm.cx,0,scene.storm.cz]);
      gl.uniform1f(p.u.uRadius,scene.storm.r);gl.uniform1f(p.u.uTime,scene.time);
      const model=M4.fromTRS([scene.storm.cx,120,scene.storm.cz],null,[scene.storm.r*2,260,scene.storm.r*2]);
      gl.uniformMatrix4fv(p.u.uModel,false,model);
      gl.disable(gl.CULL_FACE);
      this.cyl.bind();gl.drawElements(gl.TRIANGLES,this.cyl.count,this.cyl.itype,0);}
    gl.depthMask(true);gl.disable(gl.BLEND);
    /* ---- paso 3: bloom ---- */
    scene.shadowTex=this.depthTex;scene.shadowMats=this.shadowMats;scene.cascadeEnds=this.cascadeEnds;
    let bloomOn=this.settings.bloom;
    if(bloomOn){
      gl.disable(gl.DEPTH_TEST);gl.bindVertexArray(this.quadVAO);
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.bloomA.fb);gl.viewport(0,0,this.bloomA.w,this.bloomA.h);
      let p=this.progBright;gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.sceneFBO.tex);gl.uniform1i(p.u.uTex,0);
      gl.uniform1f(p.u.uThresh,1.05);gl.drawArrays(gl.TRIANGLES,0,3);
      for(let i=0;i<2;i++){
        p=this.progBlur;gl.useProgram(p);
        gl.bindFramebuffer(gl.FRAMEBUFFER,this.bloomB.fb);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.bloomA.tex);gl.uniform1i(p.u.uTex,0);
        gl.uniform2f(p.u.uDir,1,0);gl.drawArrays(gl.TRIANGLES,0,3);
        gl.bindFramebuffer(gl.FRAMEBUFFER,this.bloomA.fb);
        gl.bindTexture(gl.TEXTURE_2D,this.bloomB.tex);gl.uniform2f(p.u.uDir,0,1);gl.drawArrays(gl.TRIANGLES,0,3);
      }
    }
    /* ---- paso 4: composición a pantalla ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,this.vw,this.vh);
    gl.disable(gl.DEPTH_TEST);gl.bindVertexArray(this.quadVAO);
    const p=this.progComp;gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.sceneFBO.tex);gl.uniform1i(p.u.uScene,0);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.bloomA.tex);gl.uniform1i(p.u.uBloom,1);
    gl.uniform1f(p.u.uBloomStr,bloomOn?0.35:0.0);
    gl.uniform1f(p.u.uExposure,scene.exposure*this.settings.exposure);
    gl.uniform1f(p.u.uVignette,0.34);gl.uniform1f(p.u.uGrain,0.02);
    gl.uniform1f(p.u.uAberr,0.0012);gl.uniform1f(p.u.uTime,scene.time);
    gl.uniform1i(p.u.uDoFx,1);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.enable(gl.DEPTH_TEST);
  }
}
export {makeFBO};
