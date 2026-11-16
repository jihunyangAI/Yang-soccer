"""
Builds web/src/render/headData.ts from the MakeHuman base mesh (CC0).

Inputs (download once, see README.md next to this script):
  <mh>/base.obj               makehuman/data/3dobjs/base.obj
  <mh>/targets/*.target       makehuman/data/targets/**.target (flat folder)

Usage:  python build_head.py <mh-folder> <out.ts>

Output: the head and neck cut from a young adult male, in game space (metres, x forward,
y up, z to the player's right), with
  - packed UVs for a 1024x1024 face sheet and a baked face texture (PNG, multiplied by skin),
  - per-vertex ambient occlusion and an ear mask,
  - sparse morph targets for face variety,
  - the eyeball centres (MakeHuman eye helpers) for the base and each morph.
"""
import sys, base64, io, zlib, struct
import numpy as np

MH, OUT = sys.argv[1], sys.argv[2]

# ---------------------------------------------------------------- load
V, VT, FV, FT, G = [], [], [], [], []
g = None
for line in open(f'{MH}/base.obj'):
    if line.startswith('v '): V.append([float(x) for x in line.split()[1:4]])
    elif line.startswith('vt '): VT.append([float(x) for x in line.split()[1:3]])
    elif line.startswith('g '): g = line.split()[1]
    elif line.startswith('f '):
        p = line.split()[1:]
        FV.append([int(t.split('/')[0]) - 1 for t in p])
        FT.append([int(t.split('/')[1]) - 1 for t in p])
        G.append(g)
V = np.array(V); VT = np.array(VT); N = len(V)

def target(name):
    d = np.zeros((N, 3))
    for line in open(f'{MH}/targets/{name}.target'):
        if line[0].isdigit():
            a = line.split(); d[int(a[0])] = [float(a[1]), float(a[2]), float(a[3])]
    return pad(d) if 'pad' in globals() else d

ETH = {k: target(f'{k}-male-young') for k in ('caucasian', 'asian', 'african')}
mean_eth = sum(ETH.values()) / 3
LEAN = target('universal-male-young-averagemuscle-minweight')
BASE = V + mean_eth + 0.3 * LEAN

def eye_center(P, grp):
    vs = set(); [vs.update(f) for f, gg in zip(FV, G) if gg == grp]
    return P[sorted(vs)].mean(0)

# ---------------------------------------------------------------- cut the head
CUT_Y = 6.86
sel = [i for i, (f, gg) in enumerate(zip(FV, G))
       if gg == 'body' and any(BASE[v, 1] > CUT_Y for v in f) and all(abs(BASE[v, 0]) < 1.4 for v in f)]
# Flatten the ragged bottom row onto the cut plane so the neck ends in a clean ring.
_low = sorted({v for i in sel for v in FV[i] if BASE[v, 1] < CUT_Y})
# Those vertices also sit wider (toward the shoulders): pull each in to the radius of its
# neighbours above the cut, so the neck does not flare into a ledge.
_c0 = BASE[_low][:, [0, 2]].mean(0)
_up = {v: [] for v in _low}
for i in sel:
    for v in FV[i]:
        if v in _up: _up[v] += [u for u in FV[i] if BASE[u, 1] >= CUT_Y]
for v, us in _up.items():
    if us:
        r_ok = np.mean([np.linalg.norm(BASE[u][[0, 2]] - _c0) for u in us])
        off = BASE[v][[0, 2]] - _c0; r = np.linalg.norm(off)
        if r > r_ok: BASE[v, [0, 2]] = _c0 + off * (r_ok / r)
BASE[_low, 1] = CUT_Y

# islands in UV space (faces sharing a uv corner)
par = list(range(len(VT)))
def find(a):
    while par[a] != a:
        par[a] = par[par[a]]; a = par[a]
    return a
for i in sel:
    for t in FT[i][1:]: par[find(t)] = find(FT[i][0])
islands = {}
for i in sel: islands.setdefault(find(FT[i][0]), []).append(i)
islands = sorted(islands.values(), key=len, reverse=True)

