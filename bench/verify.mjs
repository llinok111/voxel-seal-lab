#!/usr/bin/env node
/**
 * bench/verify.mjs — assertions over src/core.mjs and data/icosphere.json.
 * Exit 0 iff every assertion holds. Prints the actual measured value of each,
 * never a bare "ok".
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mulberry32, meshBounds, makeGrid, triBoxOverlap, voxelizeConservative,
  voxelizeNaive, sampleSurfacePoints, countEscapes, floodExterior, floodStats,
  makeSphereInside, occupancyHash, certifyAtResolution,
} from '../src/core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mesh = JSON.parse(readFileSync(join(ROOT, 'data', 'icosphere.json'), 'utf8'));
const RES = 48;
const ESCAPES = 20000;

let failures = 0;
function check(name, ok, value) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  :: ${value}`);
  if (!ok) failures++;
}

/* ---- A1: SAT predicate on hand-built cases --------------------------- */
{
  const box = (c) => [c[0], c[1], c[2], 0.5, 0.5, 0.5];
  const hit = triBoxOverlap([-2, 0, 0], [2, 0, 0], [0, 2, 0], ...box([0, 0, 0]));
  const miss = triBoxOverlap([-2, 3, 3], [2, 3, 3], [0, 5, 3], ...box([0, 0, 0]));
  check('A1a SAT: triangle through box centre -> overlap', hit === true, `triBoxOverlap=${hit}`);
  check('A1b SAT: far coplanar triangle -> no overlap', miss === false, `triBoxOverlap=${miss}`);

  // A1c: box entirely outside the triangle plane but with overlapping AABB
  const planeMiss = triBoxOverlap([0, 0, 0.9], [4, 0, 0.9], [0, 4, 0.9], 2, 2, 0, 1, 1, 0.1);
  check('A1c SAT: AABB overlaps but plane separates', planeMiss === false, `triBoxOverlap=${planeMiss}`);
}

/* ---- A2: no false negatives on 3000 random triangle/box pairs -------- */
{
  const rnd = mulberry32(0xC0FFEE);
  const rv = () => rnd() * 4 - 2;
  let pairs = 0, overlapped = 0, falseNeg = 0, sampled = 0;
  for (let n = 0; n < 3000; n++) {
    const v0 = [rv(), rv(), rv()], v1 = [rv(), rv(), rv()], v2 = [rv(), rv(), rv()];
    const c = [rv(), rv(), rv()], h = 0.25 + rnd() * 0.75;
    pairs++;
    if (triBoxOverlap(v0, v1, v2, c[0], c[1], c[2], h, h, h)) { overlapped++; continue; }
    // SAT said "separated": try hard to falsify it by dense sampling of the box
    const M = 9;
    let found = false;
    for (let a = 0; a < M && !found; a++) {
      const x = c[0] - h + (2 * h * (a + 0.5)) / M;
      for (let b = 0; b < M && !found; b++) {
        const y = c[1] - h + (2 * h * (b + 0.5)) / M;
        for (let d = 0; d < M; d++) {
          const z = c[2] - h + (2 * h * (d + 0.5)) / M;
          sampled++;
          if (pointInTriangle(x, y, z, v0, v1, v2, 1e-9)) { found = true; break; }
        }
      }
    }
    if (found) falseNeg++;
  }
  check('A2 SAT: 0 false negatives over random pairs', falseNeg === 0,
    `pairs=${pairs} overlapped=${overlapped} separated=${pairs - overlapped} probePoints=${sampled} falseNegatives=${falseNeg}`);
}

function pointInTriangle(px, py, pz, a, b, c, eps) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (nl < 1e-15) return false;
  const d = ((px - a[0]) * n[0] + (py - a[1]) * n[1] + (pz - a[2]) * n[2]) / nl;
  if (Math.abs(d) > eps) return false;
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const vp = [px - a[0], py - a[1], pz - a[2]];
  const d00 = dot(e1, e1), d01 = dot(e1, e2), d11 = dot(e2, e2);
  const d20 = dot(vp, e1), d21 = dot(vp, e2);
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-18) return false;
  const u = (d11 * d20 - d01 * d21) / den;
  const v = (d00 * d21 - d01 * d20) / den;
  return u > eps && v > eps && u + v < 1 - eps;
}

