/**
 * Map authoring helpers.
 *
 * Maps are built from architectural primitives (rooms with real walls, floors,
 * doorways and windows; stairs; catwalks; crates) rather than hand-listed
 * boxes. This is what keeps a map readable in source and lets a level designer
 * change a building's footprint in one line.
 */

import { type Vec3, vec3 } from '../../core/math.js';
import { Rng } from '../../core/random.js';
import { SurfaceMaterial } from '../../types/domain.js';
import type { MapProp, MapVolume } from './mapTypes.js';

export class MapBuilder {
  readonly volumes: MapVolume[] = [];
  readonly props: MapProp[] = [];

  box(at: Vec3, size: Vec3, material: SurfaceMaterial, extra: Partial<MapVolume> = {}): this {
    this.volumes.push({ at, size, material, ...extra });
    return this;
  }

  prop(kind: string, at: Vec3, rotationY = 0, scale = 1, lod: 0 | 1 | 2 = 1, color?: number): this {
    this.props.push({ kind, at, rotationY, scale, lod, color });
    return this;
  }

  /** Flat ground slab. */
  ground(
    center: Vec3,
    width: number,
    depth: number,
    material = SurfaceMaterial.Concrete,
    thickness = 1,
    style?: string,
  ): this {
    return this.box(
      vec3(center.x, center.y - thickness / 2, center.z),
      vec3(width, thickness, depth),
      material,
      { style },
    );
  }

  /**
   * A wall with an optional doorway and window band.
   * `axis` is the direction the wall runs along.
   */
  wall(
    from: Vec3,
    to: Vec3,
    height: number,
    thickness: number,
    material: SurfaceMaterial,
    opts: {
      /** Doorway centred at this fraction along the wall (0..1), or null. */
      doorAt?: number | null;
      doorWidth?: number;
      doorHeight?: number;
      /** Window band as [fromHeight, toHeight]; glass fills it. */
      windowBand?: [number, number] | null;
      windowSpacing?: number;
      windowWidth?: number;
      style?: string;
    } = {},
  ): this {
    const {
      doorAt = null,
      doorWidth = 1.6,
      doorHeight = 2.3,
      windowBand = null,
      windowSpacing = 4,
      windowWidth = 1.8,
      style,
    } = opts;

    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.01) return this;
    const alongX = Math.abs(dx) >= Math.abs(dz);
    const cx = (from.x + to.x) / 2;
    const cz = (from.z + to.z) / 2;
    const baseY = from.y;

    const sizeFor = (segLength: number, segHeight: number): Vec3 =>
      alongX ? vec3(segLength, segHeight, thickness) : vec3(thickness, segHeight, segLength);

    const posFor = (offset: number, y: number): Vec3 =>
      alongX
        ? vec3(from.x + (dx < 0 ? -1 : 1) * offset, y, cz)
        : vec3(cx, y, from.z + (dz < 0 ? -1 : 1) * offset);

    // Split the wall into horizontal spans around the doorway.
    const spans: [number, number][] = [];
    if (doorAt === null) {
      spans.push([0, length]);
    } else {
      const doorCenter = length * doorAt;
      const dStart = Math.max(0, doorCenter - doorWidth / 2);
      const dEnd = Math.min(length, doorCenter + doorWidth / 2);
      if (dStart > 0.05) spans.push([0, dStart]);
      if (dEnd < length - 0.05) spans.push([dEnd, length]);
      // Lintel above the door.
      if (doorHeight < height) {
        const lintelH = height - doorHeight;
        this.box(
          posFor((dStart + dEnd) / 2, baseY + doorHeight + lintelH / 2),
          sizeFor(dEnd - dStart, lintelH),
          material,
          { style },
        );
      }
    }

