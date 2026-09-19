/**
 * Menu and meta-game UI.
 *
 * Plain DOM rather than a framework: the whole UI is a few thousand nodes that
 * change on discrete events, and shipping a framework would cost more download
 * and more frame budget than it saves in code. Everything is rendered from the
 * shared content config plus the server's profile state, so adding a weapon or
 * a quest needs no UI change.
 *
 * All text goes through `t()`. Any string you see inline here is a symbol or a
 * number, never prose.
 */

import {
  ATTACHMENTS,
  CHARACTERS,
  Currency,
  GAME_MODES,
  ITEMS,
  ItemCategory,
  MAPS,
  RARITY_COLOR,
  Rarity,
  SKILLS,
  WEAPONS,
  formatDuration,
  formatNumber,
  getAchievement,
  getAttachment,
  getCharacter,
  getItem,
  getQuest,
  getWeapon,
  levelFromTotalXp,
  rankFromPoints,
  t,
  type ItemDefinition,
  type Loadout,
  type MatchResultPlayer,
  type ServerProfileSync,
} from '@titan/shared';
import { escapeHtml } from './Hud.js';
import type { SettingsStore } from '../core/Settings.js';

export type ScreenId = 'boot' | 'login' | 'menu' | 'match' | 'results';
export type MenuTab =
  | 'play'
  | 'loadout'
  | 'inventory'
  | 'shop'
  | 'quests'
  | 'rank'
  | 'social'
  | 'settings';

export interface ProfileView extends Omit<ServerProfileSync, 'type'> {}

export interface ScreenCallbacks {
  onLogin: (displayName: string) => void;
  onQueue: (modeId: string, mapIds: string[]) => void;
  onCancelQueue: () => void;
  onEquip: (itemId: string, slot: string) => void;
  onPurchase: (itemId: string, section: string) => void;
  onOpenCrate: (crateId: string) => void;
  onClaimQuest: (questId: string) => void;
  onClaimLogin: () => void;
  onPartyCreate: () => void;
  onPartyJoin: (code: string) => void;
  onPartyLeave: () => void;
  onSettingsChanged: () => void;
  onRequestLeaderboard: (board: string) => void;
  onReturnToMenu: () => void;
}

export class Screens {
  private readonly root: HTMLDivElement;
  private readonly screens = new Map<ScreenId, HTMLElement>();
  private active: ScreenId = 'boot';
  private tab: MenuTab = 'play';

  private profile: ProfileView | null = null;
  private selectedMode: string = GAME_MODES[0]!.id;
  private queueStatus: { inQueue: boolean; queuedMs: number; found: number; needed: number } | null = null;
  private shopData: Record<string, unknown[]> = {};
  private party: { code: string | null; members: { displayName: string; isLeader: boolean; ready: boolean }[] } | null = null;
  private queueSizes: Record<string, number> = {};

  constructor(
    container: HTMLElement,
    private readonly settings: SettingsStore,
    private readonly callbacks: ScreenCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'screens';
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    container.appendChild(this.root);

    this.buildBoot();
    this.buildLogin();
    this.buildMenu();
    this.buildResults();
    this.show('boot');
  }

  // ================================================================== boot

  private buildBoot(): void {
    const screen = this.makeScreen('boot');
    screen.innerHTML = `
      <div class="boot-mark">TITAN</div>
      <div class="boot-bar"><div class="boot-bar-fill" data-el="bootBar"></div></div>
      <div class="boot-status" data-el="bootStatus"></div>
      <div class="boot-tip" data-el="bootTip"></div>
    `;
    screen.style.alignItems = 'center';
    screen.style.justifyContent = 'center';
  }

  setBootProgress(fraction: number, statusKey: string): void {
    const bar = this.query('bootBar');
    const status = this.query('bootStatus');
    if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
    if (status) status.textContent = t(statusKey);
  }

  setBootTip(text: string): void {
    const tip = this.query('bootTip');
    if (tip) tip.textContent = text;
  }

  // ================================================================= login

  private buildLogin(): void {
    const screen = this.makeScreen('login');
    screen.innerHTML = `
      <div style="margin:auto;width:min(420px,90vw)">
        <div class="boot-mark" style="font-size:1.6rem;margin-bottom:2.5rem">TITAN</div>
        <div class="panel">
          <h2 style="margin:0 0 1.2rem;font-size:0.9rem;letter-spacing:0.16em;text-transform:uppercase"
              data-i18n="login.title"></h2>
          <div class="field">
            <label data-i18n="login.name_label"></label>
            <input type="text" data-el="loginName" maxlength="16" autocomplete="off" spellcheck="false" />
          </div>
          <div class="error-text" data-el="loginError"></div>
          <button class="btn primary large" style="width:100%" data-el="loginEnter"
                  data-i18n="login.enter"></button>
        </div>
      </div>
    `;

    const input = this.query<HTMLInputElement>('loginName')!;
    const button = this.query<HTMLButtonElement>('loginEnter')!;

    const submit = (): void => {
      const name = input.value.trim();
      if (name.length < 2) {
        this.setLoginError(t('login.name_too_short'));
        return;
      }
      if (name.length > 16) {
        this.setLoginError(t('login.name_too_long'));
        return;
      }
      this.setLoginError('');
      this.callbacks.onLogin(name);
    };

    button.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    // Remember the last name so returning players don't retype it.
    try {
      const stored = localStorage.getItem('titan.name');
      if (stored) input.value = stored;
    } catch {
      // Storage unavailable; the field simply starts empty.
    }
  }

  setLoginError(message: string): void {
    const element = this.query('loginError');
    if (element) element.textContent = message;
  }

  rememberName(name: string): void {
    try {
      localStorage.setItem('titan.name', name);
    } catch {
      // Not fatal.
    }
  }

  // ================================================================== menu

