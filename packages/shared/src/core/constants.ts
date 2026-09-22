/**
 * Global tuning constants shared by client and server.
 *
 * Anything here affects prediction correctness — if the client and server
 * disagree on these numbers, prediction will mispredict and the player will
 * see rubber-banding. They live in `shared` for exactly that reason.
 */

/** Server simulation rate. 64 Hz is the sweet spot for responsiveness vs CPU. */
export const TICK_RATE = 64;
export const TICK_DELTA = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/** How often full/delta snapshots are broadcast. Lower than tick rate to save bandwidth. */
export const SNAPSHOT_RATE = 20;
export const SNAPSHOT_INTERVAL_TICKS = Math.round(TICK_RATE / SNAPSHOT_RATE);

/** Client renders remote players this far in the past, so it always interpolates. */
export const INTERPOLATION_DELAY_MS = 100;

/** How much history the server keeps for lag compensation (rewinding hitboxes). */
export const LAG_COMPENSATION_HISTORY_MS = 1000;
/** Hard cap on how far back a client may be rewound — bounds "peeker's advantage" abuse. */
export const MAX_REWIND_MS = 250;

/** Player collision capsule. */
export const PLAYER_RADIUS = 0.42;
export const PLAYER_HEIGHT_STAND = 1.8;
export const PLAYER_HEIGHT_CROUCH = 1.05;
export const PLAYER_EYE_OFFSET = 0.16; // below the top of the capsule

/** World. */
export const GRAVITY = 22.0; // m/s^2 — higher than real gravity; standard for snappy FPS feel
export const TERMINAL_VELOCITY = 60;
export const WORLD_FLOOR_Y = -50; // below this a player is killed (fell out of the map)

/** Combat. */
export const MAX_HEALTH = 100;
export const MAX_SHIELD = 50;
export const SPAWN_PROTECTION_MS = 2500;
export const RESPAWN_DELAY_MS = 4000;
export const ASSIST_WINDOW_MS = 8000;
export const ASSIST_DAMAGE_THRESHOLD = 25;
export const MULTIKILL_WINDOW_MS = 4500;
export const SHIELD_REGEN_DELAY_MS = 6000;
export const SHIELD_REGEN_PER_SEC = 12;

/** Networking limits — also enforced by the anti-cheat validators. */
export const MAX_INPUTS_PER_PACKET = 12;
export const MAX_PACKET_BYTES = 8 * 1024;
export const HEARTBEAT_INTERVAL_MS = 2000;
export const CONNECTION_TIMEOUT_MS = 15000;
/** Grace period during which a dropped player keeps their slot and match state. */
export const RECONNECT_GRACE_MS = 60_000;

/** Match sizing. */
export const MAX_PLAYERS_PER_MATCH = 12;
export const MAX_PARTY_SIZE = 4;

/** Progression. */
export const MAX_LEVEL = 100;
export const PRESTIGE_UNLOCK_LEVEL = 100;

/** Data format version — bumped whenever the save schema changes. */
export const SAVE_SCHEMA_VERSION = 3;

/** Wire protocol version — client and server must match exactly. */
export const PROTOCOL_VERSION = 1;
