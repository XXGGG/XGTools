export type MediaType = 'image' | 'video' | 'audio' | 'unknown'

export interface FileInfo {
  path: string
  name: string
  extension: string
  media_type: MediaType
  size: number
  duration?: number
  width?: number
  height?: number
}

export interface FileEntry {
  info: FileInfo
  status: 'pending' | 'converting' | 'done' | 'error'
  progress: number
  outputPath?: string
  error?: string
}

export interface ConvertOptions {
  quality?: number
  video_codec?: string
  audio_codec?: string
  audio_bitrate?: string
}

export interface ConvertProgress {
  file_index: number
  total_files: number
  file_name: string
  file_progress: number
  status: 'converting' | 'done' | 'error'
  error?: string
}

export type OutputLocation = 'original' | 'desktop' | string

export const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif', 'ico', 'avif'] as const
export const VIDEO_FORMATS = ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv'] as const
export const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a'] as const
export const ALL_FORMATS = [...IMAGE_FORMATS, ...VIDEO_FORMATS, ...AUDIO_FORMATS] as const

export function getTargetFormats(mediaType: MediaType): string[] {
  switch (mediaType) {
    case 'image': return ['webp', 'png', 'jpg', 'bmp', 'tiff', 'gif', 'ico', 'avif']
    case 'video': return ['mp4', 'webm', 'avi', 'mkv', 'mov', 'flv', 'gif', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a']
    case 'audio': return ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a']
    default: return []
  }
}

export function getMediaTypeIcon(type: MediaType): string {
  switch (type) {
    case 'image': return 'icon-[lucide--image]'
    case 'video': return 'icon-[lucide--video]'
    case 'audio': return 'icon-[lucide--music]'
    default: return 'icon-[lucide--file]'
  }
}

export function getMediaTypeLabel(type: MediaType): string {
  switch (type) {
    case 'image': return '图片'
    case 'video': return '视频'
    case 'audio': return '音频'
    default: return '未知'
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}
