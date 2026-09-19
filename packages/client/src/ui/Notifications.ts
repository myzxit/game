/**
 * Toast notifications and modal overlays (crate reveal, level up, rank up).
 *
 * Notifications are queued rather than stacked without limit: during a busy
 * match-end a player can earn a dozen things at once, and showing all of them
 * simultaneously means they read none of them.
 */

import { RARITY_COLOR, Rarity, formatNumber, getItem, t } from '@titan/shared';
import { escapeHtml } from './Hud.js';

export type NotificationLevel = 'info' | 'success' | 'warning';

interface QueuedNotification {
  level: NotificationLevel;
  text: string;
  durationMs: number;
}

export class Notifications {
  private readonly container: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly queue: QueuedNotification[] = [];
  private readonly visible: { element: HTMLElement; expiresAt: number }[] = [];
  private readonly maxVisible = 4;

  /** Resolved when the player dismisses the current overlay. */
  private overlayResolve: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'notifications';
    parent.appendChild(this.container);

    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    parent.appendChild(this.overlay);

    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.closeOverlay();
    });
  }

  push(level: NotificationLevel, text: string, durationMs = 4000): void {
    this.queue.push({ level, text, durationMs });
    this.drain();
  }

  /** Convenience for server-sent, already-localized notifications. */
  pushKey(
    level: NotificationLevel,
    messageKey: string,
    params?: Record<string, string | number>,
    durationMs = 4000,
  ): void {
    this.push(level, t(messageKey, params), durationMs);
  }

  private drain(): void {
    while (this.visible.length < this.maxVisible && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const element = document.createElement('div');
      element.className = `notification ${next.level}`;
      element.textContent = next.text;
      this.container.appendChild(element);
      this.visible.push({ element, expiresAt: performance.now() + next.durationMs });
    }
  }

  update(now: number): void {
    for (let i = this.visible.length - 1; i >= 0; i--) {
      const entry = this.visible[i]!;
      if (now >= entry.expiresAt) {
        entry.element.remove();
        this.visible.splice(i, 1);
      }
    }
    if (this.visible.length < this.maxVisible && this.queue.length > 0) this.drain();
  }

  // ================================================================ overlays

  private openOverlay(html: string): Promise<void> {
    this.overlay.innerHTML = `<div class="overlay-panel">${html}</div>`;
    this.overlay.classList.add('active');

    for (const button of Array.from(this.overlay.querySelectorAll('[data-close]'))) {
      button.addEventListener('click', () => this.closeOverlay());
    }

    return new Promise((resolve) => {
      this.overlayResolve = resolve;
    });
  }

  closeOverlay(): void {
    this.overlay.classList.remove('active');
    this.overlay.innerHTML = '';
    this.overlayResolve?.();
    this.overlayResolve = null;
  }

  get isOverlayOpen(): boolean {
    return this.overlay.classList.contains('active');
  }

  /**
   * Crate reveal.
   *
   * The rates the roll actually used are shown alongside the result — the same
   * numbers the server rolled against, passed through from the server message
   * rather than re-derived here.
   */
  showCrateResult(result: {
    crateId: string;
    itemId: string;
    rarity: Rarity;
    duplicate: boolean;
    coinsAwarded: number;
    rates: Record<string, number>;
  }): Promise<void> {
    const item = getItem(result.itemId);
    const color = RARITY_COLOR[result.rarity].toString(16).padStart(6, '0');

    const rateRows = Object.entries(result.rates)
      .map(
        ([rarity, weight]) =>
          `<tr><td style="color:#${(RARITY_COLOR[rarity as Rarity] ?? 0x9aa4b2).toString(16).padStart(6, '0')}">
             ${t(`rarity.${rarity}`)}</td>
           <td style="text-align:right">${(weight * 100).toFixed(2)}%</td></tr>`,
      )
      .join('');

    return this.openOverlay(`
      <div class="overlay-header">
        <h2>${t('crate.result_title')}</h2>
        <button class="btn" data-close>${t('common.close')}</button>
      </div>
      <div class="crate-reveal">
        <div class="crate-item" style="border-color:#${color}">
          <div style="font-size:1.3rem;margin-bottom:0.4rem">${item ? t(item.nameKey) : result.itemId}</div>
          <div style="color:#${color};font-size:0.8rem;text-transform:uppercase;letter-spacing:0.14em">
            ${t(`rarity.${result.rarity}`)}
          </div>
        </div>
        ${
          result.duplicate
            ? `<div style="margin-top:1rem;color:var(--text-dim)">
                 ${t('crate.duplicate', { coins: formatNumber(result.coinsAwarded) })}
               </div>`
            : ''
        }
        <div style="margin-top:1.5rem">
          <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.14em;color:var(--text-faint)">
            ${t('crate.rates_title')}
          </div>
          <table class="rates-table">${rateRows}</table>
          <div style="font-size:0.72rem;color:var(--text-faint);margin-top:0.6rem;max-width:24rem;margin-inline:auto;line-height:1.6">
            ${t('crate.rates_note')}
          </div>
        </div>
      </div>`);
  }

  showLevelUp(level: number, unlockedItems: string[]): Promise<void> {
    const unlocks = unlockedItems
      .map((id) => {
        const item = getItem(id);
        return `<li style="margin:0.25rem 0">${item ? t(item.nameKey) : escapeHtml(id)}</li>`;
      })
      .join('');

    return this.openOverlay(`
      <div class="overlay-header">
        <h2>${t('progress.level_up')}</h2>
        <button class="btn" data-close>${t('common.ok')}</button>
      </div>
      <div style="text-align:center;padding:2.5rem 1.5rem">
        <div style="font-size:3.5rem;font-weight:200">${level}</div>
        <div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.2em;font-size:0.75rem">
          ${t('progress.level', { level })}
        </div>
        ${
          unlocks
            ? `<div style="margin-top:1.5rem">
                 <div style="font-size:0.75rem;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.14em">
                   ${t('progress.reward_unlocked', { name: '' })}
                 </div>
                 <ul style="list-style:none;padding:0;margin:0.6rem 0 0">${unlocks}</ul>
               </div>`
            : ''
        }
      </div>`);
  }

  showRankChange(from: string, to: string, promoted: boolean): Promise<void> {
    return this.openOverlay(`
      <div class="overlay-header">
        <h2>${promoted ? t('rank.promoted') : t('rank.demoted')}</h2>
        <button class="btn" data-close>${t('common.ok')}</button>
      </div>
      <div style="text-align:center;padding:2.5rem 1.5rem">
        <div style="font-size:1.6rem;color:${promoted ? 'var(--good)' : 'var(--bad)'}">
          ${escapeHtml(from)} → ${escapeHtml(to)}
        </div>
      </div>`);
  }

  showSecretDiscovered(nameKey: string): Promise<void> {
    return this.openOverlay(`
      <div class="overlay-header">
        <h2>${t('quest.secret')}</h2>
        <button class="btn" data-close>${t('common.ok')}</button>
      </div>
      <div style="text-align:center;padding:2.5rem 1.5rem">
        <div style="font-size:1.4rem;color:var(--warn);letter-spacing:0.1em">${t(nameKey)}</div>
        <div style="margin-top:0.8rem;color:var(--text-dim);font-size:0.85rem">
          ${t('quest.new_available')}
        </div>
      </div>`);
  }

  /** A blocking connection-problem overlay with a retry action. */
  showConnectionProblem(
    messageKey: string,
    params: Record<string, string | number> | undefined,
    onRetry: (() => void) | null,
  ): void {
    this.overlay.innerHTML = `
      <div class="overlay-panel" style="max-width:420px">
        <div class="overlay-header"><h2>${t('network.disconnected')}</h2></div>
        <div class="overlay-body" style="text-align:center">
          <p style="color:var(--text-dim);line-height:1.7">${t(messageKey, params)}</p>
          ${onRetry ? `<button class="btn primary" data-el="retry">${t('common.retry')}</button>` : ''}
        </div>
      </div>`;
    this.overlay.classList.add('active');
    this.overlay.querySelector('[data-el="retry"]')?.addEventListener('click', () => {
      this.closeOverlay();
      onRetry?.();
    });
  }

  /** Dialogue with an NPC. */
  showDialogue(
    npcNameKey: string,
    textKey: string,
    options: { textKey: string; index: number }[],
    onChoose: (index: number) => void,
  ): void {
    this.overlay.innerHTML = `
      <div class="overlay-panel" style="max-width:640px">
        <div class="overlay-header"><h2>${t(npcNameKey)}</h2></div>
        <div class="overlay-body">
          <p style="line-height:1.8;font-size:0.95rem;margin:0 0 1.5rem">${t(textKey)}</p>
          <div style="display:flex;flex-direction:column;gap:0.5rem">
            ${options
              .map(
                (o) =>
                  `<button class="btn" style="justify-content:flex-start;text-transform:none;letter-spacing:0"
                           data-choice="${o.index}">${t(o.textKey)}</button>`,
              )
              .join('')}
          </div>
        </div>
      </div>`;
    this.overlay.classList.add('active');

    for (const button of Array.from(this.overlay.querySelectorAll<HTMLElement>('[data-choice]'))) {
      button.addEventListener('click', () => onChoose(Number(button.dataset.choice)));
    }
  }
}
