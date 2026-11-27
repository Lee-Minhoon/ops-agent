# ops-agent

다른 레포의 PR을 Claude Code로 자동 리뷰하는 중앙 워크플로입니다. 대상 레포가 `repository_dispatch` 이벤트를 보내면, 이 레포의 워크플로가 PR diff를 읽고 리뷰어 GitHub App 이름으로 리뷰(승인 / 변경 요청 / 코멘트)를 남깁니다.

## 동작 흐름

1. 대상 레포에서 PR이 열리거나 갱신되면 [examples/request-review.yml](examples/request-review.yml) 워크플로가 이 레포로 `pr-review-requested` 이벤트를 보냅니다.
2. [.github/workflows/pr-review.yml](.github/workflows/pr-review.yml)이 대상 레포 하나로 범위를 좁힌 앱 토큰을 발급받아 PR 메타데이터와 diff를 내려받습니다.
3. diff의 각 줄에 변경 후 파일 기준 줄 번호를 붙인 `pr.annotated.diff`를 만듭니다. Claude가 인라인 코멘트의 줄 번호를 틀리지 않게 하기 위함입니다.
4. 같은 워크플로가 대상 레포를 PR의 최신 커밋으로 `target/`에 내려받습니다. Claude가 diff 밖의 호출부나 타입 정의를 확인하기 위한 읽기 전용 자료이며, 코드를 설치하거나 실행하지 않습니다.
5. 헤드리스 Claude Code가 [.claude/skills/pr-review/SKILL.md](.claude/skills/pr-review/SKILL.md) 규칙에 따라 리뷰하고, [schemas/review.schema.json](schemas/review.schema.json) 형태의 JSON을 출력합니다.
6. [scripts/submit-review.ts](scripts/submit-review.ts)가 가드레일을 적용한 뒤 GitHub Review API로 제출합니다.

## 설정

### 1. 리뷰어 GitHub App

GitHub App을 만들고 리뷰할 대상 레포에 설치합니다.

| 레포 권한 | 수준 |
|---|---|
| Pull requests | Read and write |
| Contents | Read-only |

App 설정 화면에서 두 가지를 챙깁니다.

- **Client ID**: "About" 항목에 표시됩니다(`Iv`로 시작). 비밀 값은 아닙니다.
- **Private key**: "Generate a private key"로 `.pem` 파일을 내려받습니다.

### 2. 이 레포(ops-agent)의 시크릿과 변수

| 종류 | 이름 | 설명 |
|---|---|---|
| Secret | `REVIEWER_APP_CLIENT_ID` | 리뷰어 App의 Client ID |
| Secret | `REVIEWER_APP_PRIVATE_KEY` | 리뷰어 App의 private key (PEM 전체) |
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | Claude 구독 계정의 장기 토큰. 로컬에서 `claude setup-token`으로 발급. 구독 사용량 한도에서 차감 |
| Secret | `ANTHROPIC_API_KEY` | Claude API 키 (Console에서 발급, 사용량만큼 과금). 위 토큰 대신 사용 가능 |
| Variable (선택) | `REVIEW_MODEL` | 리뷰에 쓸 모델. 기본값 `claude-opus-5-5` |
| Variable (선택) | `REVIEW_MAX_BUDGET_USD` | 리뷰 1회당 API 비용 상한(USD). 기본값 `2` |

App 시크릿 두 개는 `gh`로 등록합니다.

```bash
gh secret set REVIEWER_APP_CLIENT_ID --repo Lee-Minhoon/ops-agent --body "<Client ID>"
gh secret set REVIEWER_APP_PRIVATE_KEY --repo Lee-Minhoon/ops-agent < <내려받은 .pem 파일 경로>
```

Claude 구독 토큰은 [scripts/set-claude-token.sh](scripts/set-claude-token.sh)로 등록합니다. 스크립트가 클립보드에서 토큰을 읽으므로 **스크립트를 먼저 실행한 뒤에 토큰을 복사**해야 합니다. 토큰을 복사한 다음 명령을 복사해 붙여넣으면 클립보드가 덮어써져 엉뚱한 값이 등록됩니다.

