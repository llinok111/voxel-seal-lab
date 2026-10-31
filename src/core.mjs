/**
 * src/core.mjs — conservative (watertight) mesh voxelization, pure geometry.
 *
 * No three.js, no DOM, no I/O, no globals touched at import time.
 * Every function is deterministic: same input bytes -> same output bytes.
 *
 * Claim under test: a voxelization that marks a voxel iff the voxel BOX really
 * overlaps the triangle (13-axis SAT, Akenine-Moller style) has *zero* surface
 * escapes and *zero* outside-flood leaks, at a sample budget where a
 * barycentric point-sampling voxelizer both escapes and leaks.
 */

/* ------------------------------------------------------------------ math */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function meshBounds(positions) {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  return { min: [minx, miny, minz], max: [maxx, maxy, maxz] };
}

/** Cubic, axis-aligned grid that contains `bounds` with `pad` relative margin. */
export function makeGrid(bounds, res, pad = 1.06) {
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const ex = bounds.max[0] - bounds.min[0];
  const ey = bounds.max[1] - bounds.min[1];
  const ez = bounds.max[2] - bounds.min[2];
  const half = Math.max(Math.max(ex, ey, ez) / 2 * pad, 1e-9);
  const cell = (2 * half) / res;
  return {
    res,
    cell,
    half,
    center: [cx, cy, cz],
    origin: [cx - half, cy - half, cz - half],
  };
}

export function voxelCount(grid) {
  return grid.res * grid.res * grid.res;
}

/* ------------------------------------------------- 13-axis SAT tri vs box */

function separated(ax, ay, az, u0x, u0y, u0z, u1x, u1y, u1z, u2x, u2y, u2z, hx, hy, hz) {
  const len = Math.sqrt(ax * ax + ay * ay + az * az);
  if (len < 1e-12) return false; // degenerate axis: carries no information
  const p0 = (u0x * ax + u0y * ay + u0z * az) / len;
  const p1 = (u1x * ax + u1y * ay + u1z * az) / len;
  const p2 = (u2x * ax + u2y * ay + u2z * az) / len;
  let mn = p0, mx = p0;
  if (p1 < mn) mn = p1; if (p1 > mx) mx = p1;
  if (p2 < mn) mn = p2; if (p2 > mx) mx = p2;
  const r = (hx * Math.abs(ax) + hy * Math.abs(ay) + hz * Math.abs(az)) / len;
  return mn > r || mx < -r;
}

/**
 * Exact overlap test for a triangle and an axis-aligned box.
 * Separating-axis theorem with the 13 axes of two convex polytopes
 * (3 box normals + triangle normal + 9 edge x box-axis cross products).
 * Conservative for the "does the box touch the triangle" question:
 * no false negatives. False positives are impossible too (SAT is exact for
 * convex sets), so `true` really means the closed sets intersect.
 */
export function triBoxOverlap(v0, v1, v2, cx, cy, cz, hx, hy, hz) {
  const u0x = v0[0] - cx, u0y = v0[1] - cy, u0z = v0[2] - cz;
  const u1x = v1[0] - cx, u1y = v1[1] - cy, u1z = v1[2] - cz;
  const u2x = v2[0] - cx, u2y = v2[1] - cy, u2z = v2[2] - cz;

  // cheap AABB reject
  const tminx = Math.min(u0x, u1x, u2x), tmaxx = Math.max(u0x, u1x, u2x);
  if (tminx > hx || tmaxx < -hx) return false;
  const tminy = Math.min(u0y, u1y, u2y), tmaxy = Math.max(u0y, u1y, u2y);
  if (tminy > hy || tmaxy < -hy) return false;
  const tminz = Math.min(u0z, u1z, u2z), tmaxz = Math.max(u0z, u1z, u2z);
  if (tminz > hz || tmaxz < -hz) return false;

  const e0x = u1x - u0x, e0y = u1y - u0y, e0z = u1z - u0z;
  const e1x = u2x - u1x, e1y = u2y - u1y, e1z = u2z - u1z;
  const e2x = u0x - u2x, e2y = u0y - u2y, e2z = u0z - u2z;

  // triangle normal
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  if (separated(nx, ny, nz, u0x, u0y, u0z, u1x, u1y, u1z, u2x, u2y, u2z, hx, hy, hz)) return false;

  const A = [u0x, u0y, u0z, u1x, u1y, u1z, u2x, u2y, u2z];
  const E = [e0x, e0y, e0z, e1x, e1y, e1z, e2x, e2y, e2z];
  for (let e = 0; e < 3; e++) {
    const ex = E[3 * e], ey = E[3 * e + 1], ez = E[3 * e + 2];
    // e x (1,0,0) = (0, ez, -ey)
    if (separated(0, ez, -ey, ...A, hx, hy, hz)) return false;
    // e x (0,1,0) = (-ez, 0, ex)
    if (separated(-ez, 0, ex, ...A, hx, hy, hz)) return false;
    // e x (0,0,1) = (ey, -ex, 0)
    if (separated(ey, -ex, 0, ...A, hx, hy, hz)) return false;
  }
  return true;
}

