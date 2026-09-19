/**
 * Procedural materials.
 *
 * No texture files ship with this build, so surfaces are built from generated
 * canvas textures: a base colour, a noise/grain pass, and a per-material detail
 * pattern (panel lines for metal, aggregate for concrete, planks for wood...).
 * They are cached by key, because a map has thousands of surfaces but only a
 * dozen distinct materials.
 *
 * Real textures drop in through the AssetManifest without touching this file's
 * callers — see `docs/ASSETS.md`.
 */

import * as THREE from 'three';
import { Rng, SurfaceMaterial, hashString } from '@titan/shared';

export interface MaterialStyle {
  color: number;
  roughness: number;
  metalness: number;
  /** Emissive intensity, for neon and screens. */
  emissive: number;
  /** How strongly the generated detail pattern shows. 0-1. */
  detail: number;
  /** Detail pattern to draw. */
  pattern: 'panels' | 'aggregate' | 'planks' | 'bricks' | 'smooth' | 'grain' | 'noise' | 'grid';
  /** UV repeats per metre. */
  tiling: number;
  transparent?: boolean;
  opacity?: number;
}

export const MATERIAL_STYLES: Record<SurfaceMaterial, MaterialStyle> = {
  [SurfaceMaterial.Metal]: {
    color: 0x6f7885, roughness: 0.42, metalness: 0.85, emissive: 0, detail: 0.55,
    pattern: 'panels', tiling: 0.5,
  },
  [SurfaceMaterial.Concrete]: {
    color: 0x8d8f92, roughness: 0.92, metalness: 0.02, emissive: 0, detail: 0.5,
    pattern: 'aggregate', tiling: 0.35,
  },
  [SurfaceMaterial.Asphalt]: {
    color: 0x3b3e44, roughness: 0.96, metalness: 0.0, emissive: 0, detail: 0.6,
    pattern: 'noise', tiling: 0.4,
  },
  [SurfaceMaterial.Wood]: {
    color: 0x9a6f42, roughness: 0.8, metalness: 0.0, emissive: 0, detail: 0.7,
    pattern: 'planks', tiling: 0.6,
  },
  [SurfaceMaterial.Glass]: {
    color: 0x9fc4d8, roughness: 0.08, metalness: 0.1, emissive: 0, detail: 0.1,
    pattern: 'smooth', tiling: 0.25, transparent: true, opacity: 0.28,
  },
  [SurfaceMaterial.Brick]: {
    color: 0x8c5a49, roughness: 0.88, metalness: 0.0, emissive: 0, detail: 0.75,
    pattern: 'bricks', tiling: 0.75,
  },
  [SurfaceMaterial.Plastic]: {
    color: 0xa8adb5, roughness: 0.55, metalness: 0.0, emissive: 0, detail: 0.2,
    pattern: 'smooth', tiling: 0.4,
  },
  [SurfaceMaterial.Fabric]: {
    color: 0x8a5f52, roughness: 0.98, metalness: 0.0, emissive: 0, detail: 0.5,
    pattern: 'grain', tiling: 1.2,
  },
  [SurfaceMaterial.Dirt]: {
    color: 0x6d5a42, roughness: 0.98, metalness: 0.0, emissive: 0, detail: 0.65,
    pattern: 'noise', tiling: 0.5,
  },
  [SurfaceMaterial.Grass]: {
    color: 0x4a6b3a, roughness: 0.95, metalness: 0.0, emissive: 0, detail: 0.7,
    pattern: 'grain', tiling: 1.0,
  },
  [SurfaceMaterial.Water]: {
    color: 0x2d4c5e, roughness: 0.06, metalness: 0.35, emissive: 0, detail: 0.15,
    pattern: 'smooth', tiling: 0.3, transparent: true, opacity: 0.72,
  },
  [SurfaceMaterial.Flesh]: {
    color: 0x9c4a44, roughness: 0.85, metalness: 0.0, emissive: 0, detail: 0.3,
    pattern: 'grain', tiling: 1.0,
  },
};

