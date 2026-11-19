// Interactive PushMimic demo: three.js view and controls around PushMimicSim.
//
// MuJoCo runs in the sim2sim gravity frame, with flat ground and rotated gravity. The view puts it
// back on a ramp by rotating the whole MuJoCo scene so that gravity points down on screen. Each
// episode plays the nominal reference once and then resets.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PushMimicSim } from './sim.js';

const MUJOCO_URL = 'https://cdn.jsdelivr.net/npm/@mujoco/mujoco@3.8.1/mujoco.js';
const ASSETS = './static/demo/';
const CONTROL_DT = 0.02;
const RESET_AFTER_FALL = 1.5;  // s
const CHART_SECONDS = 10;
const ROBOT_COLOR = '#e8663d';
const REF_COLOR = '#3d8bfd';
// Fixed chart range. At the heaviest box and steepest ramp (15 kg, 15 deg) the robot leans at most
// about 29 deg beyond the reference, so the top sits just above that.
const LEAN_MIN = -5;
const LEAN_MAX = 30;

function $(id) {
  return document.getElementById(id);
}

async function fetchBytes(name) {
  const r = await fetch(ASSETS + name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function srgb(rgba) {
  return new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace);
}

function quat(q) {
  return new THREE.Quaternion(q[1], q[2], q[3], q[0]);
}

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#c9d0d8';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#b7bfc9';
  g.fillRect(0, 0, 64, 64);
  g.fillRect(64, 64, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// One THREE.Group per MuJoCo body, holding that body's visual geoms at their local poses.
function buildBodies(meta, visual, parent, materialFor) {
  const groups = new Map();
  const meshCache = new Map();
  for (const g of meta.visual.geoms) {
    let geometry;
    if (g.type === 7) {
      if (!meshCache.has(g.mesh)) {
        const m = meta.visual.meshes[g.mesh];
        const vert = new Float32Array(visual.buffer, visual.byteOffset + m.vert.offset, m.vert.count);
        const FaceArray = m.face.dtype === 'uint16' ? Uint16Array : Uint32Array;
        const face = new FaceArray(visual.buffer, visual.byteOffset + m.face.offset, m.face.count);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(vert, 3));
        geo.setIndex(new THREE.BufferAttribute(face, 1));
        geo.computeVertexNormals();
        meshCache.set(g.mesh, geo);
      }
      geometry = meshCache.get(g.mesh);
    } else if (g.type === 6) {
      geometry = new THREE.BoxGeometry(2 * g.size[0], 2 * g.size[1], 2 * g.size[2]);
    } else {
      continue;
    }
    const mesh = new THREE.Mesh(geometry, materialFor(g));
    mesh.position.fromArray(g.pos);
    mesh.quaternion.copy(quat(g.quat));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!groups.has(g.body)) {
      const grp = new THREE.Group();
      parent.add(grp);
      groups.set(g.body, grp);
    }
    groups.get(g.body).add(mesh);
    if (g.box) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0x7a5a36 }));
      edges.position.copy(mesh.position);
      edges.quaternion.copy(mesh.quaternion);
      groups.get(g.body).add(edges);
    }
  }
  return groups;
}

function poseBodies(groups, data, dx) {
  const p = data.xpos;
  const q = data.xquat;
  for (const [b, grp] of groups) {
    grp.position.set(p[3 * b] + dx, p[3 * b + 1], p[3 * b + 2]);
    grp.quaternion.set(q[4 * b + 1], q[4 * b + 2], q[4 * b + 3], q[4 * b]);
  }
}

