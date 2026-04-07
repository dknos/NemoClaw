# WEIRDBOX — Workshop Console Game Brief

## What This Is

WEIRDBOX is the workshop crew's own retro gaming console — a standalone HTML/CSS/JS page inspired by PIPEBOX but with its own identity. The agents (Candy, MaoMao, CodeGen) build and improve it iteratively during workshop sessions.

**NOT a copy** — WEIRDBOX should feel like a cousin of PIPEBOX. Same retro-CRT DNA, but weirder, glitchier, with its own color palette, its own games, its own personality.

## Name & Branding

- Name: **WEIRDBOX**
- Tagline: "BUILT BY AGENTS. PLAYED BY HUMANS."
- Personality: Glitchy, surreal, slightly unsettling. The UI should feel like it was assembled by AIs who almost understand games.

## Visual Identity

### Color Palette (DIFFERENT from PIPEBOX)

- **Primary**: `#ff3366` (hot pink/magenta — NOT teal)
- **Secondary**: `#00e5ff` (electric cyan)
- **Accent**: `#ffe033` (glitch yellow)
- **Background**: `#0a0014` (deep purple-black)
- **Panel**: `#1a0028` (dark plum)
- **Text Bright**: `#fff0f5` (warm white)
- **Text Dim**: `#6a3060` (muted mauve)
- **Error/Danger**: `#ff0040`
- **Success**: `#00ff88`

### CRT Effects (keep these from PIPEBOX)

- Horizontal scanlines: `linear-gradient(transparent 50%, rgba(0,0,0,0.12) 50%)` @ `background-size: 100% 3px`
- Vertical RGB shift: `linear-gradient(90deg, rgba(255,0,80,0.03), rgba(0,229,255,0.02), rgba(255,224,51,0.03))` @ `background-size: 3px 100%`
- Screen glow: `box-shadow: inset 0 0 30px rgba(0,0,0,0.9), 0 0 12px rgba(255,51,102,0.15)`
- Body glow: `box-shadow: 0 0 60px rgba(255,51,102,0.10), 0 0 120px rgba(0,229,255,0.04)`

### Typography

- **Pixel Font**: "Press Start 2P" from Google Fonts
- **Labels**: monospace, 8-10px, bold, letter-spacing: 1-3px
- **Headers**: "Press Start 2P", 11-14px

### Glitch Effects (WEIRDBOX specialty)

- Random CSS `transform: skewX()` on text (2-5deg, brief flicker)
- Occasional RGB split: text-shadow with offset red/cyan copies
- Screen "tear" — a 2px horizontal line that scrolls down occasionally
- Static noise overlay (CSS animation with random opacity)

## Layout Structure

```text
┌─────────────────────────────────────────────────┐
│  WEIRDBOX HEADER                    [MUTE] [?]  │
│  Logo + Agent Status + Currency                  │
├─────────────────────────────────────────────────┤
│  [TAB] [TAB] [TAB] [TAB] [TAB]                 │
├──────────┬──────────────────────┬───────────────┤
│  ACTION  │                      │  INVENTORY    │
│  PANEL   │   GAME SCREEN        │  GRID         │
│  (btns)  │   (canvas 800x440)   │  (items)      │
│          │   .pb-screen class    │               │
│          │                      │               │
└──────────┴──────────────────────┴───────────────┘
│  STATUS BAR — agent activity, last action        │
└─────────────────────────────────────────────────┘
```

## Available Sprite Assets (at /assets/weirdbox/)

The game runs in an iframe with same-origin access — sprites load fine via `<img src="/assets/weirdbox/...">` or `new Image()` in canvas.

### Characters (/assets/weirdbox/sprites/)

