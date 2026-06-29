# FlowDock — 개발자용 멀티 API 자동화 허브 (아키텍처 설계)

> "여러 무료 API를 노드처럼 연결해 워크플로로 자동화하는, 개발자 우선(B2D) 셀프호스트 Zapier."
> 원가는 0에 수렴, 해자는 **워크플로 + 크리덴셜 + 실행 이력의 축적**.

---

## 0. 한 줄 요약과 해자 설계

자동화 허브는 **연결(connector)이 많다고 못 떠나는 게 아니라**, 사용자의 **중요한 자동화가 그 위에서 돌기 때문에** 못 떠납니다. 개발자(B2D)를 겨냥하므로 해자를 4겹으로 쌓습니다.

| 해자 | 메커니즘 | 이탈 비용 |
|---|---|---|
| **워크플로 자산** | 수십 개의 동작하는 파이프라인이 누적 | 재구축 비용 = 수십~수백 시간 |
| **크리덴셜 볼트** | 모든 API 키·OAuth 토큰이 한곳에 암호화 저장 | 전부 재발급·재연결 |
| **실행 이력/관측** | 디버깅·감사에 쓰는 로그·메트릭 누적 | 과거 데이터 소실 |
| **커넥터 생태계** | 커뮤니티가 만든 커넥터 + 템플릿 (네트워크 효과) | 떠나면 생태계 못 씀 |

개발자에게 **추가로** 통하는 결정타: **Workflows-as-Code**. 워크플로를 Git에 버전관리되는 YAML로 정의 → 비주얼 에디터와 양방향 동기화. 이게 "Pulumi가 Terraform 사용자를 잠그는" 방식의 락인을 만듭니다.

---

## 1. 시스템 컨텍스트 (C4 Level 1)

```
                 ┌──────────────────────────────────────────────┐
   개발자 ──────▶│  Web Dashboard (비주얼 빌더 + 실행 로그)      │
   (브라우저)    └──────────────────────────────────────────────┘
                                  │
   개발자 ──────▶  CLI / SDK / REST API  ─────────┐
   (터미널/CI)                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │            FlowDock Control Plane             │
                 │  (워크플로 정의·인증·크리덴셜·스케줄·관측)    │
                 └──────────────────────────────────────────────┘
                                  │ enqueue
                                  ▼
                 ┌──────────────────────────────────────────────┐
                 │      Execution Plane (Durable Workflows)      │
                 │   노드 단위로 외부 무료 API 호출·재시도·상태  │
                 └──────────────────────────────────────────────┘
                     │        │        │        │        │
                     ▼        ▼        ▼        ▼        ▼
                  Jina   Pollinations  edge-tts  Vector   LLM(Puter
                 (추출)    (이미지)    /Whisper   DB      /HF 등)  ... (N개 커넥터)
```

- **Triggers(인입)**: ① Webhook(워크플로별 고유 URL) ② Cron 스케줄 ③ Polling ④ 수동/이벤트
- **Sinks(출력)**: Resend(이메일), ntfy(푸시), R2(아티팩트), DB, 외부 webhook

---

## 2. 핵심 설계 결정 (왜 이렇게)

### 2.1 Control Plane / Execution Plane 분리
- **Control Plane**: 빠르고 상태가 작음(워크플로 정의 CRUD, 인증, 스케줄 등록). 일반 요청-응답.
- **Execution Plane**: 느리고 길고 실패 가능(외부 API 줄줄이 호출). **반드시 비동기·내구성(durable) 실행**.
- 둘을 큐로 분리해야 한 워크플로의 폭주가 대시보드를 마비시키지 않음.

### 2.2 내구성 실행(Durable Execution)이 심장
자동화 허브의 진짜 난이도는 UI가 아니라 **"7번째 노드에서 외부 API가 타임아웃났을 때 어떻게 6번까지의 결과를 잃지 않고 재개하는가"** 입니다.
- 각 노드 실행을 **체크포인트**로 저장 → 재시도는 실패 노드부터.
- **멱등성 키**(idempotency key)로 중복 실행 방지 (재시도가 이미 보낸 이메일을 또 보내지 않게).
- 선택지: **Cloudflare Workflows**(durable execution 내장, 무료 티어) 또는 자체 구현(큐 + 상태 테이블). → MVP는 Cloudflare Workflows 권장.

### 2.3 커넥터(노드)를 1급 추상화로
새 무료 API 추가가 **설정 파일 하나**로 끝나야 생태계가 큼. 모든 노드는 동일 인터페이스를 구현:

