# Design Language: "Opal"

A quiet, editorial design system based on opal.fashion. Most of the screen is calm: an off‑white canvas, ink‑black type, generous space, and no ornament. Two things give it character: a large **italic serif** and **objects that float** on the surface with soft shadows. Everything else stays in the background.

## Principles

1. **Restraint first.** No decorative gradients, heavy borders, emoji or accent colors. Color comes only from content such as images, artwork and product shots.
2. **Content as objects.** Show important items (products, projects, media) like things resting on a table: soft shadow, lots of space, centered. Avoid dense card grids.
3. **Two voices.** An italic serif for anything expressive, like headlines and names. A small lowercase sans for anything functional, like UI, labels and controls.
4. **Centered and calm.** Use a central axis. Separate sections with space, not lines.
5. **Slow, soft motion.** Long ease‑outs. Things rise and fade in. Save springy overshoot for one signature interaction.

---

## Color tokens

Define every color as a CSS variable, and never hardcode a color in a component.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#fafafa` | `#0b0b0b` | App background |
| `--bg-elev` | `#ffffff` | `#141414` | Raised surfaces: dialogs, popovers, sheets |
| `--bg-sunken` | `#f2f2f1` | `#101010` | Hover fills, wells, inputs |
| `--ink` | `#111111` | `#f2f2f0` | Headlines, primary text, active state |
| `--ink-2` | `#3a3a3a` | `#cfcfcd` | Body copy |
| `--ink-muted` | `#8a8a8a` | `#8e8e8e` | Labels, meta, nav, timestamps |
| `--faint` | `#c9c9c9` | `#3a3a3a` | Resting underlines, list markers, separators |
| `--line` | `rgba(17,17,17,.08)` | `rgba(255,255,255,.09)` | Hairline rules |
| `--shadow` | `rgba(0,0,0,.14)` | `rgba(0,0,0,.7)` | Drop shadows |

- **Text hierarchy:** ink → ink‑2 → ink‑muted → faint. Most screens need only three of these.
- **States without color:** for hover, active and selected, move one step up the ink ladder (`ink-muted` → `ink`) or add a `--bg-sunken` fill. Don't introduce a brand color for this.
- **Errors and success, if needed:** one muted red (`#d92d20` light, `#ff6b5e` dark), used only for text. Never fill large areas with it.
- **Name collisions:** if you use shadcn or Tailwind, don't name your tokens `--muted`, `--border` or `--accent`. Point their tokens at yours instead.

### Theming

- Mark dark mode with a `.dark` class on `<html>`.
- Set the theme **before first paint** with an inline script: the saved `localStorage.theme` first, then `prefers-color-scheme`. (In this app: the `theme` setting, `system` → `prefers-color-scheme`.)
- The toggle is a single 15px sun or moon line icon in a 30px round button.
- Animate `background-color` and `color` on `body` over `.4s` so switching themes is a soft cross‑fade.

---

## Typography

| Role | Font | Notes |
|---|---|---|
| Display / headings | **Instrument Serif, italic, 400** | Always italic. Never bold. |
| UI / body | **Inter, 400–700** | Weight 600 for emphasis lines |
| Data / meta (optional) | System monospace | File sizes, IDs, counts |

| Class | Size | Style | Use |
|---|---|---|---|
| `.display` | `clamp(3.25rem, 8vw, 7.25rem)` | serif italic, lh .95, ls −0.02em | Hero, one per screen |
| `.h2` | `clamp(2.5rem, 5.5vw, 4.5rem)` | serif italic | Section and page titles |
| `.h3` | `clamp(1.5rem, 2.4vw, 2rem)` | serif italic, lh 1.05 | Group titles |
| `.lead` | `clamp(1.25rem, 2.2vw, 1.75rem)` | Inter 600, ls −0.02em | Key statement under a headline |
| `.eyebrow` | `13px` | Inter, **lowercase**, ink‑muted | Label above a heading |
| body | `15–16px` | Inter, lh 1.55–1.65, ink‑2 | Paragraphs |

**Type rules**

- Functional text is **lowercase**: nav, buttons, labels, tags. For example "settings", "save", "copy link".
- Headings are sentence case in the italic serif.
- External links end with **↗**.
- Keep lines short: about `34em` for prose and `62ch` for lists.
- Separate inline items with ` · ` (a middle dot with spaces).
- Numbers and dates use `tabular-nums`.

