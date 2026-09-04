/**
 * Core math primitives.
 *
 * These are deliberately plain objects (not classes with hidden state) so the
 * exact same code runs on the server (Node) and inside the browser client's
 * prediction loop, and so values serialize directly to the wire format.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });

export const v3clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const v3add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const v3sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const v3scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const v3dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const v3cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const v3lenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const v3len = (a: Vec3): number => Math.sqrt(v3lenSq(a));

export const v3distSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

export const v3dist = (a: Vec3, b: Vec3): number => Math.sqrt(v3distSq(a, b));

export function v3normalize(a: Vec3): Vec3 {
  const len = v3len(a);
  if (len < 1e-9) return vec3(0, 0, 0);
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

export function v3lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Clamp a vector's length, preserving direction. Used for velocity caps. */
export function v3clampLength(a: Vec3, max: number): Vec3 {
  const lenSq = v3lenSq(a);
  if (lenSq <= max * max || lenSq < 1e-12) return v3clone(a);
  return v3scale(a, max / Math.sqrt(lenSq));
}

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number =>
  Math.abs(b - a) < 1e-9 ? 0 : (v - a) / (b - a);

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Wrap an angle in radians into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

/** Shortest angular difference from `a` to `b`, in radians. */
export const angleDelta = (a: number, b: number): number => wrapAngle(b - a);

/**
 * Frame-rate independent exponential smoothing.
 * `rate` is the fraction of the remaining distance covered per second.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function dampVec3(current: Vec3, target: Vec3, rate: number, dt: number): Vec3 {
  const t = 1 - Math.exp(-rate * dt);
  return v3lerp(current, target, t);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/**
 * Convert yaw/pitch (radians) into a unit forward vector.
 * Convention: +Y is up, yaw 0 looks down -Z, positive pitch looks up.
 * This matches the client camera so aim direction is identical on both sides.
 */
export function anglesToForward(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

/** Right-hand vector for a given yaw (ignores pitch — ground-plane strafing). */
export function yawToRight(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
}

/** Ground-plane forward for a given yaw (ignores pitch). */
export function yawToForward(yaw: number): Vec3 {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

/** Round to a fixed number of decimals — keeps snapshots compact and stable. */
export function round(v: number, decimals = 3): number {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}

export function roundVec3(v: Vec3, decimals = 3): Vec3 {
  return { x: round(v.x, decimals), y: round(v.y, decimals), z: round(v.z, decimals) };
}

export function approxEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

export function v3approxEqual(a: Vec3, b: Vec3, eps = 1e-6): boolean {
  return approxEqual(a.x, b.x, eps) && approxEqual(a.y, b.y, eps) && approxEqual(a.z, b.z, eps);
}