/* ------------------------------------------------------------ voxelizers */

function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function voxelOf(grid, x, y, z) {
  const { res, cell, origin } = grid;
  const i = Math.floor((x - origin[0]) / cell);
  const j = Math.floor((y - origin[1]) / cell);
  const k = Math.floor((z - origin[2]) / cell);
  if (i < 0 || j < 0 || k < 0 || i >= res || j >= res || k >= res) return -1;
  return (k * res + j) * res + i;
}

/** Akenine-Moller style exact SAT voxelization: every voxel the surface touches is marked. */
export function voxelizeConservative(mesh, grid) {
  const { positions, indices } = mesh;
  const { res, cell, origin } = grid;
  const occ = new Uint8Array(voxelCount(grid));
  const triCount = (indices.length / 3) | 0;
  let tests = 0, marked = 0;
  // hoisted vertex scratch: keeps the hot loop allocation-free (GC noise)
  const v0 = [0, 0, 0], v1 = [0, 0, 0], v2 = [0, 0, 0];

  for (let t = 0; t < triCount; t++) {
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    v0[0] = positions[a]; v0[1] = positions[a + 1]; v0[2] = positions[a + 2];
    v1[0] = positions[b]; v1[1] = positions[b + 1]; v1[2] = positions[b + 2];
    v2[0] = positions[c]; v2[1] = positions[c + 1]; v2[2] = positions[c + 2];

    const i0 = clampInt(Math.floor((Math.min(v0[0], v1[0], v2[0]) - origin[0]) / cell), 0, res - 1);
    const i1 = clampInt(Math.floor((Math.max(v0[0], v1[0], v2[0]) - origin[0]) / cell), 0, res - 1);
    const j0 = clampInt(Math.floor((Math.min(v0[1], v1[1], v2[1]) - origin[1]) / cell), 0, res - 1);
    const j1 = clampInt(Math.floor((Math.max(v0[1], v1[1], v2[1]) - origin[1]) / cell), 0, res - 1);
    const k0 = clampInt(Math.floor((Math.min(v0[2], v1[2], v2[2]) - origin[2]) / cell), 0, res - 1);
    const k1 = clampInt(Math.floor((Math.max(v0[2], v1[2], v2[2]) - origin[2]) / cell), 0, res - 1);

    const h = cell / 2;
    for (let k = k0; k <= k1; k++) {
      const cz = origin[2] + (k + 0.5) * cell;
      for (let j = j0; j <= j1; j++) {
        const cy = origin[1] + (j + 0.5) * cell;
        const rowBase = (k * res + j) * res;
        for (let i = i0; i <= i1; i++) {
          tests++;
          const cx = origin[0] + (i + 0.5) * cell;
          if (triBoxOverlap(v0, v1, v2, cx, cy, cz, h, h, h)) {
            const idx = rowBase + i;
            if (occ[idx] === 0) { occ[idx] = 1; marked++; }
          }
        }
      }
    }
  }
  return { occ, tests, marked, triangles: triCount };
}

function triangleAreas(positions, indices) {
  const triCount = (indices.length / 3) | 0;
  const areas = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const cxx = e1y * e2z - e1z * e2y, cyy = e1z * e2x - e1x * e2z, czz = e1x * e2y - e1y * e2x;
    const area = 0.5 * Math.sqrt(cxx * cxx + cyy * cyy + czz * czz);
    areas[t] = area;
    total += area;
  }
  return { areas, total };
}

