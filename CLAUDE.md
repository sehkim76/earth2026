# ARMissionWeb - Claude 개발 가이드

이 문서는 ARMissionWeb 프로젝트 작업 시 Claude의 참고 자료입니다. 현재 코드베이스 상태를 반영한 최신 정보입니다.

## 프로젝트 개요

ARMissionWeb은 AR(증강현실) 기반의 미션 및 게임 플랫폼 웹 애플리케이션입니다. 사용자는 QR 코드를 스캔하고 위치 기반 미션을 수행하며, 다양한 AR 게임과 콘텐츠를 경험할 수 있습니다.

**핵심 기능:**
- AR QR 코드 스캐닝 및 인식
- 위치 기반 미션 시스템 (GPS 연동)
- 사용자 인증 및 실시간 위치 추적
- CMS(Content Management System) 통합
- 팀 기반 멀티플레이어 기능
- 다양한 AR 게임 (Crossy Road, Tower Block 등)
- 스코어 보드 및 랭킹 시스템

## 기술 스택

### 핵심 프레임워크
- **Next.js**: 16.1.5 (App Router)
- **React**: 19.2.3
- **TypeScript**: 5.x (Strict Mode)
- **Tailwind CSS**: v4

### 데이터 및 상태 관리
- **Database**: MySQL via Prisma ORM (v6.14.0)
- **Authentication**: next-auth (4.24.13)
- **Generated Client**: `src/generated/prisma` (수정 금지)

### AR/3D 기술
- **MindAR**: 오프라인 컴파일러 for AR 인식
- **three.js**: 0.182.0 for 3D 그래픽
- **HTML5 QR Code**: 2.3.8 for QR 스캐닝
- **Leaflet**: 1.9.4 for 지도 (WebGL 지원)
- **GSAP**: 3.14.2 for 애니메이션

### 기타 주요 라이브러리
- **Radix UI**: Headless UI components
- **Lottie**: `lucide-react` 0.563.0 for icons
- **Axios**: 1.13.4 for HTTP requests
- **SST**: 3.17.38 for deployment

## 프로젝트 구조

```
src/
├── app/                          # Next.js App Router
│   ├── api/                      # API Routes
│   │   ├── auth/                 # 인증 관련
│   │   ├── login/                # 로그인/회원가입
│   │   ├── map-settings/         # 지도 설정
│   │   ├── player-location/      # 위치 추적
│   │   ├── updatescore/          # 점수 업데이트
│   │   └── ...
│   ├── 8th/                      # 이벤트/미션 페이지
│   │   ├── butterfly/            # 나비 AR 경험
│   │   ├── portal-*/             # 다양한 포탈 콘텐츠
│   │   └── trees/                # 나무 관련 콘텐츠
│   ├── games/                    # 게임 페이지
│   │   ├── crossyroadgame/
│   │   ├── newrallyx/
│   │   └── towerblock/
│   ├── arqr/                     # AR QR 코드 페이지
│   ├── event/                    # 이벤트 페이지
│   ├── map/                      # 지도 페이지
│   └── page.tsx                  # 홈페이지
│
├── components/                   # React Components
│   ├── ui/                       # 재사용 가능한 UI 컴포넌트
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   └── ...
│   ├── ArImageTargetMode.tsx     # AR 이미지 타겟 모드
│   ├── CrossyRoadGame.tsx
│   ├── CurrentLocationMap.tsx    # 실시간 위치 지도
│   ├── NewRallyX.tsx
│   ├── QRScanner.tsx             # QR 코드 스캐너
│   ├── QuizPart.tsx
│   ├── Ranking.tsx
│   └── TVImageMCQuiz.tsx
│
├── lib/                          # 유틸리티 라이브러리
│   ├── armissionwebconfig.ts     # 설정
│   ├── auth.ts                   # 인증 로직
│   ├── map-settings.ts
│   ├── prismadb.ts               # Prisma 싱글톤
│   └── utils.ts                  # 일반 유틸리티
│
├── generated/prisma/             # Prisma 생성 코드 (자동 생성, 수정 금지)
└── prisma/schema.prisma          # 데이터베이스 스키마

public/                           # 정적 에셋
├── arqr-assets/                  # AR QR 에셋
├── map-assets/                   # 지도 관련 에셋
└── portal-*/                     # 포탈 전용 에셋
```

