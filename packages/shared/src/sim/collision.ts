/**
 * Collision world.
 *
 * The world is a set of axis-aligned boxes ("brushes"). This is a deliberate
 * choice: AABB-vs-AABB and AABB-vs-ray are exact, branch-free and cheap, which
 * means the client's prediction and the server's authoritative simulation
 * produce bit-identical results. Arbitrary triangle meshes would not.
 *
 * Visual geometry on the client is free to be far more detailed than these
 * brushes; the brushes are the *collision proxy* only.
 */

import { type Vec3, vec3, v3add, v3scale, clamp } from '../core/math.js';
import type { AABB } from '../types/domain.js';
import { SurfaceMaterial } from '../types/domain.js';

export interface Brush {
  id: number;
  min: Vec3;
  max: Vec3;
  material: SurfaceMaterial;
  /** Bullets pass through but players cannot walk through (e.g. railings). */
  bulletPassthrough?: boolean;
  /** Players pass through but bullets stop (e.g. one-way glass). Rare. */
  playerPassthrough?: boolean;
  /** Reduces damage of bullets that penetrate. 0 = impenetrable. */
  penetration?: number;
  /** Breakable surfaces (glass) are removed from the world when destroyed. */
  breakable?: boolean;
  /** Marks a ladder/climbable volume. */
  climbable?: boolean;
}

export interface RaycastHit {
  brushId: number;
  point: Vec3;
  normal: Vec3;
  distance: number;
  material: SurfaceMaterial;
  penetration: number;
}

export interface MoveResult {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  groundNormal: Vec3;
  /** True if horizontal motion was blocked — used for wall-jump detection. */
  hitWall: boolean;
  wallNormal: Vec3 | null;
  /** Vertical speed at the moment of landing; drives fall damage and camera dip. */
  landingSpeed: number;
  steppedUp: boolean;
}

const EPSILON = 1e-4;
/** Small skin so the player never rests exactly on a surface (avoids jitter). */
const SKIN = 0.001;

/**
 * Uniform grid broadphase. Maps cell -> brush indices.
 * A grid beats a BVH here because brushes are static and roughly uniform in
 * size, and rebuild cost is zero (built once at map load).
 */
export class CollisionWorld {
  readonly brushes: Brush[] = [];
  private readonly grid = new Map<string, number[]>();
  private readonly cellSize: number;
  private removed = new Set<number>();

  constructor(brushes: Brush[] = [], cellSize = 8) {
    this.cellSize = cellSize;
    for (const b of brushes) this.addBrush(b);
  }

