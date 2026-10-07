import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Alert,
  AppBar,
  Button,
  Chip,
  Container,
  FormControlLabel,
  LinearProgress,
  Link,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Switch,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import YouTubeIcon from '@mui/icons-material/YouTube'
import { api, type DownloadJob, type Health, type YoutubeStatus } from './api.ts'
import FileBrowser from './FileBrowser.tsx'
import YoutubeAccountDialog, { type YoutubeNotice } from './YoutubeAccountDialog.tsx'

const POLL_INTERVAL_MS = 1500

const STATUS_LABEL: Record<DownloadJob['status'], string> = {
  pending: 'Starting…',
  collecting: 'Finding latest reels…',
  downloading: 'Downloading…',
  done: 'Done',
  failed: 'Failed',
}

const SKIP_REASON_LABEL: Record<string, string> = {
  'Already downloaded': 'already downloaded',
  'Deleted earlier': 'deleted earlier',
  'Custom cover': 'had a custom cover',
  'Cover check failed': "couldn't be checked for a custom cover",
}

/** Why a finished job got fewer than `count` reels: the page ran out after the skips. */
function shortfallMessage(job: DownloadJob) {
  const seen = job.files.length + job.failed.length + job.skipped.length
  const counts = new Map<string, number>()
  for (const s of job.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
  const parts = [...counts].map(
    ([reason, n]) => `${n} ${SKIP_REASON_LABEL[reason] ?? reason.toLowerCase()}`,
  )
  if (job.failed.length > 0) parts.push(`${job.failed.length} failed to download`)
  const result =
    job.files.length === 0
      ? 'so no new reels were downloaded'
      : `so only ${job.files.length} of ${job.count} were downloaded`
  return (
    `Facebook showed ${seen} reel${seen === 1 ? '' : 's'} ` +
    "(it stops at about 50 for visitors who aren't logged in)" +
    (parts.length > 0 ? `: ${parts.join(', ')}` : '') +
    ` — ${result}.`
  )
}

function isRunning(job: DownloadJob | null) {
  return job !== null && job.status !== 'done' && job.status !== 'failed'
}

/**
 * Reads (and removes from the address bar) what the YouTube sign-in left in the URL: Google's
 * ?code=&state= / ?error=&state= redirect, or ?youtube_error= if the sign-in couldn't start.
 */
function takeYoutubeRedirect() {
  const params = new URLSearchParams(window.location.search)
  const state = params.get('state')
  const google = state ? { state, code: params.get('code'), error: params.get('error') } : null
  const startError = params.get('youtube_error')
  if (!google && !startError) return null
  for (const key of ['state', 'code', 'error', 'scope', 'authuser', 'prompt', 'youtube_error']) {
    params.delete(key)
  }
  const query = params.toString()
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
  return { google, startError }
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [count, setCount] = useState('5')
  const [pageUrl, setPageUrl] = useState('')
  const [skipCustomCovers, setSkipCustomCovers] = useState(true)
  const [skipExisting, setSkipExisting] = useState(true)
  const [job, setJob] = useState<DownloadJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [youtube, setYoutube] = useState<YoutubeStatus | null>(null)
  // Read once on load; after a sign-in redirect the dialog reopens to show the result.
  const [youtubeRedirect] = useState(takeYoutubeRedirect)
  const [youtubeNotice, setYoutubeNotice] = useState<YoutubeNotice | null>(
    youtubeRedirect?.startError ? { severity: 'error', message: youtubeRedirect.startError } : null,
  )
  const [youtubeOpen, setYoutubeOpen] = useState(youtubeRedirect !== null)
  // Google's code works once; StrictMode runs effects twice in development.
  const signInFinished = useRef(false)

  useEffect(() => {
    api.health().then(setHealth).catch((e: Error) => setError(e.message))
    const google = youtubeRedirect?.google
    if (google && !signInFinished.current) {
      signInFinished.current = true
      api
        .finishYoutubeSignIn(google)
        .then((s) => {
          setYoutube(s)
          setYoutubeNotice({ severity: 'success', message: 'Signed in to YouTube.' })
        })
        .catch((e: Error) => setYoutubeNotice({ severity: 'error', message: e.message }))
    } else if (!google) {
      api.youtubeStatus().then(setYoutube).catch((e: Error) => setError(e.message))
    }
    // Pick up the latest job so a page refresh doesn't lose a running download.
    api
      .listDownloads()
      .then((jobs) => setJob((current) => current ?? jobs[0] ?? null))
      .catch((e: Error) => setError(e.message))
  }, [youtubeRedirect])

  const running = isRunning(job)
  const jobId = job?.id

  useEffect(() => {
    if (!running || jobId === undefined) return
    const timer = setInterval(() => {
      api.getDownload(jobId).then(setJob).catch((e: Error) => setError(e.message))
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [running, jobId])

  const n = Number(count)
  const countValid = Number.isInteger(n) && n >= 1 && n <= 200

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!countValid || !pageUrl.trim()) return
    try {
      setError(null)
      setJob(await api.createDownload(pageUrl.trim(), n, skipCustomCovers, skipExisting))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // Skipped and failed reels don't count toward `count`; the job moves on to the next one.
  const done = job ? job.files.length : 0

  return (
    <>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Reels Downloader
          </Typography>
          <Button
            color="inherit"
            startIcon={<YouTubeIcon />}
            onClick={() => setYoutubeOpen(true)}
            sx={{ mr: 2, textTransform: 'none' }}
          >
            {youtube?.connected ? (youtube.channel ?? 'YouTube') : 'Sign in to YouTube'}
          </Button>
          {health && (
            <Chip
              size="small"
              color={health.database === 'ok' ? 'success' : 'error'}
              label={`API ${health.status} · DB ${health.database}`}
            />
          )}
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack spacing={3}>
          {error && <Alert severity="error">{error}</Alert>}

          <Paper component="form" onSubmit={handleSubmit} sx={{ p: 2 }}>
            <Stack spacing={1}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: 'flex-start' }}>
                <TextField
                  label="Facebook reels page"
                  placeholder="https://www.facebook.com/rayshinlife/reels/"
                  size="small"
                  fullWidth
                  value={pageUrl}
                  onChange={(e) => setPageUrl(e.target.value)}
                />
                <TextField
                  label="Latest reels (N)"
                  type="number"
                  size="small"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  error={!countValid}
                  helperText={countValid ? undefined : 'Whole number from 1 to 200'}
                  slotProps={{ htmlInput: { min: 1, max: 200 } }}
                  sx={{ width: { xs: '100%', md: 200 }, flexShrink: 0 }}
                />
                <Button
                  type="submit"
                  variant="contained"
                  startIcon={<DownloadIcon />}
                  disabled={running || !countValid || !pageUrl.trim()}
                  sx={{ width: { xs: '100%', md: 'auto' }, height: 40, flexShrink: 0 }}
                >
                  Run
                </Button>
              </Stack>
              <FormControlLabel
                control={
                  <Switch
                    checked={skipCustomCovers}
                    onChange={(e) => setSkipCustomCovers(e.target.checked)}
                  />
                }
                label="Only reels without a custom cover"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={skipExisting}
                    onChange={(e) => setSkipExisting(e.target.checked)}
                  />
                }
                label="Skip reels I already have (downloaded or deleted)"
              />
            </Stack>
          </Paper>

          {job && (
            <Paper sx={{ p: 2 }}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">
                  {STATUS_LABEL[job.status]}
                  {job.status === 'downloading' && ` ${done} / ${job.count}`}
                </Typography>
                {job.skipped.length > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    Skipped {job.skipped.length} reel{job.skipped.length === 1 ? '' : 's'}
                  </Typography>
                )}
                {running && (
                  <LinearProgress
                    variant={job.status === 'downloading' ? 'determinate' : 'indeterminate'}
                    value={(done / job.count) * 100}
                  />
                )}
                {job.error && <Alert severity="error">{job.error}</Alert>}
                {job.status === 'done' && job.files.length < job.count && (
                  <Alert severity="warning">{shortfallMessage(job)}</Alert>
                )}
                {job.output_dir && (
                  <Typography variant="body2" color="text.secondary">
                    Saving to <code>downloads/{job.output_dir}/</code>
                  </Typography>
                )}
              </Stack>
              {(job.files.length > 0 || job.failed.length > 0 || job.skipped.length > 0) && (
                <List dense>
                  {job.files.map((f) => (
                    <ListItem key={f} disableGutters>
                      <ListItemText primary={f} />
                    </ListItem>
                  ))}
                  {job.failed.map((url) => (
                    <ListItem key={url} disableGutters>
                      <ListItemText
                        primary={url}
                        secondary="Failed"
                        slotProps={{ secondary: { color: 'error' } }}
                      />
                    </ListItem>
                  ))}
                  {job.skipped.map((s) => (
                    <ListItem key={s.url} disableGutters>
                      <ListItemText
                        primary={
                          <Link href={s.url} target="_blank" rel="noreferrer" color="inherit">
                            {s.url}
                          </Link>
                        }
                        secondary={`Skipped · ${s.reason}`}
                        slotProps={{ secondary: { color: 'warning' } }}
                      />
                    </ListItem>
                  ))}
                </List>
              )}
            </Paper>
          )}

          <FileBrowser
            folder={job?.output_dir ?? null}
            refreshKey={`${job?.id}:${job?.files.length}:${job?.status}`}
            onYoutubeSignIn={() => setYoutubeOpen(true)}
          />
        </Stack>
      </Container>

      <YoutubeAccountDialog
        open={youtubeOpen}
        onClose={() => {
          setYoutubeOpen(false)
          setYoutubeNotice(null)
        }}
        notice={youtubeNotice}
        onChange={setYoutube}
      />
    </>
  )
}
