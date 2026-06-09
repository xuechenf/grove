export interface CommandProfile {
  id: string
  command: string
  description: string
  mutating: boolean
  requiresConfirmation: boolean
}

export const approvedReadOnlyCommands: CommandProfile[] = [
  {
    id: 'list_directory',
    command: 'ls',
    description: 'List the current directory.',
    mutating: false,
    requiresConfirmation: false,
  },
  {
    id: 'uptime',
    command: 'uptime',
    description: 'Show uptime and load average.',
    mutating: false,
    requiresConfirmation: false,
  },
  {
    id: 'disk_usage',
    command: 'df -h',
    description: 'Show filesystem capacity.',
    mutating: false,
    requiresConfirmation: false,
  },
  {
    id: 'memory_usage',
    command: 'free -h',
    description: 'Show memory pressure.',
    mutating: false,
    requiresConfirmation: false,
  },
  {
    id: 'failed_services',
    command: 'systemctl --failed',
    description: 'List failed systemd units.',
    mutating: false,
    requiresConfirmation: false,
  },
  {
    id: 'limited_logs',
    command: 'sudo journalctl -p warning..alert -n 120 --no-pager',
    description: 'Read recent warning and alert logs.',
    mutating: false,
    requiresConfirmation: false,
  },
]

const mutatingPatterns = [
  /\bsudo\s+reboot\b/i,
  /\bsystemctl\s+reboot\b/i,
  /\bsystemctl\s+(restart|start|stop|enable|disable|reload|daemon-reload|kill)\b/i,
  /\bservice\s+\S+\s+(restart|start|stop|reload)\b/i,
  /\brm\s+/i,
  /\bmv\s+/i,
  /\bcp\s+/i,
  /\binstall\s+/i,
  /\bapt\s+/i,
  /\bapt-get\s+/i,
  /\byum\s+/i,
  /\bdnf\s+/i,
  /\bpip\s+install\b/i,
  /\bnpm\s+(install|update|audit\s+fix)\b/i,
  /\bchmod\s+/i,
  /\bchown\s+/i,
  /\bkill(all)?\s+/i,
  /\bpkill\s+/i,
  /\bdocker\s+(run|rm|restart|stop|start|compose\s+up|compose\s+down)\b/i,
  /\b(iptables|ufw|firewall-cmd)\s+/i,
  /\bsed\s+-i\b/i,
  /\btee\s+/i,
  /(^|\s)>\s*[^&\s]/,
  /(^|\s)>>\s*[^&\s]/,
  /\bcurl\b.*\|\s*(sh|bash)\b/i,
  /\bwget\b.*\|\s*(sh|bash)\b/i,
]

export function classifyCommand(command: string) {
  const normalized = command.trim()
  const approved = approvedReadOnlyCommands.find((profile) => profile.command === normalized)
  const mutating = mutatingPatterns.some((pattern) => pattern.test(normalized))

  return {
    approvedReadOnly: Boolean(approved),
    mutating,
    requiresConfirmation: mutating,
  }
}