## 주요 데이터베이스 모델

### 핵심 엔티티
- **MissionTable**: 미션 메타데이터 (ARMissionKey, 기간, GPS 범위)
- **MissionUser**: 사용자 정보 (userId, nickname, score, 위치)
- **ARMissionEvent**: 이벤트/퀴즈 콘텐츠 (EventType, EventURI, QuizCount)
- **ARMissionUserScore**: 사용자 점수 기록 (score, answer, timestamp)
- **LockTable**: 위치 잠금/동시성 제어
- **MissionResources**: AR 에셋 리소스
- **PrefabInstanceTable**: AR 프리팹 인스턴스 상태

### 인덱스
- 위치 기반 쿼리 최적화 (ARMissionKey, lat/lon)
- 시간 기반 쿼리 최적화 (location_updated_at)
- 셀 기반 위치 인덱싱 (location_cell)

## 명령어

### 개발 서버
```bash
npm run dev    # 개발 서버 시작 (http://localhost:8798)
npm run build  # 프로덕션 빌드
npm start      # 프로덕션 서버 시작
```

### 코드 품질
```bash
npm run lint   # ESLint 실행
```

### 데이터베이스
```bash
npx prisma generate      # Prisma 클라이언트 재생성 (src/generated/prisma)
npx prisma db push       # 스키마 변경사항을 DB에 적용
npx prisma studio        # Prisma GUI 열기
```

### AR QR 에셋 생성
```bash
npm run generate:arqr-targets  # AR QR 타겟 이미지 생성
```

## 개발 워크플로우

### 1. AR 콘텐츠 추가
1. `prisma/schema.prisma`에서 이벤트 타입 정의
2. Prisma 마이그레이션 실행
3. `src/app/8th/`에 라우트/페이지 생성
4. 필요시 컴포넌트 구현
5. `public/`에 AR 에셋 추가

### 2. API 엔드포인트 추가
1. `src/app/api/[endpoint-name]/route.ts` 생성
2. GET/POST/PUT/DELETE 함수 내보내기
3. Prisma 클라이언트 사용 (`@/lib/prismadb`)
4. 오류 처리 및 응답 형식 일관성 유지

### 3. UI 컴포넌트 생성
1. `src/components/ui/`에 재사용 가능한 컴포넌트 생성
2. `cn()` 유틸리티로 클래스명 관리
3. TypeScript strict mode 준수
4. shadcn/ui 패턴 따르기

### 4. AR 기능 구현
1. `MindAR` 오프라인 컴파일러 사용 for 타겟 생성
2. AR 타겟 이미지는 `public/arqr-assets/`에 저장
3. AR 세션 설정은 `src/lib/mindar/` 참고
4. Three.js for 3D 오브젝트 렌더링

## 코딩 가이드라인

### TypeScript
- **Strict mode** 필수
- **명시적 타입** 모든 함수/매개변수/반환값에 사용
- **인터페이스** for 객체 형태, **타입** for 유니언/별칭
- **`any` 금지** - 대신 `unknown` 사용

### Imports & Module Structure
- **이중 인용부호** 사용: `import X from "package"`
- **경로 별칭** 필수 사용: `@/components/...`, `@/lib/...`
- **가져오기 순서**: React → 외부 라이브러리 → 내부 모듈

### 명명 규칙
- **파일**: kebab-case (`my-component.tsx`)
- **컴포넌트**: PascalCase (`MyComponent`)
- **함수**: camelCase (`myFunction`)
- **상수**: SCREAMING_SNAKE_CASE (`API_BASE_URL`)
- **타입**: PascalCase (`MyType`)

