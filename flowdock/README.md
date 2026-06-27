# FlowDock (M0 core)

개발자용 멀티 API 자동화 허브 — **내구성 워크플로 엔진**의 M0 코어 구현.
설계 배경과 해자(lock-in) 전략은 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 참고.

> 한 줄: 여러 무료 API를 노드로 연결해 YAML 한 파일로 자동화한다. 엔진이 **순서·재시도·레이트리밋·체크포인트·크리덴셜 주입**을 다 처리하므로, 커넥터 작성자는 비즈니스 로직만 짠다.

## 이번 M0에서 실제로 동작하는 것

| 영역 | 구현 | 검증 |
|---|---|---|
| DAG 실행 | `{{ nodes.x }}` 참조로 의존성 자동 추론 → 위상정렬 | `test/engine.test.ts` |
| 내구성 실행 | 노드별 체크포인트 → 같은 runId로 **재개 시 성공 노드 스킵** | resume 테스트 |
| 재시도 | 노드별 지수 백오프 | retry 테스트 |
| 표현식 | `eval` 없는 안전 파서(경로·`??`·리터럴) | `test/expr.test.ts` |
| 크리덴셜 볼트 | AES-256-GCM 봉투 암호화 + 로그 마스킹 | `test/vault.test.ts` |
| 레이트리밋 | 커넥터별 토큰버킷(무료 티어 보호) | `src/ratelimit.ts` |
| 커넥터 | echo, http.request, jina.reader, llm.chat(Pollinations), pollinations.image, ntfy.publish, resend.email | `flowdock connectors` |

## 빠른 시작

```bash
npm install
npm test                                   # 21개 테스트 (네트워크 불필요)
npm run -s cli connectors                  # 등록된 커넥터 목록
npm run -s cli validate examples/morning-briefing.yaml
```

### 워크플로 실행

```bash
# keyless 데모: 추출(Jina) → 요약(LLM) → 푸시(ntfy)
npm run -s cli run examples/morning-briefing.yaml --trigger '{"topic":"my-topic"}'

# 중단된 실행 재개 (성공한 노드는 체크포인트로 스킵)
npm run -s cli run examples/morning-briefing.yaml --resume <runId>
```

> 참고: 외부 API 호출은 실행 환경의 네트워크 정책에 따라 차단될 수 있다(샌드박스에서는 허용 호스트 외 outbound가 막힘). 엔진 동작 자체는 `npm test`로 오프라인 검증된다.

## 시크릿 & 크리덴셜

- 워크플로 시크릿: `FLOWDOCK_SECRET_<NAME>` 환경변수 → `{{ secrets.NAME }}`
- 커넥터 크리덴셜(개발용): `.flowdock/credentials.json`
  ```json
  { "resend.email": { "apiKey": "re_..." } }
  ```
- 운영용 볼트: `src/vault.ts` (마스터키 → 테넌트키 → 시크릿). `FLOWDOCK_MASTER_KEY`(base64 32B) 필요.

## 새 커넥터 추가 (확장 지점)

`src/connectors/index.ts`에 `Connector` 하나 구현 후 레지스트리에 등록하면 끝.
`ctx.fetch`는 이미 레이트리밋·타임아웃·시크릿 마스킹이 적용된 래퍼다.

```ts
const myApi: Connector = {
  id: "myapi.action",
  title: "My API",
  rateLimit: { requests: 5, intervalMs: 1000 },
  async execute(input, ctx) {
    const res = await ctx.fetch("https://api.example.com/...", { /* ... */ });
    return { /* 다음 노드가 {{ nodes.<id>.output.* }}로 참조 */ };
  },
};
```

## 다음 단계 (로드맵)

- **M1 DX**: `flowdock push/pull`(에디터 동기화), 로컬 dry-run, 실행 타임라인 뷰
- **M2 생태계**: Connector SDK + 템플릿 갤러리
- **M3 수익화**: 플랜·과금·레이트리밋 풀 + 팀 협업

자세한 내용은 [`ARCHITECTURE.md`](./ARCHITECTURE.md).
