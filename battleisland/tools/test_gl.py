import glfw, moderngl, sys
if not glfw.init():
    print("NO GLFW DISPLAY"); sys.exit(1)
glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)
w = glfw.create_window(640, 480, "t", None, None)
if not w:
    print("NO WINDOW"); sys.exit(1)
glfw.make_context_current(w)
ctx = moderngl.create_context()
print("RENDERER:", ctx.info.get('GL_RENDERER'))
print("VERSION:", ctx.info.get('GL_VERSION'))
print("MAX_TEX:", ctx.info.get('GL_MAX_TEXTURE_SIZE'))
glfw.terminate()
