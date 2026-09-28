#version 330 core
// ===========================================================================
// sky.frag — Cielo procedural fullscreen: gradiente atmosférico + sol con
// disco/halo + nubes por raymarching en capa + estrellas nocturnas.
// Escribe HDR para el pipeline de tone mapping.
// ===========================================================================
@COMMON_HEADER@

in vec2 vNdc;          // coordenadas -1..1
out vec4 fragColor;

uniform mat4 uInvViewProj;

void main() {
    vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
    vec3 dir = normalize(far.xyz / far.w - uCamPos);
    vec3 col = sky_with_clouds(dir, uSunDir);
    fragColor = vec4(col, 1.0);
}
