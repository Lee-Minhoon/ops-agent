import fs from "node:fs";

type Decision = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

interface InlineComment {
  path: string;
  line: number;
  body: string;
}

interface ReviewOutput {
  decision: Decision;
  summary: string;
  comments: InlineComment[];
}

interface PrMeta {
  title: string;
  headRefOid: string;
  files: Array<{ path: string; additions: number; deletions: number }>;
  // `gh pr view --json files` returns at most 100 files, so PR-wide totals are fetched separately.
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

interface ReviewPayload {
  event: Decision;
  body: string;
  comments: Array<InlineComment & { side: "RIGHT" }>;
}

const DECISIONS: readonly Decision[] = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];
const SENSITIVE_PATH_REGEX =
  /(^|\/)(auth|billing|payment|migrations|\.github|\.env)/i;
const MAX_AUTO_APPROVE_LINES = 1500;

/**
 * Parses a unified diff into, per file, the set of line numbers (RIGHT side) that can take a review comment.
 */
export function parseValidDiffLines(
  diffText: string,
): Map<string, Set<number>> {
  const validMap = new Map<string, Set<number>>();
  let currentLines: Set<number> | null = null;
  let newLineNum = 0;

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      // Start of a new file section: reset so a deleted file (+++ /dev/null) is not counted under the previous file
      currentLines = null;
      newLineNum = 0;
      continue;
    }

    if (rawLine.startsWith("+++ b/")) {
      const file = rawLine.slice(6).trim();
      currentLines = validMap.get(file) ?? new Set<number>();
      validMap.set(file, currentLines);
      newLineNum = 0;
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch?.[1] && currentLines) {
      newLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!currentLines || newLineNum === 0) continue;

    // Deleted lines ("-") do not advance the RIGHT side line number
    if (rawLine.startsWith("+") || rawLine.startsWith(" ")) {
      currentLines.add(newLineNum);
      newLineNum++;
    }
  }

  return validMap;
}

function isInlineComment(value: unknown): value is InlineComment {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.path === "string" &&
    c.path.length > 0 &&
    typeof c.line === "number" &&
    Number.isInteger(c.line) &&
    c.line > 0 &&
    typeof c.body === "string" &&
    c.body.trim().length > 0
  );
}

/**
 * Normalizes model output into a ReviewOutput without trusting its shape.
 */
function normalizeReview(value: unknown): ReviewOutput {
  if (typeof value !== "object" || value === null) {
    throw new Error("리뷰 결과가 JSON 객체가 아닙니다.");
  }
  const raw = value as Record<string, unknown>;

  if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
    throw new Error("리뷰 결과에 summary가 없습니다.");
  }

  const decision = DECISIONS.find((d) => d === raw.decision) ?? "COMMENT";
  const comments = Array.isArray(raw.comments)
    ? raw.comments.filter(isInlineComment)
    : [];

  return { decision, summary: raw.summary, comments };
}

/**
 * Extracts the review JSON from the Claude CLI (--output-format json) wrapper.
 * With --json-schema it is in `structured_output`; otherwise it is in the `result` string.
 */
