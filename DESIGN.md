# ARMissionWeb Quiz UI Design System

This contract records the quiz screen at `/quiz/[EventKey]` and the POI marker state transition on the map. The quiz visual inventory comes from the existing quiz component and supplied iPhone Safari screenshot; the map marker tokens below are extracted from its existing red/green marker assets and CSS. Keep each surface's existing palette and behavior except for the documented marker celebration motion.

## 1. Atmosphere & Identity

The quiz is a bright, playful arcade screen: a translucent timer card and white question surface sit over a saturated indigo-to-purple-to-pink prompt, followed by high-energy, color-coded answer buttons. Its signature is the contrast between soft glass-like white panels and chunky, dimensional answer controls. This is a compact timed interaction, not a general app-shell redesign.

## 2. Color

Quiz colors are the existing Tailwind utility palette used by `QuizPart`; do not introduce a separate global theme or recolor the choices.

| Role | Existing token/classes | Usage |
|------|------------------------|-------|
| Canvas | `bg-background` (`--background`, white) | Global quiz page canvas |
| Main panel | `bg-white/95`, `bg-white/80` | Question, answer, and timer surfaces |
| Panel edge | `border-white/20`, `border-white/40` | Soft panel separation/highlight |
| Prompt gradient | `from-indigo-600 via-purple-600 to-pink-500` | Text-only question card |
| Prompt text | `text-white` | Question copy and colored answer labels |
| Timer ink | `text-slate-600`, `text-slate-900` | Timer label and countdown |
| Timer track/fill | `bg-slate-200`, `bg-rose-500` | Remaining-time indicator |
| MC choices, in order | `bg-red-600`, `bg-blue-600`, `bg-yellow-500`, `bg-green-600` | Four answer choices; dark lower edges use corresponding `border-*-900`/`border-*-800` classes |
| OX choices | `bg-blue-600`, `bg-red-600` | O and X default states |
| Correct/incorrect result | `bg-green-500`, `bg-red-500` | Submitted answer feedback |
| Unselected result | `bg-slate-100`, `text-slate-300`, `opacity-20` | De-emphasized choices after submission |

Color is redundant with the choice label/icon and the Korean result message; do not make color the only correctness signal. The yellow MC option currently retains white text for fidelity; its contrast is a recorded follow-up, not a reason to silently change the palette here.

## 3. Typography

| Role | Existing scale/classes | Weight and treatment |
|------|------------------------|----------------------|
| Family | `Malgun Gothic`, `맑은 고딕`, `sans-serif` | Inherited from `globals.css` |
| Timer label | `text-xs` | `font-black`, uppercase, wide tracking |
| Countdown | `text-base` | `font-black`, slate ink |
| MC prompt | `text-base sm:text-xl` | `font-black`, tight tracking, snug leading |
| Short-answer prompt | `text-2xl sm:text-4xl` | `font-black`, tight tracking |
| MC answer | `text-lg` | `font-black`, uppercase, italic |
| OX answer | `text-7xl` | `font-black` |
| Result heading | `text-4xl` | `font-black`, uppercase |

Keep the existing bold, energetic hierarchy and Korean-capable system font. Do not add a new font dependency or global type scale as part of this quiz-only fix.

## 4. Spacing & Layout

### Base Unit

Spacing follows Tailwind's existing 4px base scale. The quiz uses `p-3`/`p-4` panel insets, `gap-3` between the timer/question/answer regions, `gap-2` between answer choices, and `px-4 py-3` for timer content. Existing custom corner sizes are recorded in Section 7 rather than normalized during this fix.

### Grid and Viewport

