#version 330 core
// ===========================================================================
// water.frag — Agua con normal map animado (dos capas scrolling), fresnel
// sky-reflection, reflejo planar desde textura RT, traslucidez de orilla y
// espuma procedural cerca de la línea de costa.
// ===========================================================================
@COMMON_HEADER@

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uWaterNormal;
uniform sampler2D uPlanarRefl;   // reflejo planar (RT)
uniform float uUsePlanar;        // 0/1
uniform float uWaterLevel;

void main() {
    vec3 N = normalize(vNormal);
    // dos capas de olas scrolling
    vec2 uv1 = vWorldPos.xz * 0.015 + vec2(uTime * 0.03, uTime * 0.02);
    vec2 uv2 = vWorldPos.xz * 0.037 - vec2(uTime * 0.045, uTime * 0.015);
    vec3 n1 = texture(uWaterNormal, uv1).rgb * 2.0 - 1.0;
    vec3 n2 = texture(uWaterNormal, uv2).rgb * 2.0 - 1.0;
    vec3 bump = normalize(vec3(n1.x + n2.x, 1.0, n1.z + n2.z));
    N = normalize(N + (bump - vec3(0, 1, 0)) * 0.85);

    vec3 V = normalize(uCamPos - vWorldPos);
    float NoV = max(dot(N, V), 1e-4);
    float fres = pow(1.0 - NoV, 4.0) * 0.9 + 0.08;

    // reflejo: planar o cielo procedural
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.03);
    vec3 reflCol = sky_with_clouds(R, uSunDir);
    if (uUsePlanar > 0.5) {
        vec2 suv = vWorldPos.xz / 4096.0 + 0.5;
        vec3 pr = texture(uPlanarRefl, clamp(suv, 0.0, 1.0)).rgb;
        reflCol = mix(reflCol, pr, 0.65);
    }

    vec3 deep = vec3(0.012, 0.08, 0.11);
    vec3 shallow = vec3(0.05, 0.32, 0.36);
    vec3 body = mix(shallow, deep, 0.6);

    // luz solar especular GGX simple sobre bumps
    vec3 sunC = uSunColor * 0.9;
    vec3 col = pbr_direct(N, V, uSunDir, body, 0.0, 0.06, sunC);
    col = mix(col * 0.9 + body * 0.35, reflCol, fres);

    // espuma en orillas (altura cercana al nivel del mar)
    float edge = smoothstep(1.6, 0.0, abs(vWorldPos.y - uWaterLevel));
    float foamNoise = fbm(vWorldPos.xz * 0.15 + uTime * 0.1);
    float foam = edge * smoothstep(0.35, 0.65, foamNoise) * 0.9;
    col = mix(col, vec3(0.9, 0.95, 1.0), foam);

    float dist = length(uCamPos - vWorldPos);
    col = apply_fog(col, dist, normalize(vWorldPos - uCamPos));
    fragColor = vec4(col, 0.92 + fres * 0.08);
}
