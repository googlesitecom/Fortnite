"""
renderer.py — Motor de renderizado PBR diferido-adiantado del juego.

Pipeline por frame:
  1. CSM: 4 shadow maps 2048² (reducibles por preset) con light-fit.
  2. G-buffer ligero: normales+depth para SSAO/SSR.
  3. Pase opaco HDR (RGBA16F): terreno, edificios, props, personajes, agua
     reflejada (planar RT a media resolución), estructuras construidas.
  4. Post en cadena: SSAO(+blur), brightpass+bloom(2 niveles), god rays,
     SSR, composición final (ACES, viñeta, aberración, grain).
  5. Cielo procedural (dentro del pase HDR como quad fullscreen tardío con
     depth-test LEQUAL).
  6. Transparentes: tormenta, haces de loot, partículas, cristal.
  7. UI 2D (PIL -> textura) encima de todo.

API pública: Renderer(ctx_gl, settings), .draw_frame(scene_data).
scene_data es un dict preparado por el juego (listas de draw items).
"""
import ctypes
import os
import numpy as np
import moderngl as gl

from engine import math3d as m3

SHADER_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "shaders")


def _load(name):
    with open(os.path.join(SHADER_DIR, name)) as f:
        return f.read()


def _link(common_src):
    """Inserta common.glsl tras la línea #version."""
    common = _load("common.glsl").split("\n", 1)[1]
    return common_src.replace("@COMMON_HEADER@", common)


# ---------------------------------------------------------------- Mesh GPU --
class GpuMesh:
    def __init__(self, ctx, verts, indices):
        self.ctx = ctx
        vbo = ctx.buffer(verts.astype(np.float32).tobytes())
        ibo = ctx.buffer(indices.astype(np.uint32).tobytes())
        self.vao = ctx.vertex_array(None, [(vbo, "3f 3f 2f 1f", 0, 1, 2, 3)], ibo)
        self.count = len(indices)
        self.pos_min = verts[:, :3].min(0) if len(verts) else np.zeros(3, np.float32)
        self.pos_max = verts[:, :3].max(0) if len(verts) else np.zeros(3, np.float32)
        center = (self.pos_min + self.pos_max) * 0.5
        self.radius = float(np.linalg.norm(self.pos_max - center))
        self._vbo, self._ibo = vbo, ibo

    def bind_program(self, prog):
        self.vao.program_obj = prog

    def release(self):
        self.vao.release()
        self._vbo.release()
        self._ibo.release()


class TextureSet:
    """Trío albedo/rough/normal de un material."""
    def __init__(self, ctx, albedo, rough, normal):
        self.albedo = ctx.texture(albedo.shape[:2][::-1], 3, dtype="F1", data=albedo.tobytes()) \
            if False else ctx.texture(albedo.shape[1::-1], 3, dtype="F1", data=albedo.tobytes())
        self.rough = ctx.texture(rough.shape[1::-1], 3, dtype="F1", data=rough.tobytes())
        self.normal = ctx.texture(normal.shape[1::-1], 3, dtype="F1", data=normal.tobytes())
        for t in (self.albedo, self.rough, self.normal):
            t.build_mipmaps()
            t.repeat_x = True
            t.repeat_y = True


# ------------------------------------------------------------- Render Targets
class RT:
    def __init__(self, ctx, w, h, depth=True, hdr=False, samples=1):
        self.w, self.h = w, h
        fmt = "RGBA16F" if hdr else "RGBA8"
        self.color = ctx.texture((w, h), 4, dtype="F2" if hdr else "F1")
        self.color.filter = (gl.LINEAR, gl.LINEAR)
        if hdr:
            self.color.build_mipmaps()
        atts = [self.color]
        self.depth_tex = None
        if depth:
            self.depth_tex = ctx.depth_texture((w, h))
            self.depth_tex.filter = (gl.NEAREST, gl.NEAREST)
            atts.append(self.depth_tex)
        self.fbo = ctx.framebuffer(color_attachments=atts, depth_attachment=self.depth_tex if depth else None)

    def release(self):
        self.color.release()
        if self.depth_tex:
            self.depth_tex.release()
        self.fbo.release()


