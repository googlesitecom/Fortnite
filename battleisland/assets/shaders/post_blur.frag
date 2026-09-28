#version 330 core
// ===========================================================================
// post_blur.frag — desenfoque gaussiano separable genérico (reutilizado por
// el blur de SSAO y por los pases de bloom). uSrc, uDir, uRadius.
// ===========================================================================
@COMMON_HEADER@

in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uRadius;

void main() {
    vec2 texel = 1.0 / textureSize(uSrc, 0);
    vec2 uv = gl_FragCoord.xy * texel;
    vec3 sum = vec3(0.0);
    float w[5] = float[](0.227, 0.194, 0.121, 0.054, 0.016);
    vec2 off = uDir * texel * uRadius;
    sum += texture(uSrc, uv).rgb * w[0];
    for (int i = 1; i < 5; i++) {
        sum += texture(uSrc, uv + off * float(i)).rgb * w[i];
        sum += texture(uSrc, uv - off * float(i)).rgb * w[i];
    }
    fragColor = vec4(sum, 1.0);
}