/** Named visual overrides used by the map builder's `style` field. */
export const STYLE_OVERRIDES: Record<string, Partial<MaterialStyle>> = {
  container: { roughness: 0.55, metalness: 0.7, detail: 0.7, pattern: 'panels', tiling: 0.6 },
  neon: { emissive: 2.4, roughness: 0.3, metalness: 0.0, detail: 0, pattern: 'smooth' },
  holo_board: { emissive: 1.6, roughness: 0.2, detail: 0, pattern: 'grid', tiling: 1.5 },
  objective_pad: { emissive: 1.1, roughness: 0.4, detail: 0.2, pattern: 'grid', tiling: 0.8 },
  railing: { metalness: 0.9, roughness: 0.35, detail: 0.2 },
  catwalk: { metalness: 0.8, roughness: 0.5, pattern: 'grid', tiling: 1.2, detail: 0.8 },
  stairs: { metalness: 0.7, roughness: 0.55, pattern: 'grid', tiling: 1.4 },
  crate: { color: 0xa87c48, pattern: 'planks', detail: 0.8, tiling: 1.4 },
  smelter: { color: 0x4a4038, roughness: 0.6, metalness: 0.8, emissive: 0.25, detail: 0.7 },
  smelter_stack: { color: 0x3a332c, roughness: 0.7, metalness: 0.7 },
  wet_asphalt: { roughness: 0.42, metalness: 0.12, color: 0x33363c },
  puddle: { roughness: 0.05, metalness: 0.4, opacity: 0.55, transparent: true },
  flood: { roughness: 0.05, metalness: 0.35, opacity: 0.6, transparent: true },
  pavement: { color: 0x9a9ca0, pattern: 'grid', tiling: 0.5, detail: 0.35 },
  shop: { color: 0x7a5348, detail: 0.7 },
  awning: { color: 0xb04a5a, roughness: 0.95, detail: 0.4 },
  stall_canopy: { roughness: 0.95, detail: 0.4, pattern: 'grain' },
  lamppost: { metalness: 0.8, roughness: 0.4 },
  perimeter: { color: 0x74767a, detail: 0.4 },
  block_wall: { color: 0x4a4d55, detail: 0.5 },
  roof: { color: 0x5a5f66, metalness: 0.5, roughness: 0.7 },
  tunnel: { color: 0x6a6f74, roughness: 0.95, detail: 0.6 },
  vault: { color: 0x51565c, roughness: 0.9, detail: 0.5 },
  vault_panel: { emissive: 0.15 },
  hub_floor: { color: 0x39414f, metalness: 0.6, roughness: 0.45, pattern: 'grid', tiling: 0.4 },
  hub_emblem: { color: 0x3f8ce8, emissive: 0.7, pattern: 'grid', tiling: 1.0 },
  hub_glass: { metalness: 0.7, roughness: 0.25 },
  hub_wall: { color: 0x424a58, metalness: 0.5, roughness: 0.5 },
  hub_ceiling: { color: 0x2c333e, roughness: 0.8 },
  counter: { color: 0x4d5666, metalness: 0.5, roughness: 0.4 },
  range_floor: { color: 0x5a5348, pattern: 'grid', tiling: 0.6 },
  range_target: { emissive: 0.6, metalness: 0.6 },
  pillar: { color: 0x4a525e, metalness: 0.55, roughness: 0.5 },
  fountain: { color: 0x8d8f92, detail: 0.6 },
  fountain_column: { metalness: 0.8, roughness: 0.35 },
  plaza: { color: 0x7d8085, pattern: 'grid', tiling: 0.35, detail: 0.45 },
  stall: { color: 0x8a6440, pattern: 'planks', detail: 0.7 },
  shelf: { metalness: 0.75, roughness: 0.5 },
  warehouse: { color: 0x86888c, detail: 0.45 },
  foundry: { color: 0x7d5347, detail: 0.7 },
  gantry: { metalness: 0.85, roughness: 0.45, color: 0x8a7f5a },
  barrier: { color: 0x9a9c9e, detail: 0.5 },
  platform: { metalness: 0.7, roughness: 0.45, emissive: 0.12 },
  ac_unit: { metalness: 0.6, roughness: 0.55 },
  dumpster: { color: 0x3f5a48, metalness: 0.6, roughness: 0.6 },
  alley: { color: 0x6e5348, detail: 0.7 },
  column: { metalness: 0.7, roughness: 0.5 },
  secret: { color: 0x44494f, roughness: 0.9 },
  shutter: { emissive: 0.1 },
  spawn_alpha: { color: 0x3d5570, metalness: 0.6, roughness: 0.5 },
  spawn_bravo: { color: 0x6b4550, metalness: 0.6, roughness: 0.5 },
  water: { transparent: true, opacity: 0.7, roughness: 0.06, metalness: 0.35 },
  glass: { transparent: true, opacity: 0.28, roughness: 0.08 },
  grass: { color: 0x4a6b3a },
  asphalt: { color: 0x3b3e44 },
};