class ShadowAtlas:
    """4 cascadas CSM en una sola textura 2x2 de 4096 (cada casilla 2048).

    Se muestrea como sampler2DShadow con offset manual de casilla, evitando
    arrays de texturas de sombra (soporte irregular en drivers).
    """
    def __init__(self, ctx, cell=2048):
        self.cell = cell
        self.size = cell * 2
        self.depth = ctx.depth_texture((self.size, self.size))
        self.depth.filter = (gl.LINEAR, gl.LINEAR)
        # quadrant FBOs via viewport scissoring sobre un solo fbo
        self.fbo = ctx.framebuffer(depth_attachment=self.depth)

    def release(self):
        self.depth.release()
        self.fbo.release()


# ------------------------------------------------------------------ RENDERER
class Renderer:
    def __init__(self, ctx, width, height, settings=None):
        self.ctx = ctx
        self.width, self.height = width, height
        self.settings = settings or {}
        self.time = 0.0
        self.frame_idx = 0

        ctx.enable(gl.BLEND)
        ctx.blend_func(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        ctx.enable(gl.DEPTH_TEST)
        ctx.cull_face = "back"

        self.textures = {}       # nombre -> TextureSet
        self.meshes = {}         # nombre -> GpuMesh
        self._programs_cache = {}
        self._rt_cache = {}
        self._build_shaders()
        self._build_quad()

    # ------------------------------------------------------------ shaders --
    def _prog(self, key, vert, frag, extra_defs=None):
        src_v, src_f = vert, frag
        prog = self.ctx.program(vertex_shader=src_v, fragment_shader=src_f)
        self._programs_cache[key] = prog
        return prog

    def _build_shaders(self):
        pbr_v = _load("pbr.vert")
        pbr_f = _link(_load("pbr.frag"))
        self.prog_pbr = self.ctx.program(vertex_shader=pbr_v, fragment_shader=pbr_f)
        sky_v = _load("fullscreen.vert")
        sky_f = _link(_load("sky.frag"))
        self.prog_sky = self.ctx.program(vertex_shader=sky_v, fragment_shader=sky_f)
        storm_f = _link(_load("storm.frag"))
        self.prog_storm = self.ctx.program(vertex_shader=pbr_v, fragment_shader=storm_f)
        water_f = _link(_load("water.frag"))
        self.prog_water = self.ctx.program(vertex_shader=pbr_v, fragment_shader=water_f)
        comp_f = _link(_load("post_composite.frag"))
        self.prog_comp = self.ctx.program(vertex_shader=sky_v, fragment_shader=comp_f)
        ssao_f = _link(_load("post_ssao.frag"))
        self.prog_ssao = self.ctx.program(vertex_shader=sky_v, fragment_shader=ssao_f)
        blur_f = _link(_load("post_blur.frag"))
        self.prog_blur = self.ctx.program(vertex_shader=sky_v, fragment_shader=blur_f)
        bloom_f = _link(_load("post_bloom.frag"))
        self.prog_bright = self.ctx.program(vertex_shader=sky_v, fragment_shader=bloom_f)
        gr_f = _link(_load("post_godrays.frag"))
        self.prog_godray = self.ctx.program(vertex_shader=sky_v, fragment_shader=gr_f)
        ssr_f = _link(_load("post_ssr.frag"))
        self.prog_ssr = self.ctx.program(vertex_shader=sky_v, fragment_shader=ssr_f)
        sh_v = _load("shadow.vert")
        self.prog_shadow = self.ctx.program(
            vertex_shader=sh_v,
            fragment_shader="#version 330 core\nvoid main() { }")
        gb_v = _load("gbuffer.vert")
        gb_f = _link(_load("gbuffer.frag"))
        self.prog_gbuffer = self.ctx.program(vertex_shader=gb_v, fragment_shader=gb_f)

    def _build_quad(self):
        self.empty_vao = self.ctx.vertex_array(self.prog_sky, [])

    # ------------------------------------------------------------- targets --
    def get_rt(self, key, w, h, depth=True, hdr=False):
        old = self._rt_cache.get(key)
        if old and (old.w != w or old.h != h):
            old.release()
            old = None
        if not old:
            old = RT(self.ctx, max(w, 1), max(h, 1), depth, hdr)
            self._rt_cache[key] = old
        return old

    @property
    def shadow(self):
        if not hasattr(self, "_shadow"):
            res = int(self.settings.get("shadow_res", 2048))
            self._shadow = ShadowAtlas(self.ctx, cell=res)
        return self._shadow

    # --------------------------------------------------------------- setup --
    def resize(self, w, h):
        self.width, self.height = w, h

    def set_quality(self, settings):
        self.settings.update(settings)
        if "shadow_res" in settings and getattr(self, "_shadow", None):
            self._shadow.release()
            del self._shadow

    # ------------------------------------------------------ uniforms globales
    def _set_common_uniforms(self, prog, scene):
        try:
            prog["uSunDir"].value = tuple(scene["sun_dir"])
            prog["uSunColor"].value = tuple(scene["sun_color"])
            prog["uCamPos"].value = tuple(scene["cam_pos"])
            prog["uTime"].value = scene["time"]
            prog["uHour"].value = scene.get("hour", 12.0)
            prog["uFogColor"].value = tuple(scene["fog_color"])
            prog["uFogDensity"].value = scene["fog_density"]
            prog["uSkyTint"].value = tuple(scene.get("sky_tint", (1, 1, 1)))
            prog["uExposure"].value = scene.get("exposure", 1.0)
        except KeyError:
            pass

    def _set_csm_uniforms(self, prog, scene):
        try:
            prog["uLightViewProj[0]"].value = [m.ravel(order="F").tolist()
                                               for m in scene["csm_matrices"]]
            prog["uCascadeSplits"].value = list(scene["csm_splits"])
            prog["uShadowMap[0]"].value = 7
            prog["uShadowStrength"].value = scene.get("shadow_strength", 0.85)
            prog["uShadowsOn"].value = 1 if scene.get("shadows", True) else 0
            prog["uPcfQuality"].value = int(scene.get("pcf", 1))
        except KeyError:
            pass

    # ----------------------------------------------------------- draw items --
    def _draw_batch(self, prog, batch, scene, textures, blend=False, depth_write=True):
        self.ctx.depth_mask = depth_write
        if blend:
            self.ctx.blend_func(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        for item in batch:
            mesh = item["mesh"]
            mat = item.get("material", {})
            tex_name = mat.get("tex")
            use_tex = 1.0 if (tex_name and tex_name in textures) else 0.0
            ts = textures.get(tex_name) if tex_name else None
            try:
                prog["uModel"].value = np.asarray(item["model"], np.float32).ravel(order="F").tolist()
                nm = m3.mat4_inverse_affine(np.asarray(item["model"], np.float32))[:3, :3].T
                prog["uNormalMat"].value = [float(x) for x in nm.ravel()]
                prog["uAlbedoFactor"].value = tuple(mat.get("color", (0.8, 0.8, 0.8, 1.0)))
                prog["uMetallic"].value = float(mat.get("metallic", 0.0))
                prog["uRoughness"].value = float(mat.get("roughness", 0.7))
                prog["uUseTextures"].value = use_tex
                prog["uAlpha"].value = float(mat.get("alpha", 1.0))
                prog["uEmissive"].value = tuple(mat.get("emissive", (0, 0, 0)))
                prog["uWindParams"].value = tuple(scene.get("wind_params", (0, 1, 0, 0)))
            except KeyError:
                pass
            if ts:
                ts.albedo.use(0)
                ts.rough.use(1)
                ts.normal.use(2)
                try:
                    prog["uAlbedoTex"].value = 0
                    prog["uRoughTex"].value = 1
                    prog["uNormalTex"].value = 2
                except KeyError:
                    pass
            mesh.bind_program(prog)
            mesh.vao.render(mode=gl.TRIANGLES)

    # ---------------------------------------------------------- frame entry --
    def draw_frame(self, scene):
        """scene keys: cam matrices, sun, listas de draw items por tipo, etc."""
        s = self.settings
        self.time = scene["time"]
        scale = float(s.get("render_scale", 1.0))
        rw, rh = int(self.width * scale), int(self.height * scale)

        post_on = bool(s.get("post_effects", True))
        hdr_rt = self.get_rt("hdr", rw, rh, depth=True, hdr=True) if post_on else None
        gbuf = self.get_rt("gbuf", rw, rh, depth=True, hdr=False) if post_on and s.get("ssao", True) else None

        # ---------- 1. CSM ----------
        csm_ok = scene.get("shadows", True) and int(s.get("cascade_count", 4)) > 0
        if csm_ok:
            self._render_csm(scene)

        # ---------- 2. G-buffer ----------
        target = hdr_rt if post_on else None
        if gbuf:
            gbuf.fbo.use()
            self.ctx.clear(0, 0, 0, 1, depth=1.0)
            self.ctx.disable(gl.BLEND)
            self._set_common_uniforms(self.prog_gbuffer, scene)
            try:
                self.prog_gbuffer["uViewProj"].value = np.asarray(scene["view_proj"], np.float32).ravel(order="F").tolist()
            except KeyError:
                pass
            for item in scene.get("opaque", []):
                if item.get("no_gbuffer"):
                    continue
                self._draw_batch_simple(self.prog_gbuffer, item)
            self.ctx.enable(gl.BLEND)

        # ---------- 3. Opacos HDR ----------
        fb = hdr_rt.fbo if post_on else None
        if post_on:
            hdr_rt.fbo.use()
        self.ctx.clear(0.02, 0.03, 0.05, 1.0, depth=1.0)
        self.ctx.disable(gl.BLEND)
        self._set_common_uniforms(self.prog_pbr, scene)
        self._set_csm_uniforms(self.prog_pbr, scene)
        try:
            self.prog_pbr["uViewProj"].value = np.asarray(scene["view_proj"], np.float32).ravel(order="F").tolist()
            self.prog_pbr["uNumLights"].value = len(scene.get("point_lights", []))
            arr = []
            for pl in scene.get("point_lights", [])[:8]:
                arr += [pl[0], pl[1], pl[2], pl[3], pl[4], pl[5], pl[6], pl[7]]
            while len(arr) < 8 * 8:
                arr += [0, 0, 0, 0, 0, 0, 0, 0]
            self.prog_pbr["uLights[0].pos"].value = [(arr[i * 8], arr[i * 8 + 1], arr[i * 8 + 2]) for i in range(8)]
            self.prog_pbr["uLights[0].color"].value = [(arr[i * 8 + 3], arr[i * 8 + 4], arr[i * 8 + 5]) for i in range(8)]
            self.prog_pbr["uLights[0].radius"].value = [arr[i * 8 + 6] for i in range(8)]
            self.prog_pbr["uLights[0].intensity"].value = [arr[i * 8 + 7] for i in range(8)]
        except KeyError:
            pass

        # reflejo planar del agua (escena sin agua re-renderizada a RT bajo)
        planar_used = False
        if s.get("planar_reflection", True) and scene.get("water"):
            pw, ph = rw // 2, rh // 2
            prt = self.get_rt("planar", pw, ph, depth=True, hdr=True)
            prt.fbo.use()
            self.ctx.clear(0.02, 0.03, 0.05, 1.0, depth=1.0)
            self._draw_batch(self.prog_pbr, [i for i in scene["opaque"] if not i.get("is_water")],
                             scene, self.textures)
            self._draw_batch(self.prog_pbr, scene.get("props_planar", []), scene, self.textures)
            planar_used = True
            if post_on:
                hdr_rt.fbo.use()

        self._draw_batch(self.prog_pbr, [i for i in scene["opaque"] if not i.get("is_water")],
                         scene, self.textures)
        # construcciones y personajes usan el mismo programa
        self._draw_batch(self.prog_pbr, scene.get("characters", []), scene, self.textures)
        self._draw_batch(self.prog_pbr, scene.get("structures", []), scene, self.textures)

        # ---------- agua ----------
        if scene.get("water"):
            self._set_common_uniforms(self.prog_water, scene)
            try:
                self.prog_water["uViewProj"].value = np.asarray(scene["view_proj"], np.float32).ravel(order="F").tolist()
                self.prog_water["uWaterLevel"].value = scene.get("water_level", 2.0)
                self.prog_water["uUsePlanar"].value = 1.0 if planar_used else 0.0
                if planar_used:
                    self._rt_cache["planar"].color.use(5)
                    self.prog_water["uPlanarRefl"].value = 5
                wt = scene.get("water_normal_tex")
                if wt:
                    wt.use(6)
                    self.prog_water["uWaterNormal"].value = 6
                self.prog_water["uShadowMap[0]"].value = 7
                self._set_csm_uniforms(self.prog_water, scene)
            except KeyError:
                pass
            if csm_ok:
                self.shadow.depth.use(7)
            for item in scene["water"]:
                try:
                    self.prog_water["uModel"].value = np.asarray(item["model"], np.float32).ravel(order="F").tolist()
                    nm = m3.mat4_inverse_affine(np.asarray(item["model"], np.float32))[:3, :3].T
                    self.prog_water["uNormalMat"].value = [float(x) for x in nm.ravel()]
                    self.prog_water["uWindParams"].value = tuple(scene.get("wind_params", (0, 1, 0, 0)))
                except KeyError:
                    pass
                item["mesh"].bind_program(self.prog_water)
                item["mesh"].vao.render()

        # ---------- cielo ----------
        self.ctx.disable(gl.DEPTH_TEST)
        self._set_common_uniforms(self.prog_sky, scene)
        try:
            self.prog_sky["uInvViewProj"].value = np.asarray(
                m3.mat4_inverse(scene["view_proj"]), np.float32).ravel(order="F").tolist()
        except KeyError:
            pass
        self.empty_vao.program_obj = self.prog_sky
        self.empty_vao.render(gl.TRIANGLES, vertices=3)
        self.ctx.enable(gl.DEPTH_TEST)

        # ---------- transparentes aditivos (tormenta, beams, partículas) ----
        self.ctx.blend_func(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        if scene.get("storm"):
            self._set_common_uniforms(self.prog_storm, scene)
            try:
                self.prog_storm["uViewProj"].value = np.asarray(scene["view_proj"], np.float32).ravel(order="F").tolist()
                self.prog_storm["uStormColor"].value = tuple(scene["storm_color"])
                self.prog_storm["uStormColor2"].value = tuple(scene["storm_color2"])
                self.prog_storm["uStormRadius"].value = scene["storm_radius"]
                self.prog_storm["uStormHeight"].value = 900.0
                self.prog_storm["uPhasePulse"].value = scene.get("storm_phase", 0.0)
            except KeyError:
                pass
            for item in scene["storm"]:
                try:
                    self.prog_storm["uModel"].value = np.asarray(item["model"], np.float32).ravel(order="F").tolist()
                    nm = m3.mat4_inverse_affine(np.asarray(item["model"], np.float32))[:3, :3].T
                    self.prog_storm["uNormalMat"].value = [float(x) for x in nm.ravel()]
                except KeyError:
                    pass
                item["mesh"].bind_program(self.prog_storm)
                self.ctx.cull_face = "front_and_back"
                item["mesh"].vao.render()
                self.ctx.cull_face = "back"

        self._draw_batch(self.prog_pbr, scene.get("transparent", []), scene,
                         self.textures, blend=True)
        self._draw_batch(self.prog_pbr, scene.get("beams", []), scene,
                         self.textures, blend=True)
        self.ctx.blend_func(gl.SRC_ALPHA, gl.ONE)
        self._draw_batch(self.prog_pbr, scene.get("particles", []), scene,
                         self.textures, blend=True)
        self.ctx.blend_func(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

        # ---------- 4. Post-procesado ----------
        if post_on:
            out = self._post_pipeline(scene, hdr_rt, gbuf, rw, rh)
        else:
            out = hdr_rt  # no aplica

        # ---------- 5. Presentar ----------
        self.ctx.use_framebuffer(None) if False else None
        # blit manual: dibujar quad con la textura final sobre default FB
        self.ctx.disable(gl.DEPTH_TEST)
        self._present(out)
        self.ctx.enable(gl.DEPTH_TEST)

        # ---------- 6. UI ----------
        if scene.get("ui_tex"):
            self._draw_ui(scene["ui_tex"], scene.get("ui_dirty", True))

        self.frame_idx += 1

    def _draw_batch_simple(self, prog, item):
        mesh = item["mesh"]
        try:
            prog["uModel"].value = np.asarray(item["model"], np.float32).ravel(order="F").tolist()
            nm = m3.mat4_inverse_affine(np.asarray(item["model"], np.float32))[:3, :3].T
            prog["uNormalMat"].value = [float(x) for x in nm.ravel()]
        except KeyError:
            pass
        mesh.bind_program(prog)
        mesh.vao.render()

    # -------------------------------------------------------------- CSM -----
    def _render_csm(self, scene):
        atlas = self.shadow
        cell = atlas.cell
        atlas.fbo.use()
        self.ctx.enable(gl.DEPTH_TEST)
        self.ctx.cull_face = "front"   # reduce peter-panning
        splits = scene["csm_splits"]
        for ci in range(4):
            x0 = (ci % 2) * cell
            y0 = (ci // 2) * cell
            self.ctx.viewport = (x0, y0, cell, cell)
            self.ctx.clear(depth=1.0)
            vp = np.asarray(scene["csm_matrices"][ci], np.float32)
            try:
                self.prog_shadow["uLightViewProj"].value = vp.ravel(order="F").tolist()
            except KeyError:
                pass
            for item in scene.get("casters", []):
                try:
                    self.prog_shadow["uModel"].value = np.asarray(item["model"], np.float32).ravel(order="F").tolist()
                except KeyError:
                    pass
                item["mesh"].bind_program(self.prog_shadow)
                item["mesh"].vao.render()
        self.ctx.viewport = (0, 0, self.width, self.height)
        self.ctx.cull_face = "back"
        atlas.depth.use(7)

    # ------------------------------------------------------- post pipeline --
    def _post_pipeline(self, scene, hdr_rt, gbuf, rw, rh):
        s = self.settings
        cur = hdr_rt
        # SSAO
        if s.get("ssao", True) and gbuf:
            ao = self.get_rt("ssao", rw // 2, rh // 2, depth=False)
            ao.fbo.use()
            self._set_common_uniforms(self.prog_ssao, scene)
            try:
                self.prog_ssao["uDepth"].value = 3
                self.prog_ssao["uNormals"].value = 4
                self.prog_ssao["uViewProj"].value = np.asarray(scene["view_proj"], np.float32).ravel(order="F").tolist()
                self.prog_ssao["uInvViewProj"].value = np.asarray(m3.mat4_inverse(scene["view_proj"]), np.float32).ravel(order="F").tolist()
                self.prog_ssao["uRadius"].value = float(s.get("ssao_radius", 1.6))
                self.prog_ssao["uIntensity"].value = float(s.get("ssao_intensity", 0.9))
            except KeyError:
                pass
            gbuf.depth_tex.use(3)
            gbuf.color.use(4)
            self.empty_vao.program_obj = self.prog_ssao
            self.empty_vao.render(gl.TRIANGLES, vertices=3)
            # blur 2 pasadas
            tmp = self.get_rt("ssao_b", rw // 2, rh // 2, depth=False)
            for d in ((1, 0), (0, 1)):
                tgt = tmp if d == (1, 0) else ao
                (ao if d == (1, 0) else tmp).fbo.use()
                self._set_common_uniforms(self.prog_blur, scene)
                try:
                    self.prog_blur["uSrc"].value = 3
                    self.prog_blur["uDir"].value = d
                    self.prog_blur["uRadius"].value = 2.0
                except KeyError:
                    pass
                (tmp if d == (1, 0) else ao).color.use(3)
                self.empty_vao.program_obj = self.prog_blur
                self.empty_vao.render(gl.TRIANGLES, vertices=3)
            ssao_out = tmp
        else:
            ssao_out = None

        # Bloom: bright -> blur H/V a 1/4 y 1/8, suma
        bloom_small = None
        if s.get("bloom", True):
            bw, bh = rw // 4, rh // 4
            b1 = self.get_rt("bloom1", bw, bh, depth=False)
            b1.fbo.use()
            self._set_common_uniforms(self.prog_bright, scene)
            try:
                self.prog_bright["uSrc"].value = 3
                self.prog_bright["uThreshold"].value = 1.05
                self.prog_bright["uSoftKnee"].value = 0.6
            except KeyError:
                pass
            hdr_rt.color.use(3)
            self.empty_vao.program_obj = self.prog_bright
            self.empty_vao.render(gl.TRIANGLES, vertices=3)
            b2 = self.get_rt("bloom2", bw, bh, depth=False)
            for rad in (2.0, 4.0):
                for d in ((1, 0), (0, 1)):
                    src, dst = (b1, b2) if d == (1, 0) else (b2, b1)
                    dst.fbo.use()
                    self._set_common_uniforms(self.prog_blur, scene)
                    try:
                        self.prog_blur["uSrc"].value = 3
                        self.prog_blur["uDir"].value = d
                        self.prog_blur["uRadius"].value = rad
                    except KeyError:
                        pass
                    src.color.use(3)
                    self.empty_vao.program_obj = self.prog_blur
                    self.empty_vao.render(gl.TRIANGLES, vertices=3)
            bloom_small = b1

        # God rays a 1/4
        god = None
        if s.get("god_rays", True) and scene.get("sun_screen"):
            gw, gh = rw // 4, rh // 4
            gp = self.get_rt("godray_pre", gw, gh, depth=False)
            gp.fbo.use()
            self._set_common_uniforms(self.prog_bright, scene)
            try:
                self.prog_bright["uSrc"].value = 3
                self.prog_bright["uThreshold"].value = 3.0
                self.prog_bright["uSoftKnee"].value = 0.3
            except KeyError:
                pass
            hdr_rt.color.use(3)
            self.empty_vao.program_obj = self.prog_bright
            self.empty_vao.render(gl.TRIANGLES, vertices=3)
            god = self.get_rt("godray", gw, gh, depth=False)
            god.fbo.use()
            self._set_common_uniforms(self.prog_godray, scene)
            try:
                self.prog_godray["uSrc"].value = 3
                self.prog_godray["uSunScreen"].value = tuple(scene["sun_screen"])
                self.prog_godray["uIntensity"].value = float(s.get("godray_intensity", 0.35))
                self.prog_godray["uDecay"].value = 0.95
                self.prog_godray["uDensity"].value = 0.7
                self.prog_godray["uSamples"].value = int(s.get("godray_samples", 16))
            except KeyError:
                pass
            gp.color.use(3)
            self.empty_vao.program_obj = self.prog_godray
            self.empty_vao.render(gl.TRIANGLES, vertices=3)

        # SSR a 1/2
        ssr = None
        if s.get("ssr", True) and gbuf:
            qw, qh = rw // 2, rh // 2
            ssr = self.get_rt("ssr", qw, qh, depth=False)
            ssr.fbo.use()
            self._set_common_uniforms(self.prog_ssr, scene)
            try:
                self.prog_ssr["uHDR"].value = 3
                self.prog_ssr["uDepth"].value = 4
                self.prog_ssr["uNormals"].value = 5
                self.prog_ssr["uProj"].value = np.asarray(scene["proj"], np.float32).ravel(order="F").tolist()
                self.prog_ssr["uInvViewProj"].value = np.asarray(m3.mat4_inverse(scene["view_proj"]), np.float32).ravel(order="F").tolist()
                self.prog_ssr["uMaxDist"].value = 60.0
                self.prog_ssr["uSteps"].value = int(s.get("ssr_steps", 24))
            except KeyError:
                pass
            hdr_rt.color.use(3)
            gbuf.depth_tex.use(4)
            gbuf.color.use(5)
            self.empty_vao.program_obj = self.prog_ssr
            self.empty_vao.render(gl.TRIANGLES, vertices=3)

        # Composición final a RT LDR full-res
        final = self.get_rt("final", rw, rh, depth=False)
        final.fbo.use()
        self._set_common_uniforms(self.prog_comp, scene)
        try:
            self.prog_comp["uHDR"].value = 3
            self.prog_comp["uBloomTex"].value = 4
            self.prog_comp["uSSAO"].value = 5
            self.prog_comp["uDepth"].value = 6
            self.prog_comp["uNormals"].value = 8
            self.prog_comp["uGodRay"].value = 9
            self.prog_comp["uSSR"].value = 10
            self.prog_comp["uSunScreen"].value = tuple(scene.get("sun_screen") or (0.5, 0.5))
            self.prog_comp["uBloomStrength"].value = float(s.get("bloom_strength", 0.45))
            self.prog_comp["uGodRayStrength"].value = 1.0
            self.prog_comp["uSSAOStrrength"].value = 1.0 if ssao_out else 0.0
            self.prog_comp["uSSRStrength"].value = float(s.get("ssr_strength", 0.5))
            self.prog_comp["uVignette"].value = float(s.get("vignette", 0.35))
            self.prog_comp["uChromatic"].value = float(s.get("chromatic", 0.004))
            self.prog_comp["uGrain"].value = float(s.get("film_grain", 0.0))
            self.prog_comp["uDOF"].value = float(s.get("dof", 0.0))
            self.prog_comp["uAutoExposure"].value = float(scene.get("auto_exposure", 1.0))
        except KeyError:
            pass
        hdr_rt.color.use(3)
        if bloom_small:
            bloom_small.color.use(4)
        if ssao_out:
            ssao_out.color.use(5)
        if gbuf:
            gbuf.depth_tex.use(6)
            gbuf.color.use(8)
        if god:
            god.color.use(9)
        if ssr:
            ssr.color.use(10)
        self.empty_vao.program_obj = self.prog_comp
        self.empty_vao.render(gl.TRIANGLES, vertices=3)
        return final

    # ------------------------------------------------------------- present --
    def _present(self, rt):
        # shader trivial de copia
        if not hasattr(self, "prog_copy"):
            self.prog_copy = self.ctx.program(
                vertex_shader=_load("fullscreen.vert"),
                fragment_shader=_link("""#version 330 core
in vec2 vNdc;
out vec4 fragColor;
uniform sampler2D uSrc;
void main(){
    vec2 texel = 1.0 / textureSize(uSrc,0);
    vec2 uv = gl_FragCoord.xy * texel;
    fragColor = vec4(texture(uSrc, uv).rgb, 1.0);
}"""))
        self.ctx.default_framebuffer.use()
        self.ctx.viewport = (0, 0, self.width, self.height)
        self.ctx.disable(gl.DEPTH_TEST)
        try:
            self.prog_copy["uSrc"].value = 3
        except KeyError:
            pass
        rt.color.use(3)
        self.empty_vao.program_obj = self.prog_copy
        self.empty_vao.render(gl.TRIANGLES, vertices=3)
        self.ctx.enable(gl.DEPTH_TEST)

    # ------------------------------------------------------------------- UI --
    def _draw_ui(self, ui_tex, dirty):
        if not hasattr(self, "prog_ui"):
            self.prog_ui = self.ctx.program(
                vertex_shader="""#version 330 core
layout(location=0) in vec2 in_pos;
layout(location=1) in vec2 in_uv;
out vec2 vUV;
void main(){ vUV = in_uv; gl_Position = vec4(in_pos, 0.0, 1.0); }""",
                fragment_shader="""#version 330 core
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
void main(){ fragColor = texture(uTex, vUV); }""")
        if dirty or not hasattr(self, "_ui_vao"):
            self._ui_vao = self.ctx.vertex_array(
                self.prog_ui, [(self.ctx.buffer(ui_tex.tobytes()), "2f 2f", 0, 1)])
            self._ui_tex = self.ctx.texture(ui_tex.shape[1::-1], 4, dtype="F1")
        self._ui_tex.write(ui_tex.tobytes())
        self.ctx.disable(gl.DEPTH_TEST)
        self.ctx.depth_mask = False
        self._ui_tex.use(0)
        try:
            self.prog_ui["uTex"].value = 0
        except KeyError:
            pass
        self._ui_vao.program_obj = self.prog_ui
        self._ui_vao.render(gl.TRIANGLES)
        self.ctx.depth_mask = True
        self.ctx.enable(gl.DEPTH_TEST)
