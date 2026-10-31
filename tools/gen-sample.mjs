#!/usr/bin/env node
/**
 * Deterministic sample asset: an icosphere mesh.
 *   node tools/gen-sample.mjs
 * Writes data/icosphere.json (positions, indices, radius).
 * Same command twice -> byte-identical file (no Date, no Math.random).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'data', 'icosphere.json');

const SUBDIVISIONS = 3; // 20 * 4^3 = 1280 triangles

function icosphere(subdiv) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const unit = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  verts = verts.map(unit);

  for (let s = 0; s < subdiv; s++) {
    const mid = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const m = unit([
        (verts[a][0] + verts[b][0]) / 2,
        (verts[a][1] + verts[b][1]) / 2,
        (verts[a][2] + verts[b][2]) / 2,
      ]);
      verts.push(m);
      const id = verts.length - 1;
      mid.set(key, id);
      return id;
    };
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { verts, faces };
}

const { verts, faces } = icosphere(SUBDIVISIONS);
const q = (x) => Number(x.toFixed(6));

const positions = [];
for (const v of verts) positions.push(q(v[0]), q(v[1]), q(v[2]));
const indices = [];
for (const f of faces) indices.push(f[0], f[1], f[2]);

// radius actually realised after quantisation, measured - not assumed
let rmax = 0, rmin = Infinity;
for (let i = 0; i < positions.length; i += 3) {
  const r = Math.hypot(positions[i], positions[i + 1], positions[i + 2]);
  if (r > rmax) rmax = r;
  if (r < rmin) rmin = r;
}

const doc = {
  name: 'icosphere-subdiv3',
  generator: 'tools/gen-sample.mjs',
  subdivisions: SUBDIVISIONS,
  sphere: { center: [0, 0, 0], rMin: q(rmin), rMax: q(rmax) },
  vertexCount: positions.length / 3,
  triangleCount: indices.length / 3,
  positions,
  indices,
};

const text = JSON.stringify(doc);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);

console.log(`wrote ${OUT}`);
console.log(`  vertices=${doc.vertexCount} triangles=${doc.triangleCount} bytes=${text.length}`);
console.log(`  radial range [${q(rmin)}, ${q(rmax)}]`);
console.log(`  sha256=${createHash('sha256').update(text).digest('hex')}`);
