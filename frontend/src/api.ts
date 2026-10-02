export interface Health {
  status: string
  database: string
}

export type JobStatus = 'pending' | 'collecting' | 'downloading' | 'done' | 'failed'

export interface SkippedReel {
  url: string
  reason: string
}

export interface DownloadJob {
  id: number
  page_url: string
  count: number
  skip_custom_covers: boolean
  status: JobStatus
  output_dir: string | null
  files: string[]
  failed: string[]
  skipped: SkippedReel[]
  error: string | null
  created_at: string
}

export interface LibraryFolder {
  name: string
  file_count: number
}

export interface LibraryFile {
  name: string
  size: number
  /** Unix timestamp (seconds). */
  modified: number
}

/** URL of a downloaded video; append `/thumbnail` for its thumbnail image. */
export function libraryUrl(folder: string, name: string) {
  return `/api/library/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    // FastAPI puts the reason in `detail` (a string, or a list of validation errors).
    const body = await res.json().catch(() => null)
    const detail = body?.detail
    const message = Array.isArray(detail)
      ? detail.map((d: { msg: string }) => d.msg).join('; ')
      : (detail ?? `${res.status} ${res.statusText}`)
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<Health>('/health'),
  listDownloads: () => request<DownloadJob[]>('/downloads'),
  getDownload: (id: number) => request<DownloadJob>(`/downloads/${id}`),
  listFolders: () => request<LibraryFolder[]>('/library'),
  listFiles: (folder: string) =>
    request<LibraryFile[]>(`/library/${encodeURIComponent(folder)}`),
  createDownload: (pageUrl: string, count: number, skipCustomCovers: boolean) =>
    request<DownloadJob>('/downloads', {
      method: 'POST',
      body: JSON.stringify({ page_url: pageUrl, count, skip_custom_covers: skipCustomCovers }),
    }),
}
