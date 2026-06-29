# FlowDock

개발자용 멀티 API 자동화 허브 — **내구성 워크플로 엔진 + Workflows-as-Code + 트리거 서버 + 커넥터 생태계**.
설계 배경과 해자(lock-in) 전략은 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 참고.

> 한 줄: 여러 무료 API를 노드로 연결해 YAML 한 파일로 자동화한다. 엔진이 **순서·재시도·레이트리밋·체크포인트·크리덴셜 주입**을 다 처리하므로, 작성자는 비즈니스 로직만 짠다. 그리고 워크플로·크리덴셜·실행이력이 쌓일수록 떠나기 어려워진다.

현재 **73개 테스트 전부 통과 (네트워크 불필요)**, `tsc --noEmit` 클린.

## 구현된 기능

### M0 — 코어 엔진
| 영역 | 구현 |
|---|---|
| DAG 실행 | `{{ nodes.x }}` 참조로 의존성 자동 추론 → 위상정렬 |
| 내구성 실행 | 노드별 체크포인트 → 같은 runId로 **재개 시 성공 노드 스킵** |
| 재시도 | 노드별 지수 백오프 |
| 표현식 | `eval` 없는 안전 파서 (경로·`??`·리터럴) |
| 크리덴셜 볼트 | AES-256-GCM 봉투 암호화 + 로그 마스킹 |
| 레이트리밋 | 커넥터별 토큰버킷 (무료 티어 보호) |
| 커넥터 | echo, http.request, jina.reader, llm.chat(Pollinations), pollinations.image, ntfy.publish, resend.email |

### M1 — 개발자 경험 (DX)
| 기능 | 명령 | 핵심 |
|---|---|---|
| **Workflows-as-Code** | `push` / `pull` / `history` / `diff` | 콘텐츠 주소(sha256) 버전 레지스트리 = 락인 |
| **트리거 서버** | `serve` | node:http 웹훅(`/hooks/{wf}/{secret}`) + 5필드 cron 스케줄러 |
| **드라이런** | `run --dry-run` | 네트워크 없이 DAG·표현식·입력스키마 검증 |
| **실행 타임라인** | `logs <runId>` | 노드별 상태·지연·재시도 디버깅 뷰 |

### M2 — 생태계
| 기능 | 명령 | 핵심 |
|---|---|---|
| **커넥터 SDK** | — | `defineConnector`(입력 자동검증) · `makeTestContext`(오프라인 테스트) |
| **스캐폴더** | `create-connector <ns.name>` | 커넥터+테스트 골격 생성 |
| **동적 로딩** | (자동) | `connectors/` 디렉터리의 커뮤니티 커넥터 자동 등록 (first-wins) |
| **템플릿 갤러리** | `templates list` / `templates use` | 바로 쓰는 워크플로 (네트워크 효과 씨앗) |

### M3 — 수익화 (해자 → 매출)
| 기능 | 명령 | 핵심 |
|---|---|---|
| **플랜** | `plan [set <id>]` | Free/Pro/Team 한도 (워크플로·실행·시트·동시성) |
| **실행 쿼터** | (자동, `usage`) | 월 실행 한도 — 초과 시 `QuotaError` |
| **로그 보존 = 페이월** | `prune` | Free 7일 / Pro 30일 / Team 90일. 디버깅 데이터 의존 → 업그레이드 |
| **팀 + RBAC** | `members …` | owner/admin/member/viewer 권한 매트릭스, 시트 한도 |

플랜 한도: **Free** 워크플로 3·실행 100/월·로그 7일·1시트 · **Pro** ∞·1만/월·30일·1시트($19) · **Team** ∞·10만/월·90일·10시트($99).

## 빠른 시작

```bash
npm install
npm test                                    # 73개 테스트 (오프라인)
node --import tsx src/cli.ts                 # 전체 명령 도움말
```

> CLI에 `--플래그`를 넘길 땐 `npm run` 대신 `node --import tsx src/cli.ts ...`로 직접 호출하세요 (npm이 `--`를 가로챔).

### 1) 워크플로 실행 & 검증
```bash
node --import tsx src/cli.ts validate examples/morning-briefing.yaml
node --import tsx src/cli.ts run examples/morning-briefing.yaml --dry-run   # 오프라인 검증
node --import tsx src/cli.ts run examples/morning-briefing.yaml             # 실제 실행
node --import tsx src/cli.ts logs <runId>                                   # 실행 타임라인
```

