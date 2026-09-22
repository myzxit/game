/**
 * Asset manifest.
 *
 * **This build ships no authored art or audio files.** Every model, texture,
 * animation and sound below is generated procedurally at runtime. That is a
 * real, deliberate limitation, not a placeholder pretending to be finished
 * content — see docs/ASSETS.md for the exact specification a real asset pack
 * would have to meet.
 *
 * The manifest exists so that dropping in real assets is a data change, not a
 * code change: `resolve()` returns an authored asset when one is registered and
 * falls back to the procedural generator otherwise. Nothing in the renderer or
 * audio engine knows which it got.
 */

import { createLogger } from '@titan/shared';

const log = createLogger('Assets');

export type AssetKind = 'model' | 'texture' | 'animation' | 'sound' | 'music' | 'font' | 'ui';

export interface AssetSpec {
  key: string;
  kind: AssetKind;
  /** URL of the authored asset, when one exists. */
  url: string | null;
  /** What a real version of this asset must be, for the art team. */
  requirement: string;
  /** True when the runtime is currently substituting a procedural version. */
  procedural: boolean;
}

/**
 * Required assets, with their specifications.
 *
 * `url: null` means "not authored yet". The count of nulls is reported at boot
 * and surfaced in the dev tools, so the gap is visible rather than hidden.
 */
const SPECS: AssetSpec[] = [
  // ---------------------------------------------------------------- Models
  {
    key: 'model.character.vanguard',
    kind: 'model',
    url: null,
    requirement:
      'Rigged humanoid, 8-14k tris, single 2048 albedo + normal + ORM atlas, ' +
      'Mixamo-compatible skeleton, 1.8m tall, origin at feet.',
    procedural: true,
  },
  {
    key: 'model.character.specter',
    kind: 'model',
    url: null,
    requirement: 'As vanguard, slimmer silhouette, 1.74m.',
    procedural: true,
  },
  {
    key: 'model.character.warden',
    kind: 'model',
    url: null,
    requirement: 'As vanguard, heavier silhouette with shoulder plating, 1.86m.',
    procedural: true,
  },
  {
    key: 'model.character.surveyor',
    kind: 'model',
    url: null,
    requirement: 'As vanguard, with a visible sensor pack, 1.78m.',
    procedural: true,
  },
  {
    key: 'model.character.forge',
    kind: 'model',
    url: null,
    requirement: 'As vanguard, with a tool harness, 1.82m.',
    procedural: true,
  },
  {
    key: 'model.weapon.viewmodel',
    kind: 'model',
    url: null,
    requirement:
      'First-person arms + weapon set, 6-10k tris each, separate muzzle/ejection ' +
      'port/magazine sockets, 512-1024 textures. One per weapon id.',
    procedural: true,
  },
  {
    key: 'model.vehicle.scout_buggy',
    kind: 'model',
    url: null,
    requirement: '10-16k tris, 4 wheel bones, 2048 texture, collision proxy 2.2 x 1.5 x 4.2m.',
    procedural: true,
  },
  {
    key: 'model.npc.generic',
    kind: 'model',
    url: null,
    requirement: 'Rigged humanoid, idle-only rig acceptable, 6-10k tris.',
    procedural: true,
  },

  // -------------------------------------------------------------- Textures
  {
    key: 'texture.surface.atlas',
    kind: 'texture',
    url: null,
    requirement:
      'Tiling PBR set for metal / concrete / asphalt / wood / glass / brick / ' +
      'plastic / fabric / dirt / grass / water. 1024 albedo + normal + roughness ' +
      'each, or one 4096 atlas.',
    procedural: true,
  },
  {
    key: 'texture.decal.impacts',
    kind: 'texture',
    url: null,
    requirement: 'Bullet-hole decal sheet, 4x4 variations, 512 alpha-masked.',
    procedural: true,
  },
  {
    key: 'texture.vfx.particles',
    kind: 'texture',
    url: null,
    requirement: 'Smoke / spark / flash sprite sheet, 8x8, 1024 premultiplied alpha.',
    procedural: true,
  },
  {
    key: 'texture.sky.cubemap',
    kind: 'texture',
    url: null,
    requirement: 'Sky cubemap per environment profile, 1024/face, HDR preferred.',
    procedural: true,
  },

  // ------------------------------------------------------------ Animations
  {
    key: 'animation.character.locomotion',
    kind: 'animation',
    url: null,
    requirement:
      'idle / walk (8-dir) / run / sprint / jump / fall / land / crouch-idle / ' +
      'crouch-walk / slide / dash / death. 30fps, root motion off.',
    procedural: true,
  },
  {
    key: 'animation.viewmodel.weapon',
    kind: 'animation',
    url: null,
    requirement:
      'Per weapon: idle / fire / fire-ads / reload / reload-empty / equip / ' +
      'holster / sprint / inspect / melee. 60fps for fire and reload.',
    procedural: true,
  },
  {
    key: 'animation.character.emote',
    kind: 'animation',
    url: null,
    requirement: 'salute / taunt / victory pose, 2-4s each, loopable hold.',
    procedural: true,
  },

  // ---------------------------------------------------------------- Audio
  {
    key: 'audio.weapons',
    kind: 'sound',
    url: null,
    requirement:
      'Per weapon: fire (3-5 round-robin variants), fire-distant, reload start / ' +
      'mag-out / mag-in / bolt, dry fire. 48kHz mono WAV, -3dBFS peak.',
    procedural: true,
  },
  {
    key: 'audio.impacts',
    kind: 'sound',
    url: null,
    requirement: 'Per surface material: 4 impact variants + 4 footstep variants, 48kHz mono.',
    procedural: true,
  },
  {
    key: 'audio.ambience',
    kind: 'sound',
    url: null,
    requirement: 'Seamless stereo loops, 30-60s: wind, machinery, rain, city night, neon hum.',
    procedural: true,
  },
  {
    key: 'audio.vehicles',
    kind: 'sound',
    url: null,
    requirement:
      'Per vehicle: engine loop at idle / mid / full revs (seamless, 4-8s each, ' +
      'pitch-shiftable), start, stop, collision, destruction. 48kHz mono.',
    procedural: true,
  },
  {
    key: 'audio.music',
    kind: 'music',
    url: null,
    requirement:
      'Menu / lobby / combat / victory / defeat / event. Stem-separated where ' +
      'possible so intensity can follow the match. 48kHz stereo.',
    procedural: true,
  },
  {
    key: 'audio.ui',
    kind: 'sound',
    url: null,
    requirement: 'click / hover / back / error / purchase / reward / level-up / rank-up.',
    procedural: true,
  },

  // ------------------------------------------------------------------- UI
  {
    key: 'font.ui',
    kind: 'font',
    url: null,
    requirement:
      'Variable sans supporting Latin + Hangul (and later Kana + CJK). ' +
      'Currently falls back to the system UI font stack, which covers Korean on ' +
      'all target platforms.',
    procedural: false,
  },
  {
    key: 'ui.icons',
    kind: 'ui',
    url: null,
    requirement: 'SVG icon set: weapon classes, rarities, currencies, quest types, ranks.',
    procedural: true,
  },
];

