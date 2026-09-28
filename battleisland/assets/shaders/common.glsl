#version 330 core
// ---------------------------------------------------------------------------
// common.glsl — funciones compartidas PBR: GGX, luz solar, cielo procedural,
// niebla atmosférica, tone mapping ACES. Se inserta al inicio de los FS.
// ---------------------------------------------------------------------------

uniform vec3 uSunDir;        // dirección HACIA el sol (normalizada)
uniform vec3 uSunColor;      // color/intensidad solar (HDR)
uniform vec3 uCamPos;
uniform float uTime;
uniform float uHour;         // hora del día 0..24
uniform vec3 uFogColor;
uniform float uFogDensity;   // densidad exponencial base e
uniform vec3 uSkyTint;       // tintado global del cielo/ambiente
uniform float uExposure;     // exposición HDR

const float PI = 3.14159265359;

// ------------------------- BRDF Cook-Torrance GGX --------------------------
float distribution_ggx(float NoH, float rough) {
    float a = rough * rough;
    float a2 = a * a;
    float d = (NoH * NoH) * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d + 1e-7);
}

float geometry_schlick(float cosTheta, float k) {
    return cosTheta / (cosTheta * (1.0 - k) + k);
}

float geometry_smith(float NoV, float NoL, float rough) {
    float r = rough + 1.0;
    float k = (r * r) / 8.0;
    return geometry_schlick(NoV, k) * geometry_schlick(NoL, k);
}

vec3 fresnel_schlick(float cosTheta, vec3 F0) {
    return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

vec3 pbr_direct(vec3 N, vec3 V, vec3 L, vec3 albedo, float metallic, float roughness, vec3 lightCol) {
    vec3 H = normalize(V + L);
    float NoL = max(dot(N, L), 0.0);
    float NoV = max(dot(N, V), 1e-4);
    float NoH = max(dot(N, H), 0.0);
    float VoH = max(dot(V, H), 0.0);

    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    float D = distribution_ggx(NoH, max(roughness, 0.045));
    float G = geometry_smith(NoV, NoL, roughness);
    vec3  F = fresnel_schlick(VoH, F0);

    vec3 spec = (D * G * F) / (4.0 * NoV * NoL + 1e-5);
    vec3 kd = (1.0 - F) * (1.0 - metallic);
    return (kd * albedo / PI + spec) * lightCol * NoL;
}

// IBL aproximado con spherical harmonics de 2 bandas (sky simple).
vec3 irradiance_sky(vec3 N) {
    // Coeficientes derivados analíticamente del modelo de cielo inferior.
    float sunY = clamp(uSunDir.y, 0.0, 1.0);
    vec3 zenith = mix(vec3(0.02, 0.03, 0.08), vec3(0.10, 0.28, 0.62), sunY);
    vec3 horizon = mix(vec3(0.10, 0.06, 0.10), vec3(0.85, 0.75, 0.65), sunY) * uSkyTint;
    vec3 ground = vec3(0.12, 0.11, 0.10) * uSkyTint;
    float t = N.y * 0.5 + 0.5;
    vec3 sky = mix(horizon, zenith, smoothstep(0.45, 0.95, t));
    sky = mix(ground, sky, smoothstep(0.0, 0.35, t));
    return sky;
}

vec3 ibl_specular(vec3 N, vec3 V, float roughness, vec3 albedo, float metallic) {
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.05);
    vec3 env = irradiance_sky(normalize(R));
    float NoV = max(dot(N, V), 0.0);
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    vec3 F = fresnel_schlick(NoV, F0);
    float avgAo = 1.0;
    return env * (F * roughness * 0.35 + 0.02) * avgAo;
}

// --------------------------------- Cielo -----------------------------------
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float noise2d(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 5; i++) {
        v += a * noise2d(p);
        p = rot * p * 2.05;
        a *= 0.5;
    }
    return v;
}

