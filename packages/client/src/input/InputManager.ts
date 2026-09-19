/**
 * Input.
 *
 * Produces the same `PlayerInput` shape regardless of source — keyboard+mouse,
 * gamepad, or touch — so the prediction and network layers never branch on
 * device. Look input is accumulated between frames rather than sampled, which
 * is what preserves the full precision of a high-polling-rate mouse.
 */

import {
  InputButton,
  clamp,
  type PlayerInput,
} from '@titan/shared';
import type { ControlSettings, Settings } from '../core/Settings.js';

export interface InputFrame {
  moveX: number;
  moveZ: number;
  /** Accumulated look delta since the last frame, in radians. */
  deltaYaw: number;
  deltaPitch: number;
  buttons: number;
  /** Weapon slot requested this frame, or null. */
  requestedSlot: number | null;
  /** UI actions that are not part of the simulation. */
  scoreboard: boolean;
  openChat: boolean;
  openMap: boolean;
}

const EMPTY_FRAME: InputFrame = {
  moveX: 0,
  moveZ: 0,
  deltaYaw: 0,
  deltaPitch: 0,
  buttons: 0,
  requestedSlot: null,
  scoreboard: false,
  openChat: false,
  openMap: false,
};

export class InputManager {
  private readonly held = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private accumulatedYaw = 0;
  private accumulatedPitch = 0;

  private controls: ControlSettings;
  private settings: Settings;

  /** Toggle states, when the player prefers toggles over holds. */
  private adsToggled = false;
  private crouchToggled = false;
  private sprintToggled = false;

  private requestedSlot: number | null = null;
  private pointerLocked = false;
  private enabled = false;

  /** Touch controls, built lazily on the first touch. */
  private touch: TouchControls | null = null;
  private readonly isTouchDevice: boolean;