Fonts: the app must work offline, so load Instrument Serif and Inter from Google Fonts with a `<link>` and fall back to `"Times New Roman", serif` / `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

---

## Layout and spacing

| Token | Value |
|---|---|
| `--maxw` | `1200px` |
| `--gutter` | `clamp(16px, 2.6vw, 52px)` |
| Section padding | `clamp(96px, 14vw, 180px)` vertical. For dense app views, scale it to about a third. |
| Radius | `999px` icon buttons · `14–16px` objects · `22px` dialogs |

- Make spacing fluid with `clamp()`. Breakpoints only to stack content (≈760, 640, 420px).
- Each section intro is centered: eyebrow, heading, then an optional muted line.

---

## Components

**Top bar** — sticky, transparent at top; after 8px scroll: `color-mix(in srgb, var(--bg) 78%, transparent)`, `backdrop-filter: blur(14px) saturate(1.4)`, 1px `--line` under. Left: lowercase italic serif wordmark ≈30px. Right: lowercase 15px links in `ink-muted` → `ink` on hover, then the theme toggle.

**Text link** — `ink` text with a 1px underline that draws in from the left on hover/focus (`::after` `scaleX(0→1)`, `.4s`).

**Icon button** — round, 30–36px, `ink-muted`; hover → `ink` + `--bg-sunken` fill. Lucide icons at stroke 1.5 (inline SVG).

**Primary action** — pill or 14px radius, `--ink` fill, `--bg` text, lowercase. Hover lifts `translateY(-2px)`, pressed scales `.97`. Only one per screen.

**Dialog / sheet** — native `<dialog>` + `showModal()`. Esc and backdrop click close it. Panel `--bg-elev`, 22px radius, `box-shadow: 0 40px 80px -24px var(--shadow), 0 0 0 1px var(--line)`. Backdrop `color-mix(--bg 55%)` + `blur(10px)`.

**Spec sheet / settings list** (signature list pattern) — rows separated by `--line` hairlines. Two columns: muted lowercase label (150–220px) left, value right (semibold title, muted secondary line). Expandable rows are buttons with `aria-expanded`; a thin + rotates into −. ≤640px columns stack.

**Floating object** — centered, lots of space; shadow is a blurred ellipse under the object (`radial-gradient` or `filter: blur(22px)`, 34% black light / 62% dark). Tilts 3–4° toward the pointer.

**Inputs** — `--bg-sunken` fill, no border; focus adds a 1px `--ink` ring. Labels are lowercase eyebrows above; placeholder in `--faint`.

**Copy / confirm feedback** — swap the label itself ("save" → "saved" for 1.6s), announce via `aria-live="polite"`. No toasts.

**Focus** — always `1px solid var(--ink)` outline offset 4–6px.

---

## Motion

| Name | Curve | Use |
|---|---|---|
| `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | Almost everything |
| `--ease-soft` | `cubic-bezier(.2, .8, .2, 1)` | Fades, image drift |
| `--spring` | `cubic-bezier(.34, 1.36, .5, 1)` | **One signature interaction only** |

Durations: `.3s` hover · `.4s` theme/underline/header · `.45s` dialog in · `.5–.55s` expand/collapse · `.75–.9s` reveals & moving objects · `1.1s` page entrance.

Patterns: entrance (opacity + translateY 16px→0, 1.1s, stagger 80–180ms) · scroll reveal (`.reveal` → `.is-in`) · expand via `grid-template-rows: 0fr → 1fr` with collapsed content `inert` · dialog in (opacity, translateY 12px, scale .98→1, .45s) · list stagger 40–90ms · pointer parallax via CSS vars in rAF.

**Signature interaction for this product:** the companion's flight to the thing it points at — the only place `--spring` is used.

Reduced motion: with `prefers-reduced-motion: reduce`, turn off entrances, reveals, parallax. State changes still happen, instantly.

## Accessibility

Real `<button>`/`<a>`; disclosures use `aria-expanded` + `aria-controls`, hidden content `inert`; dialogs are native modals labelled by their title; `--ink-muted` only for labels/meta; every focus state visible.

## Do / Don't

Use tokens for every color · italic serif headlines · lowercase UI text · whitespace · hairlines between rows · long ease-out motion · content carries the color · one signature interaction. Don't hardcode hex in components, bold/sans headlines, Title Case buttons, badges/icons/dividers filling space, boxes around everything, bouncy motion everywhere, brand accent color.

## Starter CSS

```css
:root {
  --bg: #fafafa; --bg-elev: #fff; --bg-sunken: #f2f2f1;
  --ink: #111; --ink-2: #3a3a3a; --ink-muted: #8a8a8a; --faint: #c9c9c9;
  --line: rgba(17,17,17,.08); --shadow: rgba(0,0,0,.14);
  --danger: #d92d20;
  --serif: "Instrument Serif", "Times New Roman", serif;
  --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif;
  --display: clamp(3.25rem, 8vw, 7.25rem);
  --h2: clamp(2.5rem, 5.5vw, 4.5rem);
  --h3: clamp(1.5rem, 2.4vw, 2rem);
  --gutter: clamp(16px, 2.6vw, 52px); --maxw: 1200px;
  --ease: cubic-bezier(.22, 1, .36, 1);
  --ease-soft: cubic-bezier(.2, .8, .2, 1);
  --spring: cubic-bezier(.34, 1.36, .5, 1);
}
.dark {
  --bg: #0b0b0b; --bg-elev: #141414; --bg-sunken: #101010;
  --ink: #f2f2f0; --ink-2: #cfcfcd; --ink-muted: #8e8e8e; --faint: #3a3a3a;
  --line: rgba(255,255,255,.09); --shadow: rgba(0,0,0,.7);
  --danger: #ff6b5e;
}
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.55 var(--sans); -webkit-font-smoothing: antialiased;
  transition: background-color .4s var(--ease), color .4s var(--ease);
}
.display, .h2, .h3 { font-family: var(--serif); font-style: italic; font-weight: 400; letter-spacing: -.02em; line-height: .95; margin: 0; }
.display { font-size: var(--display); } .h2 { font-size: var(--h2); } .h3 { font-size: var(--h3); line-height: 1.05; }
.lead { font-weight: 600; font-size: clamp(1.25rem, 2.2vw, 1.75rem); letter-spacing: -.02em; line-height: 1.2; }
.eyebrow { font-size: 13px; color: var(--ink-muted); letter-spacing: .01em; text-transform: lowercase; }
.text-link { position: relative; color: var(--ink); text-decoration: none; }
.text-link::after { content: ""; position: absolute; left: 0; right: 0; bottom: -2px; height: 1px; background: currentColor; transform: scaleX(0); transform-origin: left; transition: transform .4s var(--ease); }
.text-link:hover::after, .text-link:focus-visible::after { transform: scaleX(1); }
@keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes dialog-in { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }
:focus-visible { outline: 1px solid var(--ink); outline-offset: 4px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
```
