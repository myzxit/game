# Assets

## The honest summary

**This build ships no authored art, no authored audio, and no authored
animation.** Every model, texture, material, animation, sound effect and piece
of music you see or hear is generated procedurally in code at runtime.

That is a real limitation of the environment this was built in, not a stylistic
choice and not a placeholder pretending to be finished content. The machine has
no GPU, no DCC tooling (no Blender, no Maya, no Substance), no audio
workstation, and no licence to any third-party asset library. Producing a
genuine 10k-triangle rigged character or a recorded gunshot was not possible
here, so the code generates a stand-in and **says so**:

- `AssetManifest.report()` logs the gap at every boot:
  `23 of 23 asset groups have no authored file and are being generated
  procedurally at runtime.`
- The in-game developer panel shows `Assets: procedural` in amber.
- Every entry in `packages/client/src/core/AssetManifest.ts` carries
  `url: null` and `procedural: true`.

No copyrighted asset from any existing game, and no asset from any source the
project does not have the rights to, has been copied into this repository.
Everything here was written for it.

## What "procedural" actually means here

It is worth being precise about what the substitutes are, because "procedural"
can mean anything from a credible generated asset to a grey box.

| Area | What actually runs | Honest quality assessment |
| --- | --- | --- |
| Surface materials | Canvas-drawn albedo with a derived normal map, per material (metal, concrete, asphalt, wood, glass, brick, plastic, fabric, dirt, grass, water) | Reads correctly as distinct surfaces at gameplay distance. Will not survive a close-up. |
| Characters | Primitive-built rigs with real joints, driven by code-authored locomotion poses | Silhouettes are distinguishable and animation is readable. Clearly not a authored character model. |
| View models | Primitive weapon shapes with correct muzzle / ejection / magazine sockets | Correct timing, weight and sockets. Geometry is blocky. |
| VFX | Generated sprite particles, tracers, decals, muzzle flashes | Closest to shippable of anything here. |
| Audio | Web Audio synthesis (noise bursts, filtered envelopes, FM tones) per recipe; a looping oscillator motor for vehicles that revs with speed | Distinct and informative — you can tell weapons, surfaces and an approaching buggy apart by ear. Does not sound recorded. |
| Music | Sequenced synthesis that ducks under gunfire | Functional and non-repetitive. Not a composed score. |

The gameplay-critical property is preserved: **every sound and every material is
distinguishable from every other**, because combat information is carried by
audio and surface cues. What is missing is production polish, not information.

## Why the manifest exists

`AssetManifest.resolve()` returns an authored asset when one is registered, and
falls back to the procedural generator otherwise. Nothing in the renderer or the
audio engine knows which it received.

That means **dropping in a real asset pack is a data change, not a code
change**: set `url` on the manifest entry and the runtime uses it. No renderer,
audio or gameplay code has to be touched.

## Required asset specification

This is the spec a real asset pack would have to meet. It is the same text
carried on each manifest entry, so the two cannot drift apart.

### Models (8 groups)

| Key | Requirement |
| --- | --- |
| `model.character.vanguard` | Rigged humanoid, 8-14k tris, single 2048 albedo + normal + ORM atlas, Mixamo-compatible skeleton, 1.8m tall, origin at feet. |
| `model.character.specter` | As vanguard, slimmer silhouette, 1.74m. |
| `model.character.warden` | As vanguard, heavier silhouette with shoulder plating, 1.86m. |
| `model.character.surveyor` | As vanguard, with a visible sensor pack, 1.78m. |
| `model.character.forge` | As vanguard, with a tool harness, 1.82m. |
| `model.weapon.viewmodel` | First-person arms + weapon set, 6-10k tris each, separate muzzle/ejection port/magazine sockets, 512-1024 textures. One per weapon id. |
| `model.vehicle.scout_buggy` | 10-16k tris, 4 wheel bones, 2048 texture, collision proxy 2.2 x 1.5 x 4.2m. |
| `model.npc.generic` | Rigged humanoid, idle-only rig acceptable, 6-10k tris. |

### Textures (4 groups)

| Key | Requirement |
| --- | --- |
| `texture.surface.atlas` | Tiling PBR set for metal / concrete / asphalt / wood / glass / brick / plastic / fabric / dirt / grass / water. 1024 albedo + normal + roughness each, or one 4096 atlas. |
| `texture.decal.impacts` | Bullet-hole decal sheet, 4x4 variations, 512 alpha-masked. |
| `texture.vfx.particles` | Smoke / spark / flash sprite sheet, 8x8, 1024 premultiplied alpha. |
| `texture.sky.cubemap` | Sky cubemap per environment profile, 1024/face, HDR preferred. |

### Animation (3 groups)

| Key | Requirement |
| --- | --- |
| `animation.character.locomotion` | idle / walk (8-dir) / run / sprint / jump / fall / land / crouch-idle / crouch-walk / slide / dash / death. 30fps, root motion off. |
| `animation.viewmodel.weapon` | Per weapon: idle / fire / fire-ads / reload / reload-empty / equip / holster / sprint / inspect / melee. 60fps for fire and reload. |
| `animation.character.emote` | salute / taunt / victory pose, 2-4s each, loopable hold. |

### Audio (6 groups)

| Key | Requirement |
| --- | --- |
| `audio.weapons` | Per weapon: fire (3-5 round-robin variants), fire-distant, reload start / mag-out / mag-in / bolt, dry fire. 48kHz mono WAV, -3dBFS peak. |
| `audio.impacts` | Per surface material: 4 impact variants + 4 footstep variants, 48kHz mono. |
| `audio.ambience` | Seamless stereo loops, 30-60s: wind, machinery, rain, city night, neon hum. |
| `audio.vehicles` | Per vehicle: engine loop at idle / mid / full revs (seamless, 4-8s each, pitch-shiftable), start, stop, collision, destruction. 48kHz mono. |
| `audio.ui` | click / hover / back / error / purchase / reward / level-up / rank-up. |
| `audio.music` | Menu / lobby / combat / victory / defeat / event. Stem-separated where possible so intensity can follow the match. 48kHz stereo. |

### UI (2 groups)

| Key | Requirement |
| --- | --- |
| `font.ui` | Variable sans supporting Latin + Hangul (and later Kana + CJK). Currently falls back to the system UI font stack, which covers Korean on all target platforms. |
| `ui.icons` | SVG icon set: weapon classes, rarities, currencies, quest types, ranks. |

## Licensing rule

Any asset added here must be either original work commissioned for this project,
or licensed with redistribution rights that cover a shipped game build. Record
the licence and its source alongside the file. Do not add an asset whose
provenance cannot be stated.