1. 터미널 창 하나에서 스크립트를 실행합니다. 안내를 출력하고 Enter를 기다립니다.
   ```bash
   ./scripts/set-claude-token.sh
   ```
2. 다른 터미널 창에서 토큰을 발급받습니다. 브라우저 로그인이 필요합니다.
   ```bash
   npx claude setup-token
   ```
3. 출력된 토큰(`sk-ant-oat`로 시작)만 복사합니다.
4. 첫 번째 창으로 돌아가 Enter를 누릅니다.

클립보드 내용이 토큰 형식이 아니면 등록하지 않고 종료합니다. 두 스크립트 모두 `pbpaste`를 쓰므로 macOS에서만 동작합니다.

### 3. 대상 레포

1. [examples/request-review.yml](examples/request-review.yml)을 대상 레포의 `.github/workflows/`에 복사합니다.
2. 대상 레포가 ops-agent에 리뷰 요청을 보낼 때 쓸 토큰을 등록합니다. [scripts/set-dispatch-token.sh](scripts/set-dispatch-token.sh)를 사용하며, 위와 마찬가지로 **스크립트를 먼저 실행한 뒤에 토큰을 복사**합니다.
   1. 스크립트를 실행합니다. 인자는 대상 레포입니다.
      ```bash
      ./scripts/set-dispatch-token.sh <owner/대상-레포>
      ```
   2. <https://github.com/settings/personal-access-tokens/new>에서 fine-grained PAT을 만듭니다.
      - Repository access: "Only select repositories"에서 `ops-agent`만 선택
      - Repository permissions → Contents: **Read and write** (`repository_dispatch` 전송에 GitHub이 요구하는 권한)
   3. 생성된 토큰(`github_pat_`로 시작)을 복사하고, 터미널로 돌아가 Enter를 누릅니다.

   스크립트는 등록 전에 토큰 형식, ops-agent 접근 가능 여부, 이벤트 전송 권한을 차례로 확인합니다. 권한 확인은 어떤 워크플로도 받지 않는 시험 이벤트(`dispatch-token-check`)를 실제로 보내는 방식이라 아무것도 실행시키지 않습니다.
3. 이후 대상 레포에서 PR을 열거나, PR에 커밋을 푸시하거나, 드래프트를 해제하면 자동으로 리뷰가 실행됩니다.

이벤트 페이로드 형식:

```json
{
  "event_type": "pr-review-requested",
  "client_payload": { "repo": "owner/name", "pr_number": 123 }
}
```

## 가드레일

Claude가 `APPROVE`를 내더라도 아래 중 하나에 해당하면 `COMMENT`로 낮추고 사유를 리뷰 본문에 적습니다.

- 민감 경로 변경: `auth`, `billing`, `payment`, `migrations`, `.github`, `.env`로 시작하는 경로 세그먼트
- 변경 규모가 1,500줄 초과
- diff가 4,000줄을 넘어 잘린 경우
- 변경 파일이 100개를 넘어 파일 목록을 전부 확인하지 못한 경우

그 밖의 안전장치:

