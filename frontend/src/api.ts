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
  skip_existing: boolean
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

export type YoutubePrivacy = 'private' | 'unlisted' | 'public'

export interface YoutubeUpload {
  video_id: string
  privacy: YoutubePrivacy
  uploaded_at: string
}

/** A reel's caption and its summary (saved next to the video). */
export interface ReelCaption {
  url: string
  text: string
  summary: string | null
  /** Set once the video has been uploaded to YouTube. */
  youtube: YoutubeUpload | null
}

export interface YoutubeStatus {
  /** An OAuth client has been saved, so signing in can work. */
  configured: boolean
  connected: boolean
  channel: string | null
  client_id: string | null
  /** Must be added to the OAuth client's authorized redirect URIs in Google Cloud. */
  redirect_uri: string
}

/**
 * Opening this starts the Google sign-in. Google then sends the browser back to the app's
 * root with `?code=&state=` (or `?error=&state=`), which `finishYoutubeSignIn` completes.
 */
export const YOUTUBE_AUTH_URL = '/api/youtube/auth'

/** URL of a downloaded video; append `/thumbnail` or `/caption` for its thumbnail or caption. */
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
  // 204 No Content (e.g. after a delete) has no body to parse.
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<Health>('/health'),
  listDownloads: () => request<DownloadJob[]>('/downloads'),
  getDownload: (id: number) => request<DownloadJob>(`/downloads/${id}`),
  listFolders: () => request<LibraryFolder[]>('/library'),
  listFiles: (folder: string) =>
    request<LibraryFile[]>(`/library/${encodeURIComponent(folder)}`),
  getCaption: (folder: string, name: string) =>
    request<ReelCaption>(
      `/library/${encodeURIComponent(folder)}/${encodeURIComponent(name)}/caption`,
    ),
  deleteVideo: (folder: string, name: string) =>
    request<void>(`/library/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  youtubeStatus: () => request<YoutubeStatus>('/youtube/status'),
  saveYoutubeClient: (clientId: string, clientSecret: string) =>
    request<YoutubeStatus>('/youtube/client', {
      method: 'PUT',
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    }),
  youtubeLogout: () => request<YoutubeStatus>('/youtube/logout', { method: 'POST' }),
  finishYoutubeSignIn: (params: { state: string; code: string | null; error: string | null }) =>
    request<YoutubeStatus>('/youtube/callback', { method: 'POST', body: JSON.stringify(params) }),
  uploadToYoutube: (folder: string, name: string, privacy: YoutubePrivacy) =>
    request<ReelCaption>('/youtube/uploads', {
      method: 'POST',
      body: JSON.stringify({ folder, name, privacy }),
    }),
  createDownload: (
    pageUrl: string,
    count: number,
    skipCustomCovers: boolean,
    skipExisting: boolean,
  ) =>
    request<DownloadJob>('/downloads', {
      method: 'POST',
      body: JSON.stringify({
        page_url: pageUrl,
        count,
        skip_custom_covers: skipCustomCovers,
        skip_existing: skipExisting,
      }),
    }),
}
