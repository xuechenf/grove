import { memo, type ReactNode } from 'react'
import { Check } from 'lucide-react'

/**
 * Dependency-free markdown renderer for copilot output. Covers the constructs agent
 * answers actually use: headings, fenced code (with language label), inline code, bold,
 * italic, strikethrough, links, nested bullet/numbered lists, task lists, blockquotes,
 * simple pipe tables, and horizontal rules. Completed messages render through the memoized
 * <Markdown> component; streaming text stays plain until finalized (see CopilotPanel).
 */

const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)|(\b_[^_]+_\b)/

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = text
  let key = 0

  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest)
    if (!match || match.index === undefined) {
      nodes.push(rest)
      break
    }
    if (match.index > 0) {
      nodes.push(rest.slice(0, match.index))
    }
    const token = match[0]
    key += 1

    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-slate-100 px-1 py-px font-mono text-[0.85em] text-rose-700">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={key} className="font-semibold text-slate-900">
          {renderInline(token.slice(2, -2))}
        </strong>,
      )
    } else if (token.startsWith('~~')) {
      nodes.push(
        <del key={key} className="text-slate-500">
          {renderInline(token.slice(2, -2))}
        </del>,
      )
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
      if (link) {
        nodes.push(
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900"
          >
            {renderInline(link[1])}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    } else {
      nodes.push(
        <em key={key} className="italic">
          {renderInline(token.slice(1, -1))}
        </em>,
      )
    }

    rest = rest.slice(match.index + token.length)
  }

  return nodes
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  return (
    <div className="my-1 overflow-hidden rounded-md border border-slate-800 bg-slate-950">
      {language ? (
        <div className="border-b border-slate-800 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-slate-400">
          {language}
        </div>
      ) : null}
      <pre className="overflow-auto p-3 font-mono text-[11px] leading-relaxed text-slate-100">{code}</pre>
    </div>
  )
}

interface ListItem {
  ordered: boolean
  marker: string
  level: number
  text: string
  checked?: boolean
}

function ListItemRow({ item }: { item: ListItem }) {
  const indent = { paddingLeft: `${item.level * 1.25}rem` }
  if (item.checked !== undefined) {
    return (
      <div style={indent} className="flex gap-2 leading-relaxed">
        <span
          className={`mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
            item.checked ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-400 bg-white'
          }`}
        >
          {item.checked ? <Check className="h-2.5 w-2.5" aria-hidden="true" /> : null}
        </span>
        <span className={item.checked ? 'text-slate-500 line-through' : ''}>{renderInline(item.text)}</span>
      </div>
    )
  }
  if (item.ordered) {
    return (
      <div style={indent} className="grid grid-cols-[1.5rem_1fr] gap-1 leading-relaxed">
        <span className="font-semibold text-slate-500">{item.marker}.</span>
        <span>{renderInline(item.text)}</span>
      </div>
    )
  }
  return (
    <div style={indent} className="flex gap-2 leading-relaxed">
      <span className="mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
      <span>{renderInline(item.text)}</span>
    </div>
  )
}

function MarkdownTable({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows
  return (
    <div className="my-1 overflow-auto rounded-md border border-slate-200">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            {header.map((cell, index) => (
              <th key={index} className="px-2.5 py-1.5 font-semibold text-slate-700">
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-slate-100 last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2.5 py-1.5 align-top text-slate-700">
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}.*\|.*$/.test(line) && /^[\s|:-]+$/.test(line)
}

const HEADING_SIZES: Record<number, string> = {
  1: 'text-base font-semibold text-slate-950',
  2: 'text-sm font-semibold text-slate-950',
  3: 'text-sm font-semibold text-slate-900',
  4: 'text-xs font-semibold uppercase tracking-wide text-slate-700',
}

function renderMarkdown(content: string): ReactNode[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const nodes: ReactNode[] = []
  let index = 0
  let key = 0

  const nextKey = (prefix: string) => `${prefix}-${(key += 1)}`

  while (index < lines.length) {
    const line = lines[index]

    // Fenced code: collect to the closing fence (or end of content while streaming).
    const fence = line.match(/^\s*```\s*(\S*)\s*$/)
    if (fence) {
      const language = fence[1] || undefined
      const buffer: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        buffer.push(lines[index])
        index += 1
      }
      index += 1
      nodes.push(<CodeBlock key={nextKey('code')} language={language} code={buffer.join('\n')} />)
      continue
    }

    if (!line.trim()) {
      index += 1
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      nodes.push(
        <h3 key={nextKey('heading')} className={`mt-2 first:mt-0 ${HEADING_SIZES[level]}`}>
          {renderInline(heading[2])}
        </h3>,
      )
      index += 1
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push(<hr key={nextKey('hr')} className="my-2 border-slate-200" />)
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const buffer: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        buffer.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      nodes.push(
        <blockquote key={nextKey('quote')} className="border-l-2 border-slate-300 pl-3 text-slate-600">
          {buffer.map((quoted, quoteIndex) => (
            <p key={quoteIndex} className="leading-relaxed">
              {renderInline(quoted)}
            </p>
          ))}
        </blockquote>,
      )
      continue
    }

    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const rows: string[][] = [splitTableRow(line)]
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      nodes.push(<MarkdownTable key={nextKey('table')} rows={rows} />)
      continue
    }

    const listMatch = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.+)$/)
    if (listMatch) {
      const items: ListItem[] = []
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^(\s*)([-*•]|\d+[.)])\s+(.+)$/)
        if (!itemMatch) {
          break
        }
        const ordered = /\d/.test(itemMatch[2])
        const task = itemMatch[3].match(/^\[([ xX])\]\s+(.+)$/)
        items.push({
          ordered,
          marker: itemMatch[2].replace(/[.)]/, ''),
          level: Math.floor(itemMatch[1].replace(/\t/g, '  ').length / 2),
          text: task ? task[2] : itemMatch[3],
          checked: task ? task[1] !== ' ' : undefined,
        })
        index += 1
      }
      nodes.push(
        <div key={nextKey('list')} className="space-y-0.5">
          {items.map((item, itemIndex) => (
            <ListItemRow key={itemIndex} item={item} />
          ))}
        </div>,
      )
      continue
    }

    // Plain paragraph: adjacent non-special lines merge, as in markdown proper.
    const buffer: string[] = [line.trim()]
    index += 1
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(```|#{1,4}\s|>|([-*•]|\d+[.)])\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[index]) &&
      !(lines[index].includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
    ) {
      buffer.push(lines[index].trim())
      index += 1
    }
    nodes.push(
      <p key={nextKey('p')} className="leading-relaxed">
        {renderInline(buffer.join(' '))}
      </p>,
    )
  }

  return nodes
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return <div className="space-y-1.5 text-sm text-slate-700">{renderMarkdown(content)}</div>
})
