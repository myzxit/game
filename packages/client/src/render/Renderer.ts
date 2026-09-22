/**
 * Renderer.
 *
 * Owns the WebGL context, the scene, lighting, sky and weather, and the
 * quality-adaptation loop. The design constraint throughout is that the Low
 * preset must hold a stable frame rate on integrated graphics while keeping
 * every gameplay-critical element (enemies, tracers, hitmarkers, objectives)
 * exactly as visible as on High.
 */

import * as THREE from 'three';
import {
  DEFAULT_ENVIRONMENT,
  clamp,
  createLogger,
  type EnvironmentProfile,
  type LightDefinition,
  type MapDefinition,
} from '@titan/shared';
import { MaterialLibrary } from './Materials.js';
import { MapRenderer } from './MapRenderer.js';
import type { GraphicsSettings, Settings } from '../core/Settings.js';

const log = createLogger('Renderer');

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly materials = new MaterialLibrary();
  readonly mapRenderer: MapRenderer;

  /** Everything belonging to the current map; cleared on map change. */
  private worldRoot: THREE.Group | null = null;
  private backdropRoot: THREE.Group | null = null;
  private detailMeshes: THREE.Object3D[] = [];

  private sun: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private readonly dynamicLights: THREE.Light[] = [];
  private sky: THREE.Mesh | null = null;
  private rain: THREE.Points | null = null;
  private rainVelocities: Float32Array | null = null;

  private settings: GraphicsSettings;
  private environment: EnvironmentProfile = DEFAULT_ENVIRONMENT;

  /** Rolling frame timing, for the FPS counter and auto quality. */
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private autoAdjustCooldown = 0;
  /** Set once we've downgraded automatically, so we only do it once. */
  private hasAutoDowngraded = false;

  onQualityDowngrade: ((from: string, to: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.settings = settings.graphics;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.settings.antialiasing,
      powerPreference: 'high-performance',
      // The depth buffer is all we need; stencil costs bandwidth we can't spare
      // on low-end parts.
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(
      settings.gameplay.fov,
      window.innerWidth / window.innerHeight,
      0.06,
      1400,
    );

    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sun.name = 'sun';
    this.ambient = new THREE.HemisphereLight(0xffffff, 0x404050, 0.6);
    this.scene.add(this.sun, this.sun.target, this.ambient);

    // Only now that `sun` exists can shadow settings be applied to it. This
    // ordering caught a real crash: applying them earlier threw on undefined.
    this.applyShadowSettings();

    this.mapRenderer = new MapRenderer(this.materials);
    this.materials.configure(this.settings.anisotropy, this.settings.postProcessing);

    this.resize();
    window.addEventListener('resize', () => this.resize());

    const gl = this.renderer.getContext();
    log.info('renderer ready', {
      renderer: gl.getParameter(gl.RENDERER),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      preset: this.settings.preset,
    });
  }

  private pixelRatio(): number {
    // Cap at 2: beyond that the cost is real and the gain is not.
    return clamp(window.devicePixelRatio * this.settings.resolutionScale, 0.5, 2);
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  applySettings(settings: Settings): void {
    const previous = this.settings;
    this.settings = settings.graphics;

    if (previous.resolutionScale !== this.settings.resolutionScale) {
      this.renderer.setPixelRatio(this.pixelRatio());
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    }
    if (previous.shadows !== this.settings.shadows || previous.shadowQuality !== this.settings.shadowQuality) {
      this.applyShadowSettings();
    }
    if (previous.anisotropy !== this.settings.anisotropy) {
      this.materials.configure(this.settings.anisotropy, this.settings.postProcessing);
    }
    if (previous.detailProps !== this.settings.detailProps) {
      for (const mesh of this.detailMeshes) mesh.visible = this.settings.detailProps;
    }
    if (previous.viewDistance !== this.settings.viewDistance) {
      this.applyFog();
    }
    this.applyLightBudget();

    this.camera.fov = settings.gameplay.fov;
    this.camera.updateProjectionMatrix();
  }

  private applyShadowSettings(): void {
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.sun.castShadow = this.settings.shadows;
    if (this.settings.shadows) {
      this.sun.shadow.mapSize.set(this.settings.shadowQuality, this.settings.shadowQuality);
      // A tight ortho box around the play space keeps texel density usable at
      // 1024 — a loose box is why cheap shadows look like mush.
      const extent = 70;
      this.sun.shadow.camera.left = -extent;
      this.sun.shadow.camera.right = extent;
      this.sun.shadow.camera.top = extent;
      this.sun.shadow.camera.bottom = -extent;
      this.sun.shadow.camera.near = 1;
      this.sun.shadow.camera.far = 300;
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.normalBias = 0.03;
      this.sun.shadow.camera.updateProjectionMatrix();
    }
  }

  // ================================================================== world ==

  /** Replace the current world with a new map. */
  loadMap(map: MapDefinition): FrameStats {
    this.clearWorld();
    this.environment = map.environment;

    const result = this.mapRenderer.build(map, this.settings);
    this.worldRoot = result.root;
    this.detailMeshes = result.detailMeshes;
    this.scene.add(this.worldRoot);

    this.backdropRoot = this.mapRenderer.buildBackdrop(map, this.settings);
    this.scene.add(this.backdropRoot);

    this.applyEnvironment(map.environment);
    this.buildLights(map.lights);
    this.buildSky(map.environment);
    this.buildWeather(map.environment);

    log.info('map loaded', {
      mapId: map.id,
      drawCalls: result.stats.drawCalls,
      instances: result.stats.instances,
    });

    return {
      fps: 0,
      frameMs: 0,
      drawCalls: result.stats.drawCalls,
      triangles: result.stats.triangles,
      programs: this.renderer.info.programs?.length ?? 0,
    };
  }

  private clearWorld(): void {
    for (const root of [this.worldRoot, this.backdropRoot]) {
      if (!root) continue;
      root.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
          object.geometry.dispose();
        }
      });
      this.scene.remove(root);
    }
    this.worldRoot = null;
    this.backdropRoot = null;
    this.detailMeshes = [];

    for (const light of this.dynamicLights) this.scene.remove(light);
    this.dynamicLights.length = 0;

    if (this.sky) {
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
      this.scene.remove(this.sky);
      this.sky = null;
    }
    if (this.rain) {
      this.rain.geometry.dispose();
      (this.rain.material as THREE.Material).dispose();
      this.scene.remove(this.rain);
      this.rain = null;
      this.rainVelocities = null;
    }
  }

  private applyEnvironment(env: EnvironmentProfile): void {
    // Sun direction from time of day: 6h is sunrise (east), 18h sunset (west).
    const dayAngle = ((env.timeOfDay - 6) / 12) * Math.PI;
    const elevation = Math.sin(dayAngle);
    const azimuth = Math.cos(dayAngle);

    this.sun.position.set(azimuth * 120, Math.max(0.12, elevation) * 140, 60);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();
    this.sun.color.setHex(env.sunColor);
    this.sun.intensity = env.sunIntensity;

    this.ambient.color.setHex(env.skyTopColor);
    this.ambient.groundColor.setHex(env.ambientColor);
    this.ambient.intensity = env.ambientIntensity;

    this.applyFog();
  }

  private applyFog(): void {
    const env = this.environment;
    const far = env.fogFar * this.settings.viewDistance;
    this.scene.fog = new THREE.Fog(env.fogColor, env.fogNear * this.settings.viewDistance, far);
    this.scene.background = new THREE.Color(env.fogColor);
    // Keep the far plane just beyond the fog so nothing pops in from nothing.
    this.camera.far = Math.max(far * 1.6, 600);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Build the map's point and spot lights, honouring the light budget.
   *
   * Dynamic lights are the single biggest cost on weak GPUs, so lights are
   * sorted by importance (shadow casters first, then brightest) and the budget
   * is applied from the top.
   */
  private buildLights(definitions: LightDefinition[]): void {
    const eligible = definitions.filter((d) => this.settings.detailProps || !d.detailOnly);
    const sorted = [...eligible].sort((a, b) => {
      if (a.shadows !== b.shadows) return a.shadows ? -1 : 1;
      return b.intensity - a.intensity;
    });

    for (const def of sorted.slice(0, this.settings.maxDynamicLights)) {
      let light: THREE.Light;

      if (def.kind === 'spot') {
        const spot = new THREE.SpotLight(def.color, def.intensity, def.distance, Math.PI / 5, 0.45, 1.6);
        spot.position.set(def.at.x, def.at.y, def.at.z);
        if (def.target) {
          spot.target.position.set(def.target.x, def.target.y, def.target.z);
          this.scene.add(spot.target);
        }
        light = spot;
      } else if (def.kind === 'directional') {
        const dir = new THREE.DirectionalLight(def.color, def.intensity);
        dir.position.set(def.at.x, def.at.y, def.at.z);
        light = dir;
      } else {
        const point = new THREE.PointLight(def.color, def.intensity, def.distance, 1.8);
        point.position.set(def.at.x, def.at.y, def.at.z);
        light = point;
      }

      // Only shadow-casting lights that the preset allows actually cast.
      if (def.shadows && this.settings.shadows && this.settings.shadowQuality >= 1024) {
        light.castShadow = true;
        if ('shadow' in light && light.shadow) {
          light.shadow.mapSize.set(512, 512);
          light.shadow.bias = -0.002;
        }
      }

      this.scene.add(light);
      this.dynamicLights.push(light);
    }
  }

  private applyLightBudget(): void {
    this.dynamicLights.forEach((light, index) => {
      light.visible = index < this.settings.maxDynamicLights;
    });
  }

  /**
   * Sky dome with a vertical gradient.
   * Written as a small shader rather than a texture so it costs nothing to
   * load and adapts to every environment profile.
   */
  private buildSky(env: EnvironmentProfile): void {
    const geometry = new THREE.SphereGeometry(1000, 24, 16);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(env.skyTopColor) },
        bottomColor: { value: new THREE.Color(env.skyBottomColor) },
        offset: { value: 40 },
        exponent: { value: 0.7 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          float t = pow(max(h, 0.0), exponent);
          gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
        }
      `,
    });

    this.sky = new THREE.Mesh(geometry, material);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  /**
   * Rain, as a GPU point cloud that follows the camera.
   *
   * Particle count scales with the preset; at Low it is off entirely, which is
   * the right trade — rain is atmosphere, not information.
   */
  private buildWeather(env: EnvironmentProfile): void {
    if (env.rain <= 0 || this.settings.particleDensity < 0.3) return;

    const count = Math.round(4000 * env.rain * this.settings.particleDensity);
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 90;
      positions[i * 3 + 1] = Math.random() * 40;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 90;
      velocities[i] = 24 + Math.random() * 16;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0xaac4dd,
      size: 0.06,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.rain = new THREE.Points(geometry, material);
    this.rain.frustumCulled = false;
    this.rainVelocities = velocities;
    this.scene.add(this.rain);
  }

  private updateWeather(dt: number): void {
    if (!this.rain || !this.rainVelocities) return;

    const positions = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = positions.array as Float32Array;
    const wind = this.environment.windStrength * 6;
    const windX = Math.cos(this.environment.windDirection) * wind;
    const windZ = Math.sin(this.environment.windDirection) * wind;

    for (let i = 0; i < this.rainVelocities.length; i++) {
      const base = i * 3;
      array[base + 1]! -= this.rainVelocities[i]! * dt;
      array[base]! += windX * dt;
      array[base + 2]! += windZ * dt;

      // Recycle drops that fall below the camera into the volume above it.
      if (array[base + 1]! < -6) {
        array[base] = this.camera.position.x + (Math.random() - 0.5) * 90;
        array[base + 1] = this.camera.position.y + 32 + Math.random() * 10;
        array[base + 2] = this.camera.position.z + (Math.random() - 0.5) * 90;
      }
    }
    positions.needsUpdate = true;
  }

  // ================================================================== frame ==

  render(now: number): FrameStats {
    const frameMs = this.lastFrameAt > 0 ? now - this.lastFrameAt : 16;
    this.lastFrameAt = now;
    const dt = Math.min(frameMs / 1000, 0.1);

    this.updateWeather(dt);

    // The sky and backdrop follow the camera so they never appear to move,
    // which is what makes distant scenery read as distant.
    if (this.sky) this.sky.position.copy(this.camera.position);
    if (this.backdropRoot) {
      this.backdropRoot.position.set(this.camera.position.x, 0, this.camera.position.z);
      this.backdropRoot.updateMatrix();
    }
    // Keep the shadow box centred on the player, so shadow resolution is spent
    // where the player is looking rather than on the whole map.
    if (this.settings.shadows) {
      this.sun.target.position.set(this.camera.position.x, 0, this.camera.position.z);
      this.sun.target.updateMatrixWorld();
      this.sun.position.set(
        this.camera.position.x + this.sunOffset.x,
        this.sunOffset.y,
        this.camera.position.z + this.sunOffset.z,
      );
    }

    this.renderer.render(this.scene, this.camera);

    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.autoAdjust(frameMs);

    const info = this.renderer.info;
    return {
      fps: this.fps,
      frameMs,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
    };
  }

  private sunOffset = new THREE.Vector3(60, 120, 40);

  get fps(): number {
    if (this.frameTimes.length === 0) return 0;
    const average = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return average > 0 ? Math.round(1000 / average) : 0;
  }

  /**
   * Drop the preset once if the frame rate stays bad.
   *
   * Deliberately conservative: it needs a sustained problem (not one hitch),
   * it only fires once, and it tells the UI so the player knows their settings
   * changed rather than silently wondering why the game looks different.
   */
  private autoAdjust(frameMs: number): void {
    if (this.hasAutoDowngraded || this.settings.preset === 'low') return;
    this.autoAdjustCooldown -= frameMs;
    if (this.autoAdjustCooldown > 0) return;
    if (this.frameTimes.length < 90) return;

    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    // 90th-percentile frame time: ignores single spikes, catches real trouble.
    const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
    if (p90 < 33) {
      this.autoAdjustCooldown = 3000;
      return;
    }

    const from = this.settings.preset;
    const to = from === 'high' ? 'medium' : 'low';
    this.hasAutoDowngraded = true;
    log.warn('frame rate is poor — lowering the graphics preset', { p90: Math.round(p90), from, to });
    this.onQualityDowngrade?.(from, to);
  }

  add(object: THREE.Object3D): void {
    this.scene.add(object);
  }

  remove(object: THREE.Object3D): void {
    this.scene.remove(object);
  }

  dispose(): void {
    this.clearWorld();
    this.materials.dispose();
    this.renderer.dispose();
  }
}