- The quiz owns a full-width viewport frame, with a timer row, flexible question row, and flexible answer row. MC/OX use the existing 3:2 question-to-answer allocation; short answer retains its 4:1 allocation.
- The route uses the dynamic visible height (`100dvh`/`h-dvh`) and route-scoped `viewport-fit=cover`. The frame adds its normal bottom inset plus `env(safe-area-inset-bottom)` so content remains above the device's unsafe edge.
- Grid rows and children that must shrink use `minmax(0, …)` and `min-h-0`. The document/body remain non-scrolling under the existing global `overflow-hidden` rule.
- The question's prompt/media flex column can shrink in a short viewport; at normal height the media still fills its flexible share and the existing prompt minimum remains.
- When available height is genuinely insufficient, the answer panel alone owns vertical scrolling; the timer and question panel stay in place. The 2-by-2 MC choice grid remains intact, with no fixed mobile button height.
- Spatial pattern: [StyleGallery `scroll-body-shell`](https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/scroll-body-shell.md), adapted so only the quiz answer panel scrolls. The viewport frame is bounded; its answer panel is the named scroll owner.
- The responsive layout uses the existing `sm` breakpoint (640px) to preserve the larger desktop OX sizing and short-answer prompt treatment.

## 5. Components

### `QuizFrame`
- **Structure**: A `main` grid containing timer, question, and answers in source/reading order.
- **Variants**: MC/OX rows (`auto minmax(0, 3fr) minmax(0, 2fr)`); short-answer rows (`auto minmax(0, 4fr) minmax(0, 1fr)`).
- **Spacing**: Existing `gap-3`, `p-3`/`sm:p-4`; bottom padding includes the safe-area inset.
- **States**: Active quiz; completed quiz with the existing result overlay.
- **Accessibility**: Keep DOM, reading, and focus order aligned. Bound the frame to the visible viewport without hiding the answer scroll affordance.
- **Motion**: Preserve the existing quiz entry zoom; disable it under reduced motion.
- **Layout**: Full-viewport shell; never owns scrolling itself.

### `QuizPanel`
- **Structure**: A semantic section used for the timer, question, and answer surfaces.
- **Variants**: Existing translucent timer card; white question panel; white answer panel.
- **Spacing**: Current padding and radii remain caller classes; use `min-h-0` so grid tracks can shrink.
- **States**: Static surface in the active quiz; the answer panel becomes scrollable only when its content exceeds its allocated height.
- **Accessibility**: Preserve section labels/semantics and the timer text; do not use the panel as a button.
- **Motion**: None.
- **Layout**: Grid child; the answer panel is the only scroll owner and uses contained vertical scrolling.

### `QuizAnswerGrid`
- **Structure**: Two columns by two rows, with one `QuizAnswerChoice` per option.
- **Variants**: MC choices (four cells) and existing OX choices (two cells in the same grid).
- **Spacing**: Existing `gap-2`; grid tracks and children use `min-h-0`/`minmax(0, 1fr)`.
- **States**: Default, hovered, pressed, keyboard-focused, and submitted result states are expressed by each choice.
- **Accessibility**: Preserve option order and visible text labels; decorative shape glyphs are hidden from assistive technology.
- **Motion**: Existing scale feedback on hover/press; reduced motion disables scale/transition effects.
- **Layout**: Fills the answer panel and does not scroll independently.

### `QuizAnswerChoice`
- **Structure**: A native button with the existing text and optional Lucide shape glyph.
- **Variants**: MC and OX sizing; option color; correct, selected-wrong, and de-emphasized submitted states.
- **Spacing**: Existing rounded corners, lower-edge depth, and label padding; at least a 48px minimum touch target without a fixed mobile height.
- **States**: Default option color; hover/press affordance; visible keyboard focus; completion colors remain unchanged. `QuizPart.check` continues to guard repeat answers and owns scoring/result behavior.
- **Accessibility**: Native button semantics, option text as the accessible name, explicit focus-visible ring, and at least 48px minimum target. Do not rely only on color to communicate correctness.
- **Motion**: Existing hover/press scale transitions, disabled under reduced motion.
- **Layout**: Stretches to its 2-by-2 grid cell and can wrap long option labels without forcing horizontal overflow.

### Quiz result overlay (existing)
- **Structure**: Fixed full-screen dimmed overlay with correctness status and one next-mission action.
- **Variants**: Correct/incorrect status; timer-expiry incorrect state.
- **Spacing**: Existing full-screen inset, centered white result cards, and single action.
- **States**: Appears after answer submission or timeout; its existing navigation target is unchanged.
- **Accessibility**: Keep the result text and action in DOM order; the action remains a native button.
- **Motion**: Existing fade/blur entry.
- **Layout**: Fixed overlay above the quiz; it does not change answer submission or navigation behavior.