  private buildMenu(): void {
    const screen = this.makeScreen('menu');
    screen.innerHTML = `
      <div class="screen-header">
        <div class="brand">PROJECT TITAN</div>
        <div class="profile-strip">
          <div class="level-badge" data-el="menuLevel">1</div>
          <div>
            <div class="profile-name" data-el="menuName"></div>
            <div class="profile-title" data-el="menuTitle"></div>
            <div class="xp-bar"><div class="xp-bar-fill" data-el="menuXp"></div></div>
          </div>
          <div class="currency">
            <span class="coin" data-el="menuCoins">0</span>
            <span class="core" data-el="menuCores">0</span>
          </div>
        </div>
      </div>
      <div class="menu-layout">
        <nav class="menu-nav" data-el="menuNav"></nav>
        <div class="menu-content" data-el="menuContent"></div>
      </div>
      <div class="queue-panel panel" data-el="queuePanel" style="display:none">
        <div data-i18n="match.searching" style="font-size:0.78rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-dim)"></div>
        <div class="queue-timer" data-el="queueTimer">0:00</div>
        <div data-el="queueFound" style="font-size:0.8rem;color:var(--text-dim);margin-bottom:0.8rem"></div>
        <button class="btn danger" style="width:100%" data-el="queueCancel" data-i18n="match.cancel_search"></button>
      </div>
    `;

    const nav = this.query('menuNav')!;
    const tabs: { id: MenuTab; key: string }[] = [
      { id: 'play', key: 'menu.play' },
      { id: 'loadout', key: 'menu.loadout' },
      { id: 'inventory', key: 'menu.inventory' },
      { id: 'shop', key: 'menu.shop' },
      { id: 'quests', key: 'menu.quests' },
      { id: 'rank', key: 'menu.rank' },
      { id: 'social', key: 'menu.social' },
      { id: 'settings', key: 'menu.settings' },
    ];

    for (const tab of tabs) {
      const button = document.createElement('button');
      button.dataset.tab = tab.id;
      button.textContent = t(tab.key);
      button.addEventListener('click', () => this.setTab(tab.id));
      nav.appendChild(button);
    }

    this.query('queueCancel')!.addEventListener('click', () => this.callbacks.onCancelQueue());
  }

  setTab(tab: MenuTab): void {
    this.tab = tab;
    for (const button of Array.from(this.root.querySelectorAll<HTMLElement>('[data-tab]'))) {
      button.classList.toggle('active', button.dataset.tab === tab);
    }
    this.renderTab();
  }

  private renderTab(): void {
    const content = this.query('menuContent');
    if (!content) return;

    switch (this.tab) {
      case 'play':
        content.innerHTML = this.renderPlay();
        this.bindPlay(content);
        break;
      case 'loadout':
        content.innerHTML = this.renderLoadout();
        this.bindItemGrid(content);
        break;
      case 'inventory':
        content.innerHTML = this.renderInventory();
        this.bindItemGrid(content);
        break;
      case 'shop':
        content.innerHTML = this.renderShop();
        this.bindShop(content);
        break;
      case 'quests':
        content.innerHTML = this.renderQuests();
        this.bindQuests(content);
        break;
      case 'rank':
        content.innerHTML = this.renderRank();
        break;
      case 'social':
        content.innerHTML = this.renderSocial();
        this.bindSocial(content);
        break;
      case 'settings':
        content.innerHTML = this.renderSettings();
        this.bindSettings(content);
        break;
    }
  }

  // ------------------------------------------------------------------ play

  private renderPlay(): string {
    const level = this.profile ? levelFromTotalXp(this.profile.progression.totalXp).level : 1;

    const cards = GAME_MODES.map((mode) => {
      const locked = level < mode.unlockLevel;
      const queued = this.queueSizes[mode.id] ?? 0;
      return `
        <div class="mode-card ${locked ? 'locked' : ''} ${this.selectedMode === mode.id ? 'selected' : ''}"
             data-mode="${mode.id}">
          <h3>${t(mode.nameKey)}</h3>
          <p>${t(mode.descriptionKey)}</p>
          <div class="queue-count">
            ${locked ? t('common.level_required', { level: mode.unlockLevel }) : `${mode.minPlayers}-${mode.maxPlayers} · ${queued} ${t('match.players_found', { current: queued, total: mode.maxPlayers })}`}
          </div>
        </div>`;
    }).join('');

    const maps = MAPS.filter((m) => m.id !== 'titan_hub')
      .map(
        (map) => `
        <div class="item-card" style="cursor:default">
          <div class="swatch" style="background:linear-gradient(135deg, #${map.themeColor.toString(16).padStart(6, '0')}, #1a2030)"></div>
          <div class="name">${t(map.nameKey)}</div>
          <div class="meta">${map.recommendedPlayers[0]}-${map.recommendedPlayers[1]}</div>
          <div style="font-size:0.72rem;color:var(--text-dim);margin-top:0.4rem;line-height:1.5">${t(map.descriptionKey)}</div>
        </div>`,
      )
      .join('');

    return `
      <h2 style="font-size:0.85rem;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-dim);margin:0 0 0.9rem">
        ${t('menu.play')}
      </h2>
      <div class="mode-grid">${cards}</div>
      <button class="btn primary large" style="margin-top:1.5rem;width:100%;max-width:22rem"
              data-el="playButton" ${this.queueStatus?.inQueue ? 'disabled' : ''}>
        ${t('menu.play')}
      </button>

      <h2 style="font-size:0.85rem;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-dim);margin:2rem 0 0.9rem">
        ${t('menu.lobby')}
      </h2>
      <div class="item-grid">${maps}</div>
    `;
  }

  private bindPlay(container: HTMLElement): void {
    for (const card of Array.from(container.querySelectorAll<HTMLElement>('[data-mode]'))) {
      if (card.classList.contains('locked')) continue;
      card.addEventListener('click', () => {
        this.selectedMode = card.dataset.mode!;
        this.renderTab();
      });
    }
    container.querySelector('[data-el="playButton"]')?.addEventListener('click', () => {
      this.callbacks.onQueue(this.selectedMode, []);
    });
  }

  // -------------------------------------------------------------- loadout

