import { useEffect, useState, type FormEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Link,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import GoogleIcon from '@mui/icons-material/Google'
import YouTubeIcon from '@mui/icons-material/YouTube'
import { api, YOUTUBE_AUTH_URL, type YoutubeStatus } from './api.ts'

export interface YoutubeNotice {
  severity: 'success' | 'error'
  message: string
}

interface Props {
  open: boolean
  onClose: () => void
  /** Result of the Google sign-in redirect, shown at the top. */
  notice: YoutubeNotice | null
  /** Called whenever the account changes (client saved, signed out). */
  onChange: (status: YoutubeStatus) => void
}

/** Lets the user enter their OAuth client, sign in with Google and sign out. */
export default function YoutubeAccountDialog({ open, onClose, notice, onChange }: Props) {
  const [status, setStatus] = useState<YoutubeStatus | null>(null)
  const [editingClient, setEditingClient] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    api
      .youtubeStatus()
      .then((s) => {
        setStatus(s)
        setClientId(s.client_id ?? '')
        setClientSecret('')
        setEditingClient(false)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
    // Refetched when a notice arrives: finishing a sign-in changes the status.
  }, [open, notice])

  function update(s: YoutubeStatus) {
    setStatus(s)
    onChange(s)
  }

  function saveClient(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    api
      .saveYoutubeClient(clientId.trim(), clientSecret.trim())
      .then((s) => {
        update(s)
        setClientSecret('')
        setEditingClient(false)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false))
  }

  function signOut() {
    setBusy(true)
    setError(null)
    api
      .youtubeLogout()
      .then(update)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false))
  }

  function copyRedirectUri() {
    if (!status) return
    navigator.clipboard
      .writeText(status.redirect_uri)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => setError('Could not copy; select the address and copy it manually'))
  }

  const showClientForm = status !== null && (!status.configured || editingClient)

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6, display: 'flex', alignItems: 'center', gap: 1 }}>
        <YouTubeIcon sx={{ color: '#ff0000' }} />
        YouTube account
        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          {notice && <Alert severity={notice.severity}>{notice.message}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}

          {!status ? (
            !error && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress size={28} />
              </Box>
            )
          ) : showClientForm ? (
            <Stack component="form" spacing={2} onSubmit={saveClient}>
              <Typography variant="body2" color="text.secondary">
                Google requires each app that uploads to YouTube to have its own OAuth client.
                Create one once in{' '}
                <Link
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google Cloud Console
                </Link>
                :
              </Typography>
              <Box component="ol" sx={{ m: 0, pl: 2.5, typography: 'body2', color: 'text.secondary' }}>
                <li>Enable the YouTube Data API v3 for your project.</li>
                <li>On the OAuth consent screen, add your Google account as a test user.</li>
                <li>
                  Create an OAuth client ID of type <b>Web application</b> with this authorized
                  redirect URI:
                </li>
              </Box>
              <TextField
                size="small"
                value={status.redirect_uri}
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        <Tooltip title={copied ? 'Copied' : 'Copy'}>
                          <IconButton edge="end" aria-label="Copy redirect URI" onClick={copyRedirectUri}>
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  },
                }}
              />
              <TextField
                label="Client ID"
                size="small"
                required
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="1234567890-abc.apps.googleusercontent.com"
              />
              <TextField
                label="Client secret"
                type="password"
                size="small"
                required
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
              <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                {status.configured && (
                  <Button onClick={() => setEditingClient(false)} disabled={busy}>
                    Cancel
                  </Button>
                )}
                <Button
                  type="submit"
                  variant="contained"
                  disabled={busy || !clientId.trim() || !clientSecret.trim()}
                >
                  Save
                </Button>
              </Stack>
            </Stack>
          ) : status.connected ? (
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Signed in · uploads go to
                </Typography>
                <Typography variant="subtitle1">{status.channel ?? 'your YouTube channel'}</Typography>
              </Box>
              <Button variant="outlined" onClick={signOut} disabled={busy}>
                Sign out
              </Button>
            </Stack>
          ) : (
            <Stack spacing={2} sx={{ alignItems: 'center', py: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                Sign in with the Google account that owns your YouTube channel.
              </Typography>
              <Button variant="contained" size="large" startIcon={<GoogleIcon />} href={YOUTUBE_AUTH_URL}>
                Sign in with Google
              </Button>
              <Button size="small" onClick={() => setEditingClient(true)}>
                Change OAuth client
              </Button>
            </Stack>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
