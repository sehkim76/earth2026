# Draft: /map Page (Current Location Map)

## Requirements (confirmed)
- Create `/map` page.
- Base design/layout matches `/qr`.
- Where ranking used to be, show a map centered on the user's current location.

## Technical Decisions
- Map provider: TBD (default proposal: OpenStreetMap embed via `iframe` so no API key / new deps).
- Location source: Browser `navigator.geolocation.getCurrentPosition` (one-shot) with retry button.

## Research Findings
- `/qr` page is a small wrapper around `QRScanner`: `src/app/qr/page.tsx` -> `mx-auto max-w-xl p-6`.
- The visual style to mirror lives in `src/components/QRScanner.tsx` (dark rounded card, overlays).
- Ranking UI exists as `src/components/Ranking.tsx` used by `src/components/RankingPageClient.tsx` and rendered by `src/app/ranking/page.tsx`.
- No obvious existing map/geolocation usage found yet (pending deeper search).

## Open Questions
- Which map behavior/provider is desired (OSM embed vs Leaflet vs Kakao/Naver/Google)?
- Should `/map` be reachable from existing UI (e.g., add button in ranking toolbar), or just a standalone route?

## Scope Boundaries
- INCLUDE: New `src/app/map/page.tsx` route; client-side geolocation; map render with loading/error states.
- EXCLUDE (unless asked): DB persistence of GPS, ranking changes, auth/session changes, map provider requiring API keys.
