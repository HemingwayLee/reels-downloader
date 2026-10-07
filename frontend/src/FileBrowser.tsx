import { useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import FolderIcon from '@mui/icons-material/Folder'
import PhotoSizeSelectLargeIcon from '@mui/icons-material/PhotoSizeSelectLarge'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import YouTubeIcon from '@mui/icons-material/YouTube'
import {
  api,
  libraryUrl,
  type LibraryFile,
  type LibraryFolder,
  type ReelCaption,
  type YoutubePrivacy,
  type YoutubeStatus,
} from './api.ts'

const ICON_SIZE_KEY = 'fileBrowser.iconSize'
const DEFAULT_ICON_SIZE = 160
// A thumbnail click waits this long so a double-click plays the video without the
// caption popup flashing open first.
const DOUBLE_CLICK_MS = 250

function formatSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1000
    i++
  }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function loadIconSize() {
  try {
    const n = Number(localStorage.getItem(ICON_SIZE_KEY))
    return n >= 64 && n <= 256 ? n : DEFAULT_ICON_SIZE
  } catch {
    return DEFAULT_ICON_SIZE
  }
}

interface YoutubeActionsProps {
  folder: string
  file: LibraryFile
  caption: ReelCaption
  onUploaded: (caption: ReelCaption) => void
  onSignIn: () => void
}

