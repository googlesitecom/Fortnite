#version 330 core
// ===========================================================================
// gbuffer.vert — G-buffer para SSAO/SSR: emite normal world-space + depth.
// ===========================================================================
layout(location=0) in vec3 in_pos;
layout(location=1) in vec3 in_normal;

out vec3 vWorldPos;
out vec3 vNormal;

uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;

void main() {
    vec4 wp = uModel * vec4(in_pos, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(uNormalMat * in_normal);
    gl_Position = uViewProj * wp;
}
