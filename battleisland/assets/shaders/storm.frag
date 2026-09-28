#version 330 core
// ===========================================================================
// storm.frag — Pared de tormenta: cilindro semitransparente con bandas
// eléctricas animadas, fresnel, glow interior y distorsión. Aditivo.
// ===========================================================================
@COMMON_HEADER@

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
out vec4 fragColor;

uniform vec3 uStormColor;      // púrpura eléctrico
uniform vec3 uStormColor2;     // azul cian de los rayos
uniform float uStormRadius;
uniform float uStormHeight;
uniform float uPhasePulse;     // 0..1 progreso fase (acelera el shader)

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
    vec3 V = normalize(uCamPos - vWorldPos);
    vec3 N = normalize(vNormal);
    float fres = pow(1.0 - abs(dot(V, N)), 2.2);

    // coordenadas cilíndricas para las bandas
    float h = clamp(vWorldPos.y / uStormHeight, 0.0, 1.0);
    float a = atan(vWorldPos.z - 0.0, vWorldPos.x - 0.0);

    // ruido vertical tipo relámpago trepando
    float t = uTime * (0.6 + uPhasePulse * 1.8);
    float bolts = vnoise(vec2(a * 6.0, h * 14.0 - t * 3.0));
    bolts = smoothstep(0.62, 0.95, bolts);
    float veins = vnoise(vec2(a * 22.0 + t, h * 40.0 - t * 6.0));
    veins = pow(smoothstep(0.55, 1.0, veins), 3.0);

    // hexágonos tenues (panelado futurista)
    vec2 hp = vec2(a * 8.0 / 3.14159, h * 24.0);
    float grid = step(0.92, max(fract(hp.x), fract(hp.y)));

    float pulse = 0.5 + 0.5 * sin(uTime * 2.0 + h * 6.0);
    vec3 col = uStormColor * (0.35 + 0.65 * fres) * (0.7 + 0.5 * pulse);
    col += uStormColor2 * bolts * 2.2;
    col += uStormColor2 * veins * 1.4;
    col += uStormColor * grid * 0.25;
    // base más brillante tocando el suelo
    col *= 1.0 + smoothstep(0.15, 0.0, h) * 1.5;

    float alpha = clamp(fres * 0.85 + bolts * 0.5 + veins * 0.3 + 0.08, 0.0, 1.0);
    // desvanecer arriba del cilindro
    alpha *= smoothstep(1.0, 0.85, h);
    fragColor = vec4(col, alpha);
}