```ts
interface Connector {
  id: string;                    // "jina.reader"
  inputs: JSONSchema;            // 노드 입력 스키마 (UI 자동생성용)
  outputs: JSONSchema;           // 다음 노드가 참조할 출력 스키마
  auth?: AuthSpec;               // none | apiKey | oauth2 | basic
  rateLimit?: RateLimitSpec;     // 무료 티어 한도 (풀링·큐잉에 사용)
  execute(input, ctx): Promise<output>;  // ctx = {creds, fetch, log, store}
}
```

핵심: `ctx.fetch`는 **레이트리밋·재시도·로깅이 주입된 래퍼**. 커넥터 작성자는 비즈니스 로직만 짜고, 인프라 걱정 안 함.

### 2.4 데이터 패싱 & 표현식
노드 간 데이터 연결은 **참조 표현식**으로:
```yaml
- id: tts
  uses: edge-tts.synthesize
  with:
    text: "{{ nodes.summarize.output.text }}"   # 업스트림 출력 참조
    voice: "{{ trigger.body.voice ?? 'ko-KR' }}"
```
- 엔진은 DAG 위상정렬 → 각 노드 실행 전 표현식을 해석(JSONPath + 안전한 식 평가, `eval` 금지).
- 표현식은 샌드박스(예: 화이트리스트 함수만). 임의 코드 실행은 별도 **Code 노드**(isolate/worker)로 격리.

### 2.5 멀티테넌시 격리
- 모든 행에 `tenant_id`. 쿼리 레벨 강제(또는 D1/Postgres RLS).
- 크리덴셜은 **테넌트별 데이터키**로 암호화 → 테넌트 격리 + 유출 범위 최소화.
- 실행 워커는 테넌트 컨텍스트를 토큰으로만 받음(전역 키 노출 X).

---

## 3. 컴포넌트별 상세

### 3.1 Trigger Service (인입)
| 트리거 | 구현 | 비고 |
|---|---|---|
| Webhook | 워크플로별 `/hooks/{wf_id}/{secret}` | 서명검증·페이로드를 trigger.body로 |
| Cron | 스케줄러가 워크플로 enqueue | Cloudflare Cron Triggers / GitHub Actions |
| Polling | 주기적 소스 체크 + 커서 저장 | "새 항목만" 처리용 dedup 커서 |
| Manual/API | REST `POST /workflows/{id}/run` | CLI·CI에서 호출 |

### 3.2 Workflow Engine (실행)
1. trigger 수신 → 실행(run) 레코드 생성(`status=queued`)
2. 큐에 enqueue → Durable Workflow 시작
3. DAG 위상정렬 → 노드별로:
   - 입력 표현식 해석 → 커넥터 `execute` 호출(레이트리밋·재시도·타임아웃 래퍼 경유)
   - 출력·상태 체크포인트 저장
4. 분기(if)·반복(map/loop)·병렬(fan-out/fan-in) 지원
5. 실패 시: 노드 정책(retry N회 → backoff → dead-letter) 적용, 워크플로 일시정지·재개 가능

### 3.3 Credential Vault (해자 핵심)
- 저장: `creds(tenant_id, connector, name, ciphertext, meta)`
- 암호화: **봉투 암호화**(envelope) — 마스터키(KMS/Workers Secret)로 테넌트 데이터키 암호화, 데이터키로 실제 시크릿 암호화.
- 복호화는 **실행 워커 메모리 안에서만**, 로그·응답에 절대 노출 금지(자동 마스킹).
- OAuth 커넥터: 토큰 자동 갱신(refresh) 백그라운드 잡.

### 3.4 Rate-Limit Pool (무료 티어 생존)
무료 API들은 한도가 빡빡 → **커넥터별 토큰버킷**을 중앙에서 관리:
- 한도 초과 시 요청을 **큐잉·지연**(즉시 실패 대신).
- 사용자 본인 키 vs 플랫폼 공용 키 구분(공용 키는 공정 분배).
- 이게 곧 **유료화 레버**: "더 높은 동시성/처리량" = 상위 플랜.

### 3.5 Artifact Store
- 생성물(이미지·음성·추출문서)은 **R2**(에그레스 무료)에 저장, 서명 URL 발급.
- 노드 간에는 큰 바이너리 대신 **참조(URI)** 만 전달 → 페이로드 경량화.