const TEXTURE_SIZE = 256;

/** Draw one material's detail pattern into a canvas. */
function paintPattern(
  ctx: CanvasRenderingContext2D,
  style: MaterialStyle,
  seed: number,
): void {
  const rng = new Rng(seed);
  const size = TEXTURE_SIZE;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const shade = (alpha: number, dark = true): string =>
    dark ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;

  const detail = style.detail;
  if (detail <= 0) return;

  switch (style.pattern) {
    case 'panels': {
      // Sheet-metal panels with rivets along the seams.
      const cells = 4;
      const step = size / cells;
      ctx.strokeStyle = shade(0.28 * detail);
      ctx.lineWidth = 2;
      for (let i = 0; i <= cells; i++) {
        ctx.beginPath();
        ctx.moveTo(i * step, 0);
        ctx.lineTo(i * step, size);
        ctx.moveTo(0, i * step);
        ctx.lineTo(size, i * step);
        ctx.stroke();
      }
      ctx.fillStyle = shade(0.22 * detail);
      for (let x = 0; x <= cells; x++) {
        for (let y = 0; y <= cells; y++) {
          ctx.beginPath();
          ctx.arc(x * step, y * step, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case 'aggregate': {
      // Concrete: fine speckle plus a few larger stones.
      for (let i = 0; i < 900; i++) {
        const r = rng.range(0.5, 1.8);
        ctx.fillStyle = shade(rng.range(0.03, 0.16) * detail, rng.bool(0.35));
        ctx.beginPath();
        ctx.arc(rng.range(0, size), rng.range(0, size), r, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = shade(rng.range(0.06, 0.14) * detail, rng.bool(0.5));
        ctx.beginPath();
        ctx.arc(rng.range(0, size), rng.range(0, size), rng.range(2.5, 5), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'planks': {
      const planks = 5;
      const h = size / planks;
      for (let i = 0; i < planks; i++) {
        ctx.fillStyle = shade(rng.range(0.02, 0.1) * detail, rng.bool(0.4));
        ctx.fillRect(0, i * h, size, h);
        // Seam.
        ctx.fillStyle = shade(0.35 * detail);
        ctx.fillRect(0, i * h, size, 1.5);
        // Grain lines.
        ctx.strokeStyle = shade(0.1 * detail);
        ctx.lineWidth = 1;
        for (let g = 0; g < 6; g++) {
          const y = i * h + rng.range(3, h - 3);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.bezierCurveTo(size * 0.3, y + rng.range(-2, 2), size * 0.7, y + rng.range(-2, 2), size, y);
          ctx.stroke();
        }
      }
      break;
    }
    case 'bricks': {
      const rows = 8;
      const h = size / rows;
      const w = size / 4;
      for (let r = 0; r < rows; r++) {
        const offset = r % 2 === 0 ? 0 : w / 2;
        for (let c = -1; c < 5; c++) {
          const x = c * w + offset;
          ctx.fillStyle = shade(rng.range(0.02, 0.12) * detail, rng.bool(0.4));
          ctx.fillRect(x + 1.5, r * h + 1.5, w - 3, h - 3);
        }
      }
      ctx.strokeStyle = shade(0.4 * detail);
      ctx.lineWidth = 2;
      for (let r = 0; r <= rows; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * h);
        ctx.lineTo(size, r * h);
        ctx.stroke();
      }
      break;
    }
    case 'grid': {
      const cells = 8;
      const step = size / cells;
      ctx.strokeStyle = shade(0.22 * detail);
      ctx.lineWidth = 1.5;
      for (let i = 0; i <= cells; i++) {
        ctx.beginPath();
        ctx.moveTo(i * step, 0);
        ctx.lineTo(i * step, size);
        ctx.moveTo(0, i * step);
        ctx.lineTo(size, i * step);
        ctx.stroke();
      }
      break;
    }
    case 'grain': {
      for (let i = 0; i < 2200; i++) {
        ctx.fillStyle = shade(rng.range(0.02, 0.09) * detail, rng.bool(0.5));
        ctx.fillRect(rng.range(0, size), rng.range(0, size), 1, 1);
      }
      break;
    }
    case 'noise': {
      for (let i = 0; i < 1600; i++) {
        ctx.fillStyle = shade(rng.range(0.02, 0.14) * detail, rng.bool(0.45));
        const r = rng.range(0.6, 2.2);
        ctx.fillRect(rng.range(0, size), rng.range(0, size), r, r);
      }
      break;
    }
    case 'smooth':
    default: {
      for (let i = 0; i < 200; i++) {
        ctx.fillStyle = shade(rng.range(0.01, 0.04) * detail, rng.bool(0.5));
        ctx.fillRect(rng.range(0, size), rng.range(0, size), 2, 2);
      }
      break;
    }
  }
}

/** Build a normal map by finite-differencing the albedo's luminance. */
function buildNormalMap(source: HTMLCanvasElement, strength: number): THREE.CanvasTexture {
  const size = source.width;
  const src = source.getContext('2d')!.getImageData(0, 0, size, size).data;

  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d')!;
  const image = ctx.createImageData(size, size);

  const lum = (x: number, y: number): number => {
    const ix = ((y + size) % size) * size + ((x + size) % size);
    const i = ix * 4;
    return (src[i]! * 0.299 + src[i + 1]! * 0.587 + src[i + 2]! * 0.114) / 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
      // Normalize (-dx, -dy, 1) into 0-255.
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      image.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      image.data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      image.data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(out);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

export class MaterialLibrary {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textureCache = new Map<string, { map: THREE.CanvasTexture; normal: THREE.CanvasTexture }>();
  private anisotropy = 4;
  private useNormalMaps = true;

  configure(anisotropy: number, useNormalMaps: boolean): void {
    this.anisotropy = anisotropy;
    this.useNormalMaps = useNormalMaps;
    for (const { map, normal } of this.textureCache.values()) {
      map.anisotropy = anisotropy;
      normal.anisotropy = anisotropy;
      map.needsUpdate = true;
    }
  }

  private textureFor(style: MaterialStyle, key: string) {
    const cached = this.textureCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d')!;
    paintPattern(ctx, style, hashString(key));

    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.anisotropy = this.anisotropy;
    map.colorSpace = THREE.SRGBColorSpace;

    const normal = buildNormalMap(canvas, 2.4);
    normal.anisotropy = this.anisotropy;

    const entry = { map, normal };
    this.textureCache.set(key, entry);
    return entry;
  }

  /**
   * Resolve a material for a surface + optional named style + optional colour
   * override. Materials are shared, so this is cheap to call per surface.
   */
  get(material: SurfaceMaterial, styleName?: string, colorOverride?: number, emissive?: number): THREE.MeshStandardMaterial {
    const key = `${material}|${styleName ?? ''}|${colorOverride ?? ''}|${emissive ?? ''}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const base = MATERIAL_STYLES[material];
    const override = styleName ? STYLE_OVERRIDES[styleName] : undefined;
    const style: MaterialStyle = { ...base, ...override };
    if (colorOverride !== undefined) style.color = colorOverride;
    if (emissive !== undefined) style.emissive = emissive;

    const { map, normal } = this.textureFor(style, `${material}|${style.pattern}|${style.detail}`);

    const three = new THREE.MeshStandardMaterial({
      color: style.color,
      roughness: style.roughness,
      metalness: style.metalness,
      map,
      normalMap: this.useNormalMaps ? normal : null,
      normalScale: new THREE.Vector2(0.7, 0.7),
      transparent: style.transparent ?? false,
      opacity: style.opacity ?? 1,
      emissive: style.emissive > 0 ? new THREE.Color(style.color) : new THREE.Color(0x000000),
      emissiveIntensity: style.emissive,
      side: style.transparent ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: !style.transparent,
    });

    // UV scale is applied per-mesh via the geometry, so store the tiling rate
    // on userData for the map builder to read.
    three.userData.tiling = style.tiling;

    this.cache.set(key, three);
    return three;
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    for (const { map, normal } of this.textureCache.values()) {
      map.dispose();
      normal.dispose();
    }
    this.cache.clear();
    this.textureCache.clear();
  }

  get materialCount(): number {
    return this.cache.size;
  }
}
