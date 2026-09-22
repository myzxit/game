/**
 * Builds the visible world from a MapDefinition.
 *
 * Two performance decisions do most of the work here:
 *
 *  1. **Merged geometry per material.** A map is thousands of boxes; drawing
 *     them individually would be thousands of draw calls. Boxes sharing a
 *     material are merged into one BufferGeometry, taking the map from ~3000
 *     draw calls to a few dozen.
 *  2. **Instanced props.** Repeated decoration (crates, vents, pipes, lamps)
 *     is drawn with InstancedMesh, one draw call per prop kind.
 *
 * Emissive and transparent surfaces stay separate so they can be sorted and,
 * on the Low preset, cheaply skipped.
 */

import * as THREE from 'three';
import {
  Rng,
  SurfaceMaterial,
  hashString,
  type MapDefinition,
  type MapProp,
  type MapVolume,
} from '@titan/shared';
import type { MaterialLibrary } from './Materials.js';
import type { GraphicsSettings } from '../core/Settings.js';

interface MergeBucket {
  material: THREE.MeshStandardMaterial;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  vertexCount: number;
}

/** Face definitions for a unit box, used to emit geometry with correct UVs. */
const BOX_FACES = [
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], uvAxes: [0, 1] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], uvAxes: [0, 1] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], uvAxes: [2, 1] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], uvAxes: [2, 1] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], uvAxes: [0, 2] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], uvAxes: [0, 2] },
] as const;

export interface MapRenderResult {
  root: THREE.Group;
  /** Meshes that can be hidden on the Low preset. */
  detailMeshes: THREE.Object3D[];
  stats: { drawCalls: number; triangles: number; instances: number };
}

export class MapRenderer {
  constructor(private readonly materials: MaterialLibrary) {}

  build(map: MapDefinition, settings: GraphicsSettings): MapRenderResult {
    const root = new THREE.Group();
    root.name = `map:${map.id}`;
    const detailMeshes: THREE.Object3D[] = [];

    const buckets = new Map<string, MergeBucket>();
    const detailBuckets = new Map<string, MergeBucket>();
    let triangles = 0;

    for (const volume of map.volumes) {
      // Detail-only geometry is dropped entirely on Low: this is decoration,
      // never anything a player needs to read to fight.
      if (volume.detailOnly && !settings.detailProps) continue;

      const material = this.materials.get(
        volume.material,
        volume.style,
        volume.color,
        volume.emissive,
      );
      const key = material.uuid;
      const target = volume.detailOnly ? detailBuckets : buckets;

      let bucket = target.get(key);
      if (!bucket) {
        bucket = { material, positions: [], normals: [], uvs: [], indices: [], vertexCount: 0 };
        target.set(key, bucket);
      }

      this.appendBox(bucket, volume, (material.userData.tiling as number) ?? 0.5);
      triangles += 12;
    }

    let drawCalls = 0;
    for (const bucket of buckets.values()) {
      const mesh = this.finishBucket(bucket, settings);
      root.add(mesh);
      drawCalls++;
    }
    for (const bucket of detailBuckets.values()) {
      const mesh = this.finishBucket(bucket, settings);
      mesh.castShadow = false;
      root.add(mesh);
      detailMeshes.push(mesh);
      drawCalls++;
    }

    const instances = this.buildProps(map.props, root, settings, detailMeshes);
    drawCalls += instances.calls;

    return {
      root,
      detailMeshes,
      stats: { drawCalls, triangles, instances: instances.count },
    };
  }

  /** Append a box's 12 triangles into a merge bucket, with world-scaled UVs. */
  private appendBox(bucket: MergeBucket, volume: MapVolume, tiling: number): void {
    const hx = volume.size.x / 2;
    const hy = volume.size.y / 2;
    const hz = volume.size.z / 2;
    const half = [hx, hy, hz];
    const size = [volume.size.x, volume.size.y, volume.size.z];

    for (const face of BOX_FACES) {
      const start = bucket.vertexCount;

      for (const corner of face.corners) {
        bucket.positions.push(
          volume.at.x + corner[0]! * hx,
          volume.at.y + corner[1]! * hy,
          volume.at.z + corner[2]! * hz,
        );
        bucket.normals.push(face.normal[0], face.normal[1], face.normal[2]);

        // UVs scale with world size so tiling is consistent regardless of how
        // large the box is — otherwise a 40m wall and a 1m crate would show
        // the same texture at wildly different densities.
        const [uAxis, vAxis] = face.uvAxes;
        const u = ((corner[uAxis]! + 1) / 2) * size[uAxis]! * tiling;
        const v = ((corner[vAxis]! + 1) / 2) * size[vAxis]! * tiling;
        bucket.uvs.push(u, v);
      }

      bucket.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      bucket.vertexCount += 4;
    }
    void half;
  }

