#!/usr/bin/env bash
# Registers the PAT that lets a target repository send review requests to ops-agent,
# as that repository's OPS_AGENT_DISPATCH_TOKEN secret. Reads the PAT from the macOS clipboard.
#
# Usage: ./scripts/set-dispatch-token.sh <owner/target-repo>
#
# Start this script first, then copy the token, then press Enter. That order keeps
# the clipboard from being overwritten by a copied command before the token is read.
set -euo pipefail

TARGET_REPO="${1:?사용법: ./scripts/set-dispatch-token.sh <owner/대상-레포>}"
OPS_AGENT_REPO="${OPS_AGENT_REPO:-Lee-Minhoon/ops-agent}"

echo "1) GitHub에서 fine-grained PAT 을 만드세요 (대상: ${OPS_AGENT_REPO}, Contents: Read and write)."
echo "2) 생성된 토큰(github_pat_ 로 시작)을 복사하세요."
read -r -p "3) 복사했으면 이 창에서 Enter 를 누르세요... " _

token="$(pbpaste | tr -d '[:space:]')"

if [[ ! "$token" =~ ^(github_pat_|ghp_)[A-Za-z0-9_]+$ ]]; then
  echo "✗ 클립보드 내용이 GitHub 토큰 형식이 아닙니다 (길이 ${#token}자). 토큰만 다시 복사한 뒤 재실행하세요." >&2
  exit 1
fi

# Confirm the token is live and can see ops-agent before storing it.
if ! GH_TOKEN="$token" gh api "repos/${OPS_AGENT_REPO}" --jq .full_name >/dev/null 2>&1; then
  echo "✗ 이 토큰으로 ${OPS_AGENT_REPO} 에 접근할 수 없습니다. 토큰의 Repository access 에 ${OPS_AGENT_REPO} 가 선택되어 있는지 확인하세요." >&2
  exit 1
fi

# Confirm the token may send repository_dispatch (needs Contents: Read and write).
# No workflow listens for this event type, so the probe triggers nothing.
if ! GH_TOKEN="$token" gh api "repos/${OPS_AGENT_REPO}/dispatches" -f event_type=dispatch-token-check >/dev/null 2>&1; then
  echo "✗ 이 토큰은 ${OPS_AGENT_REPO} 에 이벤트를 보낼 권한이 없습니다. 토큰의 Repository permissions 에서 Contents 를 'Read and write' 로 설정하세요." >&2
  exit 1
fi

printf '%s' "$token" | gh secret set OPS_AGENT_DISPATCH_TOKEN --repo "$TARGET_REPO"
echo "✓ 등록 완료: ${TARGET_REPO} 의 OPS_AGENT_DISPATCH_TOKEN (토큰 길이 ${#token}자)"