  addBrush(brush: Brush): void {
    const index = this.brushes.length;
    this.brushes.push(brush);
    const [minX, minY, minZ] = this.cellCoords(brush.min);
    const [maxX, maxY, maxZ] = this.cellCoords(brush.max);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const key = `${x},${y},${z}`;
          let cell = this.grid.get(key);
          if (!cell) {
            cell = [];
            this.grid.set(key, cell);
          }
          cell.push(index);
        }
      }
    }
  }

  /** Destroy a breakable brush (glass). Idempotent. */
  removeBrush(brushId: number): boolean {
    const index = this.brushes.findIndex((b) => b.id === brushId);
    if (index < 0 || this.removed.has(index)) return false;
    this.removed.add(index);
    return true;
  }

  resetDestruction(): void {
    this.removed.clear();
  }

  private cellCoords(p: Vec3): [number, number, number] {
    return [
      Math.floor(p.x / this.cellSize),
      Math.floor(p.y / this.cellSize),
      Math.floor(p.z / this.cellSize),
    ];
  }

  /** Brush indices whose cells overlap the given box. */
  private candidates(min: Vec3, max: Vec3): number[] {
    const [minX, minY, minZ] = this.cellCoords(min);
    const [maxX, maxY, maxZ] = this.cellCoords(max);
    const seen = new Set<number>();
    const out: number[] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const cell = this.grid.get(`${x},${y},${z}`);
          if (!cell) continue;
          for (const i of cell) {
            if (seen.has(i) || this.removed.has(i)) continue;
            seen.add(i);
            out.push(i);
          }
        }
      }
    }
    return out;
  }

  /**
   * Slab-method ray/AABB intersection against the whole world.
   * `ignorePassthrough` distinguishes bullet rays from movement/LOS rays.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    forBullets = true,
  ): RaycastHit | null {
    // Broadphase over the ray's bounding box.
    const end = v3add(origin, v3scale(direction, maxDistance));
    const min = vec3(Math.min(origin.x, end.x), Math.min(origin.y, end.y), Math.min(origin.z, end.z));
    const max = vec3(Math.max(origin.x, end.x), Math.max(origin.y, end.y), Math.max(origin.z, end.z));

    let best: RaycastHit | null = null;
    let bestDist = maxDistance;

    for (const i of this.candidates(min, max)) {
      const b = this.brushes[i]!;
      if (forBullets && b.bulletPassthrough) continue;
      if (!forBullets && b.playerPassthrough) continue;

      const hit = rayAabb(origin, direction, b.min, b.max, bestDist);
      if (hit && hit.distance < bestDist) {
        bestDist = hit.distance;
        best = {
          brushId: b.id,
          point: hit.point,
          normal: hit.normal,
          distance: hit.distance,
          material: b.material,
          penetration: b.penetration ?? 0,
        };
      }
    }
    return best;
  }

  /**
   * Full penetration-aware trace: walks through penetrable surfaces, returning
   * every surface crossed, so ballistics can apply per-material damage loss.
   */
  raycastPenetrating(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    maxPenetrations = 2,
  ): RaycastHit[] {
    const hits: RaycastHit[] = [];
    let currentOrigin = origin;
    let remaining = maxDistance;

    for (let i = 0; i <= maxPenetrations; i++) {
      const hit = this.raycast(currentOrigin, direction, remaining, true);
      if (!hit) break;
      hits.push(hit);
      if (hit.penetration <= 0) break;
      // Step just past the surface and continue.
      const advance = hit.distance + 0.05;
      remaining -= advance;
      if (remaining <= 0) break;
      currentOrigin = v3add(currentOrigin, v3scale(direction, advance));
    }
    return hits;
  }

  /** True if nothing blocks the segment. Used for LOS, scans and spawn safety. */
  hasLineOfSight(from: Vec3, to: Vec3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < EPSILON) return true;
    const dir = vec3(dx / dist, dy / dist, dz / dist);
    return this.raycast(from, dir, dist, true) === null;
  }

  /** Any brush overlapping this box? Used for spawn-point validation. */
  overlapsAny(min: Vec3, max: Vec3): boolean {
    for (const i of this.candidates(min, max)) {
      const b = this.brushes[i]!;
      if (b.playerPassthrough) continue;
      if (aabbOverlap(min, max, b.min, b.max)) return true;
    }
    return false;
  }

  /** Surface material directly under a point — drives footstep sounds. */
  materialUnder(position: Vec3, probeDepth = 2.0): SurfaceMaterial {
    const hit = this.raycast(position, vec3(0, -1, 0), probeDepth, false);
    return hit?.material ?? SurfaceMaterial.Concrete;
  }

  /**
   * Move an axis-aligned box through the world with collision response.
   *
   * Axes are resolved separately (X, then Z, then Y). This is the classic
   * approach for boxy FPS geometry: it is stable, never tunnels at our speeds,
   * and produces the "slide along the wall" feel players expect.
   *
   * The important rule is that a surface can only block motion that *approaches*
   * it: moving down, only a brush whose top is at or below the feet counts as
   * ground. Without that rule a player who ends up embedded in geometry (a bad
   * spawn, a barrier deployed on top of them) gets ejected to the top of
   * whichever brush happens to be found first, which reads as a teleport.
   */
  moveBox(
    position: Vec3,
    velocity: Vec3,
    dt: number,
    radius: number,
    height: number,
    stepHeight: number,
  ): MoveResult {
    let pos = { ...position };
    const vel = { ...velocity };
    let hitWall = false;
    let wallNormal: Vec3 | null = null;
    let steppedUp = false;

    const boxAt = (p: Vec3): AABB => ({
      min: vec3(p.x - radius, p.y, p.z - radius),
      max: vec3(p.x + radius, p.y + height, p.z + radius),
    });

    /** Tolerance for "was already on the correct side" tests. */
    const TOL = 0.06;

    // ---- Horizontal, with step-up ----------------------------------------
    const moveAxis = (axis: 'x' | 'z'): void => {
      const delta = vel[axis] * dt;
      if (Math.abs(delta) < EPSILON) return;

      const prevBox = boxAt(pos);
      const target = { ...pos, [axis]: pos[axis] + delta } as Vec3;
      const box = boxAt(target);

      // Only brushes we are moving *into* from outside can block us.
      const blockers = this.overlapping(box.min, box.max).filter((b) =>
        delta > 0 ? b.min[axis] >= prevBox.max[axis] - TOL : b.max[axis] <= prevBox.min[axis] + TOL,
      );

      if (blockers.length === 0) {
        pos = target;
        return;
      }

      // Try stepping up onto it (stairs, kerbs, low crates).
      //
      // We step exactly onto the top of the tallest blocker rather than probing
      // downward from the target: when the player is only edge-touching a
      // ledge, their centre is still off it, so a downward ray would miss and
      // drop them back to the floor — and on the following frame they would no
      // longer be "approaching" the ledge, so it would stop blocking and they
      // would walk straight through it.
      if (stepHeight > 0) {
        let top = -Infinity;
        for (const b of blockers) top = Math.max(top, b.max.y);
        const rise = top - pos.y;
        if (rise > 0 && rise <= stepHeight) {
          const stepUpPos = { ...target, y: top + SKIN };
          const stepBox = boxAt(stepUpPos);
          if (this.overlapping(stepBox.min, stepBox.max).length === 0) {
            pos = stepUpPos;
            steppedUp = true;
            return;
          }
        }
      }

      // Blocked: snap flush to the nearest blocking face and record the normal
      // so the movement code can offer a wall jump.
      hitWall = true;
      wallNormal = axis === 'x' ? vec3(-Math.sign(delta), 0, 0) : vec3(0, 0, -Math.sign(delta));

      let face: number;
      if (delta > 0) {
        face = Infinity;
        for (const b of blockers) face = Math.min(face, b.min[axis]);
        pos = { ...pos, [axis]: face - radius - SKIN } as Vec3;
      } else {
        face = -Infinity;
        for (const b of blockers) face = Math.max(face, b.max[axis]);
        pos = { ...pos, [axis]: face + radius + SKIN } as Vec3;
      }
      vel[axis] = 0;
    };

    moveAxis('x');
    moveAxis('z');

    // ---- Vertical --------------------------------------------------------
    let grounded = false;
    const groundNormal = vec3(0, 1, 0);
    let landingSpeed = 0;

    const dy = vel.y * dt;
    if (Math.abs(dy) > EPSILON) {
      const prevBox = boxAt(pos);
      const target = { ...pos, y: pos.y + dy };
      const box = boxAt(target);

      if (dy < 0) {
        // Falling: only a brush whose top is at or below our feet is ground.
        let top = -Infinity;
        for (const b of this.overlapping(box.min, box.max)) {
          if (b.max.y <= prevBox.min.y + TOL) top = Math.max(top, b.max.y);
        }
        if (top > -Infinity) {
          pos = { ...pos, y: top + SKIN };
          landingSpeed = Math.abs(vel.y);
          grounded = true;
          vel.y = 0;
        } else {
          pos = target;
        }
      } else {
        // Rising: only a brush whose underside is at or above our head is a ceiling.
        let underside = Infinity;
        for (const b of this.overlapping(box.min, box.max)) {
          if (b.min.y >= prevBox.max.y - TOL) underside = Math.min(underside, b.min.y);
        }
        if (underside < Infinity) {
          pos = { ...pos, y: underside - height - SKIN };
          vel.y = 0;
        } else {
          pos = target;
        }
      }
    }

    // ---- Ground probe ----------------------------------------------------
    // Even without downward motion we need to know whether we are standing on
    // something (walking along a floor at constant Y, or over a stair edge).
    if (!grounded && vel.y <= EPSILON) {
      const probe = boxAt({ ...pos, y: pos.y - 0.06 });
      let top = -Infinity;
      for (const b of this.overlapping(probe.min, probe.max)) {
        if (b.max.y <= pos.y + TOL) top = Math.max(top, b.max.y);
      }
      if (top > -Infinity) {
        grounded = true;
        const gap = pos.y - top;
        if (gap > 0 && gap < 0.08) pos = { ...pos, y: top + SKIN };
      }
    }

    return {
      position: pos,
      velocity: vel,
      grounded,
      groundNormal,
      hitWall,
      wallNormal,
      landingSpeed,
      steppedUp,
    };
  }

  /** Every solid brush overlapping the box. */
  private overlapping(min: Vec3, max: Vec3): Brush[] {
    const out: Brush[] = [];
    for (const i of this.candidates(min, max)) {
      const b = this.brushes[i]!;
      if (b.playerPassthrough) continue;
      if (aabbOverlap(min, max, b.min, b.max)) out.push(b);
    }
    return out;
  }

  /** Is there a wall within `distance` horizontally? Returns its normal. */
  probeWall(position: Vec3, radius: number, height: number, distance: number): Vec3 | null {
    const eye = vec3(position.x, position.y + height * 0.6, position.z);
    const dirs = [vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 0, 1), vec3(0, 0, -1)];
    for (const d of dirs) {
      const hit = this.raycast(eye, d, radius + distance, false);
      if (hit) return hit.normal;
    }
    return null;
  }

  get brushCount(): number {
    return this.brushes.length - this.removed.size;
  }
}