// Torso pitch of the robot minus that of the observed reference. Both stand up and lean in at the same
// moments, so the difference removes those swings and leaves the lean the policy adds on its own.
class LeanChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.samples = [];
  }

  push(lean) {
    this.samples.push(lean);
    if (this.samples.length > CHART_SECONDS / CONTROL_DT) this.samples.shift();
  }

  clear() {
    this.samples = [];
  }

  draw() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const lo = LEAN_MIN;
    const hi = LEAN_MAX;
    // The top strip holds the legend, so the curve never runs under it.
    const pad = { l: 32, r: 8, t: 18, b: 6 };
    const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
    const n = CHART_SECONDS / CONTROL_DT;
    const x = (i) => pad.l + (w - pad.l - pad.r) * (i / (n - 1));
    g.font = '11px "Noto Sans", sans-serif';
    g.fillStyle = '#7a7a7a';
    g.strokeStyle = '#e3e6ea';
    g.lineWidth = 1;
    // Grid step: the smallest of 5, 10, 20 degrees that keeps labels at least 16 px apart.
    const pxPerDeg = (h - pad.t - pad.b) / (hi - lo);
    const step = [5, 10, 20].find((d) => d * pxPerDeg >= 16) || 20;
    for (let v = step; v <= hi; v += step) {
      g.beginPath();
      g.moveTo(pad.l, y(v));
      g.lineTo(w - pad.r, y(v));
      g.stroke();
      g.fillText(`+${v}\u00b0`, 2, y(v) + 4);
    }
    // The reference is the zero line.
    g.strokeStyle = REF_COLOR;
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    g.beginPath();
    g.moveTo(pad.l, y(0));
    g.lineTo(w - pad.r, y(0));
    g.stroke();
    g.setLineDash([]);
    g.fillText('0\u00b0', 2, y(0) + 4);
    const off = n - this.samples.length;
    g.strokeStyle = ROBOT_COLOR;
    g.lineWidth = 2;
    g.beginPath();
    this.samples.forEach((v, i) => {
      const yy = y(Math.max(lo, Math.min(hi, v)));
      if (i === 0) g.moveTo(x(i + off), yy);
      else g.lineTo(x(i + off), yy);
    });
    g.stroke();
    // Legend, top right.
    g.textAlign = 'right';
    g.fillStyle = REF_COLOR;
    g.fillText('reference', w - pad.r, 12);
    g.fillStyle = ROBOT_COLOR;
    g.fillText('robot', w - pad.r - g.measureText('reference').width - 10, 12);
    g.textAlign = 'left';
  }
}

