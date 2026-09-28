#version 330 core
// ===========================================================================
// post_bloom.frag — Threshold + downsample / desenfoque separable.
// uBloomTex = entrada; uKernel = radio en texels; uThreshold = corte HDR.
// ===========================================================================
@COMMON_HEADER@

in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2 uDir;          // (1,0) horizontal, (0,1) vertical
uniform float uRadius;
uniform float uThreshold;   // >0 => modo bright-pass
uniform float uSoftKnee;

void main() {
    vec2 texel = 1.0 / textureSize(uSrc, 0);
    vec2 uv = gl_FragCoord.xy * texel;

    if (uThreshold > 0.0) {
        // bright pass con knee suave
        vec3 c = texture(uSrc, uv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float knee = uThreshold * uSoftKnee;
        float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
        soft = soft * soft / (4.0 * knee + 1e-4);
        float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
        fragColor = vec4(c * contrib, 1.0);
        return;
    }

    // desenfoque gaussiano 9-tap separable
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