# Pack: main island fills the left 880 px of a 1024 sheet (stretched), the rest stack on the right.
SHEET = 1024
pack = {}  # uv index -> (u, v) in 0..1 sheet space (v up)
def place(faces, x0, y0, w, h):
    ts = sorted({t for i in faces for t in FT[i]})
    uv = VT[ts]; lo, hi = uv.min(0), uv.max(0)
    for t, (u, v) in zip(ts, uv):
        pack[t] = ((x0 + (u - lo[0]) / (hi[0] - lo[0]) * w) / SHEET,
                   (y0 + (v - lo[1]) / (hi[1] - lo[1]) * h) / SHEET)
place(islands[0], 8, 8, 864, 1008)
for k, isl in enumerate(islands[1:]):
    place(isl, 888, 8 + k * 200, 128, 184)

# Output vertices: one per (position index, uv index) pair.
key_of = {}; out_v = []; out_t = []; tris = []
for i in sel:
    ids = []
    for v, t in zip(FV[i], FT[i]):
        k = (v, t)
        if k not in key_of:
            key_of[k] = len(out_v); out_v.append(v); out_t.append(t)
        ids.append(key_of[k])
    a, b, c, d = ids
    tris += [a, b, c, a, c, d]
# Skirt: continue the neck below the cut in two rings that taper to fit under the shirt collar,
# so the head and neck are one surface with no visible seam.
from collections import Counter
low = set(_low)
edge_n = Counter(); edge_at = {}
for i in sel:
    f, t = FV[i], FT[i]
    for k in range(4):
        a, b = f[k], f[(k + 1) % 4]
        edge_n[frozenset((a, b))] += 1
        edge_at[(a, b)] = (key_of[(a, t[k])], key_of[(b, t[(k + 1) % 4])])
rim = [(a, b) for (a, b) in edge_at if edge_n[frozenset((a, b))] == 1 and a in low and b in low]
ctr = BASE[list(low)].mean(0)
extra = []
pos_row = {}  # (source position row, ring) -> new position row, shared by every UV copy
def ring_vertex(top_id, y, kx, kz, cache):
    if top_id not in cache:
        src = out_v[top_id]
        if (src, y) not in pos_row:
            p = (BASE[src] if src < len(BASE) else extra[src - len(BASE)]).copy()
            p[0] = ctr[0] + (p[0] - ctr[0]) * kx; p[2] = ctr[2] + (p[2] - ctr[2]) * kz; p[1] = y
            extra.append(p)
            pos_row[(src, y)] = len(BASE) + len(extra) - 1
        cache[top_id] = len(out_v)
        out_v.append(pos_row[(src, y)]); out_t.append(out_t[top_id])
    return cache[top_id]
MID_Y, BOT_Y = CUT_Y - 0.17, CUT_Y - 0.55
mid, bot = {}, {}
for a, b in rim:
    ia, ib = edge_at[(a, b)]
    ma, mb = ring_vertex(ia, MID_Y, 1.0, 0.98, mid), ring_vertex(ib, MID_Y, 1.0, 0.98, mid)
    ba, bb = ring_vertex(ma, BOT_Y, 0.97, 0.92, bot), ring_vertex(mb, BOT_Y, 0.97, 0.92, bot)
    tris += [ib, ia, ma, ib, ma, mb, mb, ma, ba, mb, ba, bb]
BASE = np.vstack([BASE, np.array(extra)])
NB = len(BASE)
# Each added row follows the original neck vertex it was grown from.
root = {}
for (src, _y), row in pos_row.items(): root[row] = src
def _r(r):
    while r in root: r = root[r]
    return r
_rows = np.array(sorted(root)); _src = np.array([_r(r) for r in _rows])
def pad(d):
    if len(d) >= NB: return d
    d = np.vstack([d, np.zeros((NB - len(d), 3))]); d[_rows] = d[_src]; return d
out_v = np.array(out_v); tris = np.array(tris)
# Relax the band around the cut (horizontal only) so the neck reads as one smooth column.
_nb = {}
for t in np.array(tris).reshape(-1, 3):
    for a in t:
        for b in t:
            if a != b: _nb.setdefault(out_v[a], set()).add(out_v[b])
