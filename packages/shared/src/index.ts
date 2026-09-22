/**
 * @titan/shared — everything both the client and the authoritative server need.
 *
 * The rule that keeps this package honest: nothing here may import from
 * `@titan/server` or `@titan/client`, and nothing here may touch the DOM,
 * `node:fs`, or wall-clock-dependent globals. That is what allows the exact
 * same simulation code to run in both processes.
 */

// Core
export * from './core/math.js';
export * from './core/random.js';
export * from './core/logger.js';
export * from './core/result.js';
export * from './core/events.js';
export * from './core/pool.js';
export * from './core/constants.js';

// Types
export * from './types/domain.js';

// Simulation
export * from './sim/collision.js';
export * from './sim/movement.js';
export * from './sim/hitbox.js';
export * from './sim/ballistics.js';
export * from './sim/weaponState.js';

// Content configuration
export * from './config/weapons.js';
export * from './config/attachments.js';
export * from './config/loadout.js';
export * from './config/characters.js';
export * from './config/movement.js';
export * from './config/gameModes.js';
export * from './config/progression.js';
export * from './config/items.js';
export * from './config/quests.js';
export * from './config/economy.js';
export * from './config/vehicles.js';
export * from './config/npcs.js';
export * from './config/audio.js';
export * from './config/maps/index.js';

// Networking
export * from './net/protocol.js';
export * from './net/validation.js';
export * from './net/serialization.js';

// Localization
export * from './localization/index.js';