### 3.6 Observability
- 모든 노드 실행 = 구조화 로그(입력 해시·출력 크기·지연·비용단위).
- PostHog: 제품 분석(어떤 커넥터가 인기, 어디서 실패) + 에러 추적.
- 사용자 대면 **실행 타임라인 뷰**(노드별 성공/실패/지연) → 디버깅 의존 = 해자.

---

## 4. 기술 스택 매핑 (전부 무료 티어)

| 레이어 | 선택 | 이유 / 대안 |
|---|---|---|
| 실행 컴퓨트 | **Cloudflare Workers + Workflows** | durable 실행 내장, 100k req/day 무료 / 대안: 자체 큐+Fly |
| 큐 | **Cloudflare Queues** | Workers 통합 / 대안: Upstash QStash |
| 정의·메타 DB | **D1 (SQLite)** 또는 **Turso/Neon** | 워크플로·유저·실행 메타 |
| 상태/캐시 | **Workers KV** | 실행 체크포인트·레이트리밋 버킷 |
| 아티팩트 | **R2** | 에그레스 무료가 결정적 |
| 벡터(RAG 노드) | **Qdrant/Chroma 셀프호스트** 또는 Pinecone 2GB | RAG 커넥터용 |
| 인증 | **Supabase Auth** 또는 Appwrite | 유저·세션·소셜로그인 |
| 프론트(빌더) | **Cloudflare Pages** + React + React Flow | 비주얼 DAG 에디터 |
| 알림 | **Resend**(메일) + **ntfy**(푸시) | 출력 싱크 |
| 관측 | **PostHog** | 분석+에러 |
| CI/CD | **GitHub Actions** | 배포·스케줄 트리거 |
| LLM 노드 | **Puter.js / HF / Pollinations** | 키리스 또는 무료 |

> 의도적 결합도 최소화: 엔진은 커넥터/스토리지/큐를 **인터페이스**로만 알기 때문에, Cloudflare 락인 우려 시 다른 백엔드로 교체 가능(설계상 우리 자신이 락인되지 않게).

---

## 5. 데이터 모델 (초안)

```
tenants(id, name, plan, created_at)
users(id, tenant_id, email, role)
workflows(id, tenant_id, name, yaml, version, status, updated_at)
workflow_versions(id, workflow_id, version, yaml, author, created_at)  -- 버전 이력 = 락인
connectors(id, kind, version, schema_json, owner, visibility)          -- public/private/community
credentials(id, tenant_id, connector, name, ciphertext, meta)
triggers(id, workflow_id, type, config_json, secret)
runs(id, workflow_id, trigger_id, status, started_at, finished_at)
run_steps(id, run_id, node_id, status, input_ref, output_ref, latency_ms, attempts, error)
```

---

## 6. 개발자 경험(DX) = B2D 차별점

1. **Workflows-as-Code**: `flowdock.yaml`을 Git에 커밋 → `flowdock push/pull`로 비주얼 에디터와 동기화.
2. **CLI**: `flowdock run`, `flowdock logs`, `flowdock secrets set`, `flowdock test`(로컬 dry-run).
3. **Connector SDK**: `npm create flowdock-connector` → 스키마 + execute 만 작성 → 마켓에 게시.
4. **로컬 테스트**: 노드 단위 mock 입력으로 dry-run, 실 호출 없이 표현식 검증.
5. **타입 안전**: 커넥터 출력 스키마 → 다음 노드 입력에 타입 힌트/자동완성.

---

## 7. 수익화·플랜 (해자 → 매출 전환)

| 플랜 | 가격대 | 한도 | 락인 레버 |
|---|---|---|---|
| Free | $0 | 실행 N회/월, 워크플로 3개, 7일 로그 | 입문·바이럴 |
| Pro | 개인 | 실행↑, 워크플로 무제한, 30일 로그, 본인키 무제한 | 워크플로 자산 축적 |
| Team | 시트당 | 팀 공유·권한, 90일 로그, 프라이빗 커넥터 | 시트+협업 락인(객단가↑) |
| (옵션) Self-host | 라이선스 | 무제한, 온프레 | 엔터프라이즈 데이터 주권 |

핵심 전환 동선: 무료로 1~2개 워크플로 → 의존 → 로그 보존기간/실행량 한도에 막힘 → 업그레이드. **로그 보존기간**이 가장 자연스러운 페이월(이미 의존 중인 디버깅 데이터).

---

## 8. 단계별 로드맵

