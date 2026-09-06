// Reasoning over code (v0.3.1, audit C1/C4 — G4.1).
//
// Dhakira remembers WHY a choice was made, dead ends, conventions — never the
// code itself. Until this release nothing implemented that principle: a pasted
// file or a generated module landed verbatim in turns/ (the indexed, injected
// store). This module is the deterministic, model-free stage that enforces it
// on the STORED turn:
//
//   * fenced code blocks longer than CODE_BLOCK_MAX_LINES collapse to
//     `[code block: <lang>, N lines]` — short snippets (≤ N lines) are kept,
//     because a 3-line example is often the clearest statement of a convention;
//   * runs of identical lines (logs, repeated tool output) collapse to the first
//     line plus a repeat marker.
//
// The raw archive in conversations/ is NOT touched — it stays verbatim by design
// (the mine future re-synthesis draws on). Pure functions, no I/O, no model.

/** Fenced blocks with more lines than this are collapsed. */
export const CODE_BLOCK_MAX_LINES = 10

/** Runs of identical consecutive lines at least this long are collapsed. */
export const REPEAT_RUN_MIN = 3

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/

function isFenceClose(line: string, fence: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith(fence[0] as string)) return false
  // CommonMark: a closing fence uses the same character, at least as long, nothing else.
  const run = trimmed.match(/^(`+|~+)\s*$/)
  return (
    run !== null && (run[1] as string)[0] === fence[0] && (run[1] as string).length >= fence.length
  )
}

export function collapsedBlockMarker(lang: string, lines: number): string {
  return `[code block: ${lang.length > 0 ? lang : 'code'}, ${lines} lines]`
}

/**
 * Replace every fenced code block longer than `maxLines` with a one-line marker.
 * Blocks of `maxLines` or fewer lines are returned untouched (fences included).
 * An unterminated fence runs to the end of the text and is treated as a block.
 */
export function collapseCodeBlocks(text: string, maxLines: number = CODE_BLOCK_MAX_LINES): string {
  if (!text.includes('```') && !text.includes('~~~')) return text

  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const open = (lines[i] as string).match(FENCE_OPEN)
    if (open === null) {
      out.push(lines[i] as string)
      i++
      continue
    }

    const fence = open[1] as string
    const lang = (open[2] as string).toLowerCase()
    let j = i + 1
    while (j < lines.length && !isFenceClose(lines[j] as string, fence)) j++
    const bodyLines = j - (i + 1)
    const closed = j < lines.length
    const end = closed ? j + 1 : j // index just past the block

    if (bodyLines > maxLines) {
      out.push(collapsedBlockMarker(lang, bodyLines))
    } else {
      out.push(...lines.slice(i, end))
    }
    i = end
  }
  return out.join('\n')
}

/**
 * Collapse runs of identical consecutive non-blank lines (≥ `minRun`) to the
 * first line plus `[… repeated N more times]`. Typical source: tool output and
 * logs echoed into an assistant reply.
 */
export function collapseRepeatedLines(text: string, minRun: number = REPEAT_RUN_MIN): string {
  const lines = text.split('\n')
  if (lines.length < minRun) return text

  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    let j = i + 1
    if (line.trim().length > 0) {
      while (j < lines.length && lines[j] === line) j++
    }
    const run = j - i
    if (run >= minRun) {
      out.push(line, `[… repeated ${run - 1} more times]`)
    } else {
      for (let k = i; k < j; k++) out.push(lines[k] as string)
    }
    i = j
  }
  return out.join('\n')
}

/** The storage-side pass applied to every turn-pair side: fences first, then repeats. */
export function collapseForStorage(text: string): string {
  return collapseRepeatedLines(collapseCodeBlocks(text))
}