// --------------------------------------------------------------------------
// Free functions — also used for hitboxes, which are AABBs too.
// --------------------------------------------------------------------------

export function aabbOverlap(aMin: Vec3, aMax: Vec3, bMin: Vec3, bMax: Vec3): boolean {
  return (
    aMin.x < bMax.x &&
    aMax.x > bMin.x &&
    aMin.y < bMax.y &&
    aMax.y > bMin.y &&
    aMin.z < bMax.z &&
    aMax.z > bMin.z
  );
}

export function aabbContains(box: AABB, p: Vec3): boolean {
  return (
    p.x >= box.min.x &&
    p.x <= box.max.x &&
    p.y >= box.min.y &&
    p.y <= box.max.y &&
    p.z >= box.min.z &&
    p.z <= box.max.z
  );
}

export interface RayAabbHit {
  distance: number;
  point: Vec3;
  normal: Vec3;
}

/** Slab method. `direction` must be normalized. Returns null if no hit within maxDistance. */
export function rayAabb(
  origin: Vec3,
  direction: Vec3,
  min: Vec3,
  max: Vec3,
  maxDistance: number,
): RayAabbHit | null {
  let tMin = 0;
  let tMax = maxDistance;
  let hitAxis: 'x' | 'y' | 'z' = 'x';
  let hitSign = 1;

  const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  for (const axis of axes) {
    const d = direction[axis];
    const o = origin[axis];
    if (Math.abs(d) < 1e-9) {
      // Ray is parallel to this slab — miss if the origin is outside it.
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min[axis] - o) * inv;
    let t2 = (max[axis] - o) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      hitAxis = axis;
      hitSign = sign;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  const normal = vec3(0, 0, 0);
  normal[hitAxis] = hitSign;
  return {
    distance: tMin,
    point: v3add(origin, v3scale(direction, tMin)),
    normal,
  };
}

/** Nearest point on a box to `p` — used for splash-damage distance. */
export function closestPointOnAabb(p: Vec3, min: Vec3, max: Vec3): Vec3 {
  return vec3(clamp(p.x, min.x, max.x), clamp(p.y, min.y, max.y), clamp(p.z, min.z, max.z));
}
