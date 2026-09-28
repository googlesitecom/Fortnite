#version 330 core
// ===========================================================================
// post_ssr.frag — Screen Space Reflections por ray-marching en espacio de
// pantalla (marco simplificado estilo "screen-space cone trace"). Devuelve
// color reflejado + confianza en alfa. Calidad media, coste bajo a medio.
// ===========================================================================
@COMMON_HEADER@

in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uHDR;
uniform sampler2D uDepth;
uniform sampler2D uNormals;
uniform mat4 uProj;
uniform float uMaxDist;   // en metros
uniform int uSteps;

float linearize(float d) {
    const float near = 0.3, far = 3500.0;
    return near * far / (far - d * (far - near));
}

vec3 world_pos(vec2 uv) {
    float d = texture(uDepth, uv).r;
    if (d >= 0.9999) return vec3(1e9);
    vec4 p = uInvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
}

void main() {
    vec2 texel = 1.0 / textureSize(uDepth, 0);
    vec2 uv = gl_FragCoord.xy * texel;
    float depth = texture(uDepth, uv).r;
    if (depth >= 0.9999) { fragColor = vec4(0.0); return; }

    vec3 P = world_pos(uv);
    vec3 N = normalize(texture(uNormals, uv).rgb * 2.0 - 1.0);
    vec3 V = normalize(P - uCamPos);
    vec3 R = reflect(V, N);
    if (dot(R, N) < 0.0) { fragColor = vec4(0.0); return; }

    // marchar en dirección R proyectada a pantalla
    vec3 cur = P + N * 0.15;
    float stepLen = uMaxDist / float(max(uSteps, 1));
    vec2 hitUV = vec2(-1.0);
    for (int i = 0; i < 64; i++) {
        if (i >= uSteps) break;
        cur += R * stepLen * (1.0 + float(i) * 0.08);  // paso creciente
        vec4 clip = uProj * vec4(cur - uCamPos, 1.0);
        if (clip.w <= 0.0) break;
        vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
        if (suv.x < 0 || suv.x > 1 || suv.y < 0 || suv.y > 1) break;
        float sd = texture(uDepth, suv).r;
        if (sd >= 0.9999) continue;
        float sceneLin = linearize(sd);
        float rayLin = length(cur - uCamPos);
        if (sceneLin < rayLin) {          // el rayo penetró la superficie
            hitUV = suv;
            break;
        }
    }
    if (hitUV.x < 0.0) { fragColor = vec4(0.0); return; }
    vec3 col = texture(uHDR, hitUV).rgb;
    float distFade = 1.0 - clamp(length(hitUV - uv) * 3.0, 0.0, 1.0);
    float edgeFade = smoothstep(0.0, 0.08, min(min(hitUV.x, 1.0 - hitUV.x), min(hitUV.y, 1.0 - hitUV.y)));
    float confidence = distFade * edgeFade;
    fragColor = vec4(col, confidence);
}