- PR 내용은 신뢰할 수 없는 입력으로 취급합니다. Claude에는 읽기 전용 도구(`Read`, `Grep`, `Glob`)만 열려 있고, [ci/claude-settings.json](ci/claude-settings.json)이 명령 실행, 파일 쓰기, 네트워크 접근을 추가로 차단합니다.
- `target/`에 내려받은 대상 레포에서 Claude Code가 설정으로 읽어 들이는 파일(`CLAUDE.md`, `CLAUDE.local.md`, `.claude/`, `.mcp.json`)과 모든 심볼릭 링크, `.git`을 Claude 실행 전에 삭제합니다. PR에 심은 설정이나 작업 디렉토리 밖을 가리키는 링크가 리뷰에 영향을 주지 못하게 하기 위함입니다.
- diff에 실제로 존재하지 않는 줄을 가리키는 인라인 코멘트는 리뷰 본문의 "추가 확인 사항"으로 옮깁니다.
- 리뷰 생성이나 파싱에 실패하면 PR에 실패 안내 코멘트를 남기고 워크플로를 실패 처리합니다.
- 새 리뷰를 제출한 뒤, 같은 PR에 봇이 이전에 남긴 변경 요청(`REQUEST_CHANGES`) 리뷰를 dismiss합니다. GitHub은 `COMMENT` 리뷰를 판정으로 치지 않아서, 문제를 고친 뒤의 리뷰가 가드레일로 `COMMENT`가 되면 예전 변경 요청이 그대로 유효하게 남기 때문입니다. 리뷰 생성에 실패했거나 diff가 잘린 경우에는 이전 지적이 해결됐는지 알 수 없으므로 dismiss하지 않습니다.
- 같은 조건에서 PR 대화 탭도 정리합니다. 봇의 이전 리뷰는 "outdated"로 접고, 봇의 이전 인라인 코멘트 스레드는 resolve합니다. 최신 리뷰만 펼쳐진 채로 남고, 아직 유효한 지적은 새 리뷰가 다시 답니다. 봇이 아닌 사람이 답글을 단 스레드는 논의 중일 수 있으므로 건드리지 않습니다. PR당 리뷰 100건, 스레드 100건까지만 처리합니다.
  - 스레드 resolve는 리뷰어 App의 기본 권한(Pull requests 쓰기, Contents 읽기)으로는 GitHub이 거부합니다. 이 경우 스레드의 코멘트를 "outdated"로 접는 방식으로 대체합니다. 화면에서는 접혀 보이지만 스레드 자체는 미해결 상태로 남으므로, 브랜치 보호 규칙에서 "Require conversation resolution"을 켠 레포에서는 사람이 직접 resolve해야 머지할 수 있습니다.
- 포크에서 온 PR과 드래프트 PR은 리뷰를 요청하지 않습니다.

## 로컬 개발

```bash
npm ci          # Node.js 24 기준
npm run typecheck
```

실제 PR로 로컬에서 시험하려면 워크플로와 같은 순서로 실행합니다. `DRY_RUN=true`이면 GitHub에 제출하지 않고 제출될 페이로드만 출력합니다.

```bash
gh pr view <번호> --repo <owner/name> \
  --json title,body,headRefOid,files,additions,deletions,changedFiles > pr_meta.json
gh pr diff <번호> --repo <owner/name> > pr.diff
npx tsx scripts/annotate-diff.ts pr.diff pr.annotated.diff   # Claude가 읽을 줄 번호 표기 diff

# 대상 레포를 PR의 최신 커밋으로 target/ 에 내려받고, 워크플로와 동일하게 무력화
gh repo clone <owner/name> target -- --depth 1
git -C target fetch --depth 1 origin "pull/<번호>/head" && git -C target checkout FETCH_HEAD
rm -rf target/.git
find target -type l -delete
find target -depth \( -name '.claude' -o -name 'CLAUDE.md' -o -name 'CLAUDE.local.md' -o -name '.mcp.json' \) -exec rm -rf {} +

npx claude -p ".claude/skills/pr-review/SKILL.md 규칙을 반드시 준수하여 현재 디렉토리의 pr_meta.json과 pr.annotated.diff를 리뷰하라. PR이 적용된 대상 레포 전체 코드는 target/ 디렉토리에 있으니 변경의 영향 범위를 확인할 때 참고하라." \
  --tools "Read,Grep,Glob" --settings ci/claude-settings.json --strict-mcp-config \
  --json-schema "$(cat schemas/review.schema.json)" \
  --output-format json < /dev/null > review_result.json

DRY_RUN=true npm run submit-review
```

## 구조

```
.claude/skills/pr-review/SKILL.md   리뷰 판정 기준과 출력 규칙
.github/workflows/pr-review.yml     리뷰 워크플로 (repository_dispatch)
ci/claude-settings.json             CI에서만 적용하는 Claude Code 권한 제한
examples/request-review.yml         대상 레포용 호출 워크플로 템플릿
schemas/review.schema.json          리뷰 출력 JSON 스키마
scripts/annotate-diff.ts            diff의 각 줄에 변경 후 파일 기준 줄 번호를 붙임
scripts/submit-review.ts            가드레일 적용 및 리뷰 제출
scripts/set-claude-token.sh         구독 토큰을 클립보드에서 읽어 시크릿으로 등록
```
