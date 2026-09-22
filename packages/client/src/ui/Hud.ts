/**
 * In-match HUD.
 *
 * Split from the menu UI because it runs at frame rate: the vitals, ammo and
 * crosshair update every frame, so they hold direct element references and
 * write only the properties that changed rather than re-rendering markup.
 *
 * Every element here is information the player needs to fight. The accessibility
 * settings can change how it is *presented* (size, colour, shake) but never
 * whether it is shown.
 */

import {
  MAX_HEALTH,
  TeamId,
  clamp,
  formatDuration,
  t,
  type HitZone,
  type MatchResultPlayer,
  type ServerKillFeed,
  type Vec3,
} from '@titan/shared';
import type { AccessibilitySettings, GameplaySettings } from '../core/Settings.js';
import { pingQuality } from '../net/NetClient.js';

export interface HudVitals {
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  stamina: number;
  ammoInMag: number;
  reserveAmmo: number;
  weaponNameKey: string;
  reloading: boolean;
  reloadProgress: number;
  skillCooldownMs: number;
  skillCooldownTotalMs: number;
  skillEnergy: number;
  skillReady: boolean;
  spreadRadius: number;
  alive: boolean;
  respawnInMs: number;
  spawnProtected: boolean;
}

export interface HudMatchState {
  phase: string;
  timeRemainingMs: number;
  alphaScore: number;
  bravoScore: number;
  round: number;
  roundsWonAlpha: number;
  roundsWonBravo: number;
  objectives: { id: string; owner: TeamId; progress: number; contested: boolean }[];
  teamBased: boolean;
}

interface ScoreboardRow {
  playerId: string;
  displayName: string;
  team: TeamId;
  kills: number;
  deaths: number;
  score: number;
  ping: number;
  alive: boolean;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly elements: Record<string, HTMLElement> = {};
  private gameplay: GameplaySettings;
  private accessibility: AccessibilitySettings;

  private readonly killfeedRows: { element: HTMLElement; expiresAt: number }[] = [];
  private readonly floatingTexts: { element: HTMLElement; expiresAt: number }[] = [];
  private damageIndicators: { element: HTMLElement; expiresAt: number; angle: number }[] = [];
  private announcementTimer = 0;
  private vignetteUntil = 0;

