"""
gltf_loader.py — Cargador mínimo GLTF 2.0 (.glb binario y .gltf JSON).

Extrae mallas (posición, normales, UVs 0), materiales PBR (baseColorFactor,
metalness/roughness) y metadatos de skins para el fallback procedural.
Sin dependencias externas (struct + json).
"""
import json
import os
import struct
import numpy as np


def _read_glb(path):
    with open(path, "rb") as f:
        magic, ver, length = struct.unpack("<III", f.read(16))
        if magic != 0x46546C67:
            raise ValueError("no es GLB")
        chunks = {}
        while f.tell() < length:
            clen, ctype = struct.unpack("<II", f.read(8))
            data = f.read(clen)
            key = ctype.to_bytes(4, "little").decode("ascii", "ignore")
            chunks[key] = data
        return json.loads(chunks["JSON"].decode("utf-8")), chunks.get("BIN", b"")


COMP_DTYPE = {
    5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16,
    5125: np.uint32, 5126: np.float32,
}
COMP_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class GltfMesh:
    def __init__(self, name, positions, normals, uvs, indices, material=None):
        self.name = name
        self.positions = positions      # (N,3) float32
        self.normals = normals          # (N,3) float32 o None
        self.uvs = uvs                  # (N,2) float32 o None
        self.indices = indices          # (M,) uint32
        self.material = material or {}

    def bounds(self):
        mn = self.positions.min(0)
        mx = self.positions.max(0)
        return mn, mx


def load_gltf_meshes(path):
    """Devuelve lista de GltfMesh con posiciones ya en local."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".glb":
        gltf, bin_chunk = _read_glb(path)
    else:
        with open(path) as f:
            gltf = json.load(f)
        base = os.path.dirname(path)
        bin_chunk = b""
        for b in gltf.get("buffers", []):
            if "uri" in b:
                with open(os.path.join(base, b["uri"]), "rb") as bf:
                    bin_chunk = bf.read()
                break

    meshes = []
    for gm in gltf.get("meshes", []):
        for prim in gm.get("primitives", []):
            acc = gltf["accessors"]

            def read_attr(idx, ncomp):
                a = acc[idx]
                bv = gltf["bufferViews"][a["bufferView"]]
                dtype = COMP_DTYPE[a["componentType"]]
                count = a["count"] * a.get("type", "VEC3")[3:] or ncomp
                itemsize = np.dtype(dtype).itemsize * ncomp
                stride = bv.get("byteStride", 0)
                off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
                if stride in (0, itemsize):
                    arr = np.frombuffer(bin_chunk, dtype=dtype,
                                        count=a["count"] * ncomp, offset=off)
                    return arr.reshape(a["count"], ncomp).astype(np.float32)
                # interleave
                raw = np.frombuffer(bin_chunk, dtype=np.uint8,
                                    count=(a["count"] - 1) * stride + itemsize, offset=off)
                stepped = np.lib.stride_tricks.as_strided(
                    raw, shape=(a["count"], itemsize), strides=(stride, 1))
                return np.frombuffer(stepped.tobytes(), dtype=dtype).reshape(a["count"], ncomp).astype(np.float32)

            pos = read_attr(prim["attributes"]["POSITION"], 3)
            nrm = read_attr(prim["attributes"]["NORMAL"], 3) if "NORMAL" in prim.get("attributes", {}) else None
            uv = read_attr(prim["attributes"]["TEXCOORD_0"], 2) if "TEXCOORD_0" in prim.get("attributes", {}) else None
            idx_arr = None
            if "indices" in prim:
                ia = acc[prim["indices"]]
                bv = gltf["bufferViews"][ia["bufferView"]]
                dtype = COMP_DTYPE[ia["componentType"]]
                idx_arr = np.frombuffer(bin_chunk, dtype=dtype, count=ia["count"],
                                        offset=bv.get("byteOffset", 0) + ia.get("byteOffset", 0)).astype(np.uint32)
            mat = {}
            if "material" in prim:
                m = gltf["materials"][prim["material"]]
                pbr = m.get("pbrMetallicRoughness", {})
                mat["baseColorFactor"] = pbr.get("baseColorFactor", [0.8, 0.8, 0.8, 1.0])
                mat["metallicFactor"] = pbr.get("metallicFactor", 0.0)
                mat["roughnessFactor"] = pbr.get("roughnessFactor", 0.5)
                mat["emissiveFactor"] = m.get("emissiveFactor", [0, 0, 0])
            if idx_arr is None:
                idx_arr = np.arange(len(pos), dtype=np.uint32)
            meshes.append(GltfMesh(gm.get("name", "mesh"), pos, nrm, uv, idx_arr, mat))
    return meshes


def mesh_to_interleaved(mesh):
    """Convierte GltfMesh al layout del motor: [px py pz nx ny nz u v] por vert."""
    n = len(mesh.positions)
    verts = np.zeros((n, 8), np.float32)
    verts[:, :3] = mesh.positions
    if mesh.normals is not None and len(mesh.normals) == n:
        verts[:, 3:6] = mesh.normals
    else:
        verts[:, 5] = 1.0
    if mesh.uvs is not None and len(mesh.uvs) == n:
        verts[:, 6:8] = mesh.uvs
    return verts, mesh.indices.astype(np.uint32)
