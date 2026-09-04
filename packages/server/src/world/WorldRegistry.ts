/**
 * Collision worlds, built once per map and shared by every match on that map.
 *
 * Building a world means bucketing a few thousand brushes into a grid, which is
 * cheap but not free — doing it per match would add a visible hitch to match
 * start. Worlds are immutable apart from destructible glass, which is tracked
 * per-match rather than on the shared world (see MatchInstance.destroyedBrushes).
 */

import {
  CollisionWorld,
  createLogger,
  requireMap,
  volumesToBrushes,
  type MapDefinition,
} from '@titan/shared';

const log = createLogger('World');

export interface LoadedWorld {
  map: MapDefinition;
  collision: CollisionWorld;
  /** Ids of brushes that can be destroyed, for fast per-match lookup. */
  breakableIds: Set<number>;
  buildTimeMs: number;
}

export class WorldRegistry {
  private readonly worlds = new Map<string, LoadedWorld>();

  get(mapId: string): LoadedWorld {
    const cached = this.worlds.get(mapId);
    if (cached) return cached;

    const started = performance.now();
    const map = requireMap(mapId);
    const brushes = volumesToBrushes(map.volumes);
    const collision = new CollisionWorld(brushes);

    const breakableIds = new Set<number>();
    for (const b of brushes) if (b.breakable) breakableIds.add(b.id);

    const world: LoadedWorld = {
      map,
      collision,
      breakableIds,
      buildTimeMs: performance.now() - started,
    };

    this.worlds.set(mapId, world);
    log.info('world built', {
      mapId,
      brushes: brushes.length,
      breakable: breakableIds.size,
      ms: Math.round(world.buildTimeMs),
    });
    return world;
  }

  /** Preload every map at startup so no match start pays the build cost. */
  preload(mapIds: string[]): void {
    for (const id of mapIds) {
      try {
        this.get(id);
      } catch (e) {
        log.error('failed to build world', { mapId: id, error: String(e) });
      }
    }
  }

  get loadedCount(): number {
    return this.worlds.size;
  }
}
