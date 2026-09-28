#version 330 core
// ===========================================================================
// post_ssao.frag — SSAO (HBAO simplificado) desde depth+normal G-buffer.
// Muestreo hemisférico con kernel rotado por ruido; blur de 4 pasos aparte.
// ===========================================================================
@COMMON_HEADER@

in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uDepth;    // [0..1] no lineal
uniform sampler2D uNormals;  // world normal RGB
uniform mat4 uViewProj;
uniform mat4 uInvViewProj;
uniform float uRadius;       // radio en metros
uniform float uIntensity;

const vec3 KERNEL[16] = vec3[16](
    vec3(0.19, 0.07, 0.50), vec3(-0.15, 0.33, 0.48), vec3(0.41, -0.20, 0.60),
    vec3(-0.43, 0.17, 0.31), vec3(0.21, 0.45, 0.24), vec3(-0.30, -0.36, 0.52),
    vec3(0.55, 0.08, 0.15), vec3(-0.12, 0.52, 0.71), vec3(0.35, -0.44, 0.36),
    vec3(-0.51, 0.05, 0.63), vec3(0.08, -0.27, 0.78), vec3(-0.40, -0.14, 0.42),
    vec3(0.62, 0.24, 0.20), vec3(-0.22, 0.31, 0.89), vec3(0.44, 0.39, 0.12),
    vec3(-0.58, -0.25, 0.33));

float linearize(float d) {
    const float near = 0.3, far = 3500.0;
    return near * far / (far - d * (far - near));
}

vec3 world_pos(vec2 uv) {
    float d = texture(uDepth, uv).r;
    vec4 p = uInvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
}

void main() {
    vec2 texel = 1.0 / textureSize(uDepth, 0);
    vec2 uv = gl_FragCoord.xy * texel;
    float depth = texture(uDepth, uv).r;
    if (depth >= 0.9999) { fragColor = vec4(1.0); return; }

    vec3 P = world_pos(uv);
    vec3 N = normalize(texture(uNormals, uv).rgb * 2.0 - 1.0);
    float linD = linearize(depth);
    float radius = uRadius * clamp(1.0 - linD / 160.0, 0.05, 1.0);

    // rotación aleatoria del kernel según pixel
    float ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
    mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));

    float occl = 0.0;
    for (int i = 0; i < 16; i++) {
        vec3 k = KERNEL[i];
        k.xz = rot * k.xz;
        // reflejar hacia el hemisferio de la normal
        if (dot(k, N) < 0.0) k = -k;
        vec3 sampleP = P + k * radius;
        vec4 sp = uViewProj * vec4(sampleP, 1.0);
        vec2 suv = (sp.xy / sp.w) * 0.5 + 0.5;
        if (suv.x < 0 || suv.x > 1 || suv.y < 0 || suv.y > 1) continue;
        float sd = linearize(texture(uDepth, suv).r);
        float rangeCheck = smoothstep(0.0, 1.0, radius / max(abs(P.y - sampleP.y) + abs(linD - sd), 1e-3));
        if (sd >= linD - radius * 0.35 && sd <= linD)   // muestra detrás de la superficie
            occl += 1.0 * rangeCheck;
    }
    float ao = 1.0 - (occl / 16.0) * uIntensity;
    fragColor = vec4(clamp(ao, 0.0, 1.0));
}
