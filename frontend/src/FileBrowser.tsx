import { useEffect, useState } from 'react'
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import FolderIcon from '@mui/icons-material/Folder'
import PhotoSizeSelectLargeIcon from '@mui/icons-material/PhotoSizeSelectLarge'
import { api, libraryUrl, type LibraryFile, type LibraryFolder } from './api.ts'

const ICON_SIZE_KEY = 'fileBrowser.iconSize'
const DEFAULT_ICON_SIZE = 160

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

interface Props {
  /** Folder to switch to, e.g. the one the current job downloads into. */
  folder: string | null
  /** Changes whenever the folder's contents may have changed. */
  refreshKey: unknown
}

export default function FileBrowser({ folder, refreshKey }: Props) {
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [current, setCurrent] = useState<string | null>(folder)
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [playing, setPlaying] = useState<LibraryFile | null>(null)
  const [iconSize, setIconSize] = useState(loadIconSize)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (folder) setCurrent(folder)
  }, [folder])

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
                onDoubleClick={() => setPlaying(f)}
                sx={{ alignItems: 'center', cursor: 'default', userSelect: 'none', p: 0.5 }}
              >
                <Box
                  sx={{
                    width: iconSize,
                    height: iconSize,
                    p: 0.75,
                    borderRadius: 1.5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: isSelected ? 'action.selected' : 'transparent',
                  }}
                >
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
