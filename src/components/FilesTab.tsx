import { ArrowUp, Download, FileText, Folder, FolderOpen, Laptop, RefreshCw, Server, Upload } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatBytes } from '../lib/format'
import type { FileNode, VM } from '../types'

interface FilesTabProps {
  vm: VM
  localFiles: FileNode[]
  remoteFiles: FileNode[]
  localPath: string
  remotePath: string
  localLoading?: boolean
  localError?: string
  remoteLoading?: boolean
  remoteError?: string
  selectedLocalId?: string
  selectedRemoteId?: string
  onSelectLocal: (fileId: string) => void
  onSelectRemote: (fileId: string) => void
  onActivateLocal: (file: FileNode) => void
  onActivateRemote: (file: FileNode) => void
  onLocalUp: () => void
  onRefreshLocal: () => void
  onOpenLocalFolder: () => void
  onOpenRemoteFolder: (file: FileNode) => void
  onRemoteUp: () => void
  onRefreshRemote: () => void
  onUpload: () => void
  onDownload: () => void
  onCopyRemotePath: () => void
}

interface FilePaneProps {
  title: string
  subtitle: string
  icon: ReactNode
  files: FileNode[]
  selectedId?: string
  onSelect: (fileId: string) => void
  loading?: boolean
  error?: string
  onOpenFolder?: (file: FileNode) => void
  onActivate?: (file: FileNode) => void
}

function FileIcon({ type }: { type: FileNode['type'] }) {
  return type === 'folder' ? (
    <Folder className="h-4 w-4 text-slate-500" aria-hidden="true" />
  ) : (
    <FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />
  )
}

function FilePane({
  title,
  subtitle,
  icon,
  files,
  selectedId,
  onSelect,
  loading,
  error,
  onOpenFolder,
  onActivate,
}: FilePaneProps) {
  return (
    <section className="min-h-[360px] rounded border border-slate-200 bg-white">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-slate-500">{icon}</span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-950">{title}</h2>
            <p className="truncate text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        <span className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500">{files.length} items</span>
      </header>
      <div className="border-b border-slate-100 bg-white px-3 py-2 text-xs text-slate-500">{subtitle}</div>
      <div className="max-h-[430px] overflow-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="sticky top-0 border-b border-slate-100 bg-white text-[11px] uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Size</th>
              <th className="px-3 py-2 font-medium">Modified</th>
              <th className="px-3 py-2 font-medium">Owner</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={4}>
                  Loading directory...
                </td>
              </tr>
            ) : null}
            {!loading && error ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-rose-600" colSpan={4}>
                  {error}
                </td>
              </tr>
            ) : null}
            {!loading && !error && files.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={4}>
                  No files in this directory.
                </td>
              </tr>
            ) : null}
            {!loading && !error ? files.map((file) => (
              <tr
                key={file.id}
                onClick={() => onSelect(file.id)}
                onDoubleClick={() => onActivate?.(file)}
                className={selectedId === file.id ? 'bg-slate-100' : 'cursor-pointer hover:bg-slate-50'}
              >
                <td className="max-w-48 px-3 py-2">
                  <span className="flex items-center gap-2">
                    <FileIcon type={file.type} />
                    <span className="truncate font-medium text-slate-800">{file.name}</span>
                    {file.type === 'folder' && onOpenFolder ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenFolder(file)
                        }}
                        className="ml-auto h-6 rounded border border-slate-200 px-2 text-[11px] font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                      >
                        Open
                      </button>
                    ) : null}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-500">{formatBytes(file.size)}</td>
                <td className="px-3 py-2 text-slate-500">{file.modified}</td>
                <td className="px-3 py-2 text-slate-500">{file.owner ?? 'local'}</td>
              </tr>
            )) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function FilesTab({
  vm,
  localFiles,
  remoteFiles,
  localPath,
  remotePath,
  localLoading,
  localError,
  remoteLoading,
  remoteError,
  selectedLocalId,
  selectedRemoteId,
  onSelectLocal,
  onSelectRemote,
  onActivateLocal,
  onActivateRemote,
  onLocalUp,
  onRefreshLocal,
  onOpenLocalFolder,
  onOpenRemoteFolder,
  onRemoteUp,
  onRefreshRemote,
  onUpload,
  onDownload,
  onCopyRemotePath,
}: FilesTabProps) {
  const localSelection = localFiles.find((file) => file.id === selectedLocalId)
  const remoteSelection = remoteFiles.find((file) => file.id === selectedRemoteId)

  return (
    <div className="space-y-3" data-testid="files-tab">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-950">Dual-pane file transfer</h2>
          <p className="truncate text-xs text-slate-500">
            {localSelection ? localSelection.path : 'Select a local file'} {'->'}{' '}
            {remoteSelection ? remoteSelection.path : `${vm.hostname}:${remotePath}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onUpload}
            disabled={!localSelection || localSelection.type === 'folder'}
            className="inline-flex h-8 items-center gap-2 rounded border border-slate-900 bg-slate-900 px-2.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Upload
          </button>
          <button
            type="button"
            onClick={onDownload}
            disabled={!remoteSelection || remoteSelection.type === 'folder'}
            className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </button>
          <button
            type="button"
            onClick={onCopyRemotePath}
            disabled={!remoteSelection}
            className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Copy remote path
          </button>
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white px-3 py-2">
          <div className="min-w-0 truncate text-xs text-slate-500">
            <span className="font-medium text-slate-700">Local:</span> {localPath}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onLocalUp}
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
            >
              <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              Up
            </button>
            <button
              type="button"
              onClick={onOpenLocalFolder}
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
              Open local folder
            </button>
            <button
              type="button"
              onClick={onRefreshLocal}
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white px-3 py-2">
          <div className="min-w-0 truncate text-xs text-slate-500">
            <span className="font-medium text-slate-700">Remote:</span> {vm.connection.user}@{vm.connection.host}:{remotePath}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRemoteUp}
              disabled={remotePath === '/'}
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              Up
            </button>
            <button
              type="button"
              onClick={onRefreshRemote}
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 gap-3 xl:grid-cols-2">
        <FilePane
          title="Local machine"
          subtitle={localPath}
          icon={<Laptop className="h-4 w-4" aria-hidden="true" />}
          files={localFiles}
          selectedId={selectedLocalId}
          onSelect={onSelectLocal}
          loading={localLoading}
          error={localError}
          onOpenFolder={onActivateLocal}
          onActivate={onActivateLocal}
        />
        <FilePane
          title={vm.name}
          subtitle={remotePath}
          icon={<Server className="h-4 w-4" aria-hidden="true" />}
          files={remoteFiles}
          selectedId={selectedRemoteId}
          onSelect={onSelectRemote}
          loading={remoteLoading}
          error={remoteError}
          onOpenFolder={onOpenRemoteFolder}
          onActivate={onActivateRemote}
        />
      </div>
    </div>
  )
}