  private finishBucket(bucket: MergeBucket, settings: GraphicsSettings): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
    geometry.setIndex(bucket.indices);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    const mesh = new THREE.Mesh(geometry, bucket.material);
    mesh.castShadow = settings.shadows && !bucket.material.transparent;
    mesh.receiveShadow = settings.shadows;
    // Merged static geometry never moves, so skip the per-frame matrix update.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  // ------------------------------------------------------------------ props

  /** Geometry for each prop kind. Simple shapes, drawn instanced. */
  private propGeometry(kind: string): THREE.BufferGeometry {
    switch (kind) {
      case 'pipe':
        return new THREE.CylinderGeometry(0.12, 0.12, 1, 8, 1, true);
      case 'cable':
        return new THREE.CylinderGeometry(0.04, 0.04, 1, 5, 1, true);
      case 'vent':
        return new THREE.BoxGeometry(0.9, 0.35, 0.9);
      case 'ac_unit':
        return new THREE.BoxGeometry(1.6, 1.0, 1.4);
      case 'antenna':
        return new THREE.CylinderGeometry(0.05, 0.12, 5, 6);
      case 'barrel':
        return new THREE.CylinderGeometry(0.32, 0.32, 0.95, 12);
      case 'crate_small':
        return new THREE.BoxGeometry(0.7, 0.7, 0.7);
      case 'pallet':
        return new THREE.BoxGeometry(1.2, 0.14, 1.0);
      case 'locker':
        return new THREE.BoxGeometry(0.7, 1.9, 0.5);
      case 'toolbench':
        return new THREE.BoxGeometry(1.8, 0.95, 0.7);
      case 'cable_spool':
        return new THREE.CylinderGeometry(0.6, 0.6, 0.7, 14);
      case 'forklift':
        return new THREE.BoxGeometry(1.2, 1.5, 2.2);
      case 'shelf_unit':
        return new THREE.BoxGeometry(1.6, 2.0, 0.5);
      case 'counter':
        return new THREE.BoxGeometry(2.0, 1.0, 0.7);
      case 'table':
        return new THREE.BoxGeometry(1.2, 0.75, 1.2);
      case 'stool':
        return new THREE.CylinderGeometry(0.2, 0.22, 0.5, 8);
      case 'sign_board':
        return new THREE.BoxGeometry(1.4, 0.8, 0.08);
      case 'planter':
        return new THREE.BoxGeometry(1.2, 0.6, 0.8);
      case 'bench':
        return new THREE.BoxGeometry(1.8, 0.45, 0.5);
      case 'terminal':
        return new THREE.BoxGeometry(0.6, 1.4, 0.4);
      case 'lantern':
        return new THREE.SphereGeometry(0.16, 8, 6);
      case 'lamp_head':
        return new THREE.BoxGeometry(0.5, 0.16, 0.24);
      case 'sign_glow':
        return new THREE.PlaneGeometry(1, 0.4);
      case 'cache_terminal':
        return new THREE.BoxGeometry(0.8, 1.6, 0.6);
      default:
        return new THREE.BoxGeometry(0.5, 0.5, 0.5);
    }
  }

  private propMaterial(kind: string, color: number | undefined): THREE.MeshStandardMaterial {
    const emissiveKinds = new Set(['lantern', 'lamp_head', 'sign_glow', 'terminal', 'cache_terminal']);
    const metallicKinds = new Set([
      'pipe', 'vent', 'ac_unit', 'antenna', 'barrel', 'locker', 'shelf_unit', 'forklift', 'counter',
    ]);

    if (emissiveKinds.has(kind)) {
      return this.materials.get(SurfaceMaterial.Plastic, 'neon', color ?? 0xffc98a, 1.8);
    }
    if (kind === 'cable') {
      return this.materials.get(SurfaceMaterial.Plastic, undefined, color ?? 0x1c1c20);
    }
    if (metallicKinds.has(kind)) {
      return this.materials.get(SurfaceMaterial.Metal, undefined, color);
    }
    return this.materials.get(SurfaceMaterial.Wood, undefined, color);
  }

