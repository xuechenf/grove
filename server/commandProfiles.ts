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
  /\b(reboot|shutdown|halt|poweroff)\b/i,
  /\binit\s+[0-6]\b/i,
  /\bsystemctl\s+(restart|start|stop|enable|disable|reload|daemon-reload|kill|poweroff|halt|mask|unmask|edit|set-default)\b/i,
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
  /\bdd\s+/i,
  /\b(mkfs|mkswap|wipefs)\b/i,
  /\b(fdisk|sfdisk|parted|partprobe)\b/i,
  /\b(mount|umount|swapoff|swapon)\s+/i,
  /\bcrontab\s+/i,
  /\b(useradd|userdel|usermod|groupadd|groupdel|passwd|chpasswd|visudo)\b/i,
  /\b(insmod|modprobe|rmmod)\s+/i,
  /\bdocker\s+(run|rm|restart|stop|start|compose\s+up|compose\s+down)\b/i,
  /\b(iptables|ufw|firewall-cmd)\s+/i,
  /\bsed\s+-i\b/i,
  /\btee\s+/i,
  // Any `>`/`>>` that writes to a target, including fd-prefixed (`2>file`) and
  // space-less (`echo x>file`) forms. Excludes fd duplication (`2>&1`, `>&2`) via [^&\s].
  />>?\s*[^&\s]/,
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

/**
 * Prefixes the copilot is allowed to run directly as read-only inspections. Anything not
 * matched here (or classified mutating) must become a confirmation proposal first. This is
 * a security-sensitive boundary; widen it deliberately.
 */
export const readOnlyCommandPrefixes = [
  'awk',
  'cat',
  'command -v',
  'date',
  'df',
  'dmesg',
  'du',
  'echo',
  'find',
  'free',
  'getent',
  'grep',
  'head',
  'hostname',
  'id',
  'ip ',
  'journalctl',
  'last',
  'ls',
  'lsblk',
  'lscpu',
  'lsof',
  'nproc',
  'pgrep',
  'ps',
  'pwd',
  'sensors',
  'ss',
  'stat',
  'sudo journalctl',
  'sudo systemctl is-active',
  'sudo systemctl is-enabled',
  'sudo systemctl list-units',
  'sudo systemctl status',
  'systemctl is-active',
  'systemctl is-enabled',
  'systemctl list-units',
  'systemctl list-unit-files',
  'systemctl show',
  'systemctl status',
  'tail',
  'top -b',
  'uname',
  'uptime',
  'vmstat',
  'wc',
  'which',
  'who',
  'whoami',
]

/**
 * Split a compound shell line into its simple commands on control operators (`;`, `&&`,
 * `||`, `|`, newlines). Returns null when the line contains command substitution (backticks
 * or `$(...)`): substitution can hide an arbitrary command behind any innocent-looking
 * prefix, so such lines must never be treated as read-only.
 */
export function splitSimpleCommands(command: string): string[] | null {
  if (command.includes('`') || command.includes('$(')) {
    return null
  }
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

/**
 * True when a command is safe for the copilot to execute without an explicit confirmation
 * proposal. A chained line is only read-only when EVERY simple command in it is: checking
 * just the leading prefix let `hostname; shutdown -h now` run without a confirmation.
 */
export function isReadOnlyCommand(command: string) {
  const trimmed = command.trim()
  if (!trimmed) {
    return false
  }

  if (classifyCommand(trimmed).mutating) {
    return false
  }

  const segments = splitSimpleCommands(trimmed)
  if (!segments || segments.length === 0) {
    return false
  }

  return segments.every((segment) => {
    const normalized = segment
      .replace(/^timeout\s+\d+[smhd]?\s+/i, '')
      .replace(/\s+/g, ' ')
    return readOnlyCommandPrefixes.some((prefix) => normalized.startsWith(prefix))
  })
}
