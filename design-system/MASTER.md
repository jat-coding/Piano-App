# Cascade — Design System (MASTER)

Source of truth for the visual language. Every screen inherits these decisions.
Tokens live in `:root` (`src/index.css`) and the `COLORS` object (`src/render/Renderer.ts`);
keep the two in sync.

## 1. Classification
- **Category:** consumer music / practice tool (Synthesia-style piano visualizer + PWA).
- **Audience & state:** a learner at a keyboard, often at night, wanting focus and warmth —
  not a clinical dashboard. Primary device spans phone (landscape) → desktop.
- **The one job:** *press play and watch/learn the song fall* — the canvas is the product;
  chrome stays out of the way and auto-hides.

## 2. The seven locked decisions

**2.1 Aesthetic direction (one sentence):** *A candlelit concert grand at dusk* — warm
ebony wood, ivory & ebony keys, brass hardware, burgundy felt. Refined and tactile, not neon.
(Materially justified by the instrument, so the ebony/ivory/brass + serif combo is intentional,
not the generic "cream + serif + terracotta" AI default.)

**2.2 Layout pattern:** Task-first. Minimal chrome; the falling-note canvas fills the
viewport; a single primary action (Play). Start screen is a centered focal card + library.

**2.3 Visual style:** OLED-adjacent **warm dark mode** with restrained material realism
(ivory key gradients, felt strip, candlelight vignette). One style, committed.

**2.4 Color (named roles):**
| Token | Hex | Role |
|---|---|---|
| `--bg` | `#14110d` | background (warm ebony) |
| `--bg-2` / `--wood` | `#1d1813` / `#2a2018` | layered surfaces |
| `--brass` / `--brass-soft` | `#c2a24a` / `#d8be78` | **CTA / action** — reserved for primary actions & strike line |
| `--orange` | `#d39a52` | right hand (honey amber) |
| `--blue` | `#5f8a96` | left hand (dusty teal-blue) |
| `--sage` | `#a7b86a` | practice "play here" cue (never the only signal — paired with motion + text) |
| `--felt` | `#7a2f33` | burgundy accent (felt strip, loop) |
| `--text` / `--muted` | `#f1e7d0` / `#a89a7e` | ivory text + aged-ivory secondary |

**2.5 Typography:** Display **Fraunces** (characterful old-style serif), body/UI **Spectral**
(serif built for small sizes). No Inter/Roboto/system. Imported from Google Fonts (runtime-cached).
Scale ~1.25: 12 / 14 / 16 / 20 / 25 / 31 / 49.

**2.6 Signature & atmosphere:** the **candlelit keybed** — ivory key gradient + burgundy felt
strip + brass strike line, with a soft candlelight pool radiating up from the keys, and impact
sparks in hand color when a note lands. That's the memorable element; everything else stays quiet.
Backgrounds use vignette + faint wood grain, never flat fill.

**2.7 Spacing & scale:** 8-pt grid (4/8/12/16/24/32/48). **2.8 Motion:** 150–300ms eases;
one staggered start-screen reveal; impacts/glow toggleable; all motion respects
`prefers-reduced-motion`.

## 3. Components & conventions
- **Icons:** custom inline SVG set in `src/components/icons.tsx` (Lucide-style, `currentColor`).
  **No emoji as UI icons.** Icon-only buttons carry `aria-label`.
- **Buttons:** brass = primary only; ghost/outline for secondary. `:focus-visible` brass ring;
  ≥44px touch targets on coarse pointers; `cursor: pointer`.
- **States:** hover/active/focus/disabled + empty (library hidden when empty) + error (parse
  errors, MIDI unsupported) + loading (transcription progress) all designed.

## 4. Deviations
None yet. Add `design-system/pages/<screen>.md` to override for a specific screen.