export function parseClaudeOutput(rawContent: string): ReviewOutput {
  let text = rawContent.trim();

  try {
    const cliWrapper = JSON.parse(text) as Record<string, unknown> | null;
    if (cliWrapper && typeof cliWrapper === "object") {
      if (
        typeof cliWrapper.structured_output === "object" &&
        cliWrapper.structured_output !== null
      ) {
        return normalizeReview(cliWrapper.structured_output);
      }
      if (cliWrapper.is_error === true) {
        throw new Error(
          `Claude 실행 실패: ${String(cliWrapper.result ?? cliWrapper.subtype ?? "unknown")}`,
        );
      }
      if (typeof cliWrapper.result === "string") {
        text = cliWrapper.result.trim();
      } else if ("decision" in cliWrapper) {
        return normalizeReview(cliWrapper);
      }
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // Not a CLI wrapper: fall through and parse the text as-is
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }

  return normalizeReview(JSON.parse(text));
}

interface SubmittedReview {
  id: number;
  user: { id: number; login: string } | null;
}

interface ExistingReview extends SubmittedReview {
  state: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function submitReview(
  repoFull: string,
  prNumber: string,
  token: string,
  commitId: string,
  payload: ReviewPayload,
): Promise<SubmittedReview> {
  const apiUrl = `https://api.github.com/repos/${repoFull}/pulls/${prNumber}/reviews`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ commit_id: commitId, ...payload }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub Review API 실패 (${response.status}): ${errText}`);
  }
  return (await response.json()) as SubmittedReview;
}

/**
 * Dismisses this bot's earlier REQUEST_CHANGES reviews on the PR, now that `latest` replaces them.
 *
 * GitHub only counts a reviewer's latest APPROVE / REQUEST_CHANGES. A COMMENT review (for example an
 * approval downgraded by a guardrail) does not override an earlier REQUEST_CHANGES, so without this
 * the PR would stay "changes requested" after the author fixed everything.
 *
 * Failures here are logged as warnings and never fail the run: the new review is already posted.
 */
async function dismissSupersededChangeRequests(
  repoFull: string,
  prNumber: string,
  token: string,
  latest: SubmittedReview,
  commitId: string,
): Promise<number> {
  if (!latest.user) return 0;
  const baseUrl = `https://api.github.com/repos/${repoFull}/pulls/${prNumber}/reviews`;
  const headers = githubHeaders(token);

  const stale: ExistingReview[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${baseUrl}?per_page=100&page=${page}`, { headers });
    if (!response.ok) {
      console.log(`::warning::이전 리뷰 목록을 가져오지 못했습니다 (${response.status}).`);
      return 0;
    }
    const reviews = (await response.json()) as ExistingReview[];
    for (const review of reviews) {
      if (
        review.user?.id === latest.user.id &&
        review.id !== latest.id &&
        review.state === "CHANGES_REQUESTED"
      ) {
        stale.push(review);
      }
    }
    if (reviews.length < 100) break;
  }

  let dismissed = 0;
  for (const review of stale) {
    const response = await fetch(`${baseUrl}/${review.id}/dismissals`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `최신 커밋(${commitId.slice(0, 7)})에 대한 새 리뷰로 대체되었습니다.`,
        event: "DISMISS",
      }),
    });
    if (response.ok) {
      dismissed++;
    } else {
      console.log(
        `::warning::이전 리뷰 ${review.id}을(를) dismiss하지 못했습니다 (${response.status}): ${await response.text()}`,
      );
    }
  }
  return dismissed;
}

/**
 * Applies the guardrails (sensitive paths, change size, incomplete input), validates the inline comments,
 * and builds the final payload to submit to GitHub.
 */
export function buildReviewPayload(
  review: ReviewOutput,
  meta: PrMeta,
  diffText: string,
  diffTruncated: boolean,
): ReviewPayload {
  // 1. Guardrail checks (collect reasons to block auto-approval)
  const guardrailReasons: string[] = [];
  const touchedSensitiveFiles = meta.files
    .map((f) => f.path)
    .filter((p) => SENSITIVE_PATH_REGEX.test(p));

  if (touchedSensitiveFiles.length > 0) {
    guardrailReasons.push(
      `민감 경로 변경 감지(\`${touchedSensitiveFiles.join("`, `")}\`)`,
    );
  }

  const listedLines = meta.files.reduce(
    (acc, f) => acc + f.additions + f.deletions,
    0,
  );
  const totalChangedLines =
    typeof meta.additions === "number" && typeof meta.deletions === "number"
      ? meta.additions + meta.deletions
      : listedLines;
  if (totalChangedLines > MAX_AUTO_APPROVE_LINES) {
    guardrailReasons.push(`변경 규모 초과(${totalChangedLines}줄)`);
  }

  if (
    typeof meta.changedFiles === "number" &&
    meta.changedFiles > meta.files.length
  ) {
    guardrailReasons.push(
      `파일 목록 일부만 확인됨(${meta.files.length}/${meta.changedFiles}개)`,
    );
  }

  if (diffTruncated) {
    guardrailReasons.push("Diff가 잘려 일부만 검토됨");
  }

  let decision = review.decision;
  let body = review.summary;
  if (decision === "APPROVE" && guardrailReasons.length > 0) {
    decision = "COMMENT";
    body += `\n\n> **자동 승인 차단(Guardrail):** ${guardrailReasons.join(", ")} 사유로 인해 \`APPROVE\` 대신 \`COMMENT\`로 전환되었습니다. 담당자의 최종 확인이 필요합니다.`;
  }

  // 2. Keep only inline comments on valid diff lines (avoids 422 errors)
  const validLinesMap = parseValidDiffLines(diffText);
  const comments: ReviewPayload["comments"] = [];
  const fallbackComments: string[] = [];

  for (const c of review.comments) {
    if (validLinesMap.get(c.path)?.has(c.line)) {
      comments.push({ path: c.path, line: c.line, side: "RIGHT", body: c.body });
    } else {
      fallbackComments.push(`- **\`${c.path}:${c.line}\`**: ${c.body}`);
    }
  }

  if (fallbackComments.length > 0) {
    body += `\n\n### 추가 확인 사항\n${fallbackComments.join("\n")}`;
  }

  return { event: decision, body, comments };
}

async function main() {
  const token = process.env.GH_TOKEN;
  const repoFull = process.env.REPO; // e.g., "Lee-Minhoon/review-sandbox"
  const prNumber = process.env.PR_NUM;
  const diffTruncated = process.env.DIFF_TRUNCATED === "true";
  const dryRun = process.env.DRY_RUN === "true";

  if (!dryRun && (!token || !repoFull || !prNumber)) {
    throw new Error("필수 환경변수(GH_TOKEN, REPO, PR_NUM)가 누락되었습니다.");
  }

  const meta: PrMeta = JSON.parse(fs.readFileSync("pr_meta.json", "utf-8"));
  const diffText = fs.readFileSync("pr.diff", "utf-8");

  let payload: ReviewPayload;
  let reviewError: unknown = null;
  try {
    const review = parseClaudeOutput(
      fs.readFileSync("review_result.json", "utf-8"),
    );
    payload = buildReviewPayload(review, meta, diffText, diffTruncated);
  } catch (err) {
    // Even when generating or parsing the review fails, leave a notice on the PR so it is not silently skipped.
    reviewError = err;
    payload = {
      event: "COMMENT",
      body: "자동 리뷰를 생성하지 못했습니다. ops-agent 워크플로 실행 로그를 확인해 주세요. 이 PR은 사람의 리뷰가 필요합니다.",
      comments: [],
    };
  }

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const submitted = await submitReview(
      repoFull!,
      prNumber!,
      token!,
      meta.headRefOid,
      payload,
    );
    console.log(
      `리뷰 제출 완료: [${payload.event}] (인라인 코멘트 ${payload.comments.length}건)`,
    );

    // Only a review that actually covered the whole change may replace earlier verdicts.
    // A failure notice or a review of a truncated diff says nothing about whether old findings were fixed.
    if (!reviewError && !diffTruncated) {
      const dismissed = await dismissSupersededChangeRequests(
        repoFull!,
        prNumber!,
        token!,
        submitted,
        meta.headRefOid,
      );
      if (dismissed > 0) {
        console.log(`이전 변경 요청 리뷰 ${dismissed}건을 dismiss했습니다.`);
      }
    }
  }

  if (reviewError) throw reviewError;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