/* ---- A3..A6: the certificate itself ---------------------------------- */
const bounds = meshBounds(mesh.positions);
const grid = makeGrid(bounds, RES, 1.06);
const inside = makeSphereInside(mesh.sphere.center, mesh.sphere.rMin, 0.85);
const cert = certifyAtResolution(mesh, RES, { insideTest: inside, escapes: ESCAPES });

check('A3 exact voxelizer: 0 surface escapes', cert.exactEscapes === 0,
  `escapes=${cert.exactEscapes}/${cert.escapeSamples} (res=${RES})`);
check('A3b sampling baseline: escapes > 0 (baseline is really defective)', cert.naiveEscapes > 0,
  `naiveEscapes=${cert.naiveEscapes}/${cert.escapeSamples} = ${(100 * cert.naiveEscapes / cert.escapeSamples).toFixed(3)}%`);

check('A4 exact voxelizer: 0 outside-flood leak voxels', cert.exactLeaks === 0,
  `exactLeaks=${cert.exactLeaks} naiveLeaks=${cert.naiveLeaks} (naive does not percolate at the scanned resolutions)`);

const analyticInterior = (4 / 3) * Math.PI * Math.pow(0.85 * mesh.sphere.rMin, 3) / Math.pow(cert.cell, 3);
const sealedErr = Math.abs(cert.exactSealedInterior - analyticInterior) / analyticInterior;
check('A5 sealed interior matches the analytic sphere volume within 1%', sealedErr < 0.01,
  `sealed=${cert.exactSealedInterior} analytic=${analyticInterior.toFixed(0)} relErr=${(100 * sealedErr).toFixed(3)}%`);

// naive occupancy must be a strict subset of the conservative occupancy
const ex = voxelizeConservative(mesh, grid);
const na = voxelizeNaive(mesh, grid, ex.tests, 12345);
let notSubset = 0, naiveMarked = 0;
for (let i = 0; i < ex.occ.length; i++) {
  if (na.occ[i]) { naiveMarked++; if (!ex.occ[i]) notSubset++; }
}
check('A6 naive occupancy is a strict subset of the exact occupancy', notSubset === 0 && naiveMarked < ex.marked,
  `naiveMarked=${naiveMarked} exactMarked=${ex.marked} violations=${notSubset}`);

const again = voxelizeConservative(mesh, grid);
check('A7 determinism: repeated run gives the same bitmap hash', occupancyHash(again.occ) === cert.exactHash,
  `hash=${cert.exactHash} rerun=${occupancyHash(again.occ)}`);

/* ---- A8: generator is byte-deterministic ----------------------------- */
{
  const tmp = mkdtempSync(join(tmpdir(), 'voxseal-'));
  try {
    writeFileSync(join(tmp, 'gen-sample.mjs'), readFileSync(join(ROOT, 'tools', 'gen-sample.mjs')));
    const h = [];
    for (let i = 0; i < 2; i++) {
      execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-sample.mjs')], { cwd: ROOT });
      h.push(createHash('sha256').update(readFileSync(join(ROOT, 'data', 'icosphere.json'))).digest('hex'));
    }
    check('A8 tools/gen-sample.mjs is byte-deterministic', h[0] === h[1], `sha256=${h[0].slice(0, 16)}... twice identical=${h[0] === h[1]}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---- A9: cross-file anchor (README / bench/result.json) -------------- */
{
  const p = join(ROOT, 'bench', 'result.json');
  const res = JSON.parse(readFileSync(p, 'utf8'));
  const anchor = res.anchors?.[String(RES)];
  const benchHash = res.scan?.find((s) => s.res === RES)?.exactHash;
  check('A9 bench/result.json anchor matches this run', anchor === cert.exactHash && benchHash === cert.exactHash,
    `verify=${cert.exactHash} result.anchors=${anchor} result.scan=${benchHash}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