  private buildProps(
    props: MapProp[],
    root: THREE.Group,
    settings: GraphicsSettings,
    detailMeshes: THREE.Object3D[],
  ): { calls: number; count: number } {
    if (props.length === 0) return { calls: 0, count: 0 };

    // Group by (kind, colour) so each group is one instanced draw.
    const groups = new Map<string, { kind: string; color?: number; items: MapProp[] }>();
    for (const prop of props) {
      // LOD 2 props are the finest decoration; drop them below Medium.
      if (prop.lod >= 2 && settings.vfxQuality < 0.7) continue;
      if (prop.lod >= 1 && !settings.detailProps) continue;

      const key = `${prop.kind}|${prop.color ?? ''}`;
      let group = groups.get(key);
      if (!group) {
        group = { kind: prop.kind, color: prop.color, items: [] };
        groups.set(key, group);
      }
      group.items.push(prop);
    }

    let count = 0;
    const dummy = new THREE.Object3D();

    for (const group of groups.values()) {
      const geometry = this.propGeometry(group.kind);
      const material = this.propMaterial(group.kind, group.color);
      const mesh = new THREE.InstancedMesh(geometry, material, group.items.length);
      mesh.castShadow = settings.shadows && group.kind !== 'cable';
      mesh.receiveShadow = settings.shadows;

      group.items.forEach((prop, index) => {
        dummy.position.set(prop.at.x, prop.at.y, prop.at.z);
        dummy.rotation.set(0, prop.rotationY, 0);

        if (group.kind === 'pipe' || group.kind === 'cable') {
          // These use `scale` to carry their run length, and the cylinder's
          // long axis is Y, so rotate it onto the run direction.
          dummy.scale.set(1, prop.scale, 1);
          dummy.rotation.set(Math.PI / 2, 0, prop.rotationY);
        } else {
          dummy.scale.setScalar(prop.scale);
        }

        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        count++;
      });

      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = true;
      root.add(mesh);
      if (group.items.every((p) => p.lod >= 1)) detailMeshes.push(mesh);
    }

    return { calls: groups.size, count };
  }

  /**
   * Distant, non-interactive scenery so the horizon is never empty.
   * Everything here is unlit, shadowless and frustum-culled; it is drawn far
   * beyond the play space purely to fill the sky.
   */
  buildBackdrop(map: MapDefinition, settings: GraphicsSettings): THREE.Group {
    const group = new THREE.Group();
    group.name = 'backdrop';

    for (const layer of map.backdrop) {
      const rng = new Rng(hashString(`${map.id}:${layer.kind}:${layer.seed}`));
      const material = new THREE.MeshBasicMaterial({
        color: layer.color,
        fog: true,
      });

      if (layer.kind === 'road') {
        // A ring road: a flat torus-ish band under the skyline.
        const geometry = new THREE.RingGeometry(layer.distance * 0.94, layer.distance, 64);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = -1.5;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        continue;
      }

      const count = Math.max(4, Math.round(layer.count * (settings.detailProps ? 1 : 0.5)));
      const geometry =
        layer.kind === 'mountains'
          ? new THREE.ConeGeometry(1, 1, 5)
          : layer.kind === 'trees'
            ? new THREE.ConeGeometry(1, 1, 6)
            : layer.kind === 'antennas'
              ? new THREE.CylinderGeometry(0.06, 0.2, 1, 5)
              : new THREE.BoxGeometry(1, 1, 1);

      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const dummy = new THREE.Object3D();

      for (let i = 0; i < count; i++) {
        // Scatter around a ring with jitter, so it doesn't read as a circle.
        const angle = (i / count) * Math.PI * 2 + rng.range(-0.06, 0.06);
        const distance = layer.distance * rng.range(0.82, 1.18);
        const height = rng.range(layer.minHeight, layer.maxHeight);
        const width =
          layer.kind === 'mountains'
            ? height * rng.range(0.8, 1.4)
            : layer.kind === 'trees'
              ? height * 0.35
              : rng.range(8, 26);

        dummy.position.set(Math.cos(angle) * distance, height / 2 - 2, Math.sin(angle) * distance);
        dummy.scale.set(width, height, width);
        dummy.rotation.y = rng.range(0, Math.PI);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }

      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }

    // The backdrop must never be lit or shadowed; it is scenery, not geometry.
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    return group;
  }
}