/** Uploads the video with its summary as the title and its text as the description. */
function YoutubeActions({ folder, file, caption, onUploaded, onSignIn }: YoutubeActionsProps) {
  const [status, setStatus] = useState<YoutubeStatus | null>(null)
  const [privacy, setPrivacy] = useState<YoutubePrivacy>('private')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .youtubeStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message))
  }, [])

  function upload() {
    setUploading(true)
    setError(null)
    api
      .uploadToYoutube(folder, file.name, privacy)
      .then(onUploaded)
      .catch((e: Error) => setError(e.message))
      .finally(() => setUploading(false))
  }

  let action
  if (caption.youtube) {
    action = (
      <Button
        startIcon={<YouTubeIcon />}
        href={`https://youtu.be/${caption.youtube.video_id}`}
        target="_blank"
        rel="noreferrer"
      >
        View on YouTube ({caption.youtube.privacy})
      </Button>
    )
  } else if (!status) {
    action = null
  } else if (!status.connected) {
    action = (
      <Button startIcon={<YouTubeIcon />} onClick={onSignIn}>
        Sign in to YouTube
      </Button>
    )
  } else {
    action = (
      <>
        <TextField
          select
          size="small"
          variant="standard"
          value={privacy}
          onChange={(e) => setPrivacy(e.target.value as YoutubePrivacy)}
          disabled={uploading}
          aria-label="Privacy"
        >
          <MenuItem value="private">Private</MenuItem>
          <MenuItem value="unlisted">Unlisted</MenuItem>
          <MenuItem value="public">Public</MenuItem>
        </TextField>
        <Tooltip title={status.channel ? `Uploads to ${status.channel}` : ''}>
          <span>
            <Button
              startIcon={uploading ? <CircularProgress size={18} /> : <YouTubeIcon />}
              onClick={upload}
              disabled={uploading}
            >
              {uploading ? 'Uploading…' : 'Upload to YouTube'}
            </Button>
          </span>
        </Tooltip>
      </>
    )
  }

  return (
    <Stack spacing={0.5} sx={{ mr: 'auto', pl: 1 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        {action}
      </Stack>
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
    </Stack>
  )
}

interface CaptionDialogProps {
  folder: string
  file: LibraryFile | null
  onClose: () => void
  onPlay: (file: LibraryFile) => void
  onYoutubeSignIn: () => void
}

/** Shows a reel's saved caption text and its summary. */
function CaptionDialog({ folder, file, onClose, onPlay, onYoutubeSignIn }: CaptionDialogProps) {
  // Tagged with the file it belongs to, so a previous file's caption never shows.
  const [result, setResult] = useState<{
    key: string
    caption?: ReelCaption
    error?: string
  } | null>(null)
  const key = file && `${folder}/${file.name}`

  useEffect(() => {
    if (!file || !key) return
    let stale = false
    api
      .getCaption(folder, file.name)
      .then((caption) => !stale && setResult({ key, caption }))
      .catch((e: Error) => !stale && setResult({ key, error: e.message }))
    return () => {
      stale = true
    }
  }, [folder, file, key])

  const { caption, error } = result?.key === key ? result : {}

  return (
    <Dialog open={file !== null} onClose={onClose} maxWidth="sm" fullWidth>
      {file && (
        <>
          <DialogTitle sx={{ pr: 6 }}>
            {file.name.replace(/\.mp4$/, '')}
            <IconButton
              aria-label="Close"
              onClick={onClose}
              sx={{ position: 'absolute', right: 8, top: 8 }}
            >
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent dividers>
            {error ? (
              <Typography color="text.secondary">{error}</Typography>
            ) : !caption ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress size={28} />
              </Box>
            ) : (
              <Stack spacing={2.5}>
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    Summary
                  </Typography>
                  <Typography sx={{ whiteSpace: 'pre-wrap' }}>
                    {caption.summary ?? (
                      <Box component="span" sx={{ color: 'text.secondary' }}>
                        No summary
                      </Box>
                    )}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    Text
                  </Typography>
                  <Typography sx={{ whiteSpace: 'pre-wrap' }}>
                    {caption.text || (
                      <Box component="span" sx={{ color: 'text.secondary' }}>
                        This reel has no caption
                      </Box>
                    )}
                  </Typography>
                </Box>
                <Link href={caption.url} target="_blank" rel="noreferrer" variant="body2">
                  {caption.url}
                </Link>
              </Stack>
            )}
          </DialogContent>
          <DialogActions>
            {caption && key && (
              <YoutubeActions
                folder={folder}
                file={file}
                caption={caption}
                onUploaded={(c) => setResult({ key, caption: c })}
                onSignIn={onYoutubeSignIn}
              />
            )}
            <Button
              startIcon={<PlayArrowIcon />}
              onClick={() => onPlay(file)}
              sx={{ flexShrink: 0 }}
            >
              Play video
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  )
}

interface Props {
  /** Folder to switch to, e.g. the one the current job downloads into. */
  folder: string | null
  /** Changes whenever the folder's contents may have changed. */
  refreshKey: unknown
  /** Opens the YouTube account dialog. */
  onYoutubeSignIn: () => void
}

export default function FileBrowser({ folder, refreshKey, onYoutubeSignIn }: Props) {
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [current, setCurrent] = useState<string | null>(folder)
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [playing, setPlaying] = useState<LibraryFile | null>(null)
  const [captionFile, setCaptionFile] = useState<LibraryFile | null>(null)
  const [toDelete, setToDelete] = useState<LibraryFile | null>(null)
  const [deleting, setDeleting] = useState(false)
  const clickTimer = useRef<number | undefined>(undefined)
  const [iconSize, setIconSize] = useState(loadIconSize)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (folder) setCurrent(folder)
  }, [folder])

  useEffect(() => () => window.clearTimeout(clickTimer.current), [])

  function confirmDelete() {
    if (!toDelete || !current) return
    const name = toDelete.name
    setDeleting(true)
    api
      .deleteVideo(current, name)
      .then(() => {
        setFiles((list) => list.filter((f) => f.name !== name))
        setSelected((s) => (s === name ? null : s))
        setToDelete(null)
        setError(null)
      })
      .catch((e: Error) => {
        setToDelete(null)
        setError(e.message)
      })
      .finally(() => setDeleting(false))
  }

  function play(file: LibraryFile) {
    window.clearTimeout(clickTimer.current)
    setCaptionFile(null)
    setPlaying(file)
  }

  useEffect(() => {
    api
      .listFolders()
      .then((list) => {
        setFolders(list)
        setCurrent((c) => c ?? list[0]?.name ?? null)
      })
      .catch((e: Error) => setError(e.message))
  }, [refreshKey])

  useEffect(() => {
    if (!current) return
    api
      .listFiles(current)
      .then((list) => {
        setFiles(list)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [current, refreshKey])

  function changeIconSize(size: number) {
    setIconSize(size)
    try {
      localStorage.setItem(ICON_SIZE_KEY, String(size))
    } catch {
      // Not persisted; the size still applies for this visit.
    }
  }

  if (folders.length === 0) return null

  return (
    <Paper sx={{ overflow: 'hidden' }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ px: 2, py: 1, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}
      >
        <FolderIcon color="primary" />
        <TextField
          select
          size="small"
          variant="standard"
          value={current ?? ''}
          onChange={(e) => {
            setCurrent(e.target.value)
            setSelected(null)
          }}
          sx={{ minWidth: 180 }}
        >
          {folders.map((f) => (
            <MenuItem key={f.name} value={f.name}>
              {f.name}
            </MenuItem>
          ))}
        </TextField>
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
          {files.length} item{files.length === 1 ? '' : 's'}
        </Typography>
        <PhotoSizeSelectLargeIcon fontSize="small" color="action" />
        <Slider
          size="small"
          min={64}
          max={256}
          step={16}
          value={iconSize}
          onChange={(_, v) => changeIconSize(v as number)}
          aria-label="Icon size"
          sx={{ width: 120 }}
        />
      </Stack>

      {error && (
        <Typography color="error" variant="body2" sx={{ px: 2, pt: 2 }}>
          {error}
        </Typography>
      )}

      {/* Clicking empty space clears the selection, like Finder. */}
      <Box
        onClick={() => setSelected(null)}
        sx={{
          p: 2,
          minHeight: 160,
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${iconSize + 32}px, 1fr))`,
          gap: 1,
          alignItems: 'start',
        }}
      >
        {current &&
          files.map((f) => {
            const isSelected = selected === f.name
            return (
              <Stack
                key={f.name}
                spacing={0.75}
                title={`${f.name}\n${formatSize(f.size)} · ${new Date(f.modified * 1000).toLocaleString()}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelected(f.name)
                }}
                onDoubleClick={() => play(f)}
                sx={{ alignItems: 'center', cursor: 'default', userSelect: 'none', p: 0.5 }}
              >
                <Box
                  onClick={() => {
                    window.clearTimeout(clickTimer.current)
                    clickTimer.current = window.setTimeout(
                      () => setCaptionFile(f),
                      DOUBLE_CLICK_MS,
                    )
                  }}
                  sx={{
                    position: 'relative',
                    width: iconSize,
                    height: iconSize,
                    p: 0.75,
                    borderRadius: 1.5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: isSelected ? 'action.selected' : 'transparent',
                    // The delete button shows on hover, or while the item is selected.
                    '&:hover .delete-button': { opacity: 1 },
                  }}
                >
                  <Tooltip title="Delete">
                    <IconButton
                      className="delete-button"
                      size="small"
                      aria-label={`Delete ${f.name}`}
                      onClick={(e) => {
                        // Don't select the item or open the caption popup.
                        e.stopPropagation()
                        window.clearTimeout(clickTimer.current)
                        setToDelete(f)
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                      sx={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        zIndex: 1,
                        opacity: isSelected ? 1 : 0,
                        transition: 'opacity 0.15s',
                        bgcolor: 'background.paper',
                        boxShadow: 1,
                        '&:hover': { bgcolor: 'background.paper', color: 'error.main' },
                        '&:focus-visible': { opacity: 1 },
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Box
                    component="img"
                    src={`${libraryUrl(current, f.name)}/thumbnail?v=${f.modified}`}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    sx={{
                      maxWidth: '100%',
                      maxHeight: '100%',
                      objectFit: 'contain',
                      borderRadius: 0.5,
                      boxShadow: 2,
                      bgcolor: 'action.hover',
                    }}
                  />
                </Box>
                <Typography
                  variant="caption"
                  sx={{
                    maxWidth: iconSize + 24,
                    px: 0.75,
                    borderRadius: 1,
                    textAlign: 'center',
                    wordBreak: 'break-all',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    bgcolor: isSelected ? 'primary.main' : 'transparent',
                    color: isSelected ? 'primary.contrastText' : 'text.primary',
                  }}
                >
                  {/* Like Finder, hide the extension; every file here is an .mp4. */}
                  {f.name.replace(/\.mp4$/, '')}
                </Typography>
              </Stack>
            )
          })}
      </Box>

      <Dialog open={toDelete !== null} onClose={() => !deleting && setToDelete(null)}>
        <DialogTitle>Delete {toDelete?.name.replace(/\.mp4$/, '')}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This deletes the video and its saved text and summary from{' '}
            <code>downloads/{current}/</code>. It can't be undone. A copy already uploaded to
            YouTube isn't affected.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setToDelete(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button color="error" variant="contained" onClick={confirmDelete} disabled={deleting}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {current && (
        <CaptionDialog
          folder={current}
          file={captionFile}
          onClose={() => setCaptionFile(null)}
          onPlay={play}
          onYoutubeSignIn={onYoutubeSignIn}
        />
      )}

      <Dialog open={playing !== null} onClose={() => setPlaying(null)} maxWidth="lg">
        {playing && current && (
          <>
            <DialogTitle sx={{ pr: 6 }}>
              {playing.name}
              <IconButton
                aria-label="Close"
                onClick={() => setPlaying(null)}
                sx={{ position: 'absolute', right: 8, top: 8 }}
              >
                <CloseIcon />
              </IconButton>
            </DialogTitle>
            <DialogContent>
              <Box
                component="video"
                src={libraryUrl(current, playing.name)}
                controls
                autoPlay
                sx={{ display: 'block', maxWidth: '100%', maxHeight: '75vh', mx: 'auto' }}
              />
            </DialogContent>
          </>
        )}
      </Dialog>
    </Paper>
  )
}
