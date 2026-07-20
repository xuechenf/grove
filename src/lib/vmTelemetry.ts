import type { CloudMetricSeries, VM, VmOverviewTelemetry } from '../types'

export function hostTelemetry(vm: VM, warning?: string): VmOverviewTelemetry {
  return {
    vm,
    source: 'host',
    sourceLabel: 'Host over SSH',
    sampledAt: vm.metrics.sampledAt,
    warnings: warning ? [warning] : [],
  }
}

export function seriesFor(telemetry: VmOverviewTelemetry, key: CloudMetricSeries['key']) {
  return telemetry.cloudMetrics?.series.find((series) => series.key === key)
}

export function latestMetric(series: CloudMetricSeries | undefined) {
  return series?.points.at(-1)?.value
}

export function rateMbps(series: CloudMetricSeries | undefined, periodSeconds: number) {
  const value = latestMetric(series)
  if (value === undefined) return undefined
  const unit = series?.unit.toLowerCase() ?? ''
  if (unit.includes('bits/second')) return value / 1_000_000
  if (unit === 'bytes') return (value * 8) / Math.max(periodSeconds, 1) / 1_000_000
  if (unit.includes('megabits/second')) return value
  return value
}

export function rateLabel(value: number | undefined) {
  if (value === undefined) return 'No data'
  if (value >= 1) return `${value.toFixed(2)} Mbps`
  return `${(value * 1000).toFixed(value * 1000 >= 10 ? 1 : 2)} Kbps`
}

export function formatSampleTime(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

export function telemetryValues(telemetry: VmOverviewTelemetry) {
  const vm = telemetry.vm
  const period = telemetry.cloudMetrics?.periodSeconds ?? 1
  const cpuSeries = seriesFor(telemetry, 'cpuPercent')
  const networkInSeries = seriesFor(telemetry, 'networkInBytes')
  const networkOutSeries = seriesFor(telemetry, 'networkOutBytes')
  const cloudCpu = latestMetric(cpuSeries)
  return {
    cpuSeries,
    networkInSeries,
    networkOutSeries,
    cpuPercent: cloudCpu === undefined ? vm.metrics.cpuPercent : Number(cloudCpu.toFixed(1)),
    networkInMbps: telemetry.source === 'host' ? vm.metrics.networkInMbps : rateMbps(networkInSeries, period),
    networkOutMbps: telemetry.source === 'host' ? vm.metrics.networkOutMbps : rateMbps(networkOutSeries, period),
  }
}

export function telemetrySourceLabel(telemetry: VmOverviewTelemetry) {
  if (telemetry.source === 'host') return 'SSH'
  return telemetry.source === 'aws' ? 'CloudWatch + SSH' : 'CloudMonitor + SSH'
}