- `slime.png` — slime spritesheet (~4-6 frames)
- `frog.png` — frog spritesheet
- `ogre.png` — ogre spritesheet
- `wizard.png` — wizard spritesheet
- `mummy.png` — mummy spritesheet
- `drone.png` — mechanical drone
- `observer.png` — floating mechanical eye
- `sentinel.png` — robot sentinel
- `alien-fly.png` — flying alien spritesheet (8 frames)
- `alien-walk.png` — walking alien spritesheet

### Backgrounds (/assets/weirdbox/bg/)

- `cyberpunk-corridor.png` — neon corridor
- `back-walls.png` — industrial walls
- `bulkhead-wallsx1.png` — sci-fi bulkhead
- `tiles.png` / `tileset.png` — general tiles

### Effects (/assets/weirdbox/fx/)

- `explosion-5.png` / `explosion-animation.png` — explosion sprites
- `gems-spritesheet.png` — collectible gems
- `hit.png` — hit effect
- `electro-shock.png` — electric shock effect
- `energy-shield.png` — shield effect
- `energy-smack.png` — impact effect

You can also use emoji + canvas drawing for anything not covered by sprites. Go wild — this is your game.

## Game Modes (agents should build these)

### 1. CREATURE HUNT (like BugHunt)

- Spend currency to scan for creatures
- Creatures have rarities: Common, Rare, Ultra, Legendary, Mythic
- Use sprite assets for creature visuals
- Canvas-based reveal animation with particles

### 2. ARENA (interactive mini-game)

- Shoot/click on moving creatures
- 30-second timed rounds
- Score = creatures defeated
- Use Canvas2D or Pixi.js for rendering
- Creature sprites move around screen, player clicks to defeat

### 3. FUSION LAB (like Alchemy)

- Combine creatures to create new ones
- 3 input slots → 1 output
- Visual: drag-and-drop slots, smash animation, particle burst

### 4. WEIRD ZONE (unique to WEIRDBOX)

- Surreal mini-experience
- Glitch effects, impossible geometry
- The agents can be creative here — this is their space

### 5. SHOP

- Buy upgrades with currency
- Scan speed, luck boosts, auto-hunt

## Game State Structure

```js
{
  coins: 100,          // main currency (use gem emoji 💎)
  energy: 50,          // secondary (use ⚡)
  level: 1,
  xp: 0,
  inventory: {},       // creatureId → count
  totalHunts: 0,
  totalKills: 0,
  upgrades: {},
  achievements: []
}
```

## Rarity System

| Rarity | Color | Glow | Drop Rate |
|--------|-------|------|-----------|
| Common | `#8a6aaa` | dim purple | 60% |
| Rare | `#ffe033` | warm gold | 25% |
| Ultra | `#00e5ff` | bright cyan | 10% |
| Legendary | `#ff3366` | hot pink | 4% |
| Mythic | `#ffffff` | white+rainbow | 1% |

## Audio (Web Audio API)

- Use `tone(freq, type, vol, dur)` for SFX
- Click: 440Hz sine, 0.04vol, 50ms
- Hunt start: 200→800Hz sweep, 0.3s
- Common catch: single beep
- Rare+: ascending chords
- Use OscillatorNode + GainNode (no external audio files needed)

## Tech Stack (single HTML file)

- Canvas2D for game rendering (simpler than Pixi.js for standalone HTML)
- CSS animations for UI effects
- Web Audio API for sound
- Press Start 2P font from Google Fonts
- Font Awesome CDN for icons
- NO external JS libraries needed — vanilla JS only
- All CSS inline in `<style>`, all JS in `<script>`

## Key Differences from PIPEBOX

1. **Color**: Hot pink/cyan/yellow vs PIPEBOX's teal/coral
2. **Mood**: Glitchy/surreal vs PIPEBOX's clean retro
3. **Name**: WEIRDBOX, not PIPEBOX
4. **Creatures**: Use sprite assets, not emoji bugs
5. **Identity**: "Built by agents" — show agent personality in the UI
6. **Standalone**: Pure HTML/CSS/JS, no React, no build tools