/** Area-weighted uniform surface sampling, deterministic under `seed`. */
export function sampleSurfacePoints(mesh, n, seed) {
  const { positions, indices } = mesh;
  const { areas, total } = triangleAreas(positions, indices);
  const rnd = mulberry32(seed);
  const pts = new Float64Array(n * 3);
  let out = 0;
  // walk triangles in order, allocating floor(share) samples, then the remainder
  let acc = 0;
  const triCount = areas.length;
  for (let t = 0; t < triCount; t++) {
    acc += areas[t];
    const upto = t === triCount - 1 ? n : Math.floor((acc / total) * n);
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    for (; out < upto && out < n; out++) {
      const u = Math.sqrt(rnd());
      const r = rnd();
      const w0 = 1 - u, w1 = u * r, w2 = u * (1 - r);
      pts[3 * out] = positions[a] * w0 + positions[b] * w1 + positions[c] * w2;
      pts[3 * out + 1] = positions[a + 1] * w0 + positions[b + 1] * w1 + positions[c + 1] * w2;
      pts[3 * out + 2] = positions[a + 2] * w0 + positions[b + 2] * w1 + positions[c + 2] * w2;
    }
  }
  return pts;
}

/**
 * Baseline: barycentric point sampling. Marks the voxel that contains each
 * sample. Matched to the exact method by *total sample count* = its SAT test
 * count, so the comparison is work-for-work, not a strawman with fewer samples.
 */
export function voxelizeNaive(mesh, grid, totalSamples, seed = 12345) {
  const { positions, indices } = mesh;
  const { areas, total } = triangleAreas(positions, indices);
  const occ = new Uint8Array(voxelCount(grid));
  const rnd = mulberry32(seed);
  let samples = 0, marked = 0, acc = 0;
  const triCount = areas.length;

  for (let t = 0; t < triCount; t++) {
    acc += areas[t];
    const upto = t === triCount - 1 ? totalSamples : Math.floor((acc / total) * totalSamples);
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    for (; samples < upto && samples < totalSamples; samples++) {
      const u = Math.sqrt(rnd());
      const r = rnd();
      const w0 = 1 - u, w1 = u * r, w2 = u * (1 - r);
      const x = positions[a] * w0 + positions[b] * w1 + positions[c] * w2;
      const y = positions[a + 1] * w0 + positions[b + 1] * w1 + positions[c + 1] * w2;
      const z = positions[a + 2] * w0 + positions[b + 2] * w1 + positions[c + 2] * w2;
      const idx = voxelOf(grid, x, y, z);
      if (idx >= 0 && occ[idx] === 0) { occ[idx] = 1; marked++; }
    }
  }
  return { occ, samples, marked };
}

/* --------------------------------------------------------------- checks */

/** Surface points whose containing voxel is NOT marked. Exact method must give 0. */
export function countEscapes(pts, occ, grid) {
  let escapes = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const idx = voxelOf(grid, pts[i], pts[i + 1], pts[i + 2]);
    if (idx < 0 || occ[idx] === 0) escapes++;
  }
  return escapes;
}

/**
 * Flood fill the empty voxels reachable from the grid boundary through
 * 6-connected empty space. Anything empty left unreached is sealed inside.
 * If the flood reaches a voxel whose centre is deep inside the true solid,
 * the shell has a hole: that voxel is a leak.
 */
export function floodExterior(occ, res) {
  const n = res * res * res;
  const ext = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  const push = (i, j, k) => {
    const idx = (k * res + j) * res + i;
    if (occ[idx] === 0 && ext[idx] === 0) { ext[idx] = 1; queue[tail++] = idx; }
  };
  for (let j = 0; j < res; j++) for (let k = 0; k < res; k++) {
    push(0, j, k); push(res - 1, j, k);
  }
  for (let i = 0; i < res; i++) for (let k = 0; k < res; k++) {
    push(i, 0, k); push(i, res - 1, k);
  }
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
    push(i, j, 0); push(i, j, res - 1);
  }

  while (head < tail) {
    const idx = queue[head++];
    const i = idx % res;
    const j = ((idx / res) | 0) % res;
    const k = (idx / (res * res)) | 0;
    if (i > 0) { const m = idx - 1; if (occ[m] === 0 && ext[m] === 0) { ext[m] = 1; queue[tail++] = m; } }
    if (i < res - 1) { const m = idx + 1; if (occ[m] === 0 && ext[m] === 0) { ext[m] = 1; queue[tail++] = m; } }
    if (j > 0) { const m = idx - res; if (occ[m] === 0 && ext[m] === 0) { ext[m] = 1; queue[tail++] = m; } }
    if (j < res - 1) { const m = idx + res; if (occ[m] === 0 && ext[m] === 0) { ext[m] = 1; queue[tail++] = m; } }
    if (k > 0) { const m = idx - res * res; if (occ[m] === 0 && ext[m] === 0) { ext[m] = 1; queue[tail++] = m; } }
    if (k < res - 1) { const m = idx + res * res; if (occ[m] === 0 && ext[m] === 0) { ext[m] = 1; queue[tail++] = m; } }
  }
  return { ext, exteriorCount: tail };
}