### 2) Workflows-as-Code (락인의 핵심)
```bash
# workflows/*.yaml 을 콘텐츠 주소 버전으로 레지스트리에 저장
node --import tsx src/cli.ts push --author me
node --import tsx src/cli.ts history "아침 AI 브리핑 (keyless)"   # 버전 이력
node --import tsx src/cli.ts diff                                  # 로컬 vs 레지스트리
node --import tsx src/cli.ts pull                                  # 레지스트리 → 파일 복원
```

### 3) 트리거 서버 (웹훅 + cron)
```bash
node --import tsx src/cli.ts serve --port 8787
# 출력된 hook URL로 POST:
curl -X POST 'http://127.0.0.1:8787/hooks/<wf>/<secret>' \
     -H 'content-type: application/json' -d '{"url":"https://example.com"}'
# 상태: GET /runs/{id}, /workflows, /healthz
```

### 4) 커넥터 만들기 & 템플릿
```bash
node --import tsx src/cli.ts create-connector slack.post   # connectors/post.ts + 테스트 생성
node --import tsx src/cli.ts connectors                    # 빌트인 + 커뮤니티 목록
node --import tsx src/cli.ts templates list
node --import tsx src/cli.ts templates use example-daily-digest
```

### 5) 플랜 · 쿼터 · 팀 (M3)
```bash
node --import tsx src/cli.ts plan                          # 현재 플랜 + 한도
node --import tsx src/cli.ts plan set pro                  # 업그레이드
node --import tsx src/cli.ts usage                         # 이번 달 실행 사용/잔여
node --import tsx src/cli.ts prune                         # 보존기간 지난 실행이력 삭제 (페이월)
node --import tsx src/cli.ts members add dev@team.com --role member
```
`run`은 RBAC(권한)·월 실행 쿼터를 통과해야 실행되고 사용량이 집계된다. `push`는 플랜의 워크플로 수 한도를 적용한다.

## 프로젝트 레이아웃

```
flowdock.config.json     # 선택: name, workflowsDir, connectorsDir, registryPath
workflows/*.yaml         # 당신의 워크플로 (push/pull/serve 대상)
connectors/*.ts          # 커뮤니티 커넥터 (defineConnector, 자동 로딩)
templates/*.yaml         # 템플릿 갤러리
.flowdock/               # 런타임 상태 (레지스트리·실행·웹훅시크릿·tenant·usage; gitignore)
```

## 새 커넥터 추가

`defineConnector` 하나면 끝. `ctx.fetch`는 레이트리밋·타임아웃·시크릿 마스킹이 적용된 래퍼이고, `inputs` 스키마로 입력이 자동 검증된다.

```ts
import { defineConnector } from "../src/sdk.ts";

export default defineConnector({
  id: "myapi.action",
  title: "My API",
  manifest: { version: "0.1.0" },
  rateLimit: { requests: 5, intervalMs: 1000 },
  inputs: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
  outputs: { type: "object", properties: { result: { type: "string" } } },
  async execute(input, ctx) {
    const res = await ctx.fetch(`https://api.example.com/?q=${(input as any).query}`);
    if (!res.ok) throw new Error(`example ${res.status}`);
    return { result: await res.text() };
  },
});
```

## 시크릿 & 크리덴셜

- 워크플로 시크릿: `FLOWDOCK_SECRET_<NAME>` 환경변수 → `{{ secrets.NAME }}`
- 커넥터 크리덴셜(개발용): `.flowdock/credentials.json` → `{ "resend.email": { "apiKey": "re_..." } }`
- 운영용 볼트: `src/vault.ts` (마스터키 → 테넌트키 → 시크릿). `FLOWDOCK_MASTER_KEY`(base64 32B).
- 웹훅 시크릿: dev 티어는 `.flowdock/webhooks.json`(평문). 운영은 볼트로 이전 권장 (ARCHITECTURE.md 리스크 참조).

## 알아둘 점

- **외부 API 호출은 실행 환경 네트워크 정책에 따라 차단될 수 있다** (샌드박스에서는 허용 호스트 외 outbound 차단). 엔진/서버/동기화 로직은 `npm test`로 전부 오프라인 검증된다.
- `pull`은 정규화(키 정렬·주석 제거)된 YAML을 쓴다 — Git diff에 주석 손실이 보일 수 있다(설계상 콘텐츠 주소화 때문).

## 다음 단계

코어(M0)→DX(M1)→생태계(M2)→수익화(M3)까지 구현 완료. 다음은 운영 하드닝: 실제 결제 연동(Stripe), 볼트 기반 웹훅 시크릿, 호스티드 배포 시 동적 커넥터 샌드박싱, 동시성 풀의 실시간 적용. 설계 배경은 [`ARCHITECTURE.md`](./ARCHITECTURE.md).
