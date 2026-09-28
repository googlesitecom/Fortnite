"""
procedural.py — Generación procedural de assets del motor/juego.

Contiene:
  * Ruido value/simplex-like con octave fBm (para terreno, nubes, texturas).
  * Altura del terreno de la isla (biomas por mapa de ruido + máscaras).
  * Generación procedural de texturas PBR (albedo/rough/normal/AO) con numpy.
  * Fábrica de geometrías primitivas (box, esfera, cilindro, cápsula, plano,
    cuña/rampa, cono, toro) con UVs y normales.
Las texturas se guardan como .npy (RGB uint8) y se cargan en GPU al arrancar;
también hay un conversor a PNG en tools/.
"""
import math
import os
import numpy as np

from . import math3d as m3

ASSET_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "textures")

# ------------------------------------------------------------------- Ruido --
class ValueNoise:
    """Ruido de valor 2D/3D con interpolación cúbica suave y hash entero."""

    def __init__(self, seed=1337):
        self.seed = seed

    @staticmethod
    def _hash2(ix, iy, seed):
        h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
        h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
        return (h & 0xFFFF) / 32767.0 - 1.0

    @staticmethod
    def _hash3(ix, iy, iz, seed):
        h = (ix * 374761393 + iy * 668265263 + iz * 1440662683 + seed * 65537) & 0xFFFFFFFF
        h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
        return (h & 0xFFFF) / 32767.0 - 1.0

    def noise2(self, x, y):
        ix, iy = math.floor(x), math.floor(y)
        fx, fy = x - ix, y - iy
        ux = fx * fx * (3 - 2 * fx)
        uy = fy * fy * (3 - 2 * fy)
        a = self._hash2(ix, iy, self.seed)
        b = self._hash2(ix + 1, iy, self.seed)
        c = self._hash2(ix, iy + 1, self.seed)
        d = self._hash2(ix + 1, iy + 1, self.seed)
        return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy

    def fbm2(self, x, y, octaves=5, lac=2.0, gain=0.5):
        total, amp, freq = 0.0, 1.0, 1.0
        for _ in range(octaves):
            total += amp * self.noise2(x * freq, y * freq)
            amp *= gain
            freq *= lac
        return total


NOISE = ValueNoise(20260928)
NOISE2 = ValueNoise(777)


def fbm_np(xs, ys, octaves=5, scale=1.0, lac=2.0, gain=0.5, seed=20260928):
    """fBm vectorizado sobre grilla (para generación rápida de mapas)."""
    acc = np.zeros_like(xs, dtype=np.float64)
    amp, freq = 1.0, 1.0
    for o in range(octaves):
        # hash por celda entera con desplazamiento por octava
        gx = xs * scale * freq
        gy = ys * scale * freq
        ix = np.floor(gx).astype(np.int64)
        iy = np.floor(gy).astype(np.int64)
        fx = gx - ix
        fy = gy - iy
        ux = fx * fx * (3 - 2 * fx)
        uy = fy * fy * (3 - 2 * fy)

        def h(a, b):
            hh = (a * 374761393 + b * 668265263 + (seed + o * 977) * 2147483647) & 0xFFFFFFFF
            hh = ((hh ^ (hh >> 13)) * 1274126177) & 0xFFFFFFFF
            return (hh & 0xFFFF) / 32767.0 - 1.0

        v = (h(ix, iy) * (1 - ux) * (1 - uy) + h(ix + 1, iy) * ux * (1 - uy)
             + h(ix, iy + 1) * (1 - ux) * uy + h(ix + 1, iy + 1) * ux * uy)
        acc += amp * v
        amp *= gain
        freq *= lac
    return acc


# ----------------------------------------------------------------- Terreno --
ISLAND_SIZE = 4096.0          # 4 km x 4 km
WATER_LEVEL = 2.0             # altura del mar
MAX_HEIGHT = 320.0            # pico máximo (montaña nevada)


def island_mask(u, v):
    """Máscara radial que da forma de isla (u,v en [0,1]). Borde -> 0."""
    x = (u - 0.5) * 2.0
    y = (v - 0.5) * 2.0
    d = math.sqrt(x * x + y * y)
    wob = NOISE.noise2(u * 6.0, v * 6.0) * 0.12
    return m3.smoothstep(1.0 + wob, 0.62 + wob, d)


