# AGENTS.md - 에이전트 코딩 가이드라인

이 문서는 ARMissionWeb 프로젝트에서 작동하는 에이전트를 위한 가이드라인을 제공합니다.

## 프로젝트 개요

- **프레임워크**: Next.js 16 with App Router
- **언어**: TypeScript (strict mode)
- **UI**: React 19 + Tailwind CSS v4
- **데이터베이스**: MySQL with Prisma ORM
- **포트**: 개발 서버는 포트 8798에서 실행

---

## 명령어

### 개발
```bash
npm run dev          # 개발 서버 시작 (http://localhost:8798)
npm run build        # 프로덕션 빌드
npm run start        # 프로덕션 서버 시작 (포트 8798)
```

### 린팅 & 타입 검사
```bash
npm run lint         # ESLint 실행
# 타입 검사는 Next.js 빌드에 포함됨
```

### 테스트 실행
- **현재 테스트 프레임워크가 설정되지 않음** - 명시적으로 요청하지 않는 한 테스트 작성 금지

### 데이터베이스
```bash
npx prisma generate    # Prisma 클라이언트 생성 (이미 src/generated/prisma에 있음)
npx prisma db push     # 스키마 변경사항을 데이터베이스에 적용
npx prisma studio      # Prisma 데이터베이스 GUI 열기
```

---

## 코딩 스타일 가이드라인

### TypeScript
- 모든 새 파일에서 strict mode 활성화
- 함수 매개변수와 반환 타입에 명시적 타입 사용
- 객체 형태에는 `interface`, 유니언/별칭에는 `type` 사용
- `any` 절대 사용 금지 - 타입이 진짜 모른다면 `unknown` 사용

### 가져오기(Imports)
- 모든 가져오기에 이중 인용부호 사용: `import X from "package"`
- 경로 별칭 사용: `@/components/...`, `@/lib/...`, `@/app/...`
- 가져오기 순서: React 가져오기 → 외부 라이브러리 → 내부 모듈
- 그룹화: 가져오기, 빈 줄, 코드 순서

### 명명 규칙
- **파일**: 라우트/컴포넌트는 kebab-case: `my-component.tsx`
- **컴포넌트**: PascalCase: `MyComponent`
- **함수**: camelCase: `myFunction`
- **상수**: 설정값은 SCREAMING_SNAKE_CASE: `API_BASE_URL`
- **타입/인터페이스**: PascalCase: `MyType`, `MyInterface`

### React 컴포넌트
- 화살표 함수 또는 `function` 키워드로 함수형 컴포넌트 사용
- props를 명시적 타입 어노테이션과 함께 구조 분해
- 컴포넌트 변형에는 `cva` (class-variance-authority) 사용
- 다형성 컴포넌트에는 Radix UI `@radix-ui/react-slot` 사용
- 조건부 클래스에는 `cn()` 유틸리티 (clsx + tailwind-merge) 사용

### API 라우트 (Next.js App Router)
- `src/app/api/[path]/route.ts`에 배치
- 명명된 함수 내보내기: `GET`, `POST`, `PUT`, `DELETE`
- 응답은 `NextResponse.json()` 반환
- try/catch로 오류 처리하고 적절한 상태 코드 반환

### 오류 처리
- 비동기 API 라우트에서 try/catch 사용
- `console.log`로 로깅 또는 적절한 로깅 사용
- 의미 있는 오류 메시지와 적절한 HTTP 상태 코드 반환
- 클라이언트에 내부 오류 세부정보 노출 금지

### 데이터베이스 (Prisma)
- `@/generated/prisma/client`에서 생성된 클라이언트 사용
- PrismaClient는 싱글톤 패턴 사용 (`src/lib/prismaadb.ts` 참고)
- 생성된 모델의 적절한 TypeScript 타입으로 쿼리 작성
- 디버깅에는 Prisma Studio 사용: `npx prisma studio`

