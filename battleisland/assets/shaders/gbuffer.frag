#version 330 core
// gbuffer.frag — normal codificada a [0..1]
@COMMON_HEADER@
in vec3 vWorldPos;
in vec3 vNormal;
out vec4 fragColor;
void main() {
    fragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0);
}
