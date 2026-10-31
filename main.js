/**
 * main.js — rendering + interaction only. All geometry comes from src/core.mjs,
 * the very same module bench/verify.mjs and bench/bench.mjs import in node.
 * Nothing is recomputed here that core does not own.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  meshBounds, makeGrid, voxelizeConservative, voxelizeNaive,
  sampleSurfacePoints, countEscapes, floodExterior, floodStats,
  makeSphereInside, occupancyHash,
} from './src/core.mjs';

const $ = (id) => document.getElementById(id);
const SAMPLES = 20000;
const SEED = 20261101;

const canvas = $('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(2.6, 1.7, 2.6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x101820, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(3, 5, 2);
scene.add(key);

const group = new THREE.Group();
scene.add(group);

const mesh = await (await fetch('./data/icosphere.json')).json();
let anchors = {};
try {
  anchors = (await (await fetch('./bench/result.json')).json()).anchors ?? {};
} catch {
  anchors = {};
}
const inside = makeSphereInside(mesh.sphere.center, mesh.sphere.rMin, 0.85);

// static reference: the source surface as wireframe
{
  const pos = new Float32Array(mesh.positions);
  const idx = new Uint32Array(mesh.indices);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(g),
    new THREE.LineBasicMaterial({ color: 0x24405a })
  );
  scene.add(wire);
}

function clearGroup() {
  for (const child of [...group.children]) {
    group.remove(child);
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  }
}

function hexToColor(hex) {
  return new THREE.Color(hex);
}

function render(res) {
  clearGroup();
  const t0 = performance.now();
  const grid = makeGrid(meshBounds(mesh.positions), res, 1.06);
  const exact = voxelizeConservative(mesh, grid);
  const naive = voxelizeNaive(mesh, grid, exact.tests, 12345);
  const pts = sampleSurfacePoints(mesh, SAMPLES, SEED);
  const exactEscapes = countEscapes(pts, exact.occ, grid);
  const naiveEscapes = countEscapes(pts, naive.occ, grid);
  const exactStats = floodStats(exact.occ, floodExterior(exact.occ, res), grid, inside);
  const naiveStats = floodStats(naive.occ, floodExterior(naive.occ, res), grid, inside);
  const hash = occupancyHash(exact.occ);
  const ms = performance.now() - t0;

  // occupied voxels as one InstancedMesh
  const idxs = [];
  for (let i = 0; i < exact.occ.length; i++) if (exact.occ[i]) idxs.push(i);
  const box = new THREE.BoxGeometry(grid.cell * 0.82, grid.cell * 0.82, grid.cell * 0.82);
  const mat = new THREE.MeshLambertMaterial({ color: hexToColor('#3fbfae'), transparent: true, opacity: 0.85 });
  const inst = new THREE.InstancedMesh(box, mat, idxs.length);
  const m4 = new THREE.Matrix4();
  for (let n = 0; n < idxs.length; n++) {
    const i = idxs[n] % res;
    const j = ((idxs[n] / res) | 0) % res;
    const k = (idxs[n] / (res * res)) | 0;
    m4.makeTranslation(
      grid.origin[0] + (i + 0.5) * grid.cell,
      grid.origin[1] + (j + 0.5) * grid.cell,
      grid.origin[2] + (k + 0.5) * grid.cell
    );
    inst.setMatrixAt(n, m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);

  // surface samples: red where the naive baseline has no occupied voxel
  const colors = new Float32Array(SAMPLES * 3);
  const missed = new Float32Array(SAMPLES * 3);
  let missedCount = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const x = pts[3 * s], y = pts[3 * s + 1], z = pts[3 * s + 2];
    const gi = Math.floor((x - grid.origin[0]) / grid.cell);
    const gj = Math.floor((y - grid.origin[1]) / grid.cell);
    const gk = Math.floor((z - grid.origin[2]) / grid.cell);
    const gidx = (gk * res + gj) * res + gi;
    const miss = gidx < 0 || exact.occ[gidx] === 0;
    if (miss) { colors[3 * s] = 1; colors[3 * s + 1] = .3; colors[3 * s + 2] = .3; }
    else { colors[3 * s] = .29; colors[3 * s + 1] = .85; colors[3 * s + 2] = .5; }
    if (gi >= 0 && gi < res && gj >= 0 && gj < res && gk >= 0 && gk < res && naive.occ[gidx] === 0) {
      missed[3 * missedCount] = x; missed[3 * missedCount + 1] = y; missed[3 * missedCount + 2] = z;
      missedCount++;
    }
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  pg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  group.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: grid.cell * 0.35, vertexColors: true, sizeAttenuation: true })));

  // the baseline's actual escapes, drawn as red dots slightly outside the shell
  if (missedCount) {
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(missed.slice(0, missedCount * 3), 3));
    group.add(new THREE.Points(mg, new THREE.PointsMaterial({ color: 0xf87171, size: grid.cell * 0.55, sizeAttenuation: true })));
  }

  // HUD
  $('m-res').textContent = res;
  $('m-cell').textContent = `cell=${grid.cell.toFixed(5)}`;
  $('m-work').textContent = `${exact.tests.toLocaleString()} / ${naive.samples.toLocaleString()}`;
  $('m-occ').textContent = `${exact.marked.toLocaleString()} / ${naive.marked.toLocaleString()}`;
  $('m-esc').innerHTML = `${exactEscapes} / ${SAMPLES} <span class="ok">(0 = watertight shell)</span>`;
  $('m-esc-n').innerHTML = `${naiveEscapes} / ${SAMPLES} <span class="${naiveEscapes ? 'bad' : 'ok'}">(${(100 * naiveEscapes / SAMPLES).toFixed(2)}%)</span>`;
  $('m-leak').textContent = `${exactStats.leakVoxels} / ${naiveStats.leakVoxels}`;
  $('m-hash').textContent = hash;
  const anchor = anchors[String(res)];
  $('m-anchor').textContent = anchor ?? 'n/a';
  $('m-match').innerHTML = anchor
    ? (anchor === hash ? '<span class="ok">MATCH — node 与浏览器逐位一致</span>' : '<span class="bad">MISMATCH</span>')
    : '<span class="warn">no anchor for this resolution</span>';
  $('m-ms').textContent = `${ms.toFixed(1)} ms (this pass, in-browser)`;
  $('m-missed').textContent = `${missedCount} samples`;
  return { ms };
}

let pending = null;
const slider = $('res');
function onChange() {
  const res = Number(slider.value);
  if (pending) cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => { pending = null; render(res); });
}
slider.addEventListener('input', onChange);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
render(Number(slider.value));

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
