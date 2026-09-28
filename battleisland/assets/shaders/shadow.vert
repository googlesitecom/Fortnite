#version 330 core
// ===========================================================================
// shadow.vert — Pase de sombras CSM: solo transforma, sin salida de color.
// ===========================================================================
layout(location=0) in vec3 in_pos;

uniform mat4 uModel;
uniform mat4 uLightViewProj;

void main() {
    gl_Position = uLightViewProj * uModel * vec4(in_pos, 1.0);
}
