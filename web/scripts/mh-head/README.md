# MakeHuman head → `src/render/headData.ts`

Player heads use the MakeHuman base mesh and targets, released under **CC0 1.0**
(https://github.com/makehumancommunity/makehuman, `LICENSE.md` section C: assets are CC0).

## Rebuild

1. Download into a folder, e.g. `mh/` (outside the repo is fine):
   - `makehuman/data/3dobjs/base.obj` → `mh/base.obj`
   - these targets, flat, into `mh/targets/` (from `makehuman/data/targets/<group>/`):
     - macrodetails: `caucasian-male-young`, `asian-male-young`, `african-male-young`,
       `universal-male-young-averagemuscle-minweight`, `universal-male-young-maxmuscle-minweight`
     - head: `head-square`, `head-oval`, `head-round`, `head-rectangular`, `head-triangular`
     - nose: `nose-scale-horiz-incr/decr`, `nose-hump-incr`, `nose-point-width-incr`, `nose-scale-vert-incr`, `nose-flaring-incr`
     - chin: `chin-width-incr/decr`, `chin-prominent-incr/decr`, `chin-cleft-incr`, `chin-height-incr`
     - mouth: `mouth-upperlip-volume-incr/decr`, `mouth-lowerlip-volume-incr/decr`, `mouth-scale-horiz-incr`
     - ears: `l-ear-trans-backward`, `r-ear-trans-backward`
     - eyebrows: `eyebrows-trans-down`; forehead: `forehead-temple-decr`
2. `python build_head.py <mh-folder> ../../src/render/headData.ts` (needs numpy)

The script cuts the head and neck, grows the neck down under the collar, bakes the face
texture (brows, lash line, lips) into the face sheet, and stores the targets as sparse morphs.
`face-preview.png` is the baked sheet, for inspection only.

Preview heads in the dev server at `/dev/heads.html` (`?view=side|back`, `&n=8`).
