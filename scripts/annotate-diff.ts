import fs from "node:fs";

/**
 * Rewrites a unified diff so every hunk line carries its line number in the new file (RIGHT side).
 *
 * The model reads the diff through a tool that shows the diff file's own line numbers, and it tends
 * to report those instead of the changed file's line numbers. Printing the correct number on each
 * line removes the need to count from hunk headers.
 *
 *   before:  +  return cartTotal(items) / count;
 *   after:       13 | +  return cartTotal(items) / count;
 *
 * Deleted lines have no RIGHT side line number and get a blank gutter.
 */
export function annotateDiff(diffText: string): string {
  const GUTTER_WIDTH = 6;
  const blankGutter = `${" ".repeat(GUTTER_WIDTH)} | `;
  const out: string[] = [];
  let inHunk = false;
  let newLineNum = 0;

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      out.push(rawLine);
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch?.[1]) {
      inHunk = true;
      newLineNum = parseInt(hunkMatch[1], 10);
      out.push(rawLine);
      continue;
    }

    if (!inHunk) {
      out.push(rawLine);
      continue;
    }

    if (rawLine.startsWith("+") || rawLine.startsWith(" ")) {
      out.push(`${String(newLineNum).padStart(GUTTER_WIDTH)} | ${rawLine}`);
      newLineNum++;
    } else if (rawLine.startsWith("-") || rawLine.startsWith("\\")) {
      // Deleted lines and "\ No newline at end of file" markers
      out.push(`${blankGutter}${rawLine}`);
    } else {
      out.push(rawLine);
    }
  }

  return out.join("\n");
}

const [input = "pr.diff", output = "pr.annotated.diff"] = process.argv.slice(2);
fs.writeFileSync(output, annotateDiff(fs.readFileSync(input, "utf-8")));
console.log(`Annotated diff written to ${output}`);