export class AssetManifest {
  private readonly specs = new Map<string, AssetSpec>();
  private readonly loaded = new Map<string, unknown>();

  constructor() {
    for (const spec of SPECS) this.specs.set(spec.key, spec);
  }

  /** Register a real asset, overriding the procedural fallback. */
  register(key: string, url: string, value?: unknown): void {
    const spec = this.specs.get(key);
    if (spec) {
      spec.url = url;
      spec.procedural = false;
    } else {
      this.specs.set(key, {
        key,
        kind: 'model',
        url,
        requirement: 'registered at runtime',
        procedural: false,
      });
    }
    if (value !== undefined) this.loaded.set(key, value);
  }

  get(key: string): unknown {
    return this.loaded.get(key) ?? null;
  }

  /** True when this asset is being substituted procedurally. */
  isProcedural(key: string): boolean {
    return this.specs.get(key)?.procedural ?? true;
  }

  spec(key: string): AssetSpec | null {
    return this.specs.get(key) ?? null;
  }

  all(): AssetSpec[] {
    return Array.from(this.specs.values());
  }

  /** Assets still awaiting real art or audio. */
  missing(): AssetSpec[] {
    return this.all().filter((s) => s.url === null);
  }

  /**
   * Report the state of the asset pipeline at boot.
   * Logged rather than hidden: a build running entirely on procedural stand-ins
   * should say so.
   */
  report(): { total: number; authored: number; procedural: number } {
    const total = this.specs.size;
    const authored = this.all().filter((s) => s.url !== null).length;
    const procedural = total - authored;

    if (procedural > 0) {
      log.warn(
        `${procedural} of ${total} asset groups have no authored file and are being ` +
          'generated procedurally at runtime. See docs/ASSETS.md for the required specs.',
      );
    }
    return { total, authored, procedural };
  }
}

export const assets = new AssetManifest();