### React 컴포넌트
- **함수형 컴포넌트** with 명시적 props 타입
- **AR 컴포넌트**는 성능 최적화 필요 (useMemo, useCallback)
- **인터랙티브 요소**에는 Radix UI 사용

### API Routes
- **명명된 내보내기**: `export async function GET()`
- **NextResponse.json()** for 응답
- **오류 처리**: try/catch with 적절한 HTTP 상태 코드
- **캐싱**: 적절한 revalidate 타이밍 설정

### 데이터베이스 쿼리
- **인덱스 활용**: lat/lon, ARMissionKey로 필터링
- **트랜잭션**: 동시성 문제 방지
- **Prisma Studio**: 데이터 확인 및 디버깅용 활용

## 중요 참고사항

### 1. Prisma 생성 코드
- **`src/generated/prisma/` 수정 금지**
- `npx prisma generate`로만 갱신
- Prisma 버전 업그레이드 시 재생성 필요

### 2. React Compiler
- **`babel-plugin-react-compiler` 활성화**
- 컴파일러 최적화 인식 필요
- 메모이제션 암시적 적용됨

### 3. AR 성능 최적화
- **에셋 사이즈**: 메모리 사용 고려 (특히 모바일)
- **타겟 이미지**: MindAR 추천 사양 따르기
- **WebGL**: Three.js 리소스 적절히 정리

### 4. 위치 기반 기능
- **GPS 정확도**: `navigator.geolocation` 옵션 설정
- **배터리**: 지속적 위치 추적 영향 고려
- **권한**: 사용자 동의 프로세스 준수

### 5. 보안 고려사항
- **환경 변수**: `.env` 파일 커밋 금지
- **API 라우트**: 인증 미들웨어 적절히 사용
- **CORS**: 외부 에셋 로딩 정책 설정

### 6. 테스트 (현재 없음)
- **프로젝트에 테스트 프레임워크 없음**
- 명시적으로 요청 없이는 테스트 추가 금지
- 수동 테스트 프로세스 따름

## 설정 파일

### Next.js
- **File**: `next.config.ts`
- **Remote Images**: Cloudinary, 내부 서버 허용
- **React Compiler**: 활성화 (`reactCompiler: true`)

### TypeScript
- **File**: `tsconfig.json`
- **Path Mappings**: `@/*` → `src/*`
- **Target**: ES2017, Strict Mode

### Tailwind CSS
- **Version**: v4 (PostCSS 플러그인)
- **Config**: CSS 기반 설정 (tailwind.config 없음)
- **Merge**: `tailwind-merge`로 클래스 합치기

### Prisma
- **File**: `prisma/schema.prisma`
- **Provider**: MySQL
- **Output**: `src/generated/prisma` (custom)
- **Binary Targets**: native, Linux (ARM/x64)

## 문제 해결

### 일반적인 문제

1. **Prisma 클라이언트 오류**: `npx prisma generate` 실행
2. **AR 타겟 로드 실패**: 이미지 경로 및 MindAR 설정 확인
3. **위치 추적 실패**: 브라우저 권한 확인
4. **타입 오류**: `any` 사용 피하고 명시적 타입 사용

### 성능 최적화

- **빌드 사이즈**: Three.js tree-shaking
- **이미지 최적화**: Next.js Image 컴포넌트 활용
- **캐싱**: API 응답 적절히 캐시
- **AR 에셋**: lazy loading 고려

### 디버깅

- **Prisma Studio**: 데이터 확인용
- **React DevTools**: 컴포넌트 성능
- **Browser DevTools**: 위치/GPS 디버깅
- **Next.js 로그**: 빌드/런타임 오류

## 리소스

- **MindAR Docs**: https://hiukim.github.io/mind-ar/
- **Three.js Docs**: https://threejs.org/docs/
- **Next.js Docs**: https://nextjs.org/docs
- **Prisma Docs**: https://prisma.io/docs
- **Leaflet**: https://leafletjs.com/

---

**마지막 업데이트**: 2026년 4월 2일
**Claude 모델**: Sonnet 4.6
**프로젝트 버전**: 0.1.0