### CSS / 스타일링
- Tailwind CSS 유틸리티 클래스만 사용
- `@/lib/utils.ts`의 `cn()` 유틸리티 사용
- 사용자 정의 CSS 피하고 Tailwind 토큰 사용
- 컴포넌트별 스타일이 필요하면 `src/app/*.css`에 추가 가능

### 파일 구성
```
src/
├── app/                    # Next.js App Router 페이지/라우트
│   ├── api/               # API 라우트
│   ├── quiz/[eventKey]/   # 동적 라우트
│   └── page.tsx           # 홈 페이지
├── components/            # React 컴포넌트
│   ├── ui/               # 재사용 가능한 UI 컴포넌트 (Button, Card)
│   └── *.tsx             # 기능 컴포넌트
├── lib/                   # 유틸리티 (prismadb, utils)
└── generated/prisma/      # Prisma 생성 코드 (편집 금지)
```

### Git 규칙
- `main`에서 피처 브랜치 생성
- 프로젝트에서 conventional commit 사용 시 따르기
- `.env` 파일 또는 시크릿 커밋 금지
- `node_modules/` 커밋 금지

---

## 설정 파일

- `tsconfig.json` - 경로 별칭이 있는 TypeScript 설정
- `eslint.config.mjs` - eslint-config-next를 사용하는 ESLint
- `next.config.ts` - Next.js 설정
- `prisma/schema.prisma` - 데이터베이스 스키마
- `tailwind.config` - Tailwind (v4에서는 CSS 기반 설정 사용)

---

## 웹이벤트 게임 구현 규칙 (필독)

새 게임(`src/app/games/[name]/`) 추가 시 아래를 모두 적용한다. 누락 시 운영 버그로 직결된 항목들이다.

### 진입·이동 파라미터
- 마커 진입 URL은 `eventkey` 하나만 사용한다. `exitUrl`/`host`를 URL에 붙이지 않는다.
- 하류 기본값: `exitUrl` 없으면 `/map`, `host` 없으면 `web`으로 간주한다 (`src/lib/game-score.ts`, `src/app/event/page.tsx` 참고).
- 기본값(`/map`+`web`)일 때는 퀴즈·게임 URL에 파라미터를 전달하지 않는다. QR 스캔 등 복귀지가 다른 경우에만 명시 전달한다.

### 점수 규칙
- 제출 점수는 `Math.floor(원점수 / 1000)`으로 나눠서 기록한다 (`submitGameScore`, 종료 이동 쿼리 모두).
- 게임오버 화면에 `÷ 1000` 행을 두고 원점수→최종점수 1.4초 ease-out 카운트다운 연출을 넣는다 (갤러그 `galaga-divide` 참고).
- **포기 버튼은 필수**: 플레이 중 화면 우상단에 배치한다. 포기 시 `Math.max(1, 현재점수)`를 보장해야 방문(`score >= 1`)으로 인정된다.
- **재시작/다시 도전 버튼 금지**: 게임오버·헤더에 두지 않는다. "점수 기록하고 나가기"만 남긴다.
- 효과음은 WebAudio 합성만 사용한다 (외부 파일 금지, `galag/lib/sound.ts` 참고).