def terrain_height(x, z):
    """Altura analítica del terreno en coordenadas mundo (metros).

    Combina: forma de isla, meseta central con lago, cordillera NE nevada,
    colinas SW, playa E, cañón/desierto S, pantano W con río.
    """
    u = x / ISLAND_SIZE + 0.5
    v = z / ISLAND_SIZE + 0.5
    if not (0 <= u <= 1 and 0 <= v <= 1):
        return -20.0
    base = 26.0 + 34.0 * NOISE.fbm2(u * 5.0, v * 5.0, 4)
    # Meseta central con depresión para el lago
    cx, cy = u - 0.5, v - 0.5
    dc = math.sqrt(cx * cx + cy * cy)
    lake = -22.0 * m3.smoothstep(0.10, 0.02, dc)
    base += lake
    # Cordillera NE (nevada)
    mx, my = u - 0.74, v - 0.24
    dm = math.sqrt(mx * mx + my * my)
    ridge = MAX_HEIGHT * m3.smoothstep(0.20, 0.04, dm)
    ridge *= 0.75 + 0.5 * NOISE.fbm2(u * 9.0, v * 9.0, 4)
    base += ridge
    # Colinas de las mansiones SW
    hx, hy = u - 0.26, v - 0.72
    dh = math.sqrt(hx * hx + hy * hy)
    base += 70.0 * m3.smoothstep(0.16, 0.03, dh) * (0.8 + 0.4 * NOISE2.noise2(u * 8, v * 8))
    # Cañón desértico sur
    q = NOISE2.fbm2(u * 3.0 + 11, v * 3.0, 3)
    desert = (v > 0.66 and u > 0.35 and u < 0.68)
    if desert:
        base = base * 0.55 + 18.0 + 10.0 * abs(q)
    # Río oeste hacia el lago (entalla terreno)
    rx = 0.16 + 0.05 * math.sin(v * math.pi * 3.2)
    dr = abs(u - rx)
    river_cut = -14.0 * m3.smoothstep(0.020, 0.004, dr)
    if v < 0.52:
        base += river_cut
    # Pantano bajo al oeste
    if u < 0.30 and 0.35 < v < 0.62:
        base = min(base, 6.0 + 4.0 * NOISE.noise2(u * 12, v * 12))
    base *= island_mask(u, v)
    return float(base) - 8.0


def terrain_normal(x, z, e=1.5):
    hl = terrain_height(x - e, z)
    hr = terrain_height(x + e, z)
    hd = terrain_height(x, z - e)
    hu = terrain_height(x, z + e)
    n = np.array([hl - hr, 2.0 * e, hd - hu], dtype=np.float32)
    return m3.normalize(n)


def biome_at(x, z):
    """Devuelve id de bioma para selección de material/vegetación.
    0 agua, 1 playa, 2 hierba, 3 bosque, 4 roca/montaña, 5 nieve, 6 desierto,
    7 pantano."""
    h = terrain_height(x, z)
    u = x / ISLAND_SIZE + 0.5
    v = z / ISLAND_SIZE + 0.5
    if h < WATER_LEVEL:
        return 0
    if h < WATER_LEVEL + 3.5 and v > 0.30 and u > 0.62:
        return 1
    if u < 0.30 and 0.35 < v < 0.62 and h < 12:
        return 7
    if v > 0.66 and 0.35 < u < 0.68 and h < 40:
        return 6
    if h > 190:
        return 5
    if h > 120:
        return 4
    forest_n = NOISE2.fbm2(u * 7.0 + 3, v * 7.0, 3)
    if forest_n > 0.05:
        return 3
    return 2


# ------------------------------------------------------- Texturas PBR proc --
def _smooth_noise_img(size, freq, seed, octaves=3):
    xs, ys = np.meshgrid(np.linspace(0, freq, size), np.linspace(0, freq, size))
    return fbm_np(xs, ys, octaves=octaves, scale=1.0, seed=seed)


