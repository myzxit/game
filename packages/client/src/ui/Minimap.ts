/**
 * Minimap.
 *
 * Drawn to a 2D canvas from the map's own collision volumes, so it always
 * matches the level without a hand-authored map image. Only geometry near the
 * player's height is drawn — otherwise a multi-storey map renders as a solid
 * block and tells the player nothing.
 *
 * Enemies appear only when the game has legitimately revealed them (they fired
 * unsuppressed, or a scan pulse caught them). The client is never sent enemy
 * positions it is not allowed to show — it receives them for rendering, so the
 * minimap deliberately filters rather than displaying everything it knows.
 */

import {
  TeamId,
  clamp,
  type MapDefinition,
  type Vec3,
} from '@titan/shared';

export interface MinimapEntity {
  position: Vec3;
  yaw: number;
  team: TeamId;
  isSelf: boolean;
  /** Only revealed enemies are drawn. */
  revealed: boolean;
  alive: boolean;
}

export interface MinimapObjective {
  position: Vec3;
  owner: TeamId;
  contested: boolean;
}

const COLORS = {
  background: 'rgba(6, 9, 15, 0.0)',
  wall: '#2b3548',
  wallHigh: '#3a4761',
  floor: '#171f2d',
  self: '#ffffff',
  ally: '#3f8ce8',
  enemy: '#f0674a',
  objectiveNeutral: '#6b7280',
  border: 'rgba(255,255,255,0.1)',
};

export class MinimapRenderer {
  private map: MapDefinition | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  /** Pre-rendered static geometry, redrawn only when the height band changes. */
  private staticLayer: HTMLCanvasElement | null = null;
  private staticLayerBand = Number.NaN;

  /** Metres shown across the minimap. */
  private range = 60;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('minimap: 2D context unavailable');
    this.ctx = ctx;
  }

  setMap(map: MapDefinition): void {
    this.map = map;
    this.staticLayer = null;
    this.staticLayerBand = Number.NaN;
  }

  setRange(metres: number): void {
    this.range = clamp(metres, 20, 200);
  }

  /**
   * Render the static geometry for the height band around `centreY`.
   * Cached, because redrawing a few thousand rectangles every frame would cost
   * more than the 3D scene.
   */
  private buildStaticLayer(centreY: number): HTMLCanvasElement {
    const map = this.map!;
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    const bounds = map.bounds;
    const worldWidth = bounds.max.x - bounds.min.x;
    const worldDepth = bounds.max.z - bounds.min.z;
    const scale = size / Math.max(worldWidth, worldDepth);

    const toX = (x: number): number => (x - bounds.min.x) * scale;
    const toY = (z: number): number => (z - bounds.min.z) * scale;

    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(0, 0, size, size);

    // Only geometry within a band around the player's floor is drawn. Anything
    // far above or below is a different storey and would only add noise.
    const bandLow = centreY - 3;
    const bandHigh = centreY + 4;

    for (const volume of map.volumes) {
      if (volume.noCollision) continue;
      const top = volume.at.y + volume.size.y / 2;
      const bottom = volume.at.y - volume.size.y / 2;
      if (top < bandLow || bottom > bandHigh) continue;

      // Very thin slabs are floors; drawing them would fill the map solid.
      if (volume.size.y < 0.6 && volume.size.x > 4 && volume.size.z > 4) continue;

      const x = toX(volume.at.x - volume.size.x / 2);
      const y = toY(volume.at.z - volume.size.z / 2);
      const w = volume.size.x * scale;
      const h = volume.size.z * scale;

      // Taller geometry is drawn lighter, which reads as "you can't shoot over
      // this" versus "this is waist-high cover".
      ctx.fillStyle = volume.size.y > 2.2 ? COLORS.wallHigh : COLORS.wall;
      ctx.fillRect(x, y, Math.max(1, w), Math.max(1, h));
    }

    return canvas;
  }

  /**
   * Draw a frame.
   * `rotate` follows the player's heading when enabled, which most players
   * prefer for a first-person game; north-up is available in settings.
   */
  render(
    self: Vec3,
    selfYaw: number,
    entities: MinimapEntity[],
    objectives: MinimapObjective[],
    rotate: boolean,
  ): void {
    const map = this.map;
    const ctx = this.ctx;
    const size = this.canvas.width;
    ctx.clearRect(0, 0, size, size);
    if (!map) return;

    // Rebuild the static layer when the player changes storey.
    const band = Math.round(self.y / 4);
    if (!this.staticLayer || this.staticLayerBand !== band) {
      this.staticLayer = this.buildStaticLayer(self.y);
      this.staticLayerBand = band;
    }

    const bounds = map.bounds;
    const worldWidth = bounds.max.x - bounds.min.x;
    const worldDepth = bounds.max.z - bounds.min.z;
    const layerScale = 1024 / Math.max(worldWidth, worldDepth);

    // Pixels per metre on screen.
    const pixelsPerMetre = size / this.range;

    ctx.save();
    // Clip to a circle so the map reads as a radar rather than a rectangle.
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.translate(size / 2, size / 2);
    if (rotate) ctx.rotate(selfYaw);

    // Draw the static layer positioned so the player is at the centre.
    const selfLayerX = (self.x - bounds.min.x) * layerScale;
    const selfLayerY = (self.z - bounds.min.z) * layerScale;
    const drawScale = pixelsPerMetre / layerScale;

    ctx.save();
    ctx.scale(drawScale, drawScale);
    ctx.drawImage(this.staticLayer, -selfLayerX, -selfLayerY);
    ctx.restore();

    // Objectives.
    for (const objective of objectives) {
      const dx = (objective.position.x - self.x) * pixelsPerMetre;
      const dz = (objective.position.z - self.z) * pixelsPerMetre;
      ctx.beginPath();
      ctx.arc(dx, dz, 6, 0, Math.PI * 2);
      ctx.fillStyle =
        objective.owner === TeamId.Alpha
          ? COLORS.ally
          : objective.owner === TeamId.Bravo
            ? COLORS.enemy
            : COLORS.objectiveNeutral;
      ctx.globalAlpha = objective.contested ? 0.5 + Math.sin(performance.now() / 120) * 0.4 : 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Entities.
    for (const entity of entities) {
      if (entity.isSelf) continue;
      if (!entity.alive) continue;
      // The filter that matters: unrevealed enemies are simply not drawn.
      const isEnemy = entity.team !== TeamId.None && entity.team !== selfTeamOf(entities);
      if (isEnemy && !entity.revealed) continue;

      const dx = (entity.position.x - self.x) * pixelsPerMetre;
      const dz = (entity.position.z - self.z) * pixelsPerMetre;

      // Off-map entities are clamped to the rim, so you still know roughly
      // where a revealed enemy is even outside the radar range.
      const distance = Math.hypot(dx, dz);
      const limit = size / 2 - 8;
      const scale = distance > limit ? limit / distance : 1;

      ctx.save();
      ctx.translate(dx * scale, dz * scale);
      ctx.rotate(-entity.yaw + (rotate ? selfYaw : 0));
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(4, 4);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fillStyle = isEnemy ? COLORS.enemy : COLORS.ally;
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    // The player, always dead centre, always pointing up.
    ctx.save();
    ctx.translate(size / 2, size / 2);
    if (!rotate) ctx.rotate(-selfYaw);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fillStyle = COLORS.self;
    ctx.fill();
    ctx.restore();

    // Rim.
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/** The local player's team, taken from the entity list. */
function selfTeamOf(entities: MinimapEntity[]): TeamId {
  return entities.find((e) => e.isSelf)?.team ?? TeamId.None;
}