### 상태·스냅샷 규칙
- 새로고침 복원용 세션 스냅샷은 게임별 prefix(`galag:`, `cube-rush-60:`, `2048game:` 등)로 저장한다.
- 점수 기록·초기화 시 관련 스냅샷을 반드시 제거한다. 점수리셋 시에는 `clearAllGameSnapshots()`으로 전체 제거한다.
- **렌더 단계에서 `localStorage`/`sessionStorage`를 읽지 않는다** (서버 0 vs 클라이언트 저장값 불일치 → React #418 하이드레이션 에러). 초기값은 상수로 두고 마운트 effect에서 동기화한다.
- React 터치 핸들러(`onTouchStart`/`onTouchMove`)에서 `preventDefault()`를 호출하지 않는다 (passive 리스너 경고). 스크롤/줌 차단은 CSS `touch-action: none`으로 처리한다.

### 재방문(중복 참여) 방지 — 2중 가드 필수
- 직접 URL 입력이 `/event`를 우회하므로 서버 체크만으로 부족하다. 둘 다 구현한다.
  1. **서버**: `src/app/event/page.tsx` — 로그인 유저의 해당 `eventkey`에 `score >= 1` 기록이 있으면 `/map?eventRevisited=1`로 리다이렉트한다.
  2. **클라이언트**: 게임·퀴즈 진입 시 `GET /api/check-visited?eventkey=` 조회 후 방문済み면 게임을 시작하지 않고 "이미 진행한 이벤트입니다" 다이얼로그 + "지도로 이동" 버튼을 표시한다. 타이머·입력·사운드도 함께 정지/가드한다.
- 방문 판정 기준은 `ARMissionUserScore`의 `islastscore=1 AND score>=1`이다 (맵 뱃지·재방문 체크·API 모두 동일 기준).

### 로그인 가드 — 미들웨어에만 의존 금지
- `src/middleware.ts`가 `/quiz/*`·`/games/*`·`/map`을 보호하지만, 배포 누락·설정 오류 시 무력화되므로 각 진입점이 자체 가드를 가진다. 새 게임·퀴즈 추가 시 아래 둘 다 구현한다.
  1. **서버**: `/event`, `/quiz/[EventKey]`, 게임 페이지는 세션(`session?.user?.id`)이 없으면 `/?callbackUrl=<원래 URL 인코딩>`으로 리다이렉트한다. 로그인 후 원래 이벤트로 복귀된다 (`NicknameInput`의 `callbackUrl` 처리 참고).
  2. **클라이언트**: `checkEventEntry()`(`src/lib/game-score.ts`)는 401을 `"ok"`가 아닌 `"login"`으로 반환한다. 게임·퀴즈는 `"login"`이면 시작·입력·타이머·사운드를 멈추고 "로그인이 필요합니다" 다이얼로그 + "로그인하러 가기"(이동처: `/?callbackUrl=/event?eventkey=...`) 버튼을 표시한다.
- `checkEventEntry`에서 `!res.ok`를 `"ok"`로 취급하는 fail-open을 새로 만들지 않는다. 401은 항상 `"login"`이다 (그 외 일시적 네트워크 오류만 `"ok"`).

### 진입 판정 전 깜빡임 방지 — 로딩 게이트 필수
- `checkEventEntry()`는 비동기라, 완료 전 게임·퀴즈 화면을 먼저 그리면 "이미 진행한 이벤트" 대상이라도 순간 노출된다. 이를 막기 위해 모든 진입점은 판정 완료 전까지 로딩 상태로 가린다.
  1. **상태**: `const [entryChecked, setEntryChecked] = useState(false)` — `eventKey`가 없으면 즉시 `true`, 있으면 `checkEventEntry().finally(() => setEntryChecked(true))`로 처리한다.
  2. **렌더**: `!entryChecked`일 때는 게임 UI 대신 "확인 중…" 로딩 화면만 표시한다 (`alreadyVisited`/`needsLogin` 분기보다 먼저).
  3. **부수효과 가드**: 캔버스 루프·Three.js 초기화·타이머·스냅샷 복원 등 모든 `useEffect`는 `if (!entryChecked) return;`으로 가드하고 deps에 `entryChecked`를 포함한다.

---

## 중요 참고사항

1. **생성된 코드**: `src/generated/prisma/`を手動で編集禁止 - `npx prisma generate`로 재생성
2. **환경 변수**: `.env.example`에서 `.env` 생성 (커밋 금지)
3. **React 컴파일러**: 프로젝트에서 `babel-plugin-react-compiler` 사용 - React 컴파일러 제한사항 인식
4. **테스트 없음**: 프로젝트에 테스트 설정 없음 - 명시적으로 요청하지 않는 한 테스트 추가 금지
