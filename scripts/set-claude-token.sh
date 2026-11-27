#!/usr/bin/env bash
# Registers the Claude subscription token (from `claude setup-token`) as the
# CLAUDE_CODE_OAUTH_TOKEN secret, reading it from the macOS clipboard.
#
# Start this script first, then copy the token, then press Enter. That order keeps
# the clipboard from being overwritten by a copied command before the token is read.
set -euo pipefail

REPO="${1:-Lee-Minhoon/ops-agent}"

echo "1) 다른 터미널 창에서 'npx claude setup-token' 을 실행해 토큰을 발급받으세요."
echo "2) 출력된 토큰(sk-ant-oat 로 시작)을 복사하세요."
read -r -p "3) 복사했으면 이 창에서 Enter 를 누르세요... " _

# Terminal line wrapping can insert newlines or spaces into the copied token.
token="$(pbpaste | tr -d '[:space:]')"

if [[ ! "$token" =~ ^sk-ant-oat[0-9]+-[A-Za-z0-9_-]+$ ]]; then
  echo "✗ 클립보드 내용이 토큰 형식이 아닙니다 (길이 ${#token}자). 토큰만 다시 복사한 뒤 스크립트를 재실행하세요." >&2
  exit 1
fi

printf '%s' "$token" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$REPO"
echo "✓ 등록 완료 (토큰 길이 ${#token}자)"