def gen_grass(seed=11):
    s = 256
    n = _smooth_noise_img(s, 8, seed, 4)
    detail = _smooth_noise_img(s, 64, seed + 1, 2)
    g = 0.45 + 0.35 * (n * 0.5 + 0.5) + 0.10 * detail
    albedo = np.zeros((s, s, 3), np.uint8)
    albedo[..., 1] = np.clip(g * 255, 0, 255)
    albedo[..., 0] = np.clip(g * 120, 0, 255)
    albedo[..., 2] = np.clip(g * 70, 0, 255)
    rough = np.full((s, s, 3), int(0.92 * 255), np.uint8)
    return albedo, rough


def gen_sand(seed=22):
    s = 256
    n = _smooth_noise_img(s, 10, seed, 3)
    d = _smooth_noise_img(s, 90, seed + 3, 2)
    v = 0.75 + 0.15 * n + 0.06 * d
    albedo = np.stack([v * 235, v * 205, v * 150], -1).clip(0, 255).astype(np.uint8)
    rough = np.full((s, s, 3), int(0.85 * 255), np.uint8)
    return albedo, rough


def gen_rock(seed=33):
    s = 256
    n = _smooth_noise_img(s, 6, seed, 5)
    cracks = np.abs(_smooth_noise_img(s, 14, seed + 5, 3))
    mask = (cracks < 0.12).astype(np.float64)
    v = 0.42 + 0.30 * (n * 0.5 + 0.5)
    v -= 0.25 * mask
    albedo = np.stack([v * 150, v * 148, v * 142], -1).clip(0, 255).astype(np.uint8)
    rough = (np.full((s, s), 0.80) + 0.15 * n)[..., None].clip(0, 1) * 255
    return albedo, rough.astype(np.uint8)


def gen_snow(seed=44):
    s = 256
    n = _smooth_noise_img(s, 20, seed, 3)
    v = 0.88 + 0.10 * (n * 0.5 + 0.5)
    albedo = np.stack([v * 250, v * 252, v * 255], -1).clip(0, 255).astype(np.uint8)
    rough = np.full((s, s, 3), int(0.35 * 255), np.uint8)
    return albedo, rough


def gen_mud(seed=55):
    s = 256
    n = _smooth_noise_img(s, 9, seed, 4)
    v = 0.30 + 0.18 * (n * 0.5 + 0.5)
    albedo = np.stack([v * 120, v * 95, v * 60], -1).clip(0, 255).astype(np.uint8)
    rough = np.full((s, s, 3), int(0.95 * 255), np.uint8)
    return albedo, rough


def gen_wood(seed=66):
    s = 256
    xs, ys = np.meshgrid(np.linspace(0, 3, s), np.linspace(0, 40, s))
    rings = np.sin(xs * 6 + _smooth_noise_img(s, 6, seed, 3) * 4)
    rings = rings * 0.5 + 0.5
    grain = _smooth_noise_img(s, 80, seed + 2, 2) * 0.2
    v = 0.45 + 0.35 * rings + grain
    albedo = np.stack([v * 175, v * 120, v * 70], -1).clip(0, 255).astype(np.uint8)
    rough = np.full((s, s, 3), int(0.75 * 255), np.uint8)
    return albedo, rough


