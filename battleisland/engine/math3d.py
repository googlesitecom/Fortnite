"""
math3d.py — Matemática 3D del motor (column-vector, mano derecha).

Implementa vectores, matrices 4x4 (fila-primera estilo OpenGL/GLSL mat4),
cuaterniones y utilidades de cámara. Todo en numpy para rendimiento.
Convención: las matrices se almacenan como arrays (4,4) que se suben a GLSL
directamente con transpose=False porque usamos orden fila-primera y el shader
las reordena; para evitar ambigüedad construimos las matrices YA en orden
column-major listo para glUniformMatrix4fv / moderngl.
"""
import math
import numpy as np

EPS = 1e-6


def vec3(x=0.0, y=0.0, z=0.0):
    return np.array([x, y, z], dtype=np.float32)


def normalize(v):
    n = np.linalg.norm(v)
    if n < EPS:
        return np.zeros(3, dtype=np.float32)
    return v / n


def cross(a, b):
    return np.cross(a, b).astype(np.float32)


def dot(a, b):
    return float(np.dot(a, b))


# ---------------------------------------------------------------- Matrices --
# Todas devuelven np.ndarray (4,4) float32 en ORDEN COLUMN-MAJOR lógico,
# es decir M[i][j] es el elemento fila i, columna j (convención matemática).
# Al subirlas a GLSL con .ravel(order='F') quedan correctas.

def mat4_identity():
    return np.eye(4, dtype=np.float32)


def mat4_translate(t):
    m = np.eye(4, dtype=np.float32)
    m[0, 3], m[1, 3], m[2, 3] = t[0], t[1], t[2]
    return m


def mat4_scale(s):
    m = np.eye(4, dtype=np.float32)
    if np.ndim(s) == 0:
        m[0, 0] = m[1, 1] = m[2, 2] = s
    else:
        m[0, 0], m[1, 1], m[2, 2] = s[0], s[1], s[2]
    return m


def mat4_rot_x(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4, dtype=np.float32)
    m[1, 1], m[1, 2] = c, -s
    m[2, 1], m[2, 2] = s, c
    return m


def mat4_rot_y(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4, dtype=np.float32)
    m[0, 0], m[0, 2] = c, s
    m[2, 0], m[2, 2] = -c * 0 + c, 0  # placeholder overwritten below
    m[2, 0], m[2, 2] = -s, c
    return m


def mat4_rot_z(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4, dtype=np.float32)
    m[0, 0], m[0, 1] = c, -s
    m[1, 0], m[1, 1] = s, c
    return m


def mat4_trs(pos, rot_euler_deg, scale):
    """Translate * RotXYZ * Scale (composición clásica TRS)."""
    rx, ry, rz = (math.radians(a) for a in rot_euler_deg)
    m = mat4_translate(pos) @ mat4_rot_y(ry) @ mat4_rot_x(rx) @ mat4_rot_z(rz)
    s = mat4_scale(scale)
    return m @ s


def mat4_perspective(fov_deg, aspect, near, far):
    f = 1.0 / math.tan(math.radians(fov_deg) * 0.5)
    m = np.zeros((4, 4), dtype=np.float32)
    m[0, 0] = f / aspect
    m[1, 1] = f
    m[2, 2] = (far + near) / (near - far)
    m[2, 3] = (2 * far * near) / (near - far)
    m[3, 2] = -1.0
    return m


def mat4_ortho(left, right, bottom, top, near, far):
    m = np.zeros((4, 4), dtype=np.float32)
    m[0, 0] = 2.0 / (right - left)
    m[1, 1] = 2.0 / (top - bottom)
    m[2, 2] = -2.0 / (far - near)
    m[0, 3] = -(right + left) / (right - left)
    m[1, 3] = -(top + bottom) / (top - bottom)
    m[2, 3] = -(far + near) / (far - near)
    m[3, 3] = 1.0
    return m


def mat4_look_at(eye, target, up=(0, 1, 0)):
    eye = np.asarray(eye, dtype=np.float32)
    target = np.asarray(target, dtype=np.float32)
    up = np.asarray(up, dtype=np.float32)
    f = normalize(target - eye)
    if np.linalg.norm(f) < EPS:
        f = vec3(0, 0, -1)
    s = normalize(cross(f, up))
    if np.linalg.norm(s) < EPS:
        s = vec3(1, 0, 0)
    u = cross(s, f)
    m = np.eye(4, dtype=np.float32)
    m[0, :3] = s
    m[1, :3] = u
    m[2, :3] = -f
    m[0, 3] = -dot(s, eye)
    m[1, 3] = -dot(u, eye)
    m[2, 3] = dot(f, eye)
    return m


def mat4_inverse(m):
    return np.linalg.inv(m).astype(np.float32)


def mat4_inverse_affine(m):
    """Inversa rápida para matrices afines (rot+scale+trans)."""
    r = m[:3, :3]
    inv_r = np.linalg.inv(r)
    out = np.eye(4, dtype=np.float32)
    out[:3, :3] = inv_r
    out[:3, 3] = -inv_r @ m[:3, 3]
    return out.astype(np.float32)


def transform_point(m, p):
    p4 = np.array([p[0], p[1], p[2], 1.0], dtype=np.float32)
    q = m @ p4
    return q[:3]


def transform_dir(m, d):
    q = m[:3, :3] @ np.asarray(d, dtype=np.float32)
    return q


# --------------------------------------------------------------- Frustum ---
def frustum_planes_from_vp(vp):
    """Extrae los 6 planos (ax+by+cz+d=0, normal interior) de la matriz VP."""
    m = vp
    planes = np.array([
        m[3] + m[0],
        m[3] - m[0],
        m[3] + m[1],
        m[3] - m[1],
        m[3] + m[2],
        m[3] - m[2],
    ], dtype=np.float32)
    for i in range(6):
        n = np.linalg.norm(planes[i, :3])
        if n > EPS:
            planes[i] /= n
    return planes


def sphere_in_frustum(planes, center, radius):
    for pl in planes:
        if dot(pl[:3], center) + pl[3] < -radius:
            return False
    return True


# ------------------------------------------------------------ Cuaterniones -
def quat_from_axis_angle(axis, angle):
    axis = normalize(np.asarray(axis, dtype=np.float64))
    s = math.sin(angle * 0.5)
    return np.array([axis[0] * s, axis[1] * s, axis[2] * s, math.cos(angle * 0.5)],
                    dtype=np.float32)


def quat_mul(q1, q2):
    x1, y1, z1, w1 = q1
    x2, y2, z2, w2 = q2
    return np.array([
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2], dtype=np.float32)


def quat_slerp(q1, q2, t):
    q1 = np.asarray(q1, dtype=np.float64)
    q2 = np.asarray(q2, dtype=np.float64)
    d = float(np.dot(q1, q2))
    if d < 0:
        q2 = -q2
        d = -d
    if d > 0.9995:
        q = q1 + t * (q2 - q1)
        return (q / np.linalg.norm(q)).astype(np.float32)
    theta = math.acos(max(-1, min(1, d)))
    s = math.sin(theta)
    a = math.sin((1 - t) * theta) / s
    b = math.sin(t * theta) / s
    return (a * q1 + b * q2).astype(np.float32)


def quat_to_mat3(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float32)


# ---------------------------------------------------------------- Utilidad -
def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0 + EPS), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def random_unit():
    v = np.random.randn(3).astype(np.float32)
    return normalize(v)
