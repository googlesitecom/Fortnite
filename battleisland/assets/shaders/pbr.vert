#version 330 core
// ===========================================================================
// pbr.vert — Vertex shader PBR del motor. Soporta:
//   * transformación modelo + normal (normal matrix)
//   * sway de vegetación (windMask por atributo, en vertex)
//   * despliegue de terreno por chunk (offset uniforme)
//   * salida para G-buffer: world pos, normal, uv, dist a cámara, sombra-cs
// ===========================================================================
layout(location=0) in vec3 in_pos;
layout(location=1) in vec3 in_normal;
layout(location=2) in vec2 in_uv;
layout(location=3) in float in_wind;     // 0 = rígido, 1 = vegetación

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out float vWind;
out vec4 vSunClipPos;      // para CSM
out vec4 vCascadeClip[4];  // proyecciones de las 4 cascadas

uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;
uniform float uTime;
uniform vec4 uWindParams;              // amp, freq, dirXZ.xy como fase, speed
uniform mat4 uLightViewProj[4];        // CSM
uniform float uCascadeSplits[4];

void main() {
    vec3 pos = in_pos;
    vWind = in_wind;
    if (in_wind > 0.5) {
        // sway proporcional a la altura local, dos frecuencias para naturalidad
        float h = max(in_pos.y, 0.0);
        float phase = (uModel[3].x + uModel[3].z) * 0.6;
        float s = sin(uTime * uWindParams.y + phase + pos.x * 0.3) * 0.6
                + sin(uTime * uWindParams.y * 2.7 + phase * 1.3 + pos.z * 0.5) * 0.4;
        pos.xz += s * uWindParams.x * h * uWindParams.w;
        pos.y  -= abs(s) * uWindParams.x * h * 0.15;
    }
    vec4 wp = uModel * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(uNormalMat * in_normal);
    vUV = in_uv;
    gl_Position = uViewProj * wp;
    vSunClipPos = uLightViewProj[0] * wp;
    for (int i = 0; i < 4; i++)
        vCascadeClip[i] = uLightViewProj[i] * wp;
}