## 6. Motion & Interaction

| Interaction | Existing treatment | Reduced-motion behavior |
|-------------|--------------------|-------------------------|
| Quiz entry | `animate-in zoom-in` | No entry zoom |
| MC/OX hover and press | Existing `transition-all`, scale-on-hover/press variants | No scale or transition |
| Timer progress | `scaleX` from the left changes once per second | Progress remains visible without a decorative transition |
| Result overlay | Existing fade-in and backdrop blur | No entrance animation |

Answer selection stays immediate and one-shot; the timer, score request, correctness calculation, and next-mission flow are not altered by layout changes. Motion is limited to existing affordance/state feedback; do not add decorative animation.

## 7. Depth & Surface

### Strategy

Mixed depth: translucent white panels use a light border, backdrop blur, and broad dark shadows; the prompt is a saturated gradient with an inset shadow; answer buttons use a thick darker lower edge and a strong shadow to retain the chunky arcade-control look.

### Radius

Existing quiz radii: timer `20px`, question/answer surfaces `24px`, MC choices `30px`, OX choices `36px`, and nested prompt/media `16px`. Preserve these radii rather than imposing the global card radius on the quiz.

### Existing Elevation

- Timer: `0 12px 32px rgba(15,23,42,0.15)` with `backdrop-blur`.
- Question: `0 18px 56px rgba(15,23,42,0.25)` plus `shadow-inner` on the prompt.
- Answers: `0 14px 40px rgba(15,23,42,0.2)` with `backdrop-blur`; choice controls retain `shadow-xl` and their lower-edge depth.
- Result overlay: `0 24px 80px rgba(15,23,42,0.45)` over a dimmed, blurred backdrop.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA: 4.5:1 contrast for normal text and 3:1 for large/bold text; visible focus on every answer/action; native button/input semantics; logical Korean-language reading order; answer controls target at least 48px; respect `prefers-reduced-motion`.
- Timer progress exposes its current remaining value to assistive technology. The choices remain text-labeled; decorative shape icons do not duplicate the label.
- The answer panel is the only scroll region when needed. Keep it operable by touch and keyboard and never let global body overflow make the timer/question scroll away.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| White text on the yellow MC answer color may not meet AA contrast | `QuizPart` MC option 3 | Preserve the approved existing answer-color design in this narrowly scoped viewport fix; no palette redesign is authorized | Product owner; revisit with a contrast-preserving label treatment |
| Physical iPhone Safari visual confirmation is outstanding | `/quiz/[EventKey]` | Browser automation was explicitly prohibited for this task; code-level checks cannot prove the live Safari toolbar/safe-area rendering | Parent handoff; manually inspect a short-height iPhone Safari viewport before deployment |

## 9. Map POI Marker Transition

### Color and Shape

| Role | Existing colors | Usage |
|------|-----------------|-------|
| Unvisited marker | `#ff8080`, `#ff0000`, `#b30000` | Red three-dimensional POI marker |
| Visited marker | `#a0ffa0`, `#00ff00`, `#00b300` | Green three-dimensional POI marker |
| Visited glow/ripple | Green marker ramp above, with alpha | Temporary celebration feedback around a visited marker |

Keep the existing 30px marker size and map-counter-rotation behavior. The red and green marker assets crossfade in place so the location stays visually anchored while its state changes.

### Motion & Interaction

| Interaction | Treatment | Reduced-motion behavior |
|-------------|-----------|-------------------------|
| POI becomes visited | Wait 1000ms, then crossfade red to green over 1200ms | Show the green marker immediately |
| Visit celebration | Two 1800ms scale/flip/bounce cycles (3600ms total), with two matching circular ripple and glow pulses; begins after the same 1000ms delay | Omit the celebration motion |

The marker transition communicates mission completion. Use transform and opacity for animated layers; do not add a perpetual visited-state pulse.
