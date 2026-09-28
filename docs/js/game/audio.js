// ===== Audio procedural WebAudio: SFX sintetizados + música dinámica + buses de volumen =====
export class AudioEngine{
  constructor(){this.ctx=null;this.master=null;this.buses={};this.enabled=false;this.musVol=0.6;this.sfxVol=0.8;}
  init(){
    if(this.ctx)return;
    const AC=window.AudioContext||window.webkitAudioContext;
    this.ctx=new AC();
    this.master=this.ctx.createGain();this.master.connect(this.ctx.destination);
    for(const b of ['music','sfx','ambient']){const g=this.ctx.createGain();g.connect(this.master);this.buses[b]=g;}
    this.buses.music.gain.value=0.25*this.musVol;
    this.buses.sfx.gain.value=0.7*this.sfxVol;
    this.buses.ambient.gain.value=0.3*this.sfxVol;
    this.enabled=true;
    this._noiseBuf=this._makeNoise();
    this._startAmbient();
    this._startMusic();
  }
  setVolumes(master,music){if(!this.ctx)return;this.master.gain.value=master;
    this.buses.music.gain.value=0.25*music;this.buses.sfx.gain.value=0.7*master;this.buses.ambient.gain.value=0.3*master;}
  _makeNoise(){const n=this.ctx.sampleRate*1,len=this.ctx.createBuffer(1,n,this.ctx.sampleRate),d=len.getChannelData(0);
    for(let i=0;i<n;i++)d[i]=Math.random()*2-1;return len;}
  _env(node,t0,a,s,r,peak=1){const g=node.gain;g.setValueAtTime(0,t0);g.linearRampToValueAtTime(peak,t0+a);
    g.exponentialRampToValueAtTime(Math.max(peak*s,0.001),t0+a+0.05);g.exponentialRampToValueAtTime(0.0001,t0+a+0.05+r);}
  _tone(freq,type,dur,vol=0.3,slide=0,bus='sfx',delay=0){
    if(!this.enabled)return;const t=this.ctx.currentTime+delay;
    const o=this.ctx.createOscillator(),g=this.ctx.createGain();
    o.type=type;o.frequency.setValueAtTime(freq,t);
    if(slide)o.frequency.exponentialRampToValueAtTime(Math.max(freq+slide,20),t+dur);
    this._env(g,t,0.005,0.2,0.9,vol);o.connect(g);g.connect(this.buses[bus]);o.start(t);o.stop(t+dur+0.1);
  }
  _noise(dur,vol,filtFreq=2000,q=1,bus='sfx',delay=0,pitchSlide=0){
    if(!this.enabled)return;const t=this.ctx.currentTime+delay;
    const s=this.ctx.createBufferSource();s.buffer=this._noiseBuf;s.loop=true;
    const f=this.ctx.createBiquadFilter();f.type='bandpass';f.frequency.setValueAtTime(filtFreq,t);f.Q.value=q;
    if(pitchSlide)f.frequency.exponentialRampToValueAtTime(Math.max(filtFreq+pitchSlide,40),t+dur);
    const g=this.ctx.createGain();this._env(g,t,0.002,0.1,0.9,vol);
    s.connect(f);f.connect(g);g.connect(this.buses[bus]);s.start(t);s.stop(t+dur+0.1);
  }
  /* ---------- SFX ---------- */
  shot(kind){
    switch(kind){
      case 'pistol':this._noise(0.12,0.5,1800,0.8,'sfx',0,-300);this._tone(180,'square',0.08,0.25,-120);break;
      case 'smg':this._noise(0.07,0.35,2400,1,'sfx',0,-500);this._tone(220,'square',0.05,0.15,-100);break;
      case 'ar':this._noise(0.1,0.55,1500,0.7,'sfx',0,-400);this._tone(140,'sawtooth',0.09,0.3,-80);break;
      case 'shotgun':this._noise(0.25,0.8,700,0.5,'sfx',0,-200);this._tone(90,'square',0.2,0.4,-50);break;
      case 'sniper':this._noise(0.35,0.9,900,0.4,'sfx',0,-100);this._tone(70,'sine',0.3,0.5,-40);this._noise(0.05,0.4,5000,2,'sfx',0,0);break;
      case 'rocket':this._noise(0.5,0.5,400,0.6,'sfx',0,300);this._tone(60,'sine',0.4,0.4,80);break;
      default:this._noise(0.1,0.3,2000,1);
    }
  }
  hit(head){if(head){this._tone(1200,'sine',0.1,0.5,-400);this._tone(1800,'triangle',0.08,0.3,-600,0,'sfx',0.02);}
    else this._tone(700,'triangle',0.06,0.35,-200);}
  destroy(){this._noise(0.4,0.6,300,0.5,'sfx',0,-100);this._tone(100,'square',0.3,0.3,-60);}
  harvest(){this._noise(0.08,0.35,900,2,0,200);this._tone(300,'triangle',0.06,0.2,100);}
  place(){this._tone(500,'sine',0.08,0.3,150);this._noise(0.05,0.15,1500,1);}
  chest(){[660,880,1100].forEach((f,i)=>this._tone(f,'sine',0.25,0.3,0,'sfx',i*0.08));}
  pickup(){this._tone(880,'sine',0.1,0.25,220);}
  jump(){this._tone(300,'sine',0.1,0.15,150);}
  land(){this._noise(0.08,0.25,200,1);}
  stormWarn(){this._tone(220,'sawtooth',0.8,0.3,-60);this._tone(160,'sawtooth',0.8,0.25,-40,'sfx',0.1);}
  kill(){[440,550,660,880].forEach((f,i)=>this._tone(f,'square',0.15,0.2,0,'sfx',i*0.06));}
  victory(){const mel=[523,659,784,1047,784,1047,1319];mel.forEach((f,i)=>{this._tone(f,'triangle',0.4,0.35,0,'music',i*0.18);this._tone(f/2,'sine',0.4,0.2,0,'music',i*0.18);});}
  click(){this._tone(600,'square',0.04,0.15);}
  reload(){this._noise(0.05,0.2,1200,3);this._noise(0.05,0.25,900,3,'sfx',0.25);this._tone(400,'square',0.05,0.15,100,'sfx',0.5);}
  explode(){this._noise(0.8,1.0,150,0.4,0,-80);this._tone(50,'sine',0.6,0.6,-20);}
  footstep(surface){const f={grass:[400,1.5],stone:[1200,3],wood:[700,2],sand:[300,1]}[surface]||[500,1.5];
    this._noise(0.04,0.08,f[0],f[1]);}
  /* ---------- ambiente + música ---------- */
  _startAmbient(){
    // viento: ruido filtrado en bucle
    const s=this.ctx.createBufferSource();s.buffer=this._noiseBuf;s.loop=true;
    const f=this.ctx.createBiquadFilter();f.type='lowpass';f.frequency.value=350;f.Q.value=0.5;
    const g=this.ctx.createGain();g.gain.value=0.05;
    const lfo=this.ctx.createOscillator(),lg=this.ctx.createGain();
    lfo.frequency.value=0.13;lg.gain.value=0.03;lfo.connect(lg);lg.connect(g.gain);lfo.start();
    s.connect(f);f.connect(g);g.connect(this.buses.ambient);s.start();
    this.stormGain=g;
  }
  setStormIntensity(v){if(this.stormGain)this.stormGain.gain.value=0.05+v*0.25;}
  _startMusic(){
    // secuenciador simple: pads + arpegio, intensidad por fase final
    this.musIntensity=0;
    const scale=[220,246.9,277.2,329.6,392,440,493.9,554.4];
    const step=()=>{
      if(!this.ctx)return;
      const t=this.ctx.currentTime;
      const inten=this.musIntensity;
      // pad cada 4s
      if(!this._padT||t-this._padT>4){this._padT=t;
        const root=scale[Math.floor(Math.random()*4)];
        [root,root*1.5,inten>0.5?root*2:root*1.2].forEach((fr,i)=>{
          const o=this.ctx.createOscillator(),g=this.ctx.createGain();
          o.type='sine';o.frequency.value=fr;
          g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.05+inten*0.04,t+1);
          g.gain.linearRampToValueAtTime(0.001,t+4.2);
          o.connect(g);g.connect(this.buses.music);o.start(t);o.stop(t+4.5);});
      }
      // arpegio rítmico si hay intensidad
      if(inten>0.3){
        const fr=scale[Math.floor(Math.random()*scale.length)]*(Math.random()>0.5?2:1);
        this._tone(fr,'triangle',0.15,0.05+inten*0.05,0,'music');
      }
      setTimeout(step,500);
    };
    step();
  }
}