export async function startDemo() {
  const status = $('demo-status');
  const setStatus = (text) => {
    status.textContent = text;
    status.style.display = text ? 'flex' : 'none';
  };

  setStatus('Loading MuJoCo and the policy…');
  let sim;
  let meta;
  let visual;
  try {
    const [{ default: loadMujoco }, metaResp, mjb, policyBytes, visualBytes, refBytes] = await Promise.all([
      import(MUJOCO_URL),
      fetch(ASSETS + 'meta.json').then((r) => r.json()),
      fetchBytes('g1_push.mjb'),
      fetchBytes('policy.bin'),
      fetchBytes('visual.bin'),
      fetchBytes('ref.bin'),
    ]);
    meta = metaResp;
    visual = visualBytes;
    const mujoco = await loadMujoco();
    const f32 = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    sim = new PushMimicSim(mujoco, meta, mjb, f32(policyBytes), f32(refBytes));
  } catch (err) {
    console.error(err);
    setStatus(`The demo could not start in this browser (${err.message}).`);
    return;
  }

  // ------------------------------------------------------------------------------------------
  // Scene
  // ------------------------------------------------------------------------------------------
  const host = $('demo-canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (err) {
    console.error(err);
    setStatus('WebGL is not available in this browser, so the demo cannot be shown.');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xe9eef4);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 10, 26);

  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 9;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d97a3, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -3;
  sun.shadow.camera.right = 3;
  sun.shadow.camera.top = 3;
  sun.shadow.camera.bottom = -3;
  sun.shadow.camera.far = 20;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  // MuJoCo is z-up, three.js is y-up. Inside zUp the coordinates are MuJoCo's, and slopeGroup tilts
  // the flat MuJoCo ground into a ramp by undoing the gravity rotation.
  const zUp = new THREE.Group();
  zUp.rotation.x = -Math.PI / 2;
  scene.add(zUp);
  const slopeGroup = new THREE.Group();
  zUp.add(slopeGroup);

  const groundTex = checkerTexture();
  groundTex.repeat.set(30, 8);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 16),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95 }));
  ground.receiveShadow = true;
  slopeGroup.add(ground);

  const dark = new THREE.MeshStandardMaterial({ color: srgb([0.18, 0.19, 0.21]), roughness: 0.55, metalness: 0.15 });
  const light = new THREE.MeshStandardMaterial({ color: srgb([0.78, 0.79, 0.81]), roughness: 0.45, metalness: 0.1 });
  const cardboard = new THREE.MeshStandardMaterial({ color: srgb([0.78, 0.6, 0.4]), roughness: 0.9 });
  const ghostMat = new THREE.MeshStandardMaterial({
    color: 0x3d8bfd, transparent: true, opacity: 0.25, depthWrite: false, roughness: 0.6,
  });

  const bodies = buildBodies(meta, visual, slopeGroup,
    (g) => (g.box ? cardboard : (g.rgba[0] < 0.5 ? dark : light)));
  const robotOnly = { visual: { ...meta.visual, geoms: meta.visual.geoms.filter((g) => !g.box) } };
  const ghost = buildBodies({ ...meta, ...robotOnly }, visual, slopeGroup, () => ghostMat);
  for (const grp of ghost.values()) grp.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });

  const pelvis = bodies.get(meta.root_body);
  const boxGroup = bodies.get(meta.box_body);
  const boxPos = new THREE.Vector3();
  // Frame robot and box together, a little in front of the pelvis.
  const followPoint = (out) => {
    pelvis.getWorldPosition(out);
    boxGroup.getWorldPosition(boxPos);
    return out.lerp(boxPos, 0.35);
  };
  const target = new THREE.Vector3();
  const lastTarget = new THREE.Vector3();
  poseBodies(bodies, sim.data, 0);
  poseBodies(ghost, sim.poseGhost(), 0);
  scene.updateMatrixWorld(true);
  followPoint(target);
  lastTarget.copy(target);
  controls.target.copy(target);
  camera.position.copy(target).add(new THREE.Vector3(-0.5, 0.55, 3.4));

  function resize() {
    // The canvas is sized from its container, never the other way round, and kept to a sane size.
    const w = Math.max(1, Math.min(host.clientWidth, 2400));
    const h = Math.max(1, Math.min(host.clientHeight, Math.round(w * 0.75)));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  // ------------------------------------------------------------------------------------------
  // Controls
  // ------------------------------------------------------------------------------------------
  const massIn = $('demo-mass');
  const slopeIn = $('demo-slope');
  const chart = new LeanChart($('demo-chart'));
  let running = true;
  let visible = true;
  let last = performance.now();

  function readSliders() {
    const m = parseFloat(massIn.value);
    const s = parseFloat(slopeIn.value);
    $('demo-mass-value').textContent = `${m.toFixed(0)} kg`;
    $('demo-slope-value').textContent = `${s.toFixed(0)}°`;
    sim.setTarget(m, s);
  }
  massIn.addEventListener('input', readSliders);
  slopeIn.addEventListener('input', readSliders);
  readSliders();
  // Presets move both sliders at once. The change applies during the push, so the posture visibly adapts.
  document.querySelectorAll('.demo-preset').forEach((b) => b.addEventListener('click', () => {
    massIn.value = b.dataset.mass;
    slopeIn.value = b.dataset.slope;
    readSliders();
  }));
  sim.reset();  // the first episode starts at the slider values, not at the simulator defaults

  // Reset also brings both sliders back to their starting values.
  $('demo-reset').addEventListener('click', () => {
    massIn.value = massIn.defaultValue;
    slopeIn.value = slopeIn.defaultValue;
    readSliders();
    sim.reset();
    chart.clear();
  });
  const pauseBtn = $('demo-pause');
  pauseBtn.addEventListener('click', () => {
    running = !running;
    pauseBtn.querySelector('span:last-child').textContent = running ? 'Pause' : 'Play';
    // Font Awesome swaps <i> for an inline <svg>, so the icon is replaced rather than edited.
    pauseBtn.querySelector('.icon').innerHTML = `<i class="fas ${running ? 'fa-pause' : 'fa-play'}"></i>`;
  });

  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) last = performance.now();
  }).observe(host);

  // ------------------------------------------------------------------------------------------
  // Loop
  // ------------------------------------------------------------------------------------------
  let acc = 0;
  let chartTick = 0;
  window.pushmimicDemo = { sim, camera, controls, scene };
  setStatus('');

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) {
      last = now;
      return;
    }
    acc += Math.min(0.1, (now - last) / 1000);
    last = now;
    if (running) {
      let n = 0;
      while (acc >= CONTROL_DT && n < 4) {
        sim.controlStep();
        acc -= CONTROL_DT;
        n += 1;
        const p = sim.torsoPitch();
        chart.push(p - sim.refTorsoPitch());
        if (sim.fallTime > RESET_AFTER_FALL) {
          sim.reset();
          chart.clear();
        }
      }
      if (n === 4) acc = 0;
    } else {
      acc = 0;
    }

    slopeGroup.rotation.y = -sim.slope * Math.PI / 180;
    poseBodies(bodies, sim.data, 0);
    poseBodies(ghost, sim.poseGhost(), 0);
    scene.updateMatrixWorld(true);

    // Follow the robot, and jump back with it when an episode restarts.
    followPoint(target);
    const move = target.clone().sub(lastTarget);
    camera.position.add(move);
    controls.target.add(move);
    lastTarget.copy(target);
    controls.update();

    sun.position.copy(target).add(new THREE.Vector3(2.5, 6, 3));
    sun.target.position.copy(target);

    if (++chartTick % 6 === 0) chart.draw();

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

// Load only when the demo comes near the viewport, so the page itself stays light.
const anchor = document.getElementById('demo-canvas');
if (anchor) {
  const io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      io.disconnect();
      startDemo();
    }
  }, { rootMargin: '400px' });
  io.observe(anchor);
}
