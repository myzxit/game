/**
 * Music.
 *
 * Also procedural, for the same reason as the sound effects: no audio files
 * ship with this build. Each track in the config is a chord progression, a
 * tempo and a voice character; this sequences them with a pad, a bass and a
 * sparse pulse.
 *
 * The design rule from the spec — don't overuse music — is enforced here:
 * combat music only plays during a live match, it ducks under gunfire, and it
 * stops entirely when the player is dead so the death is quiet.
 */

import { AudioBus, clamp, createLogger, getMusic, type MusicTrack } from '@titan/shared';

const log = createLogger('Music');

interface ScheduledNote {
  osc: OscillatorNode;
  gain: GainNode;
}

export class MusicEngine {
  private context: AudioContext | null = null;
  private busGain: GainNode | null = null;
  private trackGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;

  private current: MusicTrack | null = null;
  private nextBarAt = 0;
  private barIndex = 0;
  private timer: number | null = null;
  private readonly voices: ScheduledNote[] = [];
  /** 0-1 ducking amount, raised briefly by nearby gunfire. */
  private duck = 0;
  private volume = 0.5;

  attach(context: AudioContext, destination: GainNode): void {
    this.context = context;
    this.busGain = destination;

    this.trackGain = context.createGain();
    this.trackGain.gain.value = 0;

    this.filter = context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 4200;
    this.filter.Q.value = 0.4;

    this.trackGain.connect(this.filter);
    this.filter.connect(destination);
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
  }

  /** Start (or cross-fade to) a track. */
  play(key: string, fadeSeconds = 1.5): void {
    if (!this.context || !this.trackGain) return;
    const track = getMusic(key);
    if (!track) return;
    if (this.current?.key === key) return;

    log.debug('music', { key });
    this.current = track;
    this.barIndex = 0;
    this.nextBarAt = this.context.currentTime + 0.1;

    const now = this.context.currentTime;
    this.trackGain.gain.cancelScheduledValues(now);
    this.trackGain.gain.setValueAtTime(this.trackGain.gain.value, now);
    this.trackGain.gain.linearRampToValueAtTime(track.gain * this.volume, now + fadeSeconds);

    if (this.timer === null) {
      // Schedule ahead on a slow interval; Web Audio handles the precise
      // timing, so this only needs to stay ahead of the playhead.
      this.timer = window.setInterval(() => this.schedule(), 120);
    }
  }

  stop(fadeSeconds = 1.5): void {
    if (!this.context || !this.trackGain) return;
    const now = this.context.currentTime;
    this.trackGain.gain.cancelScheduledValues(now);
    this.trackGain.gain.setValueAtTime(this.trackGain.gain.value, now);
    this.trackGain.gain.linearRampToValueAtTime(0.0001, now + fadeSeconds);
    this.current = null;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Duck the music briefly. Called on gunfire so combat audio always wins the
   * mix — the player needs to hear the fight, not the soundtrack.
   */
  duckFor(amount = 0.6): void {
    this.duck = Math.max(this.duck, clamp(amount, 0, 1));
  }

  update(dt: number): void {
    if (!this.trackGain || !this.current || !this.filter) return;

    this.duck = Math.max(0, this.duck - dt * 1.4);
    const target = this.current.gain * this.volume * (1 - this.duck * 0.8);
    const now = this.context!.currentTime;
    this.trackGain.gain.setTargetAtTime(target, now, 0.08);
    // Ducking also darkens the music, which pushes it further back in the mix
    // than volume alone can.
    this.filter.frequency.setTargetAtTime(4200 - this.duck * 2600, now, 0.1);
  }

  private schedule(): void {
    const ctx = this.context;
    const track = this.current;
    if (!ctx || !track || !this.trackGain) return;

    const barSeconds = (60 / track.bpm) * 4;
    // Stay ~1 bar ahead of the playhead.
    while (this.nextBarAt < ctx.currentTime + barSeconds) {
      this.scheduleBar(track, this.nextBarAt, barSeconds);
      this.nextBarAt += barSeconds;
      this.barIndex++;
      if (!track.loop && this.barIndex >= track.progression.length) {
        this.stop(2);
        return;
      }
    }

    // Reap finished voices.
    if (this.voices.length > 64) this.voices.splice(0, this.voices.length - 64);
  }

  private scheduleBar(track: MusicTrack, when: number, barSeconds: number): void {
    const ctx = this.context!;
    const chord = track.progression[this.barIndex % track.progression.length]!;

    const semitone = (n: number): number => track.rootHz * Math.pow(2, n / 12);

    // Pad: sustained chord tones.
    for (const note of chord) {
      const osc = ctx.createOscillator();
      osc.type = track.voice === 'drive' ? 'sawtooth' : 'triangle';
      osc.frequency.value = semitone(note);

      const gain = ctx.createGain();
      const peak = track.voice === 'sparse' ? 0.06 : 0.1;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + barSeconds * 0.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + barSeconds * 0.98);

      osc.connect(gain);
      gain.connect(this.trackGain!);
      osc.start(when);
      osc.stop(when + barSeconds);
      this.voices.push({ osc, gain });
    }

    // Bass: root, an octave down.
    const bass = ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.value = semitone(chord[0]! - 12);
    const bassGain = ctx.createGain();
    bassGain.gain.setValueAtTime(0.0001, when);
    bassGain.gain.exponentialRampToValueAtTime(0.16, when + 0.04);
    bassGain.gain.exponentialRampToValueAtTime(0.0001, when + barSeconds * 0.9);
    bass.connect(bassGain);
    bassGain.connect(this.trackGain!);
    bass.start(when);
    bass.stop(when + barSeconds);
    this.voices.push({ osc: bass, gain: bassGain });

    // Pulse: an eighth-note figure, for the driving tracks only.
    if (track.voice === 'pulse' || track.voice === 'drive') {
      const steps = 8;
      const stepSeconds = barSeconds / steps;
      for (let i = 0; i < steps; i++) {
        if (i % 2 === 1 && track.voice === 'pulse') continue;
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = semitone(chord[i % chord.length]! + 12);

        const gain = ctx.createGain();
        const start = when + i * stepSeconds;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.035, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + stepSeconds * 0.8);

        osc.connect(gain);
        gain.connect(this.trackGain!);
        osc.start(start);
        osc.stop(start + stepSeconds);
        this.voices.push({ osc, gain });
      }
    }
  }

  dispose(): void {
    this.stop(0.1);
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  get currentTrack(): string | null {
    return this.current?.key ?? null;
  }
}

export { AudioBus };