vec3 sky_color(vec3 dir, vec3 sunDir) {
    float sunY = clamp(sunDir.y, -1.0, 1.0);
    float dayF = smoothstep(-0.08, 0.25, sunY);
    vec3 zenithDay = vec3(0.18, 0.42, 0.85);
    vec3 horizonDay = vec3(0.75, 0.85, 0.98);
    vec3 zenithNight = vec3(0.010, 0.015, 0.045);
    vec3 horizonNight = vec3(0.06, 0.05, 0.10);
    vec3 duskHorizon = vec3(0.95, 0.45, 0.18);

    float t = clamp(dir.y, 0.0, 1.0);
    vec3 day = mix(horizonDay, zenithDay, pow(t, 0.55));
    vec3 night = mix(horizonNight, zenithNight, pow(t, 0.5));
    float duskF = smoothstep(0.35, 0.0, abs(sunY)) * (1.0 - dayF * 0.6);
    vec3 col = mix(night, day, dayF);
    col = mix(col, mix(horizonNight, duskHorizon, pow(1.0 - t, 2.0)), duskF * (1.0 - t));

    // Disco solar + halo
    float cosA = dot(normalize(dir), sunDir);
    float disc = smoothstep(0.9997, 0.9999, cosA);
    float glow = pow(max(cosA, 0.0), 220.0) * 2.2 + pow(max(cosA, 0.0), 18.0) * 0.25;
    vec3 sunC = mix(vec3(1.0, 0.35, 0.10), vec3(1.3, 1.2, 1.0), dayF);
    col += (disc * 40.0 + glow) * sunC * step(-0.05, sunDir.y);

    // Estrellas nocturnas
    if (dir.y > 0.0 && dayF < 0.7) {
        vec2 sc = dir.xz / (abs(dir.y) + 0.3) * 40.0;
        float st = pow(hash12(floor(sc * 8.0)), 60.0);
        col += vec3(st) * (1.0 - dayF) * step(0.4, dir.y);
    }
    return col * uSkyTint;
}

// Nubes volumétricas baratas por raymarching 2D en capa de nubes.
vec3 sky_with_clouds(vec3 dir, vec3 sunDir) {
    vec3 col = sky_color(dir, sunDir);
    if (dir.y > 0.02) {
        // proyectar sobre capa a altura fija
        float cloudH = 900.0;
        float dist = cloudH / max(dir.y, 0.02);
        vec2 p = dir.xz * (dist / 2600.0) + vec2(uTime * 0.008, uTime * 0.004);
        float c = fbm(p * 2.0);
        float cov = smoothstep(0.52, 0.75, c) * smoothstep(0.02, 0.18, dir.y);
        float lit = smoothstep(0.35, 0.85, fbm(p * 2.0 + sunDir.xz * 0.35 + 0.06));
        vec3 cloudCol = mix(vec3(0.35, 0.36, 0.42), vec3(1.15, 1.12, 1.08), lit)
                        * mix(vec3(0.25, 0.25, 0.35), vec3(1.0), clamp(sunDir.y * 3.0, 0.0, 1.0));
        col = mix(col, cloudCol, cov * 0.9);
    }
    return col;
}

// --------------------------- Niebla atmosférica ----------------------------
vec3 apply_fog(vec3 color, float dist, vec3 viewDir) {
    float h = max(uCamPos.y - 5.0, 1.0);
    float heightFog = exp(-h * 0.008) ;
    float fogAmt = 1.0 - exp(-dist * uFogDensity * heightFog);
    // out-scatter con fase hacia el sol (miey aproximada)
    float cosA = dot(viewDir, uSunDir);
    float phase = 0.05 + 0.85 * pow(max(cosA, 0.0), 8.0);
    vec3 fogCol = uFogColor + uSunColor * phase * 0.35;
    return mix(color, fogCol, clamp(fogAmt, 0.0, 1.0));
}

// ------------------------------- Tone map ----------------------------------
vec3 aces_tonemap(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 filmic(vec3 x) {
    x = max(x - 0.004, 0.0);
    return clamp((x * (6.2 * x + 0.7)) / (x * (6.2 * x + 1.3) + 0.015), 0.0, 1.0);
}
