#version 330 core
// ===========================================================================
// post_godrays.frag — Rayos volumétricos del sol: radial blur de la escena
// hacia la posición en pantalla del sol (muestreo en espiral dorada).
// ===========================================================================
@COMMON_HEADER@

in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uSrc;      // brightpass de la escena
uniform vec2 uSunScreen;     // [0..1]
uniform float uIntensity;
uniform float uDecay;
uniform float uDensity;      // 0..1 longitud de rayo
uniform int uSamples;

void main() {
    vec2 texel = 1.0 / textureSize(uSrc, 0);
    vec2 uv = gl_FragCoord.xy * texel;
    vec2 deltaUV = (uv - uSunScreen) * (uDensity / float(uSamples));

    vec2 coord = uv;
    float illum = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 40; i++) {
        if (i >= uSamples) break;
        coord -= deltaUV;
        vec3 s = texture(uSrc, clamp(coord, 0.0, 1.0)).rgb;
        acc += s * illum * uDecay;
        illum *= 0.92;
    }
    fragColor = vec4(acc * uIntensity, 1.0);
}
