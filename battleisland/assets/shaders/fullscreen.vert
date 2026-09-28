#version 330 core
// fullscreen.vert — triángulo grande que cubre la pantalla, sin VBO.
out vec2 vNdc;
void main() {
    // vértices generados desde gl_VertexID (triángulo único)
    vec2 p = vec2((gl_VertexID == 2) ? 3.0 : -1.0, (gl_VertexID == 1) ? 3.0 : -1.0);
    vNdc = p;
    gl_Position = vec4(p, 0.0, 1.0);
}