- **M0 — 코어 (4~6주)**: 엔진(DAG+durable+재시도) · 커넥터 3개(Jina/LLM/Resend) · Webhook·Cron 트리거 · 크리덴셜 볼트 · 최소 대시보드.
- **M1 — DX**: CLI + Workflows-as-Code 동기화 + 로컬 dry-run + 실행 타임라인 뷰.
- **M2 — 생태계**: Connector SDK + 템플릿 갤러리(네트워크 효과) + 커넥터 10~15개.
- **M3 — 수익화**: 플랜·과금·레이트리밋 풀 + 팀 협업·권한.

---

## 9. 가장 큰 리스크 & 대응

| 리스크 | 대응 |
|---|---|
| 무료 API 약관 위반/차단 (공용 키 남용) | 본인 키 우선 정책, 공용 키는 저한도·공정분배, ToS 모니터링 |
| 내구성 실행 버그 = 데이터 유실/중복 | 멱등성 키 + 체크포인트 + dead-letter, 처음부터 테스트 |
| 크리덴셜 유출 | 봉투암호화·로그 마스킹·최소권한·감사로그 |
| 커넥터 품질 편차(생태계) | 검증 배지·샌드박스 격리·버전 핀 |
| Cloudflare 단일 의존 | 엔진을 백엔드 인터페이스로 추상화(교체 가능) |

---

## 10. 운영 하드닝 (구현됨)

| 영역 | 구현 | 모듈 |
|---|---|---|
| **결제** | Stripe 웹훅 서명검증(HMAC + 타임스탬프 리플레이 방어) → 이벤트→플랜 매핑. checkout/subscription updated·deleted 처리. `/billing/webhook` 라우트. | `src/billing.ts` |
| **웹훅 시크릿 암호화** | 평문(dev) 대신 볼트 봉투암호화로 디스크에 ciphertext만 저장. `WebhookSecrets` 인터페이스로 서버는 둘 다 수용. `serve --vault-secrets`(+`FLOWDOCK_MASTER_KEY`). | `src/webhook-secret.ts` |
| **커넥터 egress 샌드박스** | 커뮤니티 커넥터의 네트워크를 manifest `allowedHosts` 허용목록으로 제한(엔진 주입 fetch에서 강제). 빌트인·verified=신뢰, 미검증+미선언=차단(fail-closed). `serve --sandbox`. | `src/sandbox.ts` |

### 남은 신뢰 경계 (정직한 한계)

- **egress 샌드박스는 *네트워크 egress*만 막는다, 코드 실행이 아니다.** 완전히 신뢰할 수 없는 커넥터 코드는 프로세스 수준 격리(worker_threads / V8 isolate / microVM)가 필요하다. 현재 층은 자격증명 유출·SSRF의 폭발 반경을 실질적으로 줄이지만, 결정적 공격자에 대한 완전한 격리는 아니다.
- **결제 멱등성**: Stripe는 동일 이벤트를 재전송할 수 있다 — 운영에서는 `event.id` 멱등성 저장이 추가로 필요(서명·리플레이 방어는 구현됨).
- **볼트 마스터키 관리**: `FLOWDOCK_MASTER_KEY`는 KMS/시크릿 매니저에서 주입·로테이션해야 한다.

---

## 부록 A. 워크플로 YAML 예시 (Workflows-as-Code)

```yaml
name: 매일 아침 AI 뉴스 브리핑
on:
  cron: "0 7 * * *"          # 매일 07:00
nodes:
  - id: fetch
    uses: jina.reader
    with: { url: "https://news.ycombinator.com" }

  - id: summarize
    uses: llm.chat
    with:
      model: "free"
      prompt: "다음을 한국어 3줄 요약: {{ nodes.fetch.output.text }}"

  - id: tts
    uses: edge-tts.synthesize
    with:
      text: "{{ nodes.summarize.output.text }}"
      voice: "ko-KR-SunHiNeural"

  - id: notify
    uses: resend.email
    with:
      to: "{{ secrets.MY_EMAIL }}"
      subject: "오늘의 AI 브리핑"
      html: "{{ nodes.summarize.output.text }}"
      attachments: ["{{ nodes.tts.output.audio_url }}"]
```

이 한 파일이 = Webhook/Cron 트리거 + 4개 무료 API 연결 + 내구성 실행 + 크리덴셜 참조. **사용자가 이런 걸 10개 쌓으면 떠날 수 없습니다.**