_band = [v for v in _nb if BASE[v, 1] < CUT_Y + 0.3 and v not in set(out_v[list(bot.values())])]
for _ in range(6):
    _new = {v: BASE[list(_nb[v])][:, [0, 2]].mean(0) for v in _band}
    for v, xz in _new.items(): BASE[v, [0, 2]] = 0.5 * BASE[v, [0, 2]] + 0.5 * xz
print('head verts', len(out_v), 'tris', len(tris) // 3, 'neck rim edges', len(rim))
from collections import Counter as _C; _deg=_C([a for a,b in rim]+[b for a,b in rim]); print('rim vertex degrees', _C(_deg.values()))

# ---------------------------------------------------------------- space conversion
S = 0.1
NECK_Z = 0.32   # MakeHuman z of the neck centre -> game x = 0
TOP_Y = BASE[:, 1][[v for i in sel for v in FV[i]]].max()
GAME_TOP = 1.816
def to_game(P):
    return np.stack([(P[:, 2] - NECK_Z) * S, (P[:, 1] - TOP_Y) * S + GAME_TOP, -P[:, 0] * S], 1)
def dir_to_game(D):
    return np.stack([D[:, 2] * S, D[:, 1] * S, -D[:, 0] * S], 1)

# ---------------------------------------------------------------- normals (welded), AO, masks
P = BASE[out_v]
weld = {}; wid = np.array([weld.setdefault(v, len(weld)) for v in out_v])
Pw = np.zeros((len(weld), 3)); Pw[wid] = P
Nw = np.zeros_like(Pw)
T3 = tris.reshape(-1, 3)
fn = np.cross(Pw[wid[T3[:, 1]]] - Pw[wid[T3[:, 0]]], Pw[wid[T3[:, 2]]] - Pw[wid[T3[:, 0]]])
for k in range(3): np.add.at(Nw, wid[T3[:, k]], fn)
Nw /= np.linalg.norm(Nw, axis=1, keepdims=True) + 1e-12
# Concavity AO: how far each vertex sits below the average of its neighbours, along the normal.
nb = [set() for _ in range(len(weld))]
for t in T3:
    a, b, c = wid[t]
    nb[a].update((b, c)); nb[b].update((a, c)); nb[c].update((a, b))
avg = np.array([Pw[list(s)].mean(0) for s in nb])
conc = ((avg - Pw) * Nw).sum(1)
for _ in range(2):  # smooth a little
    conc = np.array([0.5 * conc[i] + 0.5 * conc[list(s)].mean() for i, s in enumerate(nb)])
ao_w = np.clip(1 - np.maximum(0, conc) * 9.0, 0.55, 1.0)
AO = ao_w[wid]

def mag(name, scale=1.0):
    d = np.linalg.norm(target(name)[out_v], axis=1)
    return np.clip(d / (d.max() + 1e-9) * scale, 0, 1)
EAR = np.maximum(mag('l-ear-trans-backward'), mag('r-ear-trans-backward'))  # 1 on the ear, falling off around it
LIPS = np.maximum(mag('mouth-upperlip-volume-incr', 1.6), mag('mouth-lowerlip-volume-incr', 1.6))

# ---------------------------------------------------------------- bake the face texture
EL, ER = eye_center(BASE, 'helper-l-eye'), eye_center(BASE, 'helper-r-eye')
ex, ey, ez = EL
print('eye', EL.round(3))

def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)