/**
 * Classify every voxel against an analytic inside test.
 *   leakVoxels     : outside-reachable AND deep inside the solid  -> the shell has a hole
 *   sealedInterior : never reached by the outside flood AND deep inside -> correctly sealed
 *   innerBand      : never reached, but inside the analytic radius margin (shell band)
 */
export function floodStats(occ, flood, grid, insideTest) {
  const { res, cell, origin } = grid;
  let leakVoxels = 0, sealedInterior = 0, occupied = 0, exteriorEmpty = 0, innerBand = 0;
  for (let k = 0; k < res; k++) {
    const z = origin[2] + (k + 0.5) * cell;
    for (let j = 0; j < res; j++) {
      const y = origin[1] + (j + 0.5) * cell;
      for (let i = 0; i < res; i++) {
        const idx = (k * res + j) * res + i;
        if (occ[idx]) { occupied++; continue; }
        const x = origin[0] + (i + 0.5) * cell;
        const deep = insideTest(x, y, z);
        if (flood.ext[idx]) {
          if (deep) leakVoxels++; else exteriorEmpty++;
        } else {
          if (deep) sealedInterior++; else innerBand++;
        }
      }
    }
  }
  return { leakVoxels, sealedInterior, occupied, exteriorEmpty, innerBand };
}

/** Analytic ground truth used by the sample asset: sphere of radius r, shrunk by `f`. */
export function makeSphereInside(center, radius, f = 1) {
  const r2 = (radius * f) * (radius * f);
  return (x, y, z) => {
    const dx = x - center[0], dy = y - center[1], dz = z - center[2];
    return dx * dx + dy * dy + dz * dz < r2;
  };
}

/** FNV-1a 32-bit over the occupancy bitmap: the dual-end byte-identical anchor. */
export function occupancyHash(occ) {
  let h = 0x811c9dc5;
  for (let i = 0; i < occ.length; i++) {
    h ^= occ[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Convenience: full certificate for one resolution. Pure, no timing. */
export function certifyAtResolution(mesh, res, opts = {}) {
  const escapesN = opts.escapes ?? 20000;
  const seed = opts.seed ?? 20261101;
  const bounds = meshBounds(mesh.positions);
  const grid = makeGrid(bounds, res, opts.pad ?? 1.06);

  const exact = voxelizeConservative(mesh, grid);
  const naive = voxelizeNaive(mesh, grid, exact.tests, opts.naiveSeed ?? 12345);
  const pts = sampleSurfacePoints(mesh, escapesN, seed);

  const exactStats = floodStats(exact.occ, floodExterior(exact.occ, res), grid, opts.insideTest);
  const naiveStats = floodStats(naive.occ, floodExterior(naive.occ, res), grid, opts.insideTest);

  return {
    res,
    cell: grid.cell,
    exactTests: exact.tests,
    exactOccupied: exact.marked,
    naiveSamples: naive.samples,
    naiveOccupied: naive.marked,
    exactHash: occupancyHash(exact.occ),
    naiveHash: occupancyHash(naive.occ),
    exactEscapes: countEscapes(pts, exact.occ, grid),
    naiveEscapes: countEscapes(pts, naive.occ, grid),
    escapeSamples: escapesN,
    exactLeaks: exactStats.leakVoxels,
    naiveLeaks: naiveStats.leakVoxels,
    exactSealedInterior: exactStats.sealedInterior,
    naiveSealedInterior: naiveStats.sealedInterior,
    exactStats,
    naiveStats,
  };
}
