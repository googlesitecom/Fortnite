// ===== GameData: armas, rarezas, skins, emotes, pase de batalla, nombres de bots =====
export const RARITY={
  common:{name:'Común',color:[0.62,0.65,0.7],hex:'#9aa4b5',mult:1},
  uncommon:{name:'Poco común',color:[0.3,0.75,0.35],hex:'#4caf50',mult:1.1},
  rare:{name:'Raro',color:[0.25,0.55,1],hex:'#3f8cff',mult:1.2},
  epic:{name:'Épico',color:[0.65,0.25,1],hex:'#a13cff',mult:1.35},
  legendary:{name:'Legendario',color:[1,0.72,0.05],hex:'#ffb30a',mult:1.55},
};
export const WEAPONS={
  pistol:{name:'Pistola Guardia',icon:'🔫',dmg:24,rpm:300,mag:12,reload:1.4,spread:0.018,recoil:0.7,hitscan:true,range:120,ammoType:'light',auto:false},
  smg:{name:'Subfusil Avispa',icon:'💨',dmg:17,rpm:720,mag:30,reload:1.9,spread:0.035,recoil:0.5,hitscan:true,range:80,ammoType:'light',auto:true},
  ar:{name:'Fusil Vórtice',icon:'🎯',dmg:33,rpm:360,mag:30,reload:2.3,spread:0.014,recoil:1.1,hitscan:true,range:200,ammoType:'medium',auto:true},
  shotgun:{name:'Escopeta Trueno',icon:'💥',dmg:11,pellets:8,rpm:90,mag:6,reload:2.8,spread:0.09,recoil:3.5,hitscan:true,range:30,ammoType:'shells',auto:false},
  sniper:{name:'Francotirador Colmena',icon:'🔭',dmg:105,rpm:40,mag:1,reload:3.2,spread:0.001,recoil:6,hitscan:false,bulletSpeed:340,bulletGrav:0.35,range:500,ammoType:'heavy',auto:false,scope:true},
  rocket:{name:'Lanzacohetes Cometa',icon:'🚀',dmg:110,splash:9,rpm:30,mag:1,reload:3.6,spread:0.002,recoil:4,hitscan:false,bulletSpeed:60,bulletGrav:1,range:400,ammoType:'heavy',auto:false,explosive:true},
  pickaxe:{name:'Pico',icon:'⛏️',dmg:20,rpm:90,mag:Infinity,reload:0,spread:0,recoil:0,hitscan:true,range:4,melee:true,harvest:30,ammoType:null},
};
export const CONSUMABLES={
  medkit:{name:'Botiquín',icon:'➕',use:2,gives:{hp:15}},
  bandage:{name:'Venda',icon:'🩹',use:1,gives:{hp:5}},
  shield_small:{name:'Escudo pequeño',icon:'🧪',use:2,gives:{shield:25}},
  shield_big:{name:'Escudo grande',icon:'🛡️',use:3,gives:{shield:50}},
  ammo:{name:'Munición',icon:'📦',stack:true},
};
export const SKINS=[
  {id:'onda',name:'Azul Onda',cost:0,rarity:'common',colors:{body:[0.15,0.4,0.85],head:[0.95,0.8,0.65],legs:[0.1,0.15,0.3]}},
  {id:'magma',name:'Magma',cost:500,rarity:'rare',colors:{body:[0.85,0.25,0.1],head:[0.95,0.8,0.65],legs:[0.2,0.05,0.05]}},
  {id:'selva',name:'Selva Fantasma',cost:800,rarity:'epic',colors:{body:[0.1,0.5,0.25],head:[0.85,0.7,0.55],legs:[0.05,0.2,0.1]}},
  {id:'vortice',name:'Vórtice Dorado',cost:1200,rarity:'legendary',colors:{body:[1,0.75,0.1],head:[1,0.9,0.7],legs:[0.4,0.3,0.05]}},
  {id:'escarlata',name:'Escarlata Nocturna',cost:1000,rarity:'epic',colors:{body:[0.6,0.05,0.15],head:[0.2,0.2,0.25],legs:[0.1,0.05,0.1]}},
  {id:'glaciar',name:'Glaciar',cost:600,rarity:'rare',colors:{body:[0.6,0.85,1],head:[0.95,0.9,0.85],legs:[0.2,0.35,0.5]}},
];
export const PICKAXES=[
  {id:'basic',name:'Pico Básico',cost:0,color:[0.5,0.5,0.55]},
  {id:'gold',name:'Pico Áureo',cost:300,color:[1,0.8,0.2]},
  {id:'neon',name:'Pico Neón',cost:500,color:[0.3,1,0.6]},
];
export const EMOTES=['🕺 Baile Isla','🤸 Espinela','🎉 Confeti','🫡 Saludo'];
export const PASS_TIERS=[
  {lv:1,reward:'Monedas x100'},{lv:2,reward:'Grafiti "Pico Feliz"'},{lv:3,reward:'Envoltorio arma'},
  {lv:5,reward:'Pantalla carga "Atardecer"'},{lv:7,reward:'Monedas x150'},{lv:10,reward:'Skin "Recluta Vórtice"'},
  {lv:13,reward:'Mochila neón'},{lv:16,reward:'Emote extra'},{lv:20,reward:'Planeador "Ala Cromada"'},
  {lv:25,reward:'Skin "Guardián Dorado"'},{lv:30,reward:'Pico Legendario "Trueno"'},
];
export const BOT_NAMES=['TornilloX','Nocturna_9','ZarzaVeloz','LunaFugaz','RobleRojo','PixelPanda','Gaviota77',
 'CactusKid','BúhoÁgil','ChispaSur','DunaLoca','Esquirla','FuriaVerde','HalcónNoel','IvyTrap','JaguarJet',
 'KoalaK.O','LimaDulce','MareaBaja','Nimbo Gris','OrugaPro','PalmaReal','QuarkZero','RocaViva','SombraLynx',
 'TucánTurbo','UvaNegra','VulcanoV','WokiWoki','X-404Y','YunqueFino','ZenitSur','Ametralla','BrumaBlue','ColibriX'];
export function botName(i){return BOT_NAMES[i%BOT_NAMES.length]+(i>=BOT_NAMES.length?Math.floor(i/BOT_NAMES.length):'');}

/* Escalado por rareza */
export function weaponStats(base,rarity){
  const m=RARITY[rarity].mult;
  return {...base,dmg:Math.round(base.dmg*m),rpm:Math.round(base.rpm*(1+(m-1)*0.3))};
}