rng = np.random.default_rng(7)
def paint(p, n, lips):
    """p, n: (k,3) MakeHuman space; returns (k,3) multiply colour 0..1."""
    k = len(p); col = np.ones((k, 3))
    front = smooth(0.0, 0.35, n[:, 2]) * (p[:, 2] > 0.6)
    ax = np.abs(p[:, 0]); dx = ax - ex; dy = p[:, 1] - ey
    # Eyebrows: an arch over each eye, thick at the inner end, tapering outwards, with hair texture.
    t = np.clip((dx + 0.24) / 0.56, 0, 1)                  # 0 inner .. 1 outer
    cy = 0.255 + 0.075 * np.sin(np.pi * np.clip(t * 1.15, 0, 1)) - 0.03 * t
    half = 0.036 * (1 - t) + 0.013
    d = np.abs(dy - cy) / half
    brow = (1 - smooth(0.55, 1.15, d)) * (dx > -0.25) * (dx < 0.33) * front
    brow *= 0.55 + 0.45 * rng.random(k)
    col *= 1 - 0.62 * brow[:, None]
    # Lash line around the eye opening (upper lid darker), soft socket shadow above.
    de = np.sqrt(dx ** 2 + dy ** 2)
    eye_open = (np.abs(dx) < 0.17) * (np.abs(dy) < 0.11) * front
    rim = np.exp(-((de - 0.12) / 0.03) ** 2) * eye_open * (p[:, 2] > ez + 0.05)
    up = smooth(-0.02, 0.03, dy)
    col *= 1 - (0.35 + 0.5 * up)[:, None] * rim[:, None]
    sock = np.exp(-((dx + 0.02) / 0.2) ** 2 - ((dy - 0.12) / 0.07) ** 2) * front
    col *= 1 - 0.12 * sock[:, None] * np.array([1, 1.1, 1.05])
    # Lips: warmer and darker.
    col *= 1 - lips[:, None] * np.array([0.1, 0.26, 0.24])
    # Cheeks: faint warmth.
    ch = np.exp(-((ax - 0.42) / 0.2) ** 2 - ((p[:, 1] - 7.75) / 0.18) ** 2) * front
    col *= 1 - ch[:, None] * np.array([0.0, 0.08, 0.08])
    return np.clip(col, 0, 1)

R = SHEET
img = np.ones((R, R, 3)); filled = np.zeros((R, R), bool)
UVo = np.array([pack[t] for t in out_t]) * R
Pn = Nw[wid]
for tri in T3:
    q = UVo[tri]
    x0, y0 = np.floor(q.min(0)).astype(int) - 1; x1, y1 = np.ceil(q.max(0)).astype(int) + 1
    xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
    xs, ys = xs.ravel(), ys.ravel()
    (ax_, ay_), (bx_, by_), (cx_, cy_) = q
    den = (by_ - cy_) * (ax_ - cx_) + (cx_ - bx_) * (ay_ - cy_)
    if abs(den) < 1e-9: continue
    w0 = ((by_ - cy_) * (xs - cx_) + (cx_ - bx_) * (ys - cy_)) / den
    w1 = ((cy_ - ay_) * (xs - cx_) + (ax_ - cx_) * (ys - cy_)) / den
    w2 = 1 - w0 - w1
    m = (w0 > -0.02) & (w1 > -0.02) & (w2 > -0.02)
    if not m.any(): continue
    W = np.stack([w0[m], w1[m], w2[m]], 1)
    p = W @ P[tri]; nrm = W @ Pn[tri]; lp = W @ LIPS[tri]
    px = np.clip(xs[m].astype(int), 0, R - 1); py = np.clip(R - 1 - ys[m].astype(int), 0, R - 1)
    img[py, px] = paint(p, nrm, lp); filled[py, px] = True
# Bleed colours outward so mip-mapping does not pull in white at island edges.
for _ in range(6):
    acc = np.zeros_like(img); cnt = np.zeros((R, R))
    for sx, sy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        sh = np.roll(np.roll(filled, sy, 0), sx, 1)
        acc += np.roll(np.roll(img, sy, 0), sx, 1) * sh[..., None]; cnt += sh
    grow = (~filled) & (cnt > 0)
    img[grow] = acc[grow] / cnt[grow][:, None]; filled |= grow