  private renderLoadout(): string {
    const profile = this.profile;
    if (!profile) return '';
    const loadout = profile.inventory.loadout;

    const weaponSection = (slotKey: string, slot: string, currentId: string): string => {
      const owned = WEAPONS.filter((w) => profile.inventory.ownedWeaponIds.includes(w.id));
      const cards = owned
        .map(
          (weapon) => `
        <div class="item-card rarity-common ${weapon.id === currentId ? 'equipped' : ''}"
             data-equip="${weapon.id}" data-slot="${slot}">
          <div class="name">${t(weapon.nameKey)}</div>
          <div class="meta">${t(`weapon.class.${weapon.class}`)}</div>
          <div style="font-size:0.7rem;color:var(--text-dim);margin-top:0.4rem">
            ${t('weapon.stat.damage')} ${weapon.damage} · ${t('weapon.stat.fire_rate')} ${weapon.fireRate}
          </div>
        </div>`,
        )
        .join('');
      return `
        <h3 style="font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);margin:1.2rem 0 0.6rem">
          ${t(slotKey)}
        </h3>
        <div class="item-grid">${cards}</div>`;
    };

    const characters = CHARACTERS.map((character) => {
      const owned = profile.inventory.ownedCharacterIds.includes(character.id);
      return `
        <div class="item-card rarity-${character.rarity} ${loadout.characterId === character.id ? 'equipped' : ''}"
             ${owned ? `data-equip="${character.id}" data-slot="character"` : 'style="opacity:0.45"'}>
          <div class="swatch" style="background:#${character.build.accentColor.toString(16).padStart(6, '0')}"></div>
          <div class="name">${t(character.nameKey)}</div>
          <div class="meta">${t(`rarity.${character.rarity}`)}</div>
          <div style="font-size:0.7rem;color:var(--text-dim);margin-top:0.4rem;line-height:1.5">
            ${t(character.descriptionKey)}
          </div>
        </div>`;
    }).join('');

    const level = levelFromTotalXp(profile.progression.totalXp).level;
    const skills = SKILLS.map((skill) => {
      const unlocked = level >= skill.unlockLevel;
      return `
        <div class="item-card ${loadout.skillId === skill.id ? 'equipped' : ''}"
             ${unlocked ? `data-equip="${skill.id}" data-slot="skill"` : 'style="opacity:0.45"'}>
          <div class="name">${t(skill.nameKey)}</div>
          <div class="meta">${t(`skill.category.${skill.category}`)}</div>
          <div style="font-size:0.7rem;color:var(--text-dim);margin-top:0.4rem;line-height:1.5">
            ${unlocked ? t(skill.descriptionKey) : t('common.level_required', { level: skill.unlockLevel })}
          </div>
        </div>`;
    }).join('');

    const attachments = ATTACHMENTS.filter((a) =>
      profile.inventory.ownedAttachmentIds.includes(a.id),
    )
      .map(
        (attachment) => `
        <div class="item-card rarity-${attachment.rarity}"
             data-equip="${attachment.id}" data-slot="${loadout.primaryWeaponId}">
          <div class="name">${t(attachment.nameKey)}</div>
          <div class="meta">${t(`attachment.slot.${attachment.slot}`)}</div>
          <div style="font-size:0.7rem;color:var(--text-dim);margin-top:0.4rem;line-height:1.5">
            ${t(attachment.descriptionKey)}
          </div>
        </div>`,
      )
      .join('');

    return `
      ${weaponSection('weapon.class.assault_rifle', 'primary', loadout.primaryWeaponId)}
      ${weaponSection('weapon.class.pistol', 'secondary', loadout.secondaryWeaponId)}
      <h3 style="font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);margin:1.2rem 0 0.6rem">
        ${t('menu.characters')}
      </h3>
      <div class="item-grid">${characters}</div>
      <h3 style="font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);margin:1.2rem 0 0.6rem">
        ${t('skill.category.utility')}
      </h3>
      <div class="item-grid">${skills}</div>
      ${
        attachments
          ? `<h3 style="font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);margin:1.2rem 0 0.6rem">
               ${t('shop.section.attachments')}
             </h3>
             <div class="item-grid">${attachments}</div>`
          : ''
      }
    `;
  }

  private bindItemGrid(container: HTMLElement): void {
    for (const card of Array.from(container.querySelectorAll<HTMLElement>('[data-equip]'))) {
      card.addEventListener('click', () => {
        this.callbacks.onEquip(card.dataset.equip!, card.dataset.slot ?? '');
      });
    }
  }

  // ------------------------------------------------------------ inventory

