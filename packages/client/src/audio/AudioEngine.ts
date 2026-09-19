/**
 * Audio.
 *
 * **No recorded audio ships with this build.** Every sound is synthesised at
 * runtime from the recipes in `@titan/shared/config/audio.ts`: a noise or
 * oscillator source through a filter sweep and an ADSR envelope, often with a
 * second layered voice for body. That is genuinely how a gunshot's character is
 * built — a bright transient crack over a low thump — so the result is
 * recognisable rather than a beep, but it is unmistakably a stand-in for real
 * recordings. See docs/ASSETS.md for the sample specification.
 *
 * The engine is written so that dropping in real samples changes only
 * `playSample` vs `playSynth` inside `play()`; nothing that calls it changes.
 */

import {
  AMBIENCES,
  AudioBus,
  FOOTSTEP_KEYS,
  IMPACT_KEYS,
  SurfaceMaterial,
  clamp,
  createLogger,
  getAmbience,
  getSound,
  type SoundDefinition,
  type SynthRecipe,
  type Vec3,
} from '@titan/shared';
import type { AudioSettings } from '../core/Settings.js';

const log = createLogger('Audio');

interface BusNode {
  gain: GainNode;
  volume: number;
}

interface AmbienceVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  key: string;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buses = new Map<AudioBus, BusNode>();
  private compressor: DynamicsCompressorNode | null = null;

  /** Shared noise buffer — regenerating white noise per shot is wasteful. */
  private noiseBuffer: AudioBuffer | null = null;
  /** Cooldown tracking, so a 940 RPM weapon doesn't stack 16 voices. */
  private readonly lastPlayed = new Map<string, number>();
  /** Exclusive sounds (slide, channel) that must not overlap. */
  private readonly exclusiveVoices = new Map<string, AudioBufferSourceNode | OscillatorNode>();

  private readonly ambienceVoices: AmbienceVoice[] = [];
  private settings: AudioSettings;
  private started = false;
  /** Live voice count, so a chaotic fight can't exhaust the audio thread. */
  private activeVoices = 0;
  private readonly maxVoices = 48;

  constructor(settings: AudioSettings) {
    this.settings = settings;
  }

  /**
   * Browsers require a user gesture before audio can start. This is called
   * from the first click; until then the game is silent by design, not broken.
   */
  async start(): Promise<boolean> {
    if (this.started) return true;

    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new Ctor({ latencyHint: 'interactive' });
      if (this.context.state === 'suspended') await this.context.resume();
    } catch (error) {
      log.error('could not start audio', { error: String(error) });
      return false;
    }

    const ctx = this.context;

    // A gentle limiter on the master bus keeps a firefight from clipping,
    // which is the difference between "loud" and "distorted".
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -10;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.master;
    this.master.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    for (const bus of Object.values(AudioBus)) {
      const gain = ctx.createGain();
      gain.connect(this.master);
      this.buses.set(bus, { gain, volume: 1 });
    }
    this.applySettings(this.settings);

    this.noiseBuffer = this.createNoiseBuffer(2);
    this.started = true;
    log.info('audio started', { sampleRate: ctx.sampleRate });
    return true;
  }

  get isRunning(): boolean {
    return this.started && this.context?.state === 'running';
  }

  applySettings(settings: AudioSettings): void {
    this.settings = settings;
    if (!this.master) return;

    this.master.gain.value = settings.master;
    const levels: Record<AudioBus, number> = {
      [AudioBus.Master]: 1,
      [AudioBus.Music]: settings.music,
      [AudioBus.Sfx]: settings.sfx,
      [AudioBus.Voice]: settings.voice,
      [AudioBus.Ui]: settings.ui,
      [AudioBus.Ambience]: settings.ambience,
    };

    for (const [bus, node] of this.buses) {
      node.volume = levels[bus] ?? 1;
      node.gain.gain.value = node.volume;
    }
  }

  private createNoiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.context!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Build one synthesised voice from a recipe. Returns its output node. */
  private buildVoice(recipe: SynthRecipe, when: number, pitchScale: number): { output: AudioNode; duration: number } {
    const ctx = this.context!;
    const duration = recipe.attack + recipe.decay + recipe.release;

    let source: AudioBufferSourceNode | OscillatorNode;
    if (recipe.source === 'noise') {
      const node = ctx.createBufferSource();
      node.buffer = this.noiseBuffer;
      node.loop = true;
      node.playbackRate.value = pitchScale;
      source = node;
    } else {
      const node = ctx.createOscillator();
      node.type = recipe.source === 'saw' ? 'sawtooth' : recipe.source;
      node.frequency.setValueAtTime(recipe.freqStart * pitchScale, when);
      // Exponential ramps sound natural for pitch; linear does not.
      node.frequency.exponentialRampToValueAtTime(
        Math.max(20, recipe.freqEnd * pitchScale),
        when + Math.max(0.01, duration),
      );
      source = node;
    }

    const filter = ctx.createBiquadFilter();
    filter.type = recipe.source === 'noise' ? 'bandpass' : 'lowpass';
    filter.Q.value = recipe.filterQ;
    filter.frequency.setValueAtTime(clamp(recipe.filterStart * pitchScale, 40, 20000), when);
    filter.frequency.exponentialRampToValueAtTime(
      clamp(recipe.filterEnd * pitchScale, 40, 20000),
      when + Math.max(0.02, duration),
    );

    const envelope = ctx.createGain();
    const peak = Math.max(0.0001, recipe.gain);
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(peak, when + Math.max(0.001, recipe.attack));
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * recipe.sustain || 0.0001),
      when + recipe.attack + recipe.decay,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);

    source.connect(filter);

    // Soft-clipping distortion gives the transient its bite. Without it a
    // synthesised gunshot sounds like a puff of air.
    let output: AudioNode = filter;
    if (recipe.drive && recipe.drive > 0) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.distortionCurve(recipe.drive);
      shaper.oversample = '2x';
      filter.connect(shaper);
      output = shaper;
    }
    output.connect(envelope);

    source.start(when);
    source.stop(when + duration + 0.02);
    this.activeVoices++;
    source.addEventListener('ended', () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    });

    return { output: envelope, duration };
  }

  private distortionCurve(amount: number): Float32Array<ArrayBuffer> {
    const samples = 1024;
    const curve = new Float32Array(new ArrayBuffer(samples * 4));
    const k = amount * 60;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /**
   * Play a sound.
   *
   * `position` makes it 3D; omitting it plays 2D (UI, music, the local
   * player's own weapon, which should not pan as they turn).
   */
  play(key: string, position?: Vec3, volumeScale = 1, pitchScale = 1): void {
    if (!this.isRunning) return;

    const def = getSound(key);
    if (!def) return;

    const ctx = this.context!;
    const now = ctx.currentTime;

    // Cooldown: prevents a high-RPM weapon or a rapid hit sequence from
    // spawning dozens of overlapping voices.
    if (def.cooldownMs) {
      const last = this.lastPlayed.get(key) ?? 0;
      if (now * 1000 - last < def.cooldownMs) return;
      this.lastPlayed.set(key, now * 1000);
    }

    // Voice budget. Dropping a distant footstep is far better than glitching.
    if (this.activeVoices >= this.maxVoices) return;

    const bus = this.buses.get(def.bus);
    if (!bus) return;

    const variance = 1 + (Math.random() * 2 - 1) * def.pitchVariance;
    const pitch = pitchScale * variance;

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = def.volume * volumeScale;

    const main = this.buildVoice(def.synth, now, pitch);
    main.output.connect(voiceGain);

    if (def.synth.layer) {
      const layer = this.buildVoice(def.synth.layer as SynthRecipe, now, pitch);
      layer.output.connect(voiceGain);
    }

    if (position && def.maxDistance > 0 && this.settings.spatial) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = def.refDistance;
      panner.maxDistance = def.maxDistance;
      panner.rolloffFactor = 1.1;
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;

      // Distant sounds lose their high end — the cue that tells a player a
      // gunshot is far away rather than quiet.
      const distanceFilter = ctx.createBiquadFilter();
      distanceFilter.type = 'lowpass';
      distanceFilter.frequency.value = 20000;
      distanceFilter.Q.value = 0.7;

      voiceGain.connect(distanceFilter);
      distanceFilter.connect(panner);
      panner.connect(bus.gain);

      this.pendingDistanceFilters.push({ filter: distanceFilter, position, expiresAt: now + 2 });
    } else {
      voiceGain.connect(bus.gain);
    }

    if (def.exclusive) {
      const existing = this.exclusiveVoices.get(key);
      if (existing) {
        try {
          existing.stop();
        } catch {
          // Already stopped.
        }
      }
    }
  }

  private readonly pendingDistanceFilters: {
    filter: BiquadFilterNode;
    position: Vec3;
    expiresAt: number;
  }[] = [];

  /** Update the listener and apply distance filtering. */
  updateListener(position: Vec3, forward: Vec3, up: Vec3): void {
    if (!this.isRunning) return;
    const listener = this.context!.listener;

    // The modern AudioParam interface is not available everywhere; fall back to
    // the deprecated setters when it isn't.
    if (listener.positionX) {
      listener.positionX.value = position.x;
      listener.positionY.value = position.y;
      listener.positionZ.value = position.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
    } else {
      const legacy = listener as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(position.x, position.y, position.z);
      legacy.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }

    // Apply the air-absorption filter for sounds still playing.
    const now = this.context!.currentTime;
    for (let i = this.pendingDistanceFilters.length - 1; i >= 0; i--) {
      const entry = this.pendingDistanceFilters[i]!;
      if (now > entry.expiresAt) {
        this.pendingDistanceFilters.splice(i, 1);
        continue;
      }
      const distance = Math.hypot(
        entry.position.x - position.x,
        entry.position.y - position.y,
        entry.position.z - position.z,
      );
      entry.filter.frequency.value = clamp(20000 - distance * 180, 700, 20000);
    }
  }

  // ------------------------------------------------------------- helpers

  footstep(material: SurfaceMaterial, position: Vec3, running: boolean): void {
    const key = FOOTSTEP_KEYS[material] ?? FOOTSTEP_KEYS[SurfaceMaterial.Concrete];
    this.play(key, position, running ? 0.55 : 0.3, running ? 0.85 : 1.05);
  }

  impact(material: SurfaceMaterial, position: Vec3): void {
    const key = IMPACT_KEYS[material] ?? IMPACT_KEYS[SurfaceMaterial.Concrete];
    this.play(key, position, 0.9);
  }

  weaponFire(weaponId: string, position?: Vec3, isLocal = false): void {
    const key = `sfx.weapon.${weaponId}.fire`;
    // The local player's own weapon plays 2D at full volume: it should not pan
    // or attenuate as they turn, because it is attached to their own hands.
    if (isLocal) this.play(key, undefined, 1);
    else this.play(key, position, 1);
  }

  ui(key: string): void {
    this.play(key);
  }

  // ------------------------------------------------------------ ambience

  /**
   * Cross-fade to a new ambience set.
   * Each layer is a filtered noise bed with a slow LFO on its gain, which is
   * enough to read as "wind" or "machinery" without a recording.
   */
  setAmbience(keys: string[], fadeSeconds = 2): void {
    if (!this.isRunning) return;
    const ctx = this.context!;
    const now = ctx.currentTime;

    // Fade out layers that are no longer wanted.
    for (let i = this.ambienceVoices.length - 1; i >= 0; i--) {
      const voice = this.ambienceVoices[i]!;
      if (keys.includes(voice.key)) continue;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0.0001, now + fadeSeconds);
      const toStop = voice;
      setTimeout(() => {
        try {
          toStop.source.stop();
          toStop.lfo.stop();
        } catch {
          // Already stopped.
        }
      }, fadeSeconds * 1000 + 100);
      this.ambienceVoices.splice(i, 1);
    }

    const bus = this.buses.get(AudioBus.Ambience);
    if (!bus) return;

    for (const key of keys) {
      if (this.ambienceVoices.some((v) => v.key === key)) continue;
      const def = getAmbience(key);
      if (!def) continue;

      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = def.filterHz;
      filter.Q.value = def.filterQ;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(def.gain, now + fadeSeconds);

      // A slow LFO on gain stops the bed sounding like static.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = def.lfoHz;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = def.gain * def.lfoDepth;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(bus.gain);

      source.start(now);
      lfo.start(now);

      this.ambienceVoices.push({ source, gain, filter, lfo, lfoGain, key });
    }
  }

  stopAmbience(): void {
    this.setAmbience([], 1);
  }

  /** Suspend audio when the tab is hidden, to save battery. */
  async suspend(): Promise<void> {
    if (this.context?.state === 'running') await this.context.suspend();
  }

  async resume(): Promise<void> {
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  dispose(): void {
    this.stopAmbience();
    void this.context?.close();
    this.context = null;
    this.started = false;
  }

  stats(): { voices: number; ambience: number; running: boolean } {
    return {
      voices: this.activeVoices,
      ambience: this.ambienceVoices.length,
      running: this.isRunning,
    };
  }
}

export { AMBIENCES };