  constructor(container: HTMLElement, gameplay: GameplaySettings, accessibility: AccessibilitySettings) {
    this.gameplay = gameplay;
    this.accessibility = accessibility;

    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="minimap" data-el="minimap"><canvas data-el="minimapCanvas" width="240" height="240"></canvas></div>

      <div class="match-status">
        <div class="match-scores">
          <span class="alpha" data-el="alphaScore">0</span>
          <span class="match-timer" data-el="timer">0:00</span>
          <span class="bravo" data-el="bravoScore">0</span>
        </div>
        <div class="match-phase" data-el="phase"></div>
      </div>

      <div class="objectives" data-el="objectives"></div>

      <div class="crosshair" data-el="crosshair">
        <span class="dot" data-el="chDot"></span>
        <span data-el="chTop"></span>
        <span data-el="chBottom"></span>
        <span data-el="chLeft"></span>
        <span data-el="chRight"></span>
      </div>
      <div class="hitmarker" data-el="hitmarker">
        <span style="left:0;top:9px;width:22px;height:3px"></span>
        <span style="left:9px;top:0;width:3px;height:22px"></span>
      </div>

      <div class="damage-direction" data-el="damageDirection"></div>
      <div class="damage-vignette" data-el="vignette"></div>

      <div class="hud-bottom-left">
        <div class="vital">
          <span class="vital-value" data-el="healthValue">100</span>
          <div class="vital-bar health"><div data-el="healthBar" style="width:100%"></div></div>
        </div>
        <div class="vital">
          <span class="vital-value" data-el="shieldValue">0</span>
          <div class="vital-bar shield"><div data-el="shieldBar" style="width:0%"></div></div>
        </div>
        <div class="vital">
          <div class="vital-bar stamina"><div data-el="staminaBar" style="width:100%"></div></div>
        </div>
      </div>

      <div class="hud-bottom-right">
        <div class="ammo" data-el="ammo">
          <span class="mag" data-el="ammoMag">30</span><span class="reserve" data-el="ammoReserve"> / 150</span>
        </div>
        <div class="weapon-name" data-el="weaponName"></div>
      </div>

      <div class="skill-slot" data-el="skillSlot">
        <span data-el="skillKey">E</span>
        <div class="cooldown" data-el="skillCooldown" style="transform:scaleY(0)"></div>
      </div>

      <div class="killfeed" data-el="killfeed"></div>
      <div class="announcement" data-el="announcement"></div>
      <div class="interact-prompt" data-el="interact" style="display:none"></div>
      <div class="subtitles" data-el="subtitles" style="display:none"></div>

      <div class="hud-net" data-el="net"></div>

      <div class="respawn-overlay" data-el="respawn" style="display:none">
        <div>
          <div class="count" data-el="respawnCount">4</div>
          <div data-el="respawnLabel"></div>
        </div>
      </div>

      <div class="scoreboard" data-el="scoreboard" style="display:none"></div>
    `;
    container.appendChild(this.root);

    for (const element of Array.from(this.root.querySelectorAll<HTMLElement>('[data-el]'))) {
      this.elements[element.dataset.el!] = element;
    }

    this.applySettings(gameplay, accessibility);
  }

  applySettings(gameplay: GameplaySettings, accessibility: AccessibilitySettings): void {
    this.gameplay = gameplay;
    this.accessibility = accessibility;

    const root = document.documentElement;
    root.style.setProperty('--text-scale', String(accessibility.textScale));
    root.style.setProperty('--subtitle-scale', String(accessibility.subtitleScale));
    root.style.setProperty('--crosshair-color', gameplay.crosshairColor);
    root.dataset.contrast = accessibility.highContrast ? 'high' : 'normal';
    root.dataset.colorblind = accessibility.colorblind;

    this.elements.killfeed!.style.display = gameplay.killfeed ? '' : 'none';
    this.elements.subtitles!.style.display = accessibility.subtitles ? '' : 'none';
    this.elements.chDot!.style.display = gameplay.crosshairDot ? '' : 'none';
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('active', visible);
  }

  // ============================================================== per frame

  updateVitals(v: HudVitals): void {
    const e = this.elements;

    const healthPct = clamp((v.health / Math.max(1, v.maxHealth)) * 100, 0, 100);
    const shieldPct = clamp((v.shield / Math.max(1, v.maxShield)) * 100, 0, 100);

    e.healthValue!.textContent = String(Math.ceil(v.health));
    e.healthBar!.style.width = `${healthPct}%`;
    e.shieldValue!.textContent = String(Math.ceil(v.shield));
    e.shieldBar!.style.width = `${shieldPct}%`;
    e.staminaBar!.style.width = `${clamp(v.stamina, 0, 100)}%`;

    e.ammoMag!.textContent = String(v.ammoInMag);
    e.ammoReserve!.textContent = ` / ${v.reserveAmmo}`;
    e.ammo!.classList.toggle('empty', v.ammoInMag === 0);
    e.weaponName!.textContent = v.reloading ? t('hud.reloading') : t(v.weaponNameKey);

    // Skill cooldown, drawn as a vertical wipe.
    const cooldownRatio =
      v.skillCooldownTotalMs > 0 ? clamp(v.skillCooldownMs / v.skillCooldownTotalMs, 0, 1) : 0;
    e.skillCooldown!.style.transform = `scaleY(${cooldownRatio})`;
    e.skillSlot!.classList.toggle('ready', v.skillReady);

    // The crosshair opens with the weapon's actual spread, so it is telling the
    // player the truth about their accuracy rather than decorating the screen.
    this.updateCrosshair(v.spreadRadius);

    // Respawn overlay.
    if (!v.alive && v.respawnInMs > 0) {
      e.respawn!.style.display = '';
      e.respawnCount!.textContent = String(Math.ceil(v.respawnInMs / 1000));
      e.respawnLabel!.textContent = t('match.respawning', {
        count: Math.ceil(v.respawnInMs / 1000),
      });
    } else {
      e.respawn!.style.display = 'none';
    }
  }

  private updateCrosshair(spreadPixels: number): void {
    const e = this.elements;
    const size = this.gameplay.crosshairSize;
    const gap = this.gameplay.crosshairGap + spreadPixels;
    const thickness = 2;

    const apply = (element: HTMLElement, style: Partial<CSSStyleDeclaration>): void => {
      Object.assign(element.style, style);
    };

    apply(e.chTop!, {
      width: `${thickness}px`,
      height: `${size}px`,
      left: `${-thickness / 2}px`,
      top: `${-gap - size}px`,
    });
    apply(e.chBottom!, {
      width: `${thickness}px`,
      height: `${size}px`,
      left: `${-thickness / 2}px`,
      top: `${gap}px`,
    });
    apply(e.chLeft!, {
      width: `${size}px`,
      height: `${thickness}px`,
      left: `${-gap - size}px`,
      top: `${-thickness / 2}px`,
    });
    apply(e.chRight!, {
      width: `${size}px`,
      height: `${thickness}px`,
      left: `${gap}px`,
      top: `${-thickness / 2}px`,
    });
  }

  updateMatch(state: HudMatchState): void {
    const e = this.elements;

    if (state.teamBased) {
      e.alphaScore!.textContent = String(state.roundsWonAlpha || state.alphaScore);
      e.bravoScore!.textContent = String(state.roundsWonBravo || state.bravoScore);
    } else {
      e.alphaScore!.textContent = String(state.alphaScore);
      e.bravoScore!.textContent = '';
    }

    e.timer!.textContent = formatDuration(state.timeRemainingMs / 1000);

    const phaseKey =
      state.phase === 'warmup'
        ? 'match.warmup'
        : state.phase === 'countdown'
          ? 'match.starting_in'
          : state.phase === 'round_end'
            ? 'match.round_end'
            : '';
    e.phase!.textContent = phaseKey
      ? t(phaseKey, { count: Math.ceil(state.timeRemainingMs / 1000) })
      : '';

    // Objectives.
    const objectives = e.objectives!;
    if (state.objectives.length === 0) {
      objectives.style.display = 'none';
    } else {
      objectives.style.display = '';
      if (objectives.childElementCount !== state.objectives.length) {
        objectives.innerHTML = state.objectives
          .map((o) => `<div class="objective-pip" data-id="${o.id}">${o.id.slice(0, 4)}</div>`)
          .join('');
      }
      state.objectives.forEach((o, index) => {
        const pip = objectives.children[index] as HTMLElement | undefined;
        if (!pip) return;
        pip.classList.toggle('alpha', o.owner === TeamId.Alpha);
        pip.classList.toggle('bravo', o.owner === TeamId.Bravo);
        pip.classList.toggle('contested', o.contested);
      });
    }
  }

  updateNetwork(pingMs: number, fps: number): void {
    const parts: string[] = [];
    if (this.gameplay.showPing) {
      const quality = pingQuality(pingMs);
      parts.push(`<span class="${quality}">${t('network.ping', { ms: Math.round(pingMs) })}</span>`);
    }
    if (this.gameplay.showFps) parts.push(`${fps} FPS`);
    this.elements.net!.innerHTML = parts.join('<br>');
  }

  /** Advance timed HUD elements. */
  update(dt: number, now: number): void {
    for (let i = this.killfeedRows.length - 1; i >= 0; i--) {
      const row = this.killfeedRows[i]!;
      if (now >= row.expiresAt) {
        row.element.remove();
        this.killfeedRows.splice(i, 1);
      }
    }
    for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
      const text = this.floatingTexts[i]!;
      if (now >= text.expiresAt) {
        text.element.remove();
        this.floatingTexts.splice(i, 1);
      }
    }
    for (let i = this.damageIndicators.length - 1; i >= 0; i--) {
      const indicator = this.damageIndicators[i]!;
      if (now >= indicator.expiresAt) {
        indicator.element.remove();
        this.damageIndicators.splice(i, 1);
      }
    }

    if (this.announcementTimer > 0) {
      this.announcementTimer -= dt;
      if (this.announcementTimer <= 0) this.elements.announcement!.innerHTML = '';
    }

    if (now > this.vignetteUntil) {
      this.elements.vignette!.style.boxShadow = 'inset 0 0 14rem rgba(200, 30, 60, 0)';
    }
  }

  // ================================================================ events

  /** Hitmarker. Suppressed only if the player turned them off. */
  showHitmarker(zone: HitZone, lethal: boolean): void {
    if (!this.gameplay.hitmarkers) return;
    const marker = this.elements.hitmarker!;
    marker.classList.remove('show');
    marker.classList.toggle('headshot', zone === 'head' || lethal);
    // Force a reflow so the animation restarts on a rapid second hit.
    void marker.offsetWidth;
    marker.classList.add('show');
  }

  /** Floating damage number at a screen position. */
  showDamageNumber(screenX: number, screenY: number, amount: number, headshot: boolean): void {
    if (!this.gameplay.damageNumbers) return;

    const element = document.createElement('div');
    element.className = `floating-text${headshot ? ' headshot' : ''}`;
    element.textContent = String(Math.round(amount));
    element.style.left = `${screenX}px`;
    element.style.top = `${screenY}px`;
    this.root.appendChild(element);

    this.floatingTexts.push({ element, expiresAt: performance.now() + 900 });
    // Bound the list so a shotgun blast doesn't leave dozens of nodes behind.
    if (this.floatingTexts.length > 24) {
      const oldest = this.floatingTexts.shift();
      oldest?.element.remove();
    }
  }

  addKillfeed(entry: ServerKillFeed): void {
    if (!this.gameplay.killfeed) return;

    const teamClass = (team: TeamId): string =>
      team === TeamId.Alpha ? 'alpha' : team === TeamId.Bravo ? 'bravo' : '';

    const element = document.createElement('div');
    element.className = 'killfeed-row';
    const killer = entry.killerName
      ? `<span class="${teamClass(entry.killerTeam)}">${escapeHtml(entry.killerName)}</span>`
      : `<span>${t('killfeed.environment')}</span>`;
    const victim = `<span class="${teamClass(entry.victimTeam)}">${escapeHtml(entry.victimName)}</span>`;
    const headshot = entry.headshot ? `<span class="headshot">▲</span>` : '';

    element.innerHTML = `${killer}<span class="verb">${t('killfeed.killed')}</span>${victim}${headshot}`;
    this.elements.killfeed!.appendChild(element);

    this.killfeedRows.push({ element, expiresAt: performance.now() + 6000 });
    // Cap the visible feed; older entries drop off the top.
    while (this.killfeedRows.length > 6) {
      const oldest = this.killfeedRows.shift();
      oldest?.element.remove();
    }
  }

  /** Directional damage indicator plus a red vignette. */
  showDamage(fromDirection: Vec3, cameraYaw: number, amount: number): void {
    // Angle of the attacker relative to where the player is facing.
    const worldAngle = Math.atan2(fromDirection.x, fromDirection.z);
    const relative = worldAngle - cameraYaw;

    const element = document.createElement('div');
    element.className = 'damage-arc';
    element.style.transform = `rotate(${relative}rad)`;
    this.elements.damageDirection!.appendChild(element);
    // Fade in on the next frame so the transition actually runs.
    requestAnimationFrame(() => {
      element.style.opacity = '0.9';
      requestAnimationFrame(() => {
        element.style.opacity = '0';
      });
    });

    this.damageIndicators.push({ element, expiresAt: performance.now() + 1200, angle: relative });
    if (this.damageIndicators.length > 6) {
      const oldest = this.damageIndicators.shift();
      oldest?.element.remove();
    }

    // Vignette intensity scales with the hit, capped so a big hit doesn't
    // blind the player at the moment they most need to see.
    const intensity = clamp(amount / MAX_HEALTH, 0.15, 0.6);
    this.elements.vignette!.style.boxShadow = `inset 0 0 14rem rgba(200, 30, 60, ${intensity})`;
    this.vignetteUntil = performance.now() + 400;
  }

  announce(text: string, durationSec = 2): void {
    this.elements.announcement!.innerHTML = `<div class="big">${escapeHtml(text)}</div>`;
    this.announcementTimer = durationSec;
  }

  showInteractPrompt(text: string | null): void {
    const element = this.elements.interact!;
    if (text === null) {
      element.style.display = 'none';
      return;
    }
    element.style.display = '';
    element.textContent = text;
  }

  showSubtitle(text: string | null): void {
    if (!this.accessibility.subtitles) return;
    const element = this.elements.subtitles!;
    if (text === null) {
      element.style.display = 'none';
      return;
    }
    element.style.display = '';
    element.textContent = text;
  }

  // ============================================================ scoreboard

  setScoreboardVisible(visible: boolean, rows: ScoreboardRow[], selfId: string, teamBased: boolean): void {
    const board = this.elements.scoreboard!;
    if (!visible) {
      board.style.display = 'none';
      return;
    }

    board.style.display = '';
    const sorted = [...rows].sort((a, b) => b.score - a.score || b.kills - a.kills);

    const renderRows = (list: ScoreboardRow[]): string =>
      list
        .map(
          (row) => `
        <tr class="${row.playerId === selfId ? 'self' : ''}${row.alive ? '' : ' dead'}">
          <td>${escapeHtml(row.displayName)}</td>
          <td>${row.score}</td>
          <td>${row.kills}</td>
          <td>${row.deaths}</td>
          <td>${row.kills > 0 && row.deaths > 0 ? (row.kills / row.deaths).toFixed(2) : row.kills.toFixed(2)}</td>
          <td>${row.ping}</td>
        </tr>`,
        )
        .join('');

    const header = `
      <tr>
        <th>${t('login.name_label')}</th>
        <th>${t('result.score')}</th>
        <th>${t('result.kills')}</th>
        <th>${t('result.deaths')}</th>
        <th>${t('result.kd')}</th>
        <th>${t('network.ping', { ms: '' })}</th>
      </tr>`;

    if (teamBased) {
      const alpha = sorted.filter((r) => r.team === TeamId.Alpha);
      const bravo = sorted.filter((r) => r.team === TeamId.Bravo);
      board.innerHTML = `
        <h3 style="color:var(--alpha)">${t('match.team_alpha')}</h3>
        <table><thead>${header}</thead><tbody>${renderRows(alpha)}</tbody></table>
        <h3 style="color:var(--bravo);margin-top:1.25rem">${t('match.team_bravo')}</h3>
        <table><thead>${header}</thead><tbody>${renderRows(bravo)}</tbody></table>`;
    } else {
      board.innerHTML = `<table><thead>${header}</thead><tbody>${renderRows(sorted)}</tbody></table>`;
    }
  }

  /** Minimap canvas, drawn by the MinimapRenderer. */
  get minimapCanvas(): HTMLCanvasElement {
    return this.elements.minimapCanvas as HTMLCanvasElement;
  }

  setMinimapVisible(visible: boolean): void {
    this.elements.minimap!.style.display = visible ? '' : 'none';
  }

  dispose(): void {
    this.root.remove();
  }
}

/** Player names come from other players; they are never inserted as raw HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type { MatchResultPlayer };