    for (const [s, e] of spans) {
      const segLen = e - s;
      if (segLen <= 0.02) continue;
      const mid = (s + e) / 2;

      if (!windowBand) {
        this.box(posFor(mid, baseY + height / 2), sizeFor(segLen, height), material, { style });
        continue;
      }

      // Wall below the windows.
      const [wLow, wHigh] = windowBand;
      if (wLow > 0.02) {
        this.box(posFor(mid, baseY + wLow / 2), sizeFor(segLen, wLow), material, { style });
      }
      // Wall above the windows.
      if (wHigh < height) {
        const topH = height - wHigh;
        this.box(posFor(mid, baseY + wHigh + topH / 2), sizeFor(segLen, topH), material, { style });
      }
      // Piers between windows, and glass panes in the gaps.
      const bandH = wHigh - wLow;
      const pitch = windowSpacing;
      const count = Math.max(1, Math.floor(segLen / pitch));
      const pierWidth = Math.max(0.3, (segLen - count * windowWidth) / (count + 1));
      let cursor = s;
      for (let i = 0; i < count; i++) {
        this.box(
          posFor(cursor + pierWidth / 2, baseY + wLow + bandH / 2),
          sizeFor(pierWidth, bandH),
          material,
          { style },
        );
        cursor += pierWidth;
        // Glass: breakable, penetrable, and thin.
        this.box(
          posFor(cursor + windowWidth / 2, baseY + wLow + bandH / 2),
          sizeFor(windowWidth, bandH),
          SurfaceMaterial.Glass,
          { breakable: true, penetration: 0.12, style: 'glass', detailOnly: false },
        );
        cursor += windowWidth;
      }
      if (cursor < e - 0.02) {
        this.box(
          posFor((cursor + e) / 2, baseY + wLow + bandH / 2),
          sizeFor(e - cursor, bandH),
          material,
          { style },
        );
      }
    }
    return this;
  }

  /**
   * A rectangular room: floor, four walls (each optionally with a doorway),
   * and a ceiling. Returns the builder so rooms chain.
   */
  room(
    origin: Vec3,
    width: number,
    depth: number,
    height: number,
    opts: {
      material?: SurfaceMaterial;
      floorMaterial?: SurfaceMaterial;
      wallThickness?: number;
      /** Which walls get a doorway: n/s/e/w. */
      doors?: Partial<Record<'n' | 's' | 'e' | 'w', number>>;
      /** Which walls get windows. */
      windows?: Partial<Record<'n' | 's' | 'e' | 'w', [number, number]>>;
      ceiling?: boolean;
      style?: string;
    } = {},
  ): this {
    const {
      material = SurfaceMaterial.Concrete,
      floorMaterial = SurfaceMaterial.Concrete,
      wallThickness = 0.35,
      doors = {},
      windows = {},
      ceiling = true,
      style,
    } = opts;

    const x0 = origin.x;
    const z0 = origin.z;
    const x1 = origin.x + width;
    const z1 = origin.z + depth;
    const y = origin.y;

    this.ground(vec3(x0 + width / 2, y, z0 + depth / 2), width, depth, floorMaterial, 0.4, style);

    this.wall(vec3(x0, y, z0), vec3(x1, y, z0), height, wallThickness, material, {
      doorAt: doors.n ?? null,
      windowBand: windows.n ?? null,
      style,
    });
    this.wall(vec3(x0, y, z1), vec3(x1, y, z1), height, wallThickness, material, {
      doorAt: doors.s ?? null,
      windowBand: windows.s ?? null,
      style,
    });
    this.wall(vec3(x0, y, z0), vec3(x0, y, z1), height, wallThickness, material, {
      doorAt: doors.w ?? null,
      windowBand: windows.w ?? null,
      style,
    });
    this.wall(vec3(x1, y, z0), vec3(x1, y, z1), height, wallThickness, material, {
      doorAt: doors.e ?? null,
      windowBand: windows.e ?? null,
      style,
    });

    if (ceiling) {
      this.box(
        vec3(x0 + width / 2, y + height + 0.2, z0 + depth / 2),
        vec3(width + wallThickness, 0.4, depth + wallThickness),
        material,
        { style },
      );
    }
    return this;
  }

  /** A flight of stairs made from steps, walkable via the step-up logic. */
  stairs(
    start: Vec3,
    direction: 'x' | '-x' | 'z' | '-z',
    totalHeight: number,
    totalRun: number,
    width: number,
    material = SurfaceMaterial.Metal,
  ): this {
    const steps = Math.max(3, Math.round(totalHeight / 0.22));
    const stepH = totalHeight / steps;
    const stepRun = totalRun / steps;
    const sx = direction === 'x' ? 1 : direction === '-x' ? -1 : 0;
    const sz = direction === 'z' ? 1 : direction === '-z' ? -1 : 0;

    for (let i = 0; i < steps; i++) {
      const h = stepH * (i + 1);
      const cx = start.x + sx * (stepRun * (i + 0.5));
      const cz = start.z + sz * (stepRun * (i + 0.5));
      this.box(
        vec3(cx, start.y + h / 2, cz),
        sx !== 0 ? vec3(stepRun, h, width) : vec3(width, h, stepRun),
        material,
        { style: 'stairs' },
      );
    }
    return this;
  }

  /** Elevated walkway with railings that bullets pass through. */
  catwalk(
    from: Vec3,
    to: Vec3,
    width: number,
    material = SurfaceMaterial.Metal,
    railings = true,
  ): this {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const alongX = Math.abs(dx) >= Math.abs(dz);
    const length = Math.hypot(dx, dz);
    const cx = (from.x + to.x) / 2;
    const cz = (from.z + to.z) / 2;

    this.box(
      vec3(cx, from.y, cz),
      alongX ? vec3(length, 0.28, width) : vec3(width, 0.28, length),
      material,
      { style: 'catwalk' },
    );

    if (railings) {
      const offset = width / 2;
      for (const side of [-1, 1]) {
        this.box(
          alongX ? vec3(cx, from.y + 0.62, cz + side * offset) : vec3(cx + side * offset, from.y + 0.62, cz),
          alongX ? vec3(length, 1.0, 0.08) : vec3(0.08, 1.0, length),
          SurfaceMaterial.Metal,
          { bulletPassthrough: true, style: 'railing', detailOnly: true },
        );
      }
    }
    return this;
  }

  /** A stack of crates — the workhorse cover piece. */
  crateStack(at: Vec3, count: number, seed: number, size = 1.1): this {
    const rng = new Rng(seed);
    let y = at.y;
    for (let i = 0; i < count; i++) {
      const s = size * rng.range(0.85, 1.05);
      this.box(
        vec3(at.x + rng.range(-0.2, 0.2), y + s / 2, at.z + rng.range(-0.2, 0.2)),
        vec3(s, s, s),
        SurfaceMaterial.Wood,
        { style: 'crate' },
      );
      y += s;
    }
    return this;
  }

  /** Low cover: concrete barrier / jersey block. */
  barrier(at: Vec3, length: number, alongX: boolean, material = SurfaceMaterial.Concrete): this {
    return this.box(
      vec3(at.x, at.y + 0.55, at.z),
      alongX ? vec3(length, 1.1, 0.45) : vec3(0.45, 1.1, length),
      material,
      { style: 'barrier' },
    );
  }

  /** Interior dressing: desks, shelves, lockers, pipes, cables, vents. */
  dressRoom(origin: Vec3, width: number, depth: number, seed: number, kinds: string[]): this {
    const rng = new Rng(seed);
    const count = Math.max(2, Math.floor((width * depth) / 14));
    for (let i = 0; i < count; i++) {
      this.prop(
        rng.pick(kinds),
        vec3(
          origin.x + rng.range(1.2, width - 1.2),
          origin.y,
          origin.z + rng.range(1.2, depth - 1.2),
        ),
        rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]),
        rng.range(0.9, 1.12),
        1,
      );
    }
    return this;
  }

  /** Run a pipe/cable along a wall — pure decoration, no collision. */
  conduit(from: Vec3, to: Vec3, radius: number, kind: 'pipe' | 'cable' = 'pipe', color?: number): this {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy, dz);
    const at = vec3((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    const rotationY = Math.atan2(dx, dz);
    this.props.push({
      kind: kind === 'pipe' ? 'pipe' : 'cable',
      at,
      rotationY,
      scale: length,
      lod: 2,
      color,
    });
    // Radius is carried in the prop scale convention; kept explicit for clarity.
    void radius;
    return this;
  }

  /** Neon sign — emissive, no collision, a key part of the night-city look. */
  sign(at: Vec3, size: Vec3, color: number, rotationY = 0): this {
    this.box(at, size, SurfaceMaterial.Plastic, {
      noCollision: true,
      emissive: 2.4,
      color,
      style: 'neon',
      detailOnly: true,
    });
    this.prop('sign_glow', at, rotationY, Math.max(size.x, size.z), 2, color);
    return this;
  }
}

/** Convert authored volumes into collision brushes for the physics world. */
export function volumesToBrushes(volumes: MapVolume[]): import('../../sim/collision.js').Brush[] {
  const brushes: import('../../sim/collision.js').Brush[] = [];
  let id = 1;
  for (const v of volumes) {
    if (v.noCollision) continue;
    const hx = v.size.x / 2;
    const hy = v.size.y / 2;
    const hz = v.size.z / 2;
    brushes.push({
      id: id++,
      min: vec3(v.at.x - hx, v.at.y - hy, v.at.z - hz),
      max: vec3(v.at.x + hx, v.at.y + hy, v.at.z + hz),
      material: v.material,
      bulletPassthrough: v.bulletPassthrough,
      playerPassthrough: v.playerPassthrough,
      penetration: v.penetration,
      breakable: v.breakable,
      climbable: v.climbable,
    });
  }
  return brushes;
}
