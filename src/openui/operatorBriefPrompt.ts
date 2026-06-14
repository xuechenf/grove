export const OPENUI_OPERATOR_BRIEF_PROMPT = `
## OpenUI operator briefs

You may render ONE generated operator brief by adding a single fenced \`openui\` block after a
concise markdown summary. Use it only for status dashboards, operator briefs, comparisons,
diagnosis summaries, and AppRunner health reviews. Normal explanations stay markdown-only
unless a generated UI makes the operational state easier to scan.

### Syntax — openui-lang, NOT JSX (this is mandatory)
The block content is openui-lang, a declarative assignment language. It is NOT JSX, HTML, or
XML. Angle brackets (\`<OperatorBrief ...>\`, \`<VMCard/>\`) DO NOT WORK and the whole brief is
discarded. Follow these rules exactly:
- Every statement is \`identifier = Expression\` on its own line.
- \`root\` is the entry point; every block must define \`root = OperatorBrief(...)\`.
- Arguments are POSITIONAL — order matters, names do not. Write \`OperatorBrief("Title", "fleet")\`,
  never \`OperatorBrief(title="Title")\` or \`title: "Title"\` (colon/keyword syntax silently breaks).
- Skip a trailing optional argument by omitting it, or pass \`null\` to skip a middle one.
- Values are strings ("double quotes, backslash-escaped"), numbers, true/false, null, arrays
  [...], objects { key: value }, or component calls.
- Object literals inside arrays use \`{ key: value }\` (that colon is for data, not arguments).

### Components — only these exist; any other name is dropped
- OperatorBrief(title, scope, tone, summary, metrics, vms, alerts, services, processes, appServices, actions)
- MetricGrid(items)
- VmHealthTable(rows)
- AlertList(alerts)
- ServiceTable(services)
- ProcessList(processes)
- AppRunnerTable(services)
- ActionBar(actions)

Argument shapes:
- tone: "neutral" | "info" | "success" | "warning" | "critical"; scope: "fleet" | "vm".
- metrics item: { label, value, detail?, percent?, tone? }
- vms row: { id, name, health, lifecycle, host?, detail? }  (health: healthy|warning|critical|offline)
- alerts item: { vmId?, vmName?, severity?, message }
- services item: { name, state, port?, cpuPercent?, memoryMb?, detail? }  (state: running|degraded|stopped)
- actions item: { kind, label, vmId?, tab?, message? }  (kind: focus_vm|open_tab|ask_followup|request_fix)

### Safety
- Emit at most one \`openui\` block per answer. Do not use Query() or Mutation().
- Never create mutating controls. For a fix, use an ActionBar action with kind="request_fix"
  so Grove asks Copilot to propose a Grove-confirmed fix.

### Example (copy this shape exactly)
\`\`\`openui
root = OperatorBrief(
  "Fleet attention brief",
  "fleet",
  "warning",
  "Two machines are healthy and one needs attention.",
  [{ label: "Running", value: "3/3", detail: "all inventory VMs are online" }],
  [{ id: "vm-orchid", name: "orchid-build-01", health: "warning", lifecycle: "running", detail: "disk pressure" }],
  [{ vmId: "vm-orchid", vmName: "orchid-build-01", severity: "warning", message: "Disk usage is near threshold" }],
  null,
  null,
  null,
  [{ kind: "focus_vm", label: "Open orchid", vmId: "vm-orchid" }]
)
\`\`\`
`.trim()