  onPointerLockChange: ((locked: boolean) => void) | null = null;
  /** Fired when a key is pressed while rebinding. */
  onRebindCapture: ((code: string) => void) | null = null;
  private rebinding = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    settings: Settings,
  ) {
    this.settings = settings;
    this.controls = settings.controls;
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChanged);
    // Prevent the context menu so right-click can be "aim".
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.controls = settings.controls;
    this.touch?.applyLayout(settings.controls.touchLayout);
  }

  /** Enable gameplay input. Disabled while a menu is open. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.held.clear();
      this.mouseButtons.clear();
      this.accumulatedYaw = 0;
      this.accumulatedPitch = 0;
    }
  }

  requestPointerLock(): void {
    if (this.isTouchDevice) return;
    void this.canvas.requestPointerLock?.();
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get hasPointerLock(): boolean {
    return this.pointerLocked;
  }

  /** Begin capturing the next key press for a rebind. */
  beginRebind(): void {
    this.rebinding = true;
  }

  // ------------------------------------------------------------- listeners

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.rebinding) {
      event.preventDefault();
      this.rebinding = false;
      this.onRebindCapture?.(event.code);
      return;
    }

    // Never swallow keys while the player is typing.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    this.held.add(event.code);

    // Tab would move focus out of the canvas; the scoreboard needs it.
    if (event.code === this.controls.keybinds.scoreboard) event.preventDefault();
    if (event.code === 'Space') event.preventDefault();

    if (!this.enabled) return;

    const binds = this.controls.keybinds;
    if (event.code === binds.weapon1) this.requestedSlot = 0;
    else if (event.code === binds.weapon2) this.requestedSlot = 1;
    else if (event.code === binds.weapon3) this.requestedSlot = 2;

    if (this.controls.toggleCrouch && event.code === binds.crouch) {
      this.crouchToggled = !this.crouchToggled;
    }
    if (this.controls.toggleSprint && event.code === binds.sprint) {
      this.sprintToggled = !this.sprintToggled;
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.enabled) return;
    this.mouseButtons.add(event.button);
    if (this.controls.toggleAds && event.button === 2) this.adsToggled = !this.adsToggled;
  };

  private onMouseUp = (event: MouseEvent): void => {
    this.mouseButtons.delete(event.button);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || !this.pointerLocked) return;

    // Accumulate rather than overwrite: a 1000Hz mouse fires several times per
    // rendered frame, and sampling only the last event throws away most of the
    // player's movement.
    const sensitivity = this.controls.sensitivity;
    // ADS sensitivity is applied by the caller, which knows the ADS state.
    this.accumulatedYaw -= event.movementX * sensitivity;
    this.accumulatedPitch += event.movementY * sensitivity * (this.controls.invertY ? 1 : -1);
  };

  private onPointerLockChanged = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    this.onPointerLockChange?.(this.pointerLocked);
    if (!this.pointerLocked) {
      this.held.clear();
      this.mouseButtons.clear();
    }
  };

  private onBlur = (): void => {
    // Losing focus with keys held would leave the player running into a wall.
    this.held.clear();
    this.mouseButtons.clear();
  };

  // ---------------------------------------------------------------- touch

  enableTouchControls(container: HTMLElement): void {
    if (this.touch || !this.isTouchDevice) return;
    this.touch = new TouchControls(container, this.controls.touchLayout);
  }

  get touchActive(): boolean {
    return this.touch !== null;
  }

  // -------------------------------------------------------------- gamepad

  private readGamepad(frame: InputFrame, dt: number): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((p) => p !== null);
    if (!pad) return;

    const deadzone = 0.18;
    const apply = (value: number): number => {
      if (Math.abs(value) < deadzone) return 0;
      // Rescale past the deadzone so the stick still reaches full travel.
      const sign = Math.sign(value);
      return sign * ((Math.abs(value) - deadzone) / (1 - deadzone));
    };

    frame.moveX += apply(pad.axes[0] ?? 0);
    frame.moveZ += -apply(pad.axes[1] ?? 0);

    // Look: squared response gives fine control near centre and speed at full
    // deflection, which is what makes a stick usable for aiming at all.
    const lookX = apply(pad.axes[2] ?? 0);
    const lookY = apply(pad.axes[3] ?? 0);
    const speed = this.controls.gamepadSensitivity * dt;
    frame.deltaYaw -= Math.sign(lookX) * lookX * lookX * speed;
    frame.deltaPitch -= Math.sign(lookY) * lookY * lookY * speed * (this.controls.invertY ? -1 : 1);

    const pressed = (index: number): boolean => pad.buttons[index]?.pressed === true;
    if (pressed(7) || (pad.buttons[7]?.value ?? 0) > 0.4) frame.buttons |= InputButton.Fire;
    if (pressed(6) || (pad.buttons[6]?.value ?? 0) > 0.4) frame.buttons |= InputButton.Aim;
    if (pressed(0)) frame.buttons |= InputButton.Jump;
    if (pressed(1)) frame.buttons |= InputButton.Crouch;
    if (pressed(2)) frame.buttons |= InputButton.Reload;
    if (pressed(3)) frame.buttons |= InputButton.Interact;
    if (pressed(10)) frame.buttons |= InputButton.Sprint;
    if (pressed(5)) frame.buttons |= InputButton.Skill;
    if (pressed(4)) frame.requestedSlot = frame.requestedSlot ?? 1;
  }

  // ----------------------------------------------------------------- frame

  /** Read the current frame's input and clear accumulated deltas. */
  poll(dt: number, adsActive: boolean): InputFrame {
    if (!this.enabled) return { ...EMPTY_FRAME };

    const binds = this.controls.keybinds;
    const frame: InputFrame = {
      moveX: 0,
      moveZ: 0,
      deltaYaw: this.accumulatedYaw,
      deltaPitch: this.accumulatedPitch,
      buttons: 0,
      requestedSlot: this.requestedSlot,
      scoreboard: this.held.has(binds.scoreboard),
      openChat: this.held.has(binds.chat),
      openMap: this.held.has(binds.map),
    };

    this.accumulatedYaw = 0;
    this.accumulatedPitch = 0;
    this.requestedSlot = null;

    // Keyboard movement.
    if (this.held.has(binds.moveForward)) frame.moveZ += 1;
    if (this.held.has(binds.moveBack)) frame.moveZ -= 1;
    if (this.held.has(binds.moveRight)) frame.moveX += 1;
    if (this.held.has(binds.moveLeft)) frame.moveX -= 1;

    // Buttons.
    if (this.held.has(binds.jump)) frame.buttons |= InputButton.Jump;
    if (this.held.has(binds.reload)) frame.buttons |= InputButton.Reload;
    if (this.held.has(binds.dash)) frame.buttons |= InputButton.Dash;
    if (this.held.has(binds.skill)) frame.buttons |= InputButton.Skill;
    if (this.held.has(binds.melee)) frame.buttons |= InputButton.Melee;
    if (this.held.has(binds.interact)) frame.buttons |= InputButton.Interact;
    if (this.held.has(binds.inspect)) frame.buttons |= InputButton.Inspect;

    const crouching = this.controls.toggleCrouch ? this.crouchToggled : this.held.has(binds.crouch);
    if (crouching) frame.buttons |= InputButton.Crouch;

    const sprinting = this.controls.toggleSprint ? this.sprintToggled : this.held.has(binds.sprint);
    if (sprinting) frame.buttons |= InputButton.Sprint;

    // Mouse.
    if (this.mouseButtons.has(0)) frame.buttons |= InputButton.Fire;
    const aiming = this.controls.toggleAds ? this.adsToggled : this.mouseButtons.has(2);
    if (aiming) frame.buttons |= InputButton.Aim;

    // Touch and gamepad layer on top, so a player can mix them freely.
    this.touch?.apply(frame);
    this.readGamepad(frame, dt);

    // Aiming slows look speed, which is how players get precision at range.
    if (adsActive) {
      frame.deltaYaw *= this.controls.adsSensitivityMultiplier;
      frame.deltaPitch *= this.controls.adsSensitivityMultiplier;
    }

    // Normalize diagonal movement so it isn't faster than straight movement.
    const length = Math.hypot(frame.moveX, frame.moveZ);
    if (length > 1) {
      frame.moveX /= length;
      frame.moveZ /= length;
    }

    return frame;
  }

  /** Build the wire-format input from a frame plus the resolved view angles. */
  buildInput(
    frame: InputFrame,
    sequence: number,
    deltaMs: number,
    yaw: number,
    pitch: number,
  ): PlayerInput {
    return {
      sequence,
      deltaMs: clamp(deltaMs, 1, 60),
      moveX: frame.moveX,
      moveZ: frame.moveZ,
      yaw,
      pitch,
      buttons: frame.buttons,
      clientTimeMs: performance.now(),
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChanged);
    this.touch?.dispose();
  }
}

