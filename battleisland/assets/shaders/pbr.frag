#version 330 core
// ===========================================================================
// pbr.frag — Fragment shader PBR principal.
//   * materiales: albedo/rough/metal desde texturas o factor uniforme
//   * normal mapping (tangent-space derivado proceduralmente por dFdx)
//   * luz solar direccional + CSM 4 cascadas con PCSS/PCF
//   * hasta 8 luces puntuales dinámicas (explosiones, linterna tormenta)
//   * IBL aproximado (SH sky), SSAO aplicado en post (aquí AO de textura)
//   * niebla atmosférica exponencial con out-scatter solar
// Salida a buffer HDR (RGBA16F).
// ===========================================================================
@COMMON_HEADER@

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in float vWind;
out vec4 fragColor;

uniform sampler2D uAlbedoTex;
uniform sampler2D uRoughTex;
uniform sampler2D uNormalTex;

uniform vec4 uAlbedoFactor;    // si uUseTextures==0 se usa este color plano
uniform float uMetallic;
uniform float uRoughness;
uniform float uUseTextures;    // 0/1
uniform float uAlpha;          // opacidad global (cristales)
uniform vec3 uEmissive;
uniform float uTorch;          // 1 = objeto "luminoso" estilo antorcha/luz propia

struct PLight { vec3 pos; vec3 color; float radius; float intensity; };
uniform PLight uLights[8];
uniform int uNumLights;

uniform sampler2DShadow uShadowMap[4];
uniform mat4 uLightViewProj[4];
uniform float uCascadeSplits[4];
uniform float uShadowStrength;
uniform int uShadowsOn;        // toggle calidad
uniform int uPcfQuality;       // 0 simple, 1 PCF 4x4, 2 PCSS

float sample_shadow_cascade(int ci, vec4 clip, float layerBias) {
    vec3 proj = clip.xyz / clip.w;
    proj = proj * 0.5 + 0.5;
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0)
        return 1.0;
    vec2 uv = proj.xy;
    float bias = max(0.0015 * layerBias, 0.0008);
    float texel = 1.0 / 4096.0;
    float lit = 0.0;
    if (uPcfQuality == 0) {
        lit = texture(uShadowMap[ci], vec3(uv, proj.z - bias));
    } else if (uPcfQuality == 1) {
        // PCF rotativo 3x3 con patrón poisson para reducir banding
        const int N = 8;
        vec2 pois[8];
        pois[0] = vec2(-1, -1); pois[1] = vec2(1, -1); pois[2] = vec2(-1, 1); pois[3] = vec2(1, 1);
        pois[4] = vec2(0, -1.4); pois[5] = vec2(0, 1.4); pois[6] = vec2(-1.4, 0); pois[7] = vec2(1.4, 0);
        float ang = fract(sin(dot(vWorldPos.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
        mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
        for (int i = 0; i < N; i++) {
            vec2 off = rot * pois[i] * texel * 1.6;
            lit += texture(uShadowMap[ci], vec3(uv + off, proj.z - bias));
        }
        lit /= float(N);
    } else {
        // PCSS aproximado: bloqueador search con texturas separadas no
        // disponibles en sampler2DShadow -> usamos PCF de radio adaptativo
        // según distancia a la cámara (penumbra crece con la distancia).
        float penW = texel * (0.8 + layerBias * 0.012);
        float litAcc = 0.0;
        for (int x = -2; x <= 2; x++)
            for (int y = -2; y <= 2; y++)
                litAcc += texture(uShadowMap[ci], vec3(uv + vec2(x, y) * penW, proj.z - bias));
        lit = litAcc / 25.0;
    }
    return lit;
}

float csm_shadow(vec3 worldPos) {
    if (uShadowsOn == 0) return 1.0;
    float dist = length(worldPos - uCamPos);
    int ci = 3;
    for (int i = 0; i < 4; i++) {
        if (dist < uCascadeSplits[i]) { ci = i; break; }
    }
    vec4 clip = uLightViewProj[ci] * vec4(worldPos, 1.0);
    float lit = sample_shadow_cascade(ci, clip, dist);
    // fundido entre cascada actual y siguiente para evitar costuras
    if (ci < 3) {
        float t = smoothstep(uCascadeSplits[ci] - 20.0, uCascadeSplits[ci], dist);
        vec4 clipN = uLightViewProj[ci + 1] * vec4(worldPos, 1.0);
        float litN = sample_shadow_cascade(ci + 1, clipN, dist);
        lit = mix(lit, litN, t);
    }
    return mix(1.0, lit, uShadowStrength);
}

vec3 perturb_normal(vec3 N, vec3 basePos, vec2 uv, vec3 normalMapSample) {
    // TBN sin atributos de tangente: derivadas de pantalla (estilo perturbation)
    vec3 dpX = dFdx(basePos), dpY = dFdy(basePos);
    vec2 duX = dFdx(uv),  duY = dFdy(uv);
    vec3 T = normalize(dpX * duY.y - dpY * duX.y);
    vec3 B = normalize(dpX * duY.x - dpY * duX.x);
    mat3 TBN = mat3(T, B, N);
    vec3 nm = normalize(normalMapSample * 2.0 - 1.0);
    return normalize(TBN * nm);
}

void main() {
    vec3 albedo = uAlbedoFactor.rgb;
    float rough = uRoughness;
    float metal = uMetallic;
    vec3 nrm = normalize(vNormal);
    if (uUseTextures > 0.5) {
        vec4 a = texture(uAlbedoTex, vUV);
        albedo *= a.rgb;
        rough *= texture(uRoughTex, vUV).r;
        vec3 nt = texture(uNormalTex, vUV).rgb;
        nrm = perturb_normal(nrm, vWorldPos, vUV, nt);
    }
    rough = clamp(rough, 0.045, 1.0);
    vec3 V = normalize(uCamPos - vWorldPos);
    float NoV = max(dot(nrm, V), 1e-4);

    // ---- Luz solar + sombra ----
    float shadow = csm_shadow(vWorldPos);
    vec3 sunCol = uSunColor * shadow;
    vec3 col = pbr_direct(nrm, V, uSunDir, albedo, metal, rough, sunCol);

    // ---- Luces puntuales ----
    for (int i = 0; i < 8; i++) {
        if (i >= uNumLights) break;
        vec3 Lv = uLights[i].pos - vWorldPos;
        float d = length(Lv);
        if (d > uLights[i].radius) continue;
        vec3 L = Lv / d;
        float atten = pow(clamp(1.0 - d / uLights[i].radius, 0.0, 1.0), 2.0);
        col += pbr_direct(nrm, V, L, albedo, metal, rough,
                          uLights[i].color * uLights[i].intensity * atten);
    }

    // ---- IBL ambiente ----
    vec3 amb = irradiance_sky(nrm) * albedo * (1.0 - metal * 0.9);
    amb *= mix(0.35, 1.0, nrm.y * 0.5 + 0.5);      // hemisferio inferior más oscuro
    col += amb * 0.55;
    col += ibl_specular(nrm, V, rough, albedo, metal);

    // emisivo
    col += uEmissive;
    if (uTorch > 0.5) col += albedo * 1.5;

    // ---- Niebla atmosférica ----
    float dist = length(uCamPos - vWorldPos);
    vec3 viewDir = normalize(vWorldPos - uCamPos);
    col = apply_fog(col, dist, viewDir);

    fragColor = vec4(col, uAlpha * uAlbedoFactor.a);
}
