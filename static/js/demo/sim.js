// PushMimic policy deployment in the browser: MuJoCo physics, the 152-d policy
// observation, the MLP actor, and the PD law, ported from the MuJoCo sim2sim of the training repo.
//
// The ramp follows the sim2sim convention: the ground stays flat and the inclination rotates
// gravity to 9.81 (-sin a, 0, -cos a). Each episode plays the nominal reference from its first frame
// to its last and then resets, as the sim-to-sim evaluation does.

const G = 9.81;
const MASS_RATE = 10.0;   // kg per second, slider rate limit within an episode
const SLOPE_RATE = 18.0;  // deg per second

// ---------------------------------------------------------------------------------------------
// Quaternion helpers, (w, x, y, z), matching isaaclab.utils.math
// ---------------------------------------------------------------------------------------------

function quatMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function quatConj(q) {
  return [q[0], -q[1], -q[2], -q[3]];
}

function matFromQuat(q) {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

// R(q)^T v
function rotInv(q, v) {
  const R = matFromQuat(q);
  return [
    R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
    R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
    R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
  ];
}

// Tilt of the body z axis from the ground normal, positive when leaning toward +x.
function pitchFromQuat(q) {
  const R = matFromQuat(q);
  return Math.atan2(R[2], R[8]) * 180 / Math.PI;
}

// First two columns of the rotation matrix, flattened row by row.
function ori6d(q) {
  const R = matFromQuat(q);
  return [R[0], R[1], R[3], R[4], R[6], R[7]];
}

// ---------------------------------------------------------------------------------------------
// Policy: empirical normalizer, then an ELU MLP
// ---------------------------------------------------------------------------------------------

function view(buf, entry) {
  return buf.subarray(entry.offset, entry.offset + entry.shape.reduce((a, b) => a * b, 1));
}

class MLPPolicy {
  constructor(spec, weights) {
    this.mean = view(weights, spec.norm_mean);
    this.std = view(weights, spec.norm_std);
    this.layers = spec.layers.map((l) => ({
      w: view(weights, l.weight), b: view(weights, l.bias), nOut: l.weight.shape[0], nIn: l.weight.shape[1],
    }));
  }

  act(obs) {
    let x = new Float64Array(obs.length);
    for (let i = 0; i < obs.length; i++) x[i] = (obs[i] - this.mean[i]) / this.std[i];
    this.layers.forEach((l, li) => {
      const y = new Float64Array(l.nOut);
      for (let o = 0; o < l.nOut; o++) {
        let s = l.b[o];
        const row = o * l.nIn;
        for (let i = 0; i < l.nIn; i++) s += l.w[row + i] * x[i];
        y[o] = li < this.layers.length - 1 && s < 0 ? Math.expm1(s) : s;
      }
      x = y;
    });
    return x;
  }
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

export class PushMimicSim {
  constructor(mujoco, meta, mjbBytes, policyWeights, refData) {
    this.mj = mujoco;
    this.meta = meta;
    const vfs = new mujoco.MjVFS();
    vfs.addBuffer('g1_push.mjb', mjbBytes);
    this.model = mujoco.MjModel.from_binary_path('g1_push.mjb', vfs);
    vfs.delete();
    this.data = new mujoco.MjData(this.model);
    this.ghostData = new mujoco.MjData(this.model);
    this.velBuf = new mujoco.DoubleBuffer(6);
    this.policy = new MLPPolicy(meta.policy, policyWeights);

    const r = meta.ref;
    this.frames = r.frames;
    this.ref = {
      jointPos: view(refData, r.joint_pos), jointVel: view(refData, r.joint_vel),
      anchorPos: view(refData, r.anchor_pos), anchorQuat: view(refData, r.anchor_quat),
      ghostQpos: view(refData, r.ghost_qpos),
    };
    this.nj = r.joint_pos.shape[1];
    this.nq = r.ghost_qpos.shape[1];

    this.targetMass = 10.0;
    this.targetSlope = 0.0;
    this.reset();
  }

  // Back to the first frame of the reference, at the task parameter the sliders ask for.
  reset() {
    const { mj, model, data, meta } = this;
    mj.mj_resetData(model, data);
    data.qpos.set(meta.qpos0);
    data.qvel.set(meta.qvel0);
    this.mass = this.targetMass;
    this.slope = this.targetSlope;
    this.applyParams();
    mj.mj_forward(model, data);
    this.lastAction = new Float64Array(meta.n_act);
    this.k = 0;
    this.fallTime = 0.0;
    this.episodes = (this.episodes || 0) + 1;
  }

  setTarget(mass, slope) {
    this.targetMass = mass;
    this.targetSlope = slope;
  }

  applyParams() {
    const { model, meta } = this;
    const b = meta.box_body;
    model.body_mass[b] = this.mass;
    for (let i = 0; i < 3; i++) model.body_inertia[3 * b + i] = meta.box_inertia0[i] * this.mass / meta.box_mass0;
    const t = this.slope * Math.PI / 180;
    const g = model.opt.gravity;
    g[0] = -G * Math.sin(t);
    g[1] = 0.0;
    g[2] = -G * Math.cos(t);
  }

  objectVelocity(body) {
    this.mj.mj_objectVelocity(this.model, this.data, this.mj.mjtObj.mjOBJ_BODY.value, body, this.velBuf, 0);
    const v = this.velBuf.GetView();
    return { ang: [v[0], v[1], v[2]], lin: [v[3], v[4], v[5]] };
  }

  bodyPos(b) {
    const p = this.data.xpos;
    return [p[3 * b], p[3 * b + 1], p[3 * b + 2]];
  }

  bodyQuat(b) {
    const q = this.data.xquat;
    return [q[4 * b], q[4 * b + 1], q[4 * b + 2], q[4 * b + 3]];
  }

  observation() {
    const { meta, data, ref, k, nj } = this;
    const rootQ = this.bodyQuat(meta.root_body);
    const ancP = this.bodyPos(meta.anchor_body);
    const ancQ = this.bodyQuat(meta.anchor_body);
    const ancQinv = quatConj(ancQ);
    const refAncP = Array.from(ref.anchorPos.subarray(3 * k, 3 * k + 3));
    const refAncQ = Array.from(ref.anchorQuat.subarray(4 * k, 4 * k + 4));
    const boxP = this.bodyPos(meta.box_body);
    const boxQ = this.bodyQuat(meta.box_body);
    const rootVel = this.objectVelocity(meta.root_body);
    const boxVel = this.objectVelocity(meta.box_body);
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const g = this.model.opt.gravity;
    const gn = Math.hypot(g[0], g[1], g[2]);

    const term = {
      command: Array.from(ref.jointPos.subarray(nj * k, nj * (k + 1)))
        .concat(Array.from(ref.jointVel.subarray(nj * k, nj * (k + 1)))),
      motion_anchor_pos_b: rotInv(ancQ, sub(refAncP, ancP)),
      motion_anchor_ori_b: ori6d(quatMul(ancQinv, refAncQ)),
      base_lin_vel: rotInv(rootQ, rootVel.lin),
      base_ang_vel: rotInv(rootQ, rootVel.ang),
      joint_pos: meta.qadr.map((a, i) => data.qpos[a] - meta.default_joint_pos[i]),
      joint_vel: meta.vadr.map((a) => data.qvel[a]),
      actions: Array.from(this.lastAction),
      box_pos_b: rotInv(ancQ, sub(boxP, ancP)),
      box_ori_b: ori6d(quatMul(ancQinv, boxQ)),
      box_lin_vel_b: rotInv(ancQ, boxVel.lin),
      box_ang_vel_b: rotInv(ancQ, boxVel.ang),
      projected_gravity: rotInv(rootQ, [g[0] / gn, g[1] / gn, g[2] / gn]),
    };
    const obs = new Float64Array(meta.obs_dim);
    let n = 0;
    for (const name of meta.obs_names) {
      for (const v of term[name]) obs[n++] = v;
    }
    if (n !== meta.obs_dim) throw new Error(`observation is ${n} wide, the policy wants ${meta.obs_dim}`);
    return obs;
  }

  // One 50 Hz control step: rate-limited parameters, observation, policy, then the PD law held
  // over the physics substeps. The reference advances one frame and restarts at its end.
  controlStep() {
    const { mj, model, data, meta } = this;
    const dt = meta.decimation * model.opt.timestep;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    this.mass += clamp(this.targetMass - this.mass, -MASS_RATE * dt, MASS_RATE * dt);
    this.slope += clamp(this.targetSlope - this.slope, -SLOPE_RATE * dt, SLOPE_RATE * dt);
    this.applyParams();

    const obs = this.observation();
    const raw = this.policy.act(obs);
    const target = raw.map((a, i) => meta.action_offset[i] + meta.action_scale[i] * a);
    for (let s = 0; s < meta.decimation; s++) {
      for (let a = 0; a < meta.n_act; a++) {
        const j = meta.action_index[a];
        const q = data.qpos[meta.qadr[j]];
        const qd = data.qvel[meta.vadr[j]];
        const tau = meta.kp[a] * (target[a] - q) - meta.kd[a] * qd;
        data.ctrl[meta.act_ids[a]] = clamp(tau, -meta.effort[a], meta.effort[a]);
      }
      mj.mj_step(model, data);
    }
    this.lastAction = raw;
    if (this.fallen()) this.fallTime += dt;
    this.k += 1;
    if (this.k >= this.frames) this.reset();
    return obs;
  }

  // The reference ghost, posed at the current frame.
  poseGhost() {
    const k = Math.min(this.k, this.frames - 1);
    this.ghostData.qpos.set(this.ref.ghostQpos.subarray(this.nq * k, this.nq * (k + 1)));
    this.mj.mj_kinematics(this.model, this.ghostData);
    return this.ghostData;
  }

  time() {
    return this.k * this.meta.decimation * this.model.opt.timestep;
  }

  // Torso pitch measured from the ramp normal, as in the paper's dataset figures.
  torsoPitch() {
    return pitchFromQuat(this.bodyQuat(this.meta.torso_body));
  }

  // The same pitch for the nominal reference at the current frame.
  refTorsoPitch() {
    const q = this.poseGhost().xquat;
    const b = this.meta.torso_body;
    return pitchFromQuat([q[4 * b], q[4 * b + 1], q[4 * b + 2], q[4 * b + 3]]);
  }

  fallen() {
    const z = this.data.xpos[3 * this.meta.root_body + 2];
    return z < 0.35 || Math.abs(this.torsoPitch()) > 100;
  }
}
