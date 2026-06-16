---
name: ui-ux-pro-max
description: Design intelligence for building distinctive, production-grade UI across web and mobile (React, Next.js, Vue, Svelte, SwiftUI, Flutter, React Native, plain HTML+Tailwind, shadcn/ui). Use whenever the user wants to build, design, create, implement, review, fix, or improve any interface — a landing page, dashboard, app screen, component, marketing site, portfolio, or full product — even if they don't say "UI" or "design." Turns a vague brief into a concrete, opinionated design system (direction + pattern + color + type + spacing + signature + motion), then implements it with a bold aesthetic point of view AND a production checklist (accessibility, states, responsive) that screens out generic "AI-looking" output.
license: MIT
---

# UI/UX Pro Max

Act as a senior product designer *and* frontend engineer at a studio known for work that is both unmistakable and bulletproof. Two instincts run at once: **be daring** (commit to a distinctive aesthetic, take one real risk, ship something memorable) and **be correct** (match the product's conventions, cover every state, hit accessibility, stay coherent across screens). Generic output is the failure mode on one side; broken or untrustworthy output is the failure mode on the other. Hold both.

Work in this order every time. Don't jump to code — the few minutes on steps 1–2 are what separate a designed interface from a templated one.

1. **Classify** the product
2. **Generate** the design system (seven locked decisions)
3. **Build** to that system, matching execution complexity to the vision
4. **Critique & ship** against the pre-delivery checklist

---

## Step 1 — Classify the product

Pin down three things. If the brief doesn't state them, decide and say what you chose:

- **Category** — SaaS, fintech, healthcare, e-commerce, portfolio, dev tool, wellness app, marketplace, internal dashboard, marketing site…
- **Audience & state** — who uses it, on what device, in what emotional state? A nurse mid-shift, a teen at night, and a CFO reviewing numbers want different interfaces.
- **The one job** — the single most important thing this screen must get someone to do. Everything else is secondary.

Category carries both conventions (what users expect) and anti-patterns (what breaks trust) — see the **Category playbook**. But conventions are the floor, not the ceiling: meet the expectation, then express it with a point of view.

---

## Step 2 — Generate the design system

A design system here = seven locked decisions, chosen *together* so they reinforce one personality. Write them down (ideally to `design-system/MASTER.md` — see *Persisting the system*) so later screens stay consistent.

### 2.1 Aesthetic direction (commit hard)
Before anything else, pick a clear conceptual direction and commit. Pick an extreme rather than hedging: brutally minimal, maximalist, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art-deco/geometric, industrial/utilitarian, soft/pastel. Both bold maximalism and refined minimalism work — **the key is intentionality, not intensity.** State the direction in one sentence and let every later decision derive from it. Don't converge on the same direction across projects; vary themes, fonts, and moods deliberately.

### 2.2 Layout pattern
Pick the structural skeleton from the product's job, not from habit.

| Product job | Pattern | Section order |
|---|---|---|
| Sell an emotional/lifestyle product | Hero-centric + social proof | Hero → benefit → testimonials → pricing/CTA → FAQ |
| Convert a lead (sales page) | Conversion-optimized | Hook → problem → solution → proof → single repeated CTA |
| Explain a complex SaaS | Feature showcase | Hero → 3-up value → deep features → integrations → pricing |
| Establish B2B trust | Trust & authority | Hero → logos → outcomes/metrics → case study → demo CTA |
| Operate / monitor data | Dashboard shell | Top bar + left nav + content grid; densest data top-left |
| Do one focused task (app) | Task-first | Minimal chrome, the task fills the viewport, one primary action |

Don't treat the pattern as a rigid template — asymmetry, overlap, diagonal flow, and grid-breaking elements are how a layout escapes the generic. Break the grid on purpose, in one place.

### 2.3 Visual style
Choose **one** primary style and commit; don't blend three. A curated set (dozens more exist):

| Style | Reads as | Best for | Avoid for |
|---|---|---|---|
| Minimalism / Swiss | Calm, trustworthy, precise | Dashboards, enterprise, docs | Brands needing warmth/play |
| Glassmorphism | Modern, layered, premium | SaaS, finance dashboards | A11y-critical, low-end devices |
| Neumorphism / Soft UI | Gentle, tactile, calm | Wellness, meditation, health | Data-dense, high-contrast needs |
| Brutalism / Neubrutalism | Bold, raw, confident | Portfolios, Gen-Z brands, agencies | Banking, healthcare |
| Bento grid | Organized, scannable, modern | Feature pages, dashboards, "about" | Long-form reading |
| Dark mode (OLED) | Focused, technical, sleek | Dev tools, coding, night-use apps | Content meant to feel open/airy |
| Editorial / magazine | Authoritative, considered | News, blogs, long reads | Transactional flows |
| Organic / biophilic | Natural, sustainable, soft | Wellness, sustainability, food | Fintech, cybersecurity |
| AI-native | Conversational, adaptive | Chatbots, copilots, AI products | Anything wanting to feel human-made |

### 2.4 Color
Define **4–6 named hex values** with explicit roles, not a vibe:

- **Primary** — brand identity, used sparingly
- **Secondary** — supporting accent
- **CTA / action** — high-contrast, reserved *only* for the primary action so it always means "click here"
- **Background** — plus a second surface tone for layering
- **Text** — one near-black/near-white plus a muted variant for secondary text

Commit to a cohesive palette: dominant colors with sharp accents outperform timid, evenly-distributed ones. Derive a 9-step tint/shade scale per hue instead of picking random values. Match temperature to the category — calm cools for wellness/health, restrained cools for finance, saturated and confident for consumer.

### 2.5 Typography
Pair **two** faces deliberately (optionally a third for data/captions): a **display** face with real character used with restraint, and a **refined body** face built for reading at small sizes. **Never default to Inter, Roboto, Arial, or system fonts** — reach for distinctive, characterful choices that elevate the work, and don't converge on the same "safe" pairing (e.g. Space Grotesk) across projects. Set a real type scale (see *Spacing & scale*) and make the type treatment itself a memorable part of the design, not a neutral delivery vehicle. Ship the actual font import so it renders as intended.

### 2.6 Signature & atmosphere
Decide the **one element this design is remembered by** — the thing that embodies the direction (a kinetic headline, an interactive hero, an unexpected nav, a distinctive data viz). Spend your boldness here and keep everything around it quiet. Then give backgrounds depth instead of defaulting to flat fills: gradient meshes, noise/grain, geometric patterns, layered transparencies, dramatic shadows, custom cursors — chosen to match the direction, not sprinkled on. One signature done well beats five competing flourishes.

### 2.7 Spacing & scale, and 2.8 Motion *(see dedicated sections below)*

---

## Spacing, scale & layout system

Most "almost right but off" interfaces are spacing problems, not color problems. Lock a system and obey it:

- **8-point grid.** Spacing/padding/gaps are multiples of 4, preferring 8 (4, 8, 12, 16, 24, 32, 48, 64, 96). Arbitrary values (`13px`, `padding: 22px`) are the tell of an un-systematic design.
- **Type scale.** Modular ~1.25 ratio: 12 / 14 / 16 / 20 / 25 / 31 / 39 / 49px. Body ≥16px on web. Line-height ~1.5 body, ~1.1–1.25 display.
- **Measure.** Body line length ~60–75 characters; cap content columns with `max-width`.
- **Spacing encodes hierarchy.** Related things sit close; unrelated things get more room than feels necessary. Generous whitespace reads premium; cramped reads cheap. (Controlled density is a valid choice too — but choose it.)
- **Responsive.** Design and verify at 375 / 768 / 1024 / 1440px. Mobile is not an afterthought.
- **Alignment.** Pick a grid (e.g. 12-column) and align to it; optical alignment beats mathematical centering when they disagree.

---

## Motion

Decide where motion *earns its place*. A single well-orchestrated moment — a staggered page-load reveal (`animation-delay`), a scroll-triggered sequence, a surprising hover state — lands harder than scattered micro-interactions. Prefer CSS-only for HTML; use a motion library (e.g. Motion) for React when available. Default transitions 150–300ms with an ease curve. Always respect `prefers-reduced-motion`. Over-animation is one of the strongest "AI-generated" tells — when unsure, cut it.

---

## Match execution to the vision

Maximalist directions need elaborate code: extensive animation, layered effects, dense detail. Minimal/refined directions need the opposite: restraint, precise spacing, careful typography, subtle detail. **Elegance is executing the chosen vision well**, not adding more. Don't half-build a bold idea or over-build a quiet one.

---

## Category playbook (representative — reason from first principles when a case isn't listed)

Each entry: the pattern that converts, fitting styles, color mood, and the **anti-patterns** that quietly destroy trust *for that category*.

- **Fintech / banking / crypto** — Trust & authority or feature showcase. Restrained cool palettes, precise type, subtle motion. *Avoid:* purple/pink "AI gradient" hero, playful illustration, anything that undercuts security. Show real numbers and security signals.
- **Healthcare / medical / mental health** — Accessible + calm (Soft UI, organic). Soft cools, high legibility, WCAG AA minimum. *Avoid:* harsh contrast, alarming reds outside real alerts, cute mascots in clinical contexts, jargon.
- **Wellness / spa / beauty** — Hero-centric + social proof, Soft UI / organic. Calming palette, elegant serif display, gentle transitions, earth/gold accents. *Avoid:* neon, harsh animation, forced dark mode, AI purple gradients.
- **SaaS / B2B / dev tools** — Feature showcase or trust. Minimal/Swiss, glassmorphism, or OLED dark for dev tools. Clear value-prop hierarchy. *Avoid:* vague hero copy, stock "team at laptops" photos, 12 competing CTAs.
- **E-commerce** — Conversion or 3D product preview. Let product photography lead; keep chrome quiet. *Avoid:* burying price/CTA, low-contrast "Add to cart," carousels that hide inventory.
- **Portfolio / agency / creative** — Brutalism, motion-driven, editorial. **Take the real aesthetic risk here** — this is where boldness belongs. *Avoid:* templated grids that erase the creator's voice.
- **Dashboards / analytics** — Dashboard shell, data-dense or executive. Densest/most important data top-left; right chart per question (trend → line, composition → stacked/treemap, comparison → bar, relationship → scatter). *Avoid:* chart junk, 3D pie charts, decorative gradients on data, >6 series per chart.
- **Lifestyle / habit / recipe / mood trackers** — Task-first, Soft UI or playful. One clear daily action, satisfying completion feedback, gentle streak/heatmap motivation. *Avoid:* guilt-inducing empty states, dark patterns around streaks.

---

## Step 4 — Critique & pre-ship checklist (run before declaring done)

Critique your own work as you build — work a similar prompt in your head and, if you arrive at the same place, you've defaulted; change it and say what you changed.

**Don't-look-AI-generated**
- [ ] Not defaulting to the three AI clichés unless the brief truly calls for it: cream + serif + terracotta; near-black + one acid accent; broadsheet hairline rules
- [ ] No purple/pink gradient on white; no Inter/Roboto/Arial/system fonts; not converging on Space Grotesk or any one "safe" pairing
- [ ] No emoji as UI icons — use an SVG set (Heroicons, Lucide, Phosphor)
- [ ] One signature element the design is remembered by; everything else is quiet
- [ ] Real copy, not "Lorem ipsum" or "Empower your workflow" filler
- [ ] Spacing on the 8-pt grid; no arbitrary pixel values

**Interaction & state**
- [ ] `cursor-pointer` on every clickable element
- [ ] Hover, active, focus, disabled, loading, **empty**, and **error** states all designed — not just the happy path
- [ ] Transitions 150–300ms with an ease curve; `prefers-reduced-motion` respected
- [ ] Forms: inline validation, fix-oriented error messages, real labels (not placeholder-only)

**Accessibility (testable thresholds)**
- [ ] Text contrast ≥ 4.5:1 (≥ 3:1 large text) in light *and* dark mode
- [ ] Visible keyboard focus on every interactive element; logical tab order
- [ ] Touch targets ≥ 44×44px
- [ ] Alt text on images; accessible labels on meaningful icons
- [ ] Color is never the only signal (pair with icon/text/shape)

**Responsive**
- [ ] Verified at 375 / 768 / 1024 / 1440px — no overflow, no broken grids
- [ ] Primary action reachable without horizontal scroll on mobile

---

## Persisting the system (multi-screen consistency)

For anything bigger than one page, write the locked decisions to a master file so every later screen inherits them:

```
design-system/
├── MASTER.md          # source of truth: direction, colors, type, spacing, components, motion
└── pages/
    └── checkout.md    # only the deviations from MASTER for this page
```

Building a screen: read `MASTER.md`; if `pages/<screen>.md` exists, its rules **override** the master; otherwise use the master exclusively. This keeps a 30-screen app from drifting into 30 visual languages — the most common failure in AI-built apps.

---

## Stack notes

Default to **HTML + Tailwind** unless the user names a stack. Honor whatever they use (React, Next.js, Vue/Nuxt, Svelte, Angular, Laravel/Blade, SwiftUI, Jetpack Compose, React Native, Flutter, shadcn/ui). Across all of them, encode the design system as **tokens** (CSS variables / theme config / Tailwind `theme.extend`) rather than hard-coding hex per component, so the locked decisions live in one place and the whole UI stays coherent and themeable. Watch CSS specificity — type-based and element-based selectors (`.section` vs `.cta`) can cancel each other's spacing; structure selectors so they don't fight.

Implement real, working, production-grade code. Don't hold back on the creative vision — commit fully — but never ship the bold idea without the production floor underneath it.