// ==========================================================================
// Touch
// ==========================================================================

/**
 * On-screen controls for touch devices.
 *
 * A virtual stick on one side for movement, a look area on the other, and a
 * column of action buttons. Layout mirrors for left-handed players.
 */
class TouchControls {
  private readonly root: HTMLDivElement;
  private moveVector = { x: 0, y: 0 };
  private lookDelta = { x: 0, y: 0 };
  private buttons = 0;
  private stickTouchId: number | null = null;
  private lookTouchId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };

  constructor(container: HTMLElement, layout: 'default' | 'left-handed') {
    this.root = document.createElement('div');
    this.root.className = 'touch-controls';
    this.root.dataset.layout = layout;
    this.root.innerHTML = `
      <div class="touch-stick" data-role="stick"><div class="touch-stick-knob"></div></div>
      <div class="touch-look" data-role="look"></div>
      <div class="touch-actions">
        <button class="touch-btn touch-fire" data-action="fire" aria-label="Fire"></button>
        <button class="touch-btn touch-aim" data-action="aim" aria-label="Aim"></button>
        <button class="touch-btn" data-action="jump">↑</button>
        <button class="touch-btn" data-action="crouch">↓</button>
        <button class="touch-btn" data-action="reload">R</button>
        <button class="touch-btn" data-action="skill">E</button>
        <button class="touch-btn" data-action="swap">⇄</button>
      </div>
    `;
    container.appendChild(this.root);
    this.bind();
  }

  applyLayout(layout: 'default' | 'left-handed'): void {
    this.root.dataset.layout = layout;
  }

  private bind(): void {
    const stick = this.root.querySelector<HTMLElement>('[data-role="stick"]')!;
    const knob = this.root.querySelector<HTMLElement>('.touch-stick-knob')!;
    const look = this.root.querySelector<HTMLElement>('[data-role="look"]')!;

    const RADIUS = 56;

    stick.addEventListener('touchstart', (e) => {
      const touch = e.changedTouches[0]!;
      this.stickTouchId = touch.identifier;
      const rect = stick.getBoundingClientRect();
      this.stickOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      e.preventDefault();
    }, { passive: false });

    const moveHandler = (e: TouchEvent): void => {
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier === this.stickTouchId) {
          const dx = touch.clientX - this.stickOrigin.x;
          const dy = touch.clientY - this.stickOrigin.y;
          const distance = Math.min(RADIUS, Math.hypot(dx, dy));
          const angle = Math.atan2(dy, dx);
          const nx = (Math.cos(angle) * distance) / RADIUS;
          const ny = (Math.sin(angle) * distance) / RADIUS;
          this.moveVector = { x: nx, y: -ny };
          knob.style.transform = `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px)`;
        } else if (touch.identifier === this.lookTouchId) {
          const previous = this.lastLook;
          if (previous) {
            this.lookDelta.x += touch.clientX - previous.x;
            this.lookDelta.y += touch.clientY - previous.y;
          }
          this.lastLook = { x: touch.clientX, y: touch.clientY };
        }
      }
      e.preventDefault();
    };

    window.addEventListener('touchmove', moveHandler, { passive: false });

    const endHandler = (e: TouchEvent): void => {
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier === this.stickTouchId) {
          this.stickTouchId = null;
          this.moveVector = { x: 0, y: 0 };
          knob.style.transform = '';
        }
        if (touch.identifier === this.lookTouchId) {
          this.lookTouchId = null;
          this.lastLook = null;
        }
      }
    };
    window.addEventListener('touchend', endHandler);
    window.addEventListener('touchcancel', endHandler);

    look.addEventListener('touchstart', (e) => {
      const touch = e.changedTouches[0]!;
      this.lookTouchId = touch.identifier;
      this.lastLook = { x: touch.clientX, y: touch.clientY };
      e.preventDefault();
    }, { passive: false });

    const ACTION_BITS: Record<string, number> = {
      fire: InputButton.Fire,
      aim: InputButton.Aim,
      jump: InputButton.Jump,
      crouch: InputButton.Crouch,
      reload: InputButton.Reload,
      skill: InputButton.Skill,
    };

    for (const button of Array.from(this.root.querySelectorAll<HTMLElement>('[data-action]'))) {
      const action = button.dataset.action!;
      const bit = ACTION_BITS[action];
      const press = (e: Event): void => {
        e.preventDefault();
        if (bit !== undefined) this.buttons |= bit;
        else if (action === 'swap') this.swapRequested = true;
        button.classList.add('active');
      };
      const release = (): void => {
        if (bit !== undefined) this.buttons &= ~bit;
        button.classList.remove('active');
      };
      button.addEventListener('touchstart', press, { passive: false });
      button.addEventListener('touchend', release);
      button.addEventListener('touchcancel', release);
    }
  }

  private lastLook: { x: number; y: number } | null = null;
  private swapRequested = false;

  apply(frame: InputFrame): void {
    frame.moveX += this.moveVector.x;
    frame.moveZ += this.moveVector.y;
    frame.buttons |= this.buttons;

    // Touch look is in pixels; convert with a sensitivity that feels right for
    // a thumb rather than a mouse.
    frame.deltaYaw -= this.lookDelta.x * 0.0035;
    frame.deltaPitch -= this.lookDelta.y * 0.0035;
    this.lookDelta = { x: 0, y: 0 };

    if (this.swapRequested) {
      frame.requestedSlot = frame.requestedSlot === 0 ? 1 : 0;
      this.swapRequested = false;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