  private renderInventory(): string {
    const profile = this.profile;
    if (!profile) return '';

    const owned: ItemDefinition[] = [];
    for (const id of profile.inventory.ownedItemIds) {
      const item = getItem(id);
      if (item) owned.push(item);
    }

    const rarityOrder: Rarity[] = [
      Rarity.Mythic, Rarity.Legendary, Rarity.Epic, Rarity.Rare, Rarity.Uncommon, Rarity.Common,
    ];
    owned.sort((a, b) => rarityOrder.indexOf(a.rarity) - rarityOrder.indexOf(b.rarity));

    const cards = owned
      .map((item) => {
        const isCrate = item.category === ItemCategory.Crate;
        const colorHex = item.visual.color.toString(16).padStart(6, '0');
        const accentHex = item.visual.accent.toString(16).padStart(6, '0');
        return `
        <div class="item-card rarity-${item.rarity}"
             ${isCrate ? `data-crate="${item.id}"` : `data-equip="${item.id}" data-slot="${item.appliesTo ?? ''}"`}>
          <div class="swatch" style="background:linear-gradient(135deg,#${colorHex},#${accentHex})"></div>
          <div class="name">${t(item.nameKey)}</div>
          <div class="meta" style="color:#${RARITY_COLOR[item.rarity].toString(16).padStart(6, '0')}">
            ${t(`rarity.${item.rarity}`)}
          </div>
          ${isCrate ? `<button class="btn" style="width:100%;margin-top:0.5rem">${t('crate.open')}</button>` : ''}
        </div>`;
      })
      .join('');

    // A new account genuinely owns no items, so the empty state is a normal
    // screen rather than an error: it keeps the header and count (so the player
    // can see the screen loaded at all) and says where items come from.
    const body =
      owned.length > 0
        ? `<div class="item-grid">${cards}</div>`
        : `<div style="padding:1.4rem;border:1px dashed var(--line);border-radius:8px;text-align:center">
             <p style="color:var(--text-dim);margin:0 0 0.4rem">${t('inventory.empty')}</p>
             <p style="color:var(--text-faint);font-size:0.8rem;margin:0">${t('inventory.empty_hint')}</p>
           </div>`;

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.9rem">
        <h2 style="font-size:0.85rem;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-dim);margin:0">
          ${t('inventory.title')}
        </h2>
        <span style="font-size:0.78rem;color:var(--text-faint)">
          ${t('inventory.item_count', { count: owned.length })}
        </span>
      </div>
      ${body}`;
  }

  // ----------------------------------------------------------------- shop

  private renderShop(): string {
    const sections = Object.entries(this.shopData);
    if (sections.length === 0) {
      return `<p style="color:var(--text-dim)">${t('common.loading')}</p>`;
    }

    return sections
      .map(([section, entries]) => {
        if (!Array.isArray(entries) || entries.length === 0) return '';
        const cards = (entries as Record<string, unknown>[])
          .map((entry) => {
            const itemId = String(entry.itemId);
            const price = Number(entry.price);
            const currency = String(entry.currency) as Currency;
            const owned = entry.owned === true;
            const purchasable = entry.purchasable === true;
            const discount = Number(entry.discountPercent ?? 0);

            const definition = getItem(itemId) ?? getWeapon(itemId) ?? getAttachment(itemId) ?? getCharacter(itemId);
            const nameKey = definition && 'nameKey' in definition ? definition.nameKey : itemId;
            const rarity = definition && 'rarity' in definition ? definition.rarity : Rarity.Common;

            return `
            <div class="item-card rarity-${rarity} ${owned ? 'equipped' : ''}"
                 ${!owned && purchasable ? `data-buy="${itemId}" data-section="${section}"` : ''}
                 ${!owned && !purchasable ? 'style="opacity:0.5"' : ''}>
              <div class="name">${t(nameKey)}</div>
              <div class="meta">${t(`rarity.${rarity}`)}</div>
              <div class="price">
                ${owned ? t('common.owned') : `${formatNumber(price)} ${t(`currency.${currency}`)}`}
                ${discount > 0 && !owned ? `<span style="color:var(--good);margin-left:0.4rem">${t('shop.discount', { percent: discount })}</span>` : ''}
              </div>
            </div>`;
          })
          .join('');

        return `
          <h3 style="font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);margin:1.2rem 0 0.6rem">
            ${t(`shop.section.${section}`)}
          </h3>
          <div class="item-grid">${cards}</div>`;
      })
      .join('');
  }

  private bindShop(container: HTMLElement): void {
    for (const card of Array.from(container.querySelectorAll<HTMLElement>('[data-buy]'))) {
      card.addEventListener('click', () => {
        this.callbacks.onPurchase(card.dataset.buy!, card.dataset.section!);
      });
    }
  }

  // --------------------------------------------------------------- quests

  private renderQuests(): string {
    const profile = this.profile;
    if (!profile) return '';

    const groups: Record<string, string[]> = { daily: [], weekly: [], story: [], secret: [] };

    for (const entry of this.questState) {
      const definition = getQuest(entry.id);
      if (!definition) continue;

      const total = definition.objectives.reduce((a, o) => a + o.count, 0);
      const current = entry.progress.reduce((a: number, b: number) => a + b, 0);
      const percent = total > 0 ? Math.min(100, (current / total) * 100) : 0;

      const reward = definition.reward;
      const coins = reward.currency.find((c) => c.currency === Currency.Coins)?.amount ?? 0;

      groups[entry.kind]?.push(`
        <div class="quest-row ${entry.completed ? 'complete' : ''} ${entry.kind === 'secret' ? 'secret' : ''}">
          <div class="info">
            <div class="title">${t(definition.nameKey)}</div>
            <div class="desc">${t(definition.descriptionKey)}</div>
            <div class="progress-track"><div style="width:${percent}%"></div></div>
          </div>
          <div style="text-align:right;min-width:7rem">
            <div style="font-size:0.72rem;color:var(--text-dim)">${reward.xp} XP · ${coins}</div>
            ${
              entry.completed && !entry.claimed
                ? `<button class="btn primary" style="margin-top:0.4rem" data-claim="${entry.id}">${t('quest.claim_reward')}</button>`
                : entry.claimed
                  ? `<div style="font-size:0.72rem;color:var(--good);margin-top:0.4rem">${t('common.claimed')}</div>`
                  : ''
            }
          </div>
        </div>`);
    }

    const section = (key: string, rows: string[]): string =>
      rows.length === 0
        ? ''
        : `<h3 style="font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);margin:1.2rem 0 0.6rem">
             ${t(key)}
           </h3>${rows.join('')}`;

    const loginBlock = profile.loginRewardAvailable
      ? `<div class="panel" style="margin-bottom:1.2rem;display:flex;justify-content:space-between;align-items:center">
           <div>
             <div style="font-weight:600">${t('login_reward.title')}</div>
             <div style="font-size:0.78rem;color:var(--text-dim)">
               ${t('login_reward.streak', { count: profile.loginStreak })}
             </div>
           </div>
           <button class="btn primary" data-el="claimLogin">${t('common.claim')}</button>
         </div>`
      : '';

    return `
      ${loginBlock}
      ${section('quest.daily', groups.daily!)}
      ${section('quest.weekly', groups.weekly!)}
      ${section('quest.story', groups.story!)}
      ${section('quest.secret', groups.secret!)}
      ${
        groups.secret!.length === 0
          ? `<div style="margin-top:1.5rem;color:var(--text-faint);font-size:0.8rem">
               ${t('quest.secret')}: ${t('quest.secret_undiscovered')}
             </div>`
          : ''
      }`;
  }

  private questState: { id: string; kind: string; progress: number[]; completed: boolean; claimed: boolean }[] = [];

  private bindQuests(container: HTMLElement): void {
    for (const button of Array.from(container.querySelectorAll<HTMLElement>('[data-claim]'))) {
      button.addEventListener('click', () => this.callbacks.onClaimQuest(button.dataset.claim!));
    }
    container.querySelector('[data-el="claimLogin"]')?.addEventListener('click', () =>
      this.callbacks.onClaimLogin(),
    );
    for (const card of Array.from(container.querySelectorAll<HTMLElement>('[data-crate]'))) {
      card.addEventListener('click', () => this.callbacks.onOpenCrate(card.dataset.crate!));
    }
  }

  // ----------------------------------------------------------------- rank

  private renderRank(): string {
    const profile = this.profile;
    if (!profile) return '';

    const rank = rankFromPoints(profile.progression.rankPoints);
    const stats = profile.stats;
    const kd = stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills.toFixed(2);
    const winRate =
      stats.wins + stats.losses > 0
        ? Math.round((stats.wins / (stats.wins + stats.losses)) * 100)
        : 0;

    const statRow = (labelKey: string, value: string | number): string =>
      `<div style="display:flex;justify-content:space-between;padding:0.45rem 0;border-bottom:1px solid rgba(38,48,73,0.4)">
         <span style="color:var(--text-dim);font-size:0.8rem">${t(labelKey)}</span>
         <span style="font-variant-numeric:tabular-nums">${value}</span>
       </div>`;

    const achievements = profile.achievementIds
      .map((id) => getAchievement(id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined)
      .map(
        (a) => `<div class="item-card"><div class="name">${t(a.nameKey)}</div>
                <div class="meta">${t(a.descriptionKey)}</div></div>`,
      )
      .join('');

    return `
      <div class="panel" style="text-align:center;margin-bottom:1.2rem">
        <div style="font-size:1.6rem;color:#${rank.tier.color.toString(16).padStart(6, '0')};letter-spacing:0.1em">
          ${t('rank.division', { tier: t(rank.tier.nameKey), division: rank.division })}
        </div>
        <div style="color:var(--text-dim);font-size:0.85rem;margin-top:0.3rem">
          ${t('rank.points', { points: rank.points })}
        </div>
        <div class="progress-track" style="max-width:20rem;margin:0.8rem auto 0">
          <div style="width:${Math.round(rank.progress * 100)}%"></div>
        </div>
      </div>

      <div class="settings-grid">
        <div class="panel">
          <h3 style="margin:0 0 0.6rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
            ${t('result.title')}
          </h3>
          ${statRow('result.kills', formatNumber(stats.kills))}
          ${statRow('result.deaths', formatNumber(stats.deaths))}
          ${statRow('result.assists', formatNumber(stats.assists))}
          ${statRow('result.kd', kd)}
          ${statRow('result.headshots', formatNumber(stats.headshots))}
          ${statRow('result.best_streak', stats.bestStreak)}
          ${statRow('result.time_played', formatDuration(stats.playtimeMs / 1000))}
          ${statRow('match.victory', `${stats.wins} (${winRate}%)`)}
        </div>
        <div class="panel">
          <h3 style="margin:0 0 0.6rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
            ${t('achievement.title')}
          </h3>
          <div class="item-grid">${achievements || `<span style="color:var(--text-faint);font-size:0.8rem">${t('inventory.empty')}</span>`}</div>
        </div>
      </div>`;
  }

  // --------------------------------------------------------------- social

  private renderSocial(): string {
    const members = this.party?.members ?? [];
    const rows = members
      .map(
        (m) => `<div class="quest-row"><div class="info">
                  <div class="title">${escapeHtml(m.displayName)} ${m.isLeader ? `· ${t('party.leader')}` : ''}</div>
                  <div class="desc">${m.ready ? t('party.ready') : t('party.not_ready')}</div>
                </div></div>`,
      )
      .join('');

    return `
      <div class="panel" style="margin-bottom:1.2rem">
        <h3 style="margin:0 0 0.8rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
          ${t('party.title')}
        </h3>
        ${
          this.party?.code
            ? `<div style="margin-bottom:0.8rem;font-variant-numeric:tabular-nums">
                 ${t('party.code', { code: this.party.code })}
               </div>${rows}
               <button class="btn danger" style="margin-top:0.8rem" data-el="partyLeave">${t('party.leave')}</button>`
            : `<button class="btn primary" data-el="partyCreate">${t('party.create')}</button>
               <div class="field" style="margin-top:1rem">
                 <label>${t('party.join_code')}</label>
                 <div class="row">
                   <input type="text" data-el="partyCode" maxlength="8" style="flex:1" />
                   <button class="btn" data-el="partyJoin">${t('common.confirm')}</button>
                 </div>
               </div>`
        }
      </div>
      <div class="panel">
        <h3 style="margin:0 0 0.8rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
          ${t('menu.leaderboard')}
        </h3>
        <div data-el="leaderboard" style="font-size:0.82rem;color:var(--text-dim)">${t('common.loading')}</div>
      </div>`;
  }

  private bindSocial(container: HTMLElement): void {
    container.querySelector('[data-el="partyCreate"]')?.addEventListener('click', () =>
      this.callbacks.onPartyCreate(),
    );
    container.querySelector('[data-el="partyLeave"]')?.addEventListener('click', () =>
      this.callbacks.onPartyLeave(),
    );
    container.querySelector('[data-el="partyJoin"]')?.addEventListener('click', () => {
      const input = container.querySelector<HTMLInputElement>('[data-el="partyCode"]');
      if (input?.value) this.callbacks.onPartyJoin(input.value.trim().toUpperCase());
    });
    this.callbacks.onRequestLeaderboard('rank');
  }

  setLeaderboard(entries: { rank: number; displayName: string; value: number }[]): void {
    const element = this.query('leaderboard');
    if (!element) return;
    element.innerHTML =
      entries.length === 0
        ? t('inventory.empty')
        : entries
            .slice(0, 20)
            .map(
              (e) =>
                `<div style="display:flex;justify-content:space-between;padding:0.3rem 0">
                   <span>${e.rank}. ${escapeHtml(e.displayName)}</span>
                   <span style="font-variant-numeric:tabular-nums">${formatNumber(e.value)}</span>
                 </div>`,
            )
            .join('');
  }

  // ------------------------------------------------------------- settings

  private renderSettings(): string {
    const s = this.settings.current;

    const slider = (
      section: string,
      key: string,
      labelKey: string,
      min: number,
      max: number,
      step: number,
      value: number,
    ): string => `
      <div class="field">
        <label>${t(labelKey)}</label>
        <div class="row">
          <input type="range" data-setting="${section}.${key}" min="${min}" max="${max}" step="${step}" value="${value}" />
          <span class="value" data-value-for="${section}.${key}">${value}</span>
        </div>
      </div>`;

    const toggle = (section: string, key: string, labelKey: string, value: boolean): string => `
      <div class="toggle">
        <span>${t(labelKey)}</span>
        <input type="checkbox" data-setting="${section}.${key}" ${value ? 'checked' : ''} />
      </div>`;

    return `
      <div class="settings-grid">
        <div class="panel">
          <h3 style="margin:0 0 0.8rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
            ${t('settings.tab.graphics')}
          </h3>
          <div class="field">
            <label>${t('settings.graphics.preset')}</label>
            <select data-setting="graphics.preset">
              <option value="low" ${s.graphics.preset === 'low' ? 'selected' : ''}>${t('settings.graphics.preset.low')}</option>
              <option value="medium" ${s.graphics.preset === 'medium' ? 'selected' : ''}>${t('settings.graphics.preset.medium')}</option>
              <option value="high" ${s.graphics.preset === 'high' ? 'selected' : ''}>${t('settings.graphics.preset.high')}</option>
              <option value="custom" ${s.graphics.preset === 'custom' ? 'selected' : ''}>${t('settings.graphics.preset.custom')}</option>
            </select>
            <div class="hint">${t('settings.graphics.low_spec_note')}</div>
          </div>
          ${slider('graphics', 'resolutionScale', 'settings.graphics.resolution_scale', 0.5, 1, 0.05, s.graphics.resolutionScale)}
          ${slider('graphics', 'fpsLimit', 'settings.graphics.fps_limit', 30, 240, 10, s.graphics.fpsLimit)}
          ${slider('graphics', 'viewDistance', 'settings.graphics.view_distance', 0.4, 1.5, 0.05, s.graphics.viewDistance)}
          ${slider('graphics', 'particleDensity', 'settings.graphics.particle_density', 0, 1, 0.05, s.graphics.particleDensity)}
          ${toggle('graphics', 'shadows', 'settings.graphics.shadows', s.graphics.shadows)}
          ${toggle('graphics', 'bloom', 'settings.graphics.bloom', s.graphics.bloom)}
          ${toggle('graphics', 'detailProps', 'settings.graphics.detail_props', s.graphics.detailProps)}
          ${toggle('graphics', 'antialiasing', 'settings.graphics.antialiasing', s.graphics.antialiasing)}
        </div>

        <div class="panel">
          <h3 style="margin:0 0 0.8rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
            ${t('settings.tab.audio')}
          </h3>
          ${slider('audio', 'master', 'settings.audio.master', 0, 1, 0.05, s.audio.master)}
          ${slider('audio', 'music', 'settings.audio.music', 0, 1, 0.05, s.audio.music)}
          ${slider('audio', 'sfx', 'settings.audio.sfx', 0, 1, 0.05, s.audio.sfx)}
          ${slider('audio', 'ui', 'settings.audio.ui', 0, 1, 0.05, s.audio.ui)}
          ${slider('audio', 'ambience', 'settings.audio.ambience', 0, 1, 0.05, s.audio.ambience)}
          ${toggle('audio', 'spatial', 'settings.audio.spatial', s.audio.spatial)}
        </div>

        <div class="panel">
          <h3 style="margin:0 0 0.8rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
            ${t('settings.tab.controls')}
          </h3>
          ${slider('controls', 'sensitivity', 'settings.controls.sensitivity', 0.0004, 0.008, 0.0002, s.controls.sensitivity)}
          ${slider('controls', 'adsSensitivityMultiplier', 'settings.controls.ads_sensitivity', 0.2, 1.5, 0.05, s.controls.adsSensitivityMultiplier)}
          ${toggle('controls', 'invertY', 'settings.controls.invert_y', s.controls.invertY)}
          ${toggle('controls', 'toggleAds', 'settings.controls.toggle_ads', s.controls.toggleAds)}
          ${toggle('controls', 'toggleCrouch', 'settings.controls.toggle_crouch', s.controls.toggleCrouch)}
          ${toggle('controls', 'toggleSprint', 'settings.controls.toggle_sprint', s.controls.toggleSprint)}
        </div>

        <div class="panel">
          <h3 style="margin:0 0 0.8rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
            ${t('settings.tab.gameplay')}
          </h3>
          ${slider('gameplay', 'fov', 'settings.gameplay.fov', 70, 120, 1, s.gameplay.fov)}
          ${slider('gameplay', 'crosshairSize', 'settings.gameplay.crosshair_size', 1, 16, 1, s.gameplay.crosshairSize)}
          ${slider('gameplay', 'crosshairGap', 'settings.gameplay.crosshair_gap', 0, 16, 1, s.gameplay.crosshairGap)}
          <div class="field">
            <label>${t('settings.gameplay.crosshair_color')}</label>
            <input type="color" data-setting="gameplay.crosshairColor" value="${s.gameplay.crosshairColor}" />
          </div>
          ${toggle('gameplay', 'crosshairDot', 'settings.gameplay.crosshair_dot', s.gameplay.crosshairDot)}
          ${toggle('gameplay', 'damageNumbers', 'settings.gameplay.damage_numbers', s.gameplay.damageNumbers)}
          ${toggle('gameplay', 'hitmarkers', 'settings.gameplay.hitmarkers', s.gameplay.hitmarkers)}
          ${toggle('gameplay', 'killfeed', 'settings.gameplay.killfeed', s.gameplay.killfeed)}
          ${toggle('gameplay', 'minimapRotate', 'settings.gameplay.minimap_rotate', s.gameplay.minimapRotate)}
          ${toggle('gameplay', 'showFps', 'settings.gameplay.show_fps', s.gameplay.showFps)}
          ${toggle('gameplay', 'showPing', 'settings.gameplay.show_ping', s.gameplay.showPing)}
        </div>

        <div class="panel">
          <h3 style="margin:0 0 0.8rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
            ${t('settings.tab.accessibility')}
          </h3>
          ${slider('accessibility', 'cameraShake', 'settings.accessibility.camera_shake', 0, 1, 0.05, s.accessibility.cameraShake)}
          ${slider('accessibility', 'textScale', 'settings.accessibility.text_size', 0.8, 1.6, 0.05, s.accessibility.textScale)}
          ${slider('accessibility', 'subtitleScale', 'settings.accessibility.subtitle_size', 0.8, 2, 0.1, s.accessibility.subtitleScale)}
          ${toggle('accessibility', 'reduceMotion', 'settings.accessibility.motion_reduction', s.accessibility.reduceMotion)}
          ${toggle('accessibility', 'subtitles', 'settings.accessibility.subtitles', s.accessibility.subtitles)}
          ${toggle('accessibility', 'highContrast', 'settings.accessibility.high_contrast', s.accessibility.highContrast)}
          ${toggle('accessibility', 'reduceFlashing', 'settings.accessibility.flash_reduction', s.accessibility.reduceFlashing)}
          <div class="field">
            <label>${t('settings.accessibility.colorblind')}</label>
            <select data-setting="accessibility.colorblind">
              <option value="none" ${s.accessibility.colorblind === 'none' ? 'selected' : ''}>${t('settings.accessibility.colorblind.none')}</option>
              <option value="protanopia" ${s.accessibility.colorblind === 'protanopia' ? 'selected' : ''}>${t('settings.accessibility.colorblind.protanopia')}</option>
              <option value="deuteranopia" ${s.accessibility.colorblind === 'deuteranopia' ? 'selected' : ''}>${t('settings.accessibility.colorblind.deuteranopia')}</option>
              <option value="tritanopia" ${s.accessibility.colorblind === 'tritanopia' ? 'selected' : ''}>${t('settings.accessibility.colorblind.tritanopia')}</option>
            </select>
          </div>
        </div>

        <div class="panel">
          <h3 style="margin:0 0 0.8rem;font-size:0.78rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
            ${t('settings.language.title')}
          </h3>
          <div class="field">
            <select data-setting="locale">
              <option value="ko" ${s.locale === 'ko' ? 'selected' : ''}>한국어</option>
              <option value="en" ${s.locale === 'en' ? 'selected' : ''}>English</option>
              <option value="ja" disabled>日本語 (${t('settings.language.planned')})</option>
              <option value="zh" disabled>中文 (${t('settings.language.planned')})</option>
            </select>
          </div>
          <button class="btn" style="margin-top:1rem" data-el="resetSettings">${t('common.reset')}</button>
        </div>
      </div>`;
  }

  private bindSettings(container: HTMLElement): void {
    for (const input of Array.from(container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]'))) {
      const path = input.dataset.setting!;
      const [section, key] = path.split('.');

      const handler = (): void => {
        if (path === 'locale') {
          this.settings.setLocale(input.value as never);
          this.renderTab();
          this.refreshStaticText();
          this.callbacks.onSettingsChanged();
          return;
        }
        if (section === 'graphics' && key === 'preset' && input.value !== 'custom') {
          this.settings.applyPreset(input.value as 'low' | 'medium' | 'high');
          this.renderTab();
          this.callbacks.onSettingsChanged();
          return;
        }

        let value: unknown;
        if (input instanceof HTMLInputElement && input.type === 'checkbox') value = input.checked;
        else if (input instanceof HTMLInputElement && input.type === 'range') value = Number(input.value);
        else value = input.value;

        this.settings.update(section as never, { [key!]: value } as never);

        const label = container.querySelector(`[data-value-for="${path}"]`);
        if (label) label.textContent = String(value);
        this.callbacks.onSettingsChanged();
      };

      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }

    container.querySelector('[data-el="resetSettings"]')?.addEventListener('click', () => {
      this.settings.reset();
      this.renderTab();
      this.callbacks.onSettingsChanged();
    });
  }

  // ================================================================ results

  private buildResults(): void {
    const screen = this.makeScreen('results');
    screen.innerHTML = `
      <div style="margin:auto;width:min(900px,94vw)">
        <div class="result-banner" data-el="resultBanner"><h1 data-el="resultTitle"></h1></div>
        <div class="reward-row" data-el="resultRewards"></div>
        <div class="panel"><div data-el="resultTable"></div></div>
        <div style="text-align:center;margin-top:1.5rem">
          <button class="btn primary large" data-el="resultContinue"></button>
        </div>
      </div>`;
    this.query('resultContinue')!.addEventListener('click', () => this.callbacks.onReturnToMenu());
  }

  showResults(
    results: MatchResultPlayer[],
    selfId: string,
    won: boolean,
    xp: number,
    coins: number,
    rankDelta: number,
  ): void {
    const banner = this.query('resultBanner')!;
    banner.className = `result-banner ${won ? 'victory' : 'defeat'}`;
    this.query('resultTitle')!.textContent = won ? t('match.victory') : t('match.defeat');
    this.query('resultContinue')!.textContent = t('result.continue');

    this.query('resultRewards')!.innerHTML = `
      <div class="item"><div class="amount">+${formatNumber(xp)}</div><div class="label">${t('result.xp_earned')}</div></div>
      <div class="item"><div class="amount">+${formatNumber(coins)}</div><div class="label">${t('result.coins_earned')}</div></div>
      ${
        rankDelta !== 0
          ? `<div class="item"><div class="amount" style="color:${rankDelta > 0 ? 'var(--good)' : 'var(--bad)'}">
               ${rankDelta > 0 ? '+' : ''}${rankDelta}</div>
             <div class="label">${t('result.rank_change')}</div></div>`
          : ''
      }`;

    const sorted = [...results].sort((a, b) => b.score - a.score);
    this.query('resultTable')!.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <thead><tr>
          <th style="text-align:left;padding:0.4rem;color:var(--text-faint);font-size:0.68rem;text-transform:uppercase">${t('login.name_label')}</th>
          <th style="padding:0.4rem;color:var(--text-faint);font-size:0.68rem;text-transform:uppercase">${t('result.score')}</th>
          <th style="padding:0.4rem;color:var(--text-faint);font-size:0.68rem;text-transform:uppercase">${t('result.kills')}</th>
          <th style="padding:0.4rem;color:var(--text-faint);font-size:0.68rem;text-transform:uppercase">${t('result.deaths')}</th>
          <th style="padding:0.4rem;color:var(--text-faint);font-size:0.68rem;text-transform:uppercase">${t('result.damage')}</th>
          <th style="padding:0.4rem;color:var(--text-faint);font-size:0.68rem;text-transform:uppercase">${t('result.accuracy')}</th>
        </tr></thead>
        <tbody>
          ${sorted
            .map(
              (r) => `<tr style="${r.playerId === selfId ? 'background:rgba(63,140,232,0.14)' : ''}">
                <td style="padding:0.4rem">${escapeHtml(r.displayName)}${r.mvp ? ` <span style="color:var(--warn)">${t('result.mvp')}</span>` : ''}</td>
                <td style="padding:0.4rem;text-align:center;font-variant-numeric:tabular-nums">${r.score}</td>
                <td style="padding:0.4rem;text-align:center;font-variant-numeric:tabular-nums">${r.kills}</td>
                <td style="padding:0.4rem;text-align:center;font-variant-numeric:tabular-nums">${r.deaths}</td>
                <td style="padding:0.4rem;text-align:center;font-variant-numeric:tabular-nums">${Math.round(r.damage)}</td>
                <td style="padding:0.4rem;text-align:center;font-variant-numeric:tabular-nums">${Math.round(r.accuracy * 100)}%</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>`;

    this.show('results');
  }

  // ================================================================= state

  setProfile(profile: ProfileView): void {
    this.profile = profile;
    const progress = levelFromTotalXp(profile.progression.totalXp);

    const set = (key: string, value: string): void => {
      const element = this.query(key);
      if (element) element.textContent = value;
    };

    set('menuName', profile.displayName);
    set('menuLevel', String(progress.level));
    set('menuCoins', formatNumber(profile.currencies[Currency.Coins] ?? 0));
    set('menuCores', formatNumber(profile.currencies[Currency.Cores] ?? 0));
    set('menuTitle', profile.inventory.equippedTitle ? t(profile.inventory.equippedTitle) : '');

    const xpBar = this.query('menuXp');
    if (xpBar) xpBar.style.width = `${Math.round(progress.progress * 100)}%`;

    if (this.active === 'menu') this.renderTab();
  }

  setCurrencies(balances: Record<string, number>): void {
    if (!this.profile) return;
    this.profile.currencies = balances as never;
    const coins = this.query('menuCoins');
    const cores = this.query('menuCores');
    if (coins) coins.textContent = formatNumber(balances[Currency.Coins] ?? 0);
    if (cores) cores.textContent = formatNumber(balances[Currency.Cores] ?? 0);
  }

  setInventory(inventory: ProfileView['inventory']): void {
    if (!this.profile) return;
    this.profile.inventory = inventory;
    if (this.active === 'menu' && (this.tab === 'inventory' || this.tab === 'loadout')) {
      this.renderTab();
    }
  }

  setQuests(quests: { id: string; kind: string; progress: number[]; completed: boolean; claimed: boolean }[]): void {
    this.questState = quests;
    if (this.active === 'menu' && this.tab === 'quests') this.renderTab();
  }

  setShop(data: Record<string, unknown[]>): void {
    this.shopData = data;
    if (this.active === 'menu' && this.tab === 'shop') this.renderTab();
  }

  setParty(party: { code: string | null; members: { displayName: string; isLeader: boolean; ready: boolean }[] } | null): void {
    this.party = party;
    if (this.active === 'menu' && this.tab === 'social') this.renderTab();
  }

  setQueueSizes(sizes: Record<string, number>): void {
    this.queueSizes = sizes;
  }

  setQueueStatus(status: { inQueue: boolean; queuedMs: number; found: number; needed: number } | null): void {
    this.queueStatus = status;
    const panel = this.query('queuePanel');
    if (!panel) return;

    if (!status?.inQueue) {
      panel.style.display = 'none';
      if (this.active === 'menu' && this.tab === 'play') this.renderTab();
      return;
    }

    panel.style.display = '';
    const timer = this.query('queueTimer');
    const found = this.query('queueFound');
    if (timer) timer.textContent = formatDuration(status.queuedMs / 1000);
    if (found) {
      found.textContent = t('match.players_found', { current: status.found, total: status.needed });
    }
  }

  // ================================================================ helpers

  private makeScreen(id: ScreenId): HTMLElement {
    const screen = document.createElement('section');
    screen.className = 'screen';
    screen.id = `screen-${id}`;
    this.root.appendChild(screen);
    this.screens.set(id, screen);
    return screen;
  }

  show(id: ScreenId): void {
    this.active = id;
    for (const [screenId, element] of this.screens) {
      element.classList.toggle('active', screenId === id);
    }
    this.root.style.pointerEvents = id === 'match' ? 'none' : 'auto';
    if (id === 'menu') {
      this.setTab(this.tab);
      this.refreshStaticText();
    }
  }

  get activeScreen(): ScreenId {
    return this.active;
  }

  /** Re-translate elements marked with data-i18n after a language change. */
  refreshStaticText(): void {
    for (const element of Array.from(this.root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
      element.textContent = t(element.dataset.i18n!);
    }
    for (const button of Array.from(this.root.querySelectorAll<HTMLElement>('[data-tab]'))) {
      const map: Record<string, string> = {
        play: 'menu.play', loadout: 'menu.loadout', inventory: 'menu.inventory',
        shop: 'menu.shop', quests: 'menu.quests', rank: 'menu.rank',
        social: 'menu.social', settings: 'menu.settings',
      };
      const key = map[button.dataset.tab!];
      if (key) button.textContent = t(key);
    }
  }

  private query<T extends HTMLElement = HTMLElement>(name: string): T | null {
    return this.root.querySelector<T>(`[data-el="${name}"]`);
  }
}