def png(rgb):
    h, w, _ = rgb.shape
    raw = b''.join(b'\x00' + rgb[y].tobytes() for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
tex = png((img * 255 + 0.5).astype(np.uint8))
open(__file__.replace('build_head.py', 'face-preview.png'), 'wb').write(tex)  # for inspection only

# ---------------------------------------------------------------- morphs
def morph_of(name_or_delta):
    d = target(name_or_delta) if isinstance(name_or_delta, str) else name_or_delta
    return d
MORPHS = {
    'caucasian': ETH['caucasian'] - mean_eth,
    'asian': ETH['asian'] - mean_eth,
    'african': ETH['african'] - mean_eth,
    'square': target('head-square'), 'oval': target('head-oval'), 'round': target('head-round'),
    'rect': target('head-rectangular'), 'tri': target('head-triangular'),
    'noseWide': target('nose-scale-horiz-incr'), 'noseNarrow': target('nose-scale-horiz-decr'),
    'noseHump': target('nose-hump-incr'), 'noseTip': target('nose-point-width-incr'),
    'noseLong': target('nose-scale-vert-incr'), 'flare': target('nose-flaring-incr'),
    'chinWide': target('chin-width-incr'), 'chinNarrow': target('chin-width-decr'),
    'chinOut': target('chin-prominent-incr'), 'chinIn': target('chin-prominent-decr'),
    'chinCleft': target('chin-cleft-incr'), 'chinLong': target('chin-height-incr'),
    'lipsFull': target('mouth-upperlip-volume-incr') + target('mouth-lowerlip-volume-incr'),
    'lipsThin': target('mouth-upperlip-volume-decr') + target('mouth-lowerlip-volume-decr'),
    'mouthWide': target('mouth-scale-horiz-incr'),
    'lean': target('universal-male-young-maxmuscle-minweight') - target('universal-male-young-averagemuscle-minweight'),
    'browLow': target('eyebrows-trans-down'), 'temple': target('forehead-temple-decr'),
}
MORPHS = {k: pad(v) for k, v in MORPHS.items()}
# Whole-body targets also move the head with the body's height; keep only the change in shape.
for k in ('caucasian', 'asian', 'african', 'lean'):
    MORPHS[k] = MORPHS[k] - MORPHS[k][out_v].mean(0)

# ---------------------------------------------------------------- write TS
def b64(a): return base64.b64encode(a.tobytes()).decode()
G0 = to_game(P)
POS_Q = 1e-4  # 0.1 mm
lines = []
lines.append('// Generated by web/scripts/mh-head/build_head.py from the MakeHuman base mesh (CC0 1.0).')
lines.append('// Do not edit by hand.')
lines.append(f'export const HEAD_COUNT = {len(out_v)};')
lines.append(f'export const HEAD_POS = "{b64(np.round(G0 / POS_Q).astype(np.int16))}";')
lines.append(f'export const HEAD_UV = "{b64(np.round(UVo / R * 65535).astype(np.uint16))}";')
lines.append(f'export const HEAD_INDEX = "{b64(tris.astype(np.uint16))}";')
lines.append(f'export const HEAD_AO = "{b64(np.round(AO * 255).astype(np.uint8))}";')
lines.append(f'export const HEAD_EAR = "{b64(np.round(EAR * 255).astype(np.uint8))}";')
eyes = to_game(np.stack([EL, ER]))
lines.append(f'export const HEAD_EYES = {np.round(eyes, 5).tolist()}; // left, right')
lines.append('export const HEAD_MORPHS: Record<string, { idx: string; d: string; eyes: number[][] }> = {')
for name, D in MORPHS.items():
    d = D[out_v]; nz = np.nonzero(np.abs(d).max(1) > 1e-4)[0]
    dg = dir_to_game(d[nz])
    q = np.clip(np.round(dg / POS_Q), -32767, 32767).astype(np.int16)
    de = dir_to_game(np.stack([eye_center(BASE + D, 'helper-l-eye') - EL, eye_center(BASE + D, 'helper-r-eye') - ER]))
    lines.append(f'  {name}: {{ idx: "{b64(nz.astype(np.uint16))}", d: "{b64(q)}", eyes: {np.round(de, 5).tolist()} }},')
    print(f'morph {name}: {len(nz)} verts, max {np.abs(dg).max()*1000:.1f} mm')
lines.append('};')
lines.append(f'export const HEAD_FACE_PNG = "data:image/png;base64,{base64.b64encode(tex).decode()}";')
open(OUT, 'w').write('\n'.join(lines) + '\n')
print('wrote', OUT, sum(len(l) for l in lines) // 1024, 'KB')
