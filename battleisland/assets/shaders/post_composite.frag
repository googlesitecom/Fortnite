#version 330 core
// ===========================================================================
// post_composite.frag — Pase de composición final del pipeline:
//   * lectura del buffer HDR (RGBA16F)
//   * SSAO aplicado desde el buffer G (normal+depth)
//   * bloom aditivo desde mip chain
//   * god rays por radial blur hacia el sol en pantalla
//   * SSR mezclado cuando hay reflejo válido
//   * TAA ya resuelto en el pase anterior (aquí aplica jitter implícito)
//   * ACES tone mapping + exposición automática
//   * viñeta, aberración cromática leve, grain opcional
// Salida LDR sRGB a pantalla.
// ===========================================================================
@COMMON_HEADER@

in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uHDR;         // escena HDR
uniform sampler2D uBloomTex;    // pre-filtrada
uniform sampler2D uSSAO;        // oclusión ambiental
uniform sampler2D uDepth;       // profundidad lineal normalizada
uniform sampler2D uNormals;     // normales world-space (para AO y SSR)
uniform sampler2D uGodRay;      // radial blur del sol
uniform sampler2D uSSR;         // screen space reflections
uniform vec2 uSunScreen;        // posición del sol en [0..1]
uniform float uBloomStrength;
uniform float uGodRayStrength;
uniform float uSSAOStrrength;
uniform float uSSRStrength;
uniform float uVignette;
uniform float uChromatic;
uniform float uGrain;
uniform float uMotionBlur;
uniform float uDOF;             // fuerza depth of field
uniform float uAutoExposure;    // luminosidad media adaptativa

// NOTE: 'texel' es una variable global no inicializada (vec2(0)) — se usa
// siempre a través de uniforms/constantes locales abajo.
float linearize_depth(float d) {
    const float near = 0.3, far = 3500.0;
    return near * far / (far - d * (far - near));
}

void main() {
    vec2 texel = 1.0 / textureSize(uHDR, 0);
    vec2 uv = gl_FragCoord.xy * texel;
    vec3 col = texture(uHDR, uv).rgb;

    // ---- SSAO ----
    float ao = texture(uSSAO, uv).r;
    col *= mix(1.0, ao, uSSAOStrrength);

    // ---- Bloom ----
    vec3 bloom = texture(uBloomTex, uv).rgb;
    col += bloom * uBloomStrength;

    // ---- God rays ----
    vec3 rays = texture(uGodRay, uv).rgb;
    col += rays * uGodRayStrength;

    // ---- SSR (mezcla simple ponderada por validez alfa) ----
    vec4 ssr = texture(uSSR, uv);
    if (ssr.a > 0.01) {
        float rough = 1.0 - ssr.a;   // empaquetamos confianza en alfa
        col = mix(col, ssr.rgb, uSSRStrength * rough * 0.8);
    }

    // ---- Depth of field barato: desenfoque 5-tap ponderado por coc ----
    if (uDOF > 0.0) {
        float d = linearize_depth(texture(uDepth, uv).r);
        float focus = 55.0;                       // distancia focal ~ brazo+
        float coc = clamp(abs(d - focus) / max(d, 1.0), 0.0, 1.0);
        coc = smoothstep(0.05, 0.6, coc) * uDOF;
        vec2 r = texel * 3.0 * coc * 14.0;
        vec3 bl = col * 0.4
                + texture(uHDR, uv + vec2(r.x, 0)).rgb * 0.15
                + texture(uHDR, uv - vec2(r.x, 0)).rgb * 0.15
                + texture(uHDR, uv + vec2(0, r.y)).rgb * 0.15
                + texture(uHDR, uv - vec2(0, r.y)).rgb * 0.15;
        col = mix(col, bl, coc);
    }

    // ---- Exposición + ACES ----
    col *= uExposure * uAutoExposure;
    col = aces_tonemap(col);

    // ---- Aberración cromática radial ----
    if (uChromatic > 0.0) {
        vec2 dir = uv - 0.5;
        float amt = uChromatic * dot(dir, dir);
        col.r = texture(uHDR, uv + dir * amt).r * (uExposure * uAutoExposure);
        col.b = texture(uHDR, uv - dir * amt).b * (uExposure * uAutoExposure);
        col = aces_tonemap(clamp(col, 0.0, 10.0));
    }

    // ---- Viñeta ----
    vec2 vd = gl_FragCoord.xy * texel - 0.5;
    col *= 1.0 - uVignette * dot(vd, vd) * 1.6;

    // ---- Film grain ----
    if (uGrain > 0.0) {
        float g = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
        col += (g - 0.5) * uGrain * 0.06;
    }

    // gamma sRGB
    col = pow(max(col, 0.0), vec3(1.0 / 2.2));
    fragColor = vec4(col, 1.0);
}