def gen_stone_brick(seed=77):
    s = 256
    bricks = np.zeros((s, s))
    bh = s // 8
    bw = s // 4
    for row in range(8):
        off = (row % 2) * (bw // 2)
        for col in range(-1, 5):
            x0, y0 = col * bw + off, row * bh
            shade = 0.55 + 0.25 * ((hash((x0, y0, seed)) % 1000) / 1000.0)
            bricks[y0 + 3:y0 + bh - 3, x0 + 3:x0 + bw - 3] = shade
    n = _smooth_noise_img(s, 24, seed, 3) * 0.15
    v = (bricks + n).clip(0.1, 1.0)
    albedo = np.stack([v * 165, v * 160, v * 155], -1).clip(0, 255).astype(np.uint8)
    rough = np.full((s, s, 3), int(0.85 * 255), np.uint8)
    return albedo, rough


def gen_metal(seed=88):
    s = 256
    n = _smooth_noise_img(s, 40, seed, 3)
    scratches = np.abs(_smooth_noise_img(s, 60, seed + 1, 2))
    v = 0.55 + 0.18 * n
    v[scratches < 0.05] *= 1.25
    albedo = np.stack([v * 150, v * 155, v * 165], -1).clip(0, 255).astype(np.uint8)
    rough = (np.full((s, s), 0.35) + 0.2 * n)[..., None].clip(0, 1) * 255
    return albedo, rough.astype(np.uint8)


def gen_concrete(seed=99):
    s = 256
    n = _smooth_noise_img(s, 30, seed, 4)
    speckle = (_smooth_noise_img(s, 120, seed + 2, 2) > 0.55).astype(np.float64) * 0.1
    v = 0.55 + 0.18 * n + speckle
    albedo = np.stack([v * 175, v * 175, v * 172], -1).clip(0, 255).astype(np.uint8)
    rough = np.full((s, s, 3), int(0.88 * 255), np.uint8)
    return albedo, rough


def gen_glass_panel(seed=101):
    s = 256
    panel = np.zeros((s, s))
    for i in range(4):
        for j in range(4):
            t = ((i * 4 + j) % 7) / 7.0
            panel[j * 64:(j + 1) * 64, i * 64:(i + 1) * 64] = 0.25 + 0.5 * t
    albedo = np.stack([panel * 90, panel * 140, panel * 170], -1).clip(0, 255).astype(np.uint8)
    rough = np.full((s, s, 3), int(0.12 * 255), np.uint8)
    return albedo, rough


def gen_roof_shingle(seed=111):
    s = 256
    rows = np.repeat((_smooth_noise_img(s, 8, seed, 2) * 0.5 + 0.5)[::8][:, None], 8, axis=1).reshape(s, s)
    lines = np.zeros((s, s))
    lines[::16, :] = 1.0
    v = 0.35 + 0.3 * rows - 0.2 * lines
    albedo = np.stack([v * 130, v * 70, v * 55], -1).clip(0, 255).astype(np.uint8)
    rough = np.full((s, s, 3), int(0.8 * 255), np.uint8)
    return albedo, rough


def gen_water_normal(seed=121):
    """Normal map de olas generada por derivadas de suma de senos."""
    s = 256
    x = np.linspace(0, 1, s)
    X, Y = np.meshgrid(x, x)
    h = np.zeros_like(X)
    rng = np.random.default_rng(seed)
    for _ in range(8):
        ang = rng.uniform(0, 2 * np.pi)
        f = rng.uniform(4, 14)
        a = rng.uniform(0.3, 1.0) / 8
        h += a * np.sin((X * np.cos(ang) + Y * np.sin(ang)) * f * 2 * np.pi)
    dhdx = np.gradient(h, axis=1)
    dhdy = np.gradient(h, axis=0)
    n = np.stack([-dhdx * 2, -dhdy * 2, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return ((n * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)


def height_to_normal(himg, strength=2.0):
    dhdx = np.gradient(himg, axis=1) * strength
    dhdy = np.gradient(himg, axis=0) * strength
    n = np.stack([-dhdx, -dhdy, np.ones_like(himg)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return ((n * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)


PROCEDURAL_TEXTURES = {
    "grass": gen_grass, "sand": gen_sand, "rock": gen_rock, "snow": gen_snow,
    "mud": gen_mud, "wood": gen_wood, "brick": gen_stone_brick, "metal": gen_metal,
    "concrete": gen_concrete, "glass": gen_glass_panel, "roof": gen_roof_shingle,
}


def build_texture_dir(force=False):
    """Genera todas las texturas procedurales y las guarda como .npy.

    Guarda también una textura combinada RGBA: RGB=albedo, A=roughness, y su
    normal map asociada. Retorna dict nombre->ruta.
    """
    os.makedirs(ASSET_DIR, exist_ok=True)
    out = {}
    for name, fn in PROCEDURAL_TEXTURES.items():
        alb_p = os.path.join(ASSET_DIR, f"{name}_albedo.npy")
        rgh_p = os.path.join(ASSET_DIR, f"{name}_rough.npy")
        nrm_p = os.path.join(ASSET_DIR, f"{name}_normal.npy")
        out[name] = (alb_p, rgh_p, nrm_p)
        if not force and os.path.exists(alb_p):
            continue
        albedo, rough = fn()
        lum = albedo.astype(np.float32).mean(-1) / 255.0
        normal = height_to_normal(lum, 1.5)
        np.save(alb_p, albedo)
        np.save(rgh_p, rough)
        np.save(nrm_p, normal)
    wn = gen_water_normal()
    np.save(os.path.join(ASSET_DIR, "water_normal.npy"), wn)
    out["water_normal"] = (os.path.join(ASSET_DIR, "water_normal.npy"),)
    return out


# -------------------------------------------------------------- Geometrías --
def mesh_box(w=1, h=1, d=1, uv_scale=1.0):
    """Box centrado en origen. Devuelve (verts float32 [pos|normal|uv], idx)."""
    hw, hh, hd = w / 2, h / 2, d / 2
    faces = [
        ((-hw, -hh, hd), (0, 0, 1), [(0, 0), (w, 0), (w, h), (0, h)]),      # frente +Z
        ((hw, -hh, -hd), (0, 0, -1), [(0, 0), (w, 0), (w, h), (0, h)]),     # atrás -Z
        ((hw, -hh, hd), (1, 0, 0), [(0, 0), (d, 0), (d, h), (0, h)]),       # der +X
        ((-hw, -hh, -hd), (-1, 0, 0), [(0, 0), (d, 0), (d, h), (0, h)]),    # izq -X
        ((-hw, hh, hd), (0, 1, 0), [(0, 0), (w, 0), (w, d), (0, d)]),       # arriba +Y
        ((-hw, -hh, -hd), (0, -1, 0), [(0, 0), (w, 0), (w, d), (0, d)]),    # abajo -Y
    ]
    verts, idx = [], []
    base = 0
    for origin, n, uvs in faces:
        ox, oy, oz = origin
        sx = w if n[0] == 0 else (abs(n[0]) * d)
        for (ux, uy) in uvs:
            px = ox + (ux - sx / 2) * (1 if n[2] != 0 or n[0] == 0 else 0)
            # simple: desplazamos según eje normal
            verts.append([ox, oy, oz, n[0], n[1], n[2], ux * uv_scale, uy * uv_scale])
        # corregir posiciones locales: construimos manualmente
        base_idx = len(verts) - 4
        idx += [base_idx, base_idx + 1, base_idx + 2, base_idx, base_idx + 2, base_idx + 3]
    # Las caras front/back usan offsets en X/Y desde origin; reconstruyamos preciso:
    verts = []
    idx = []
    quads = [
        # (+Z) frente
        ([(-hw, -hh, hd), (hw, -hh, hd), (hw, hh, hd), (-hw, hh, hd)], (0, 0, 1)),
        # (-Z)
        ([(hw, -hh, -hd), (-hw, -hh, -hd), (-hw, hh, -hd), (hw, hh, -hd)], (0, 0, -1)),
        # (+X)
        ([(hw, -hh, hd), (hw, -hh, -hd), (hw, hh, -hd), (hw, hh, hd)], (1, 0, 0)),
        # (-X)
        ([(-hw, -hh, -hd), (-hw, -hh, hd), (-hw, hh, hd), (-hw, hh, -hd)], (-1, 0, 0)),
        # (+Y)
        ([(-hw, hh, hd), (hw, hh, hd), (hw, hh, -hd), (-hw, hh, -hd)], (0, 1, 0)),
        # (-Y)
        ([(-hw, -hh, -hd), (hw, -hh, -hd), (hw, -hh, hd), (-hw, -hh, hd)], (0, -1, 0)),
    ]
    base = 0
    for quad, n in quads:
        us = [0, w, w, 0] if abs(n[2]) > 0 else ([0, d, d, 0] if abs(n[0]) > 0 else [0, w, w, 0])
        vs = [0, 0, h, h] if abs(n[2]) > 0 or abs(n[0]) > 0 else ([0, 0, d, d] if abs(n[1]) > 0 else [0, 0, h, h])
        if abs(n[1]) > 0:
            vs = [0, 0, d, d]
        for k in range(4):
            verts.append([*quad[k], *n, us[k] * uv_scale, vs[k] * uv_scale])
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
        base += 4
    return np.array(verts, np.float32), np.array(idx, np.uint32)


def mesh_sphere(radius=1.0, seg=24, ring=16):
    verts, idx = [], []
    for r in range(ring + 1):
        phi = math.pi * r / ring
        for s in range(seg + 1):
            th = 2 * math.pi * s / seg
            x = math.sin(phi) * math.cos(th)
            y = math.cos(phi)
            z = math.sin(phi) * math.sin(th)
            n = (x, y, z)
            verts.append([x * radius, y * radius, z * radius, *n,
                          s / seg, r / ring])
    for r in range(ring):
        for s in range(seg):
            a = r * (seg + 1) + s
            b = a + seg + 1
            idx += [a, b, a + 1, b, b + 1, a + 1]
    return np.array(verts, np.float32), np.array(idx, np.uint32)


def mesh_cylinder(radius=0.5, height=1.0, seg=20, caps=True):
    verts, idx = [], []
    hh = height / 2
    for s in range(seg + 1):
        th = 2 * math.pi * s / seg
        x, z = math.cos(th) * radius, math.sin(th) * radius
        verts.append([x, -hh, z, x, 0, z, s / seg, 0.0])
        verts.append([x, hh, z, x, 0, z, s / seg, 1.0])
    for s in range(seg):
        a = s * 2
        idx += [a, a + 1, a + 2, a + 1, a + 3, a + 2]
    if caps:
        base = len(verts)
        verts.append([0, hh, 0, 0, 1, 0, 0.5, 0.5])
        for s in range(seg + 1):
            th = 2 * math.pi * s / seg
            verts.append([math.cos(th) * radius, hh, math.sin(th) * radius,
                          0, 1, 0, math.cos(th) * 0.5 + 0.5, math.sin(th) * 0.5 + 0.5])
        for s in range(seg):
            idx += [base, base + 1 + s, base + 2 + s]
        base = len(verts)
        verts.append([0, -hh, 0, 0, -1, 0, 0.5, 0.5])
        for s in range(seg + 1):
            th = 2 * math.pi * s / seg
            verts.append([math.cos(th) * radius, -hh, math.sin(th) * radius,
                          0, -1, 0, math.cos(th) * 0.5 + 0.5, math.sin(th) * 0.5 + 0.5])
        for s in range(seg):
            idx += [base, base + 2 + s, base + 1 + s]
    return np.array(verts, np.float32), np.array(idx, np.uint32)


def mesh_capsule(radius=0.4, height=1.4, seg=16, ring=8):
    """Cápsula vertical centrada (útil visualmente para personajes)."""
    verts, idx = [], []
    cyl_h = max(height - 2 * radius, 0.001)
    for r in range(ring + 1):
        phi = math.pi * r / ring
        sp, cp = math.sin(phi), math.cos(phi)
        yy = cp * radius + (cyl_h / 2 if r < ring / 2 else -cyl_h / 2) if ring else 0
        yy = cp * radius + np.clip(cyl_h / 2, -cyl_h / 2 * np.sign(cp), cyl_h / 2 * np.sign(cp)) if False else cp * (radius + cyl_h / 2 * (1 if cp > 0 else -1) if abs(cp) > 0 else 0)
        # más simple: elongar esfera
        for s in range(seg + 1):
            th = 2 * math.pi * s / seg
            x = sp * math.cos(th)
            z = sp * math.sin(th)
            y = cp
            n = normalize3(x, y, z)
            verts.append([x * radius, y * (radius + cyl_h / 2), z * radius,
                          *n, s / seg, r / ring])
    for r in range(ring):
        for s in range(seg):
            a = r * (seg + 1) + s
            b = a + seg + 1
            idx += [a, b, a + 1, b, b + 1, a + 1]
    return np.array(verts, np.float32), np.array(idx, np.uint32)


def normalize3(x, y, z):
    l = math.sqrt(x * x + y * y + z * z) or 1.0
    return x / l, y / l, z / l


def mesh_plane(size=1.0, subdivisions=1):
    verts, idx = [], []
    n = subdivisions
    half = size / 2
    step = size / n
    for i in range(n + 1):
        for j in range(n + 1):
            x = -half + i * step
            z = -half + j * step
            verts.append([x, 0.0, z, 0, 1, 0, x / size + 0.5, z / size + 0.5])
    for i in range(n):
        for j in range(n):
            a = i * (n + 1) + j
            b = a + n + 1
            idx += [a, b, a + 1, b, b + 1, a + 1]
    return np.array(verts, np.float32), np.array(idx, np.uint32)


def mesh_ramp(w=4.0, h=4.0, d=4.0):
    """Cuña/rampa de construcción: hipotenusa sube en +Y hacia +Z."""
    tri = [
        # lado triangular izq y der
        ([(-w / 2, 0, -d / 2), (-w / 2, 0, d / 2), (-w / 2, h, d / 2)], (-1, 0, 0)),
        ([(w / 2, 0, d / 2), (w / 2, 0, -d / 2), (w / 2, h, d / 2)], (1, 0, 0)),
        # base
        ([(-w / 2, 0, d / 2), (w / 2, 0, d / 2), (w / 2, 0, -d / 2), (-w / 2, 0, -d / 2)], (0, -1, 0)),
        # pared trasera
        ([(-w / 2, 0, -d / 2), (w / 2, 0, -d / 2), (w / 2, h, -d / 2), (-w / 2, h, -d / 2)], (0, 0, -1)),
        # hipotenusa
        ([(-w / 2, 0, d / 2), (w / 2, 0, d / 2), (w / 2, h, -d / 2), (-w / 2, h, -d / 2)], None),
    ]
    verts, idx = [], []
    base = 0
    for poly, n in tri:
        if n is None:
            p0, p1, p2 = np.array(poly[0]), np.array(poly[1]), np.array(poly[2])
            cr = np.cross(p1 - p0, p2 - p0)
            l = np.linalg.norm(cr) or 1
            n = tuple(cr / l)
        for p in poly:
            verts.append([*p, *n, p[0] + w / 2, p[2] + d / 2])
        if len(poly) == 3:
            idx += [base, base + 1, base + 2]
        else:
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]
        base += len(poly)
    return np.array(verts, np.float32), np.array(idx, np.uint32)


def mesh_cone(radius=0.5, height=1.0, seg=16):
    verts, idx = [], []
    for s in range(seg + 1):
        th = 2 * math.pi * s / seg
        x, z = math.cos(th) * radius, math.sin(th) * radius
        n = normalize3(x, radius / height, z)
        verts.append([x, 0, z, *n, s / seg, 0])
    apex = len(verts)
    verts.append([0, height, 0, 0, 1, 0, 0.5, 1])
    for s in range(seg):
        idx += [s, apex, s + 1]
    base = len(verts)
    verts.append([0, 0, 0, 0, -1, 0, 0.5, 0.5])
    for s in range(seg + 1):
        th = 2 * math.pi * s / seg
        verts.append([math.cos(th) * radius, 0, math.sin(th) * radius, 0, -1, 0,
                      math.cos(th) * .5 + .5, math.sin(th) * .5 + .5])
    for s in range(seg):
        idx += [base, base + 2 + s, base + 1 + s]
    return np.array(verts, np.float32), np.array(idx, np.uint32)


def mesh_tree(kind=0):
    """Árbol procedural: tronco + copa (cono o esfera). Origen en la base."""
    parts = []
    trunk_v, trunk_i = mesh_cylinder(0.35, 4.5, 10)
    trunk_v[:, 1] += 2.25
    parts.append((trunk_v, trunk_i, "wood"))
    if kind == 0:  # pino
        for k, (yy, rr) in enumerate([(4.2, 2.4), (5.8, 1.8), (7.2, 1.2)]):
            cv, ci = mesh_cone(rr, 2.4, 12)
            cv[:, 1] += yy
            parts.append((cv, ci, "leaves"))
    elif kind == 1:  # frondoso
        sv, si = mesh_sphere(2.6, 14, 10)
        sv[:, 1] += 6.0
        sv[:, 0] *= 1.15
        parts.append((sv, si, "leaves"))
    else:  # palma
        sv, si = mesh_sphere(1.6, 10, 8)
        sv[:, 1] += 7.5
        parts.append((sv, si, "leaves"))
    return parts


def merge_meshes(mesh_list):
    """mesh_list: [(verts, idx)] -> (verts, idx) fusionado."""
    all_v, all_i = [], []
    base = 0
    for v, i in mesh_list:
        all_v.append(v)
        all_i.append(i + base)
        base += len(v)
    return np.concatenate(all_v), np.concatenate(all_i)
