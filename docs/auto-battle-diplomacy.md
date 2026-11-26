# 오토배틀 점령전·외교 (구현 중, 1단계)

기획 확정: 60초 편성형 오토배틀 + 솔로=1인 국가 + 동맹 최대 3개국 + 비실시간 외교.

## 1단계 완료 범위

- DB: `TerritoryNation` / `TerritoryNationMember` / `TerritoryDiplomacy` / `TerritorySiege` (`prisma/schema.prisma`).
- 엔진: `src/lib/auto-battle.ts` — 전위3+후위2, 상성(보병>궁병>기병>마법>보병, +30%), 40틱, 스킬 1회, 시드 결정적.
- 국가: `src/lib/nations.ts` — 1인 국가 자동 생성, 국가 선포/이적, 유지비(2개 무료·이후 제곱), 외교 게이트, 게이지 적립.
- API:
  - `GET/POST /api/nations`, `POST /api/nations/join`
  - `GET/POST /api/diplomacy`, `POST /api/diplomacy/respond`
  - `POST /api/auto-battle/resolve`, `GET/POST /api/siege/report`

## 수치

- 솔로 1승 +25, 국가원 1승 +15, 패배 절반(하한 +5). 100이면 점령권.
- 불가침 48h, 선전포고 12h 예고, 동맹 상한 3개국, 파기 시 영향력 -20相当(후속 단계에서 차감).
- 리더만 제안/수락. 1인 국가는 본인이 리더라도 항상 가능.

## 2단계 완료 범위 (게이지-정복 통합 + 외교 이행)

- 정복 일원화: `conquerCastle()` (`src/lib/territory.ts`) — HP 공성·게이지 100·조공 할양 모두 수렴. 기존 `applyCastleDamage` 동작 유지.
- `POST /api/siege/report`: 외교 게이트(수비국과 동맹/불가침이면 409) → 게이지 적립 → 100이면 정복 + 게이지 초기화.
- 조공 이행: 수락 시 영향력 이전(부족하면 402) + 지정 성 `conquerCastle(skipShare)` 할양 + 게이지 초기화.
- 파기: `POST /api/diplomacy/break` — 당사자 리더만, 파기 측 영향력 -20%, 원군 귀환.
- 원군: `POST /api/diplomacy/reinforce` lend/recall — 동맹 상대 성에 1슬롯(성당 1기·동맹당 3기), 공성 쿨다운에 주둔 1명분 가산, 정복·파기 시 자동 귀환, 회수는 상시 가능.
- 전쟁 수락 시 만료 없음(파기·평화까지 유지), 불가침 48h 만료 lazy 정산.

## 3단계 완료 (전투 화면 전환)

- `POST /api/auto-battle/start` — 편성 슬롯 5칸 원샷 확정전 (무법자·대인·공성).
  - 공격: 서버가 소유·부상·상태·150m 검증, 전위/후위 위치 유지.
  - 수비: 무법자 티어 편성 / 상대 가용 지휘관(표적 선두) / 성주 편성·무주 기본 수비대.
  - 정산: 선두 full XP·승수, 나머지는 참가 XP +10, 패배 시 선두만 30분 부상.
  - 무법자 승리 시 영향력 +20·토벌, 대인 승리 시 +10·수비 선두 정산(별도 락), 공성은 게이지 적립→100이면 정복.
  - 응답은 전투 필드만 반환 (유저 data 미노출).
- 클라: `FormationPicker`(자동 편성·스킬 틱) → `AutoBattleScene`(틱 재생·1/2/4x·스킵) → `ResultPanel`(XP·영향력·게이지·부상).
- 지도: `CurrentLocationMap`의 `BattleHost`를 `AutoBattleHost`(동일 props)로 교체. 카드 전투 코드는 보관.

## 4단계 완료 (성 패널 공성 진입)

- 성 상세 패널에 `전투로 공격 (60초)` 버튼 (`TerritoryUI`, 비소유·active 성만).
- `AutoBattleHost`가 무법자/대인 + 공성을 모두 받음 (`castleRequest` prop, `CastleBattleTarget`).
- 공성 결과(게이지·점령)는 `ResultPanel`에 표시, 종료 후 성 상세 자동 갱신 (`castleRefreshNonce`).
- 지도 30초 폴링에도 점령 결과가 자동 반영됨.

## 5단계 완료 (수비 원군 + 시즌 랭킹)

- 수비 편성에 원군 합류: 성주 편성이 5기 미만이면 빈 칸을 원군으로 채움 (`listReinforcements`).
  원군은 참가 XP +10만 (승수·부상 없음). 결과 화면에 `원군 N기 참전` 표시.
- 시즌 전적: `TerritorySeasonRecord` (개인 단위, 승/패/토벌/점령).
  - 오토배틀 종료 시 공격자·수비 선두 기록, 정복 시(`conquerCastle` 전 경로) 점령 기록.
- `GET /api/rankings?scope=user|nation` — 개인 TOP / 국가 합산 TOP (시즌별).
- 하단 메뉴에 랭킹 추가 (개인/국가 탭, 20위).

## 다음 단계 (운영 조정)

- 실기기 1판 검증 후 수치 조정 (게이지 속도·상성·보상).
