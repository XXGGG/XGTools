<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { LazyStore } from '@tauri-apps/plugin-store'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  type FileInfo, type FileEntry, type ConvertProgress, type ConvertOptions,
  type OutputLocation, type MediaType,
  IMAGE_FORMATS, VIDEO_FORMATS, AUDIO_FORMATS,
  getTargetFormats, getMediaTypeIcon, formatFileSize,
} from '@/types/convert'

const store = new LazyStore('settings.json')

// ─── State ───────────────────────────────────────────
const files = ref<FileEntry[]>([])
const targetFormat = ref('')
const outputLocation = ref<OutputLocation>('original')
const customOutputDir = ref('')
const imageQuality = ref([85])
const converting = ref(false)
const taskId = ref('')
const dragOver = ref(false)

// 批量对话框
const batchDialogOpen = ref(false)
const batchFolderPath = ref('')
const batchScannedFormats = ref<{ ext: string; count: number; checked: boolean }[]>([])
const batchTargetFormat = ref('')
const batchScanning = ref(false)

// ─── Computed ────────────────────────────────────────
const dominantMediaType = computed<MediaType>(() => {
  if (files.value.length === 0) return 'unknown'
  const types = files.value.map(f => f.info.media_type)
  // 以第一个文件的类型为主
  return types[0] || 'unknown'
})

const availableFormats = computed(() => getTargetFormats(dominantMediaType.value))

const totalProgress = computed(() => {
  if (files.value.length === 0) return 0
  const total = files.value.reduce((sum, f) => sum + f.progress, 0)
  return Math.round(total / files.value.length)
})

const doneCount = computed(() => files.value.filter(f => f.status === 'done').length)
const errorCount = computed(() => files.value.filter(f => f.status === 'error').length)

const hasFiles = computed(() => files.value.length > 0)

// ─── Settings persistence ────────────────────────────
onMounted(async () => {
  await store.init()
  const loc = await store.get<string>('convert_output_location')
  if (loc === 'original' || loc === 'desktop' || loc === 'custom') outputLocation.value = loc
  const dir = await store.get<string>('convert_custom_dir')
  if (dir) customOutputDir.value = dir
  const q = await store.get<number>('convert_image_quality')
  if (q) imageQuality.value = [q]

  // Tauri drag-drop 事件
  const webview = getCurrentWebview()
  await webview.onDragDropEvent(async (event) => {
    if (event.payload.type === 'enter' || event.payload.type === 'over') {
      dragOver.value = true
    } else if (event.payload.type === 'drop') {
      dragOver.value = false
      for (const path of event.payload.paths) {
        await addFile(path)
      }
    } else if (event.payload.type === 'leave') {
      dragOver.value = false
    }
  })
})

watch(outputLocation, async (val) => { await store.set('convert_output_location', val); await store.save() })
watch(customOutputDir, async (val) => { await store.set('convert_custom_dir', val); await store.save() })
watch(() => imageQuality.value[0], async (val) => { await store.set('convert_image_quality', val); await store.save() })

// 当格式列表变化时自动选中第一个
watch(availableFormats, (fmts) => {
  if (fmts.length > 0 && !fmts.includes(targetFormat.value)) {
    targetFormat.value = fmts[0]
  }
}, { immediate: true })

// ─── File operations ─────────────────────────────────
async function addFile(path: string) {
  // 去重
  if (files.value.some(f => f.info.path === path)) return
  try {
    const info = await invoke<FileInfo>('detect_file_type', { path })
    if (info.media_type === 'unknown') return
    files.value.push({
      info,
      status: 'pending',
      progress: 0,
    })
  } catch (e) {
    console.error('Failed to detect file:', e)
  }
}

function removeFile(index: number) {
  files.value.splice(index, 1)
}

function clearFiles() {
  if (converting.value) return
  files.value = []
}

async function pickFiles() {
  const result = await openDialog({
    multiple: true,
    filters: [{
      name: '所有支持格式',
      extensions: [...IMAGE_FORMATS, ...VIDEO_FORMATS, ...AUDIO_FORMATS] as string[],
    }],
  })
  if (result) {
    const paths = Array.isArray(result) ? result : [result]
    for (const p of paths) {
      await addFile(p)
    }
  }
}

// ─── Conversion ──────────────────────────────────────
let unlistenProgress: (() => void) | null = null

async function startConvert() {
  if (files.value.length === 0 || !targetFormat.value) return
  converting.value = true
  taskId.value = `convert_${Date.now()}`

  // Reset statuses
  for (const f of files.value) {
    f.status = 'pending'
    f.progress = 0
    f.error = undefined
    f.outputPath = undefined
  }

  // Listen for progress events
  unlistenProgress = (await listen<ConvertProgress>('convert-progress', (e) => {
    const p = e.payload
    if (p.file_index < files.value.length) {
      files.value[p.file_index].progress = Math.round(p.file_progress * 100)
      if (p.status === 'done') {
        files.value[p.file_index].status = 'done'
        files.value[p.file_index].progress = 100
      } else if (p.status === 'error') {
        files.value[p.file_index].status = 'error'
        files.value[p.file_index].error = p.error || '转换失败'
      } else {
        files.value[p.file_index].status = 'converting'
      }
    }
  })) as unknown as () => void

  const fmt = targetFormat.value
  const quality = imageQuality.value[0]

  for (let i = 0; i < files.value.length; i++) {
    if (!converting.value) break // Cancelled

    const entry = files.value[i]
    entry.status = 'converting'

    try {
      // Resolve output dir
      const loc = outputLocation.value === 'custom' ? customOutputDir.value : outputLocation.value
      const outDir = await invoke<string>('resolve_output_dir', {
        location: loc,
        sourcePath: entry.info.path,
      })

      // Build output path
      const baseName = entry.info.name.replace(/\.[^.]+$/, '')
      const outPath = `${outDir}\\${baseName}.${fmt}`

      if (entry.info.media_type === 'image') {
        // Image conversion (fast, no progress events)
        const result = await invoke<string>('convert_image', {
          inputPath: entry.info.path,
          outputPath: outPath,
          format: fmt,
          quality,
        })
        entry.outputPath = result
        entry.status = 'done'
        entry.progress = 100
      } else {
        // Video/Audio conversion (via ffmpeg with progress)
        const options: ConvertOptions = {
          quality: fmt === 'mp3' || fmt === 'wav' || fmt === 'flac' || fmt === 'aac' || fmt === 'ogg' || fmt === 'm4a' || fmt === 'wma'
            ? undefined : quality,
          audio_bitrate: '192k',
        }
        const result = await invoke<string>('convert_media', {
          app: undefined,
          taskId: taskId.value,
          fileIndex: i,
          totalFiles: files.value.length,
          inputPath: entry.info.path,
          outputPath: outPath,
          format: fmt,
          options,
        })
        entry.outputPath = result
        entry.status = 'done'
        entry.progress = 100
      }
    } catch (e: any) {
      entry.status = 'error'
      entry.error = typeof e === 'string' ? e : e?.message || '转换失败'
    }
  }

  converting.value = false
  if (unlistenProgress) {
    unlistenProgress()
    unlistenProgress = null
  }
}

async function cancelConvert() {
  converting.value = false
  if (taskId.value) {
    try {
      await invoke('cancel_convert', { taskId: taskId.value })
    } catch { /* ignore */ }
  }
  if (unlistenProgress) {
    unlistenProgress()
    unlistenProgress = null
  }
}

onUnmounted(() => {
  if (unlistenProgress) unlistenProgress()
})

// ─── Batch folder ────────────────────────────────────
async function openBatchFolder() {
  const result = await openDialog({ directory: true })
  if (!result || typeof result !== 'string') return

  batchFolderPath.value = result
  batchScanning.value = true
  batchScannedFormats.value = []

  // Scan all supported extensions
  const allExts = [...IMAGE_FORMATS, ...VIDEO_FORMATS, ...AUDIO_FORMATS] as string[]
  try {
    const found = await invoke<FileInfo[]>('scan_folder', {
      path: result,
      extensions: allExts,
    })

    // Group by extension
    const extMap = new Map<string, number>()
    for (const f of found) {
      const ext = f.extension.toLowerCase()
      extMap.set(ext, (extMap.get(ext) || 0) + 1)
    }

    batchScannedFormats.value = Array.from(extMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => ({ ext, count, checked: true }))

    // Auto-select first available target format
    if (found.length > 0) {
      const firstType = found[0].media_type
      const targets = getTargetFormats(firstType)
      batchTargetFormat.value = targets[0] || 'webp'
    }
  } catch (e) {
    console.error('Scan folder failed:', e)
  }

  batchScanning.value = false
  batchDialogOpen.value = true
}

const batchSelectedCount = computed(() =>
  batchScannedFormats.value.filter(f => f.checked).reduce((sum, f) => sum + f.count, 0)
)

const batchDominantType = computed<MediaType>(() => {
  const checkedExts = batchScannedFormats.value.filter(f => f.checked).map(f => f.ext)
  if (checkedExts.length === 0) return 'unknown'
  const imgExts = IMAGE_FORMATS as readonly string[]
  const vidExts = VIDEO_FORMATS as readonly string[]
  const audExts = AUDIO_FORMATS as readonly string[]
  if (checkedExts.some(e => imgExts.includes(e))) return 'image'
  if (checkedExts.some(e => vidExts.includes(e))) return 'video'
  if (checkedExts.some(e => audExts.includes(e))) return 'audio'
  return 'unknown'
})

const batchAvailableFormats = computed(() => getTargetFormats(batchDominantType.value))

async function confirmBatch() {
  const selectedExts = batchScannedFormats.value
    .filter(f => f.checked)
    .map(f => f.ext)

  if (selectedExts.length === 0) return

  // Scan again with only selected extensions
  const found = await invoke<FileInfo[]>('scan_folder', {
    path: batchFolderPath.value,
    extensions: selectedExts,
  })

  // Add all scanned files
  for (const info of found) {
    if (!files.value.some(f => f.info.path === info.path)) {
      files.value.push({
        info,
        status: 'pending',
        progress: 0,
      })
    }
  }

  // Set target format
  if (batchTargetFormat.value) {
    targetFormat.value = batchTargetFormat.value
  }

  batchDialogOpen.value = false
}

// ─── Output location ─────────────────────────────────
async function pickCustomDir() {
  const result = await openDialog({ directory: true })
  if (result && typeof result === 'string') {
    customOutputDir.value = result
    outputLocation.value = 'custom'
  }
}

function getStatusIcon(status: FileEntry['status']) {
  switch (status) {
    case 'pending': return 'icon-[lucide--clock]'
    case 'converting': return 'icon-[lucide--loader-2] animate-spin'
    case 'done': return 'icon-[lucide--check-circle]'
    case 'error': return 'icon-[lucide--x-circle]'
  }
}

function getStatusColor(status: FileEntry['status']) {
  switch (status) {
    case 'pending': return 'text-muted-foreground'
    case 'converting': return 'text-primary'
    case 'done': return 'text-green-500'
    case 'error': return 'text-destructive'
  }
}
</script>

<template>
  <div class="h-full w-full flex flex-col p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="flex-1 overflow-hidden flex flex-col gap-4 max-w-3xl mx-auto w-full">

      <!-- Drop Zone -->
      <div
        :class="[
          'border-2 border-dashed rounded-xl text-center transition-all duration-300 cursor-pointer shrink-0',
          hasFiles ? 'p-4' : 'p-8',
          dragOver
            ? 'border-primary bg-primary/5 shadow-lg shadow-primary/10'
            : 'border-border hover:border-primary/50 hover:bg-muted/30',
          converting && 'pointer-events-none opacity-60',
        ]"
        @click="pickFiles"
      >
        <div class="flex flex-col items-center gap-3">
          <template v-if="!hasFiles">
            <div class="flex p-3 bg-primary/10 rounded-full">
              <span class="icon-[lucide--upload] w-7 h-7 text-primary" />
            </div>
            <div>
              <p class="font-medium text-sm">拖拽文件到此处，或点击选择</p>
              <p class="text-xs text-muted-foreground mt-1">支持图片 / 视频 / 音频格式</p>
            </div>
          </template>
          <div class="flex gap-2" :class="hasFiles ? '' : 'mt-1'">
            <Button variant="outline" size="sm" @click.stop="pickFiles">
              <span class="icon-[lucide--file-plus] w-4 h-4 mr-1.5" />
              选择文件
            </Button>
            <Button variant="outline" size="sm" @click.stop="openBatchFolder">
              <span class="icon-[lucide--folder-open] w-4 h-4 mr-1.5" />
              选择文件夹 (批量)
            </Button>
          </div>
        </div>
      </div>

      <!-- File List (scrollable, fills remaining space) -->
      <div v-if="hasFiles" class="flex-1 overflow-hidden flex flex-col gap-3 min-h-0">

        <!-- File list header -->
        <div class="flex items-center justify-between shrink-0">
          <div class="flex items-center gap-2">
            <h3 class="font-medium text-sm">文件列表</h3>
            <Badge variant="secondary" class="text-xs">{{ files.length }} 个文件</Badge>
          </div>
          <Button
            v-if="!converting"
            variant="ghost"
            size="icon-sm"
            @click="clearFiles"
            title="清空列表"
          >
            <span class="icon-[lucide--trash-2] w-4 h-4" />
          </Button>
        </div>

        <!-- Files (scrollable) -->
        <ScrollArea class="flex-1 min-h-0">
          <div class="space-y-2 pr-3">
            <div
              v-for="(entry, index) in files"
              :key="entry.info.path"
              class="flex items-center gap-3 p-3 border rounded-lg bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors group"
            >
              <!-- Type icon -->
              <div class="flex p-1.5 bg-primary/10 rounded-md">
                <span :class="getMediaTypeIcon(entry.info.media_type)" class="w-4 h-4 text-primary" />
              </div>

              <!-- File info -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <p class="text-sm font-medium truncate">{{ entry.info.name }}</p>
                  <Badge variant="outline" class="text-[10px] shrink-0">
                    {{ entry.info.extension.toUpperCase() }}
                  </Badge>
                </div>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-xs text-muted-foreground">{{ formatFileSize(entry.info.size) }}</span>
                  <span v-if="entry.info.width" class="text-xs text-muted-foreground">
                    {{ entry.info.width }}×{{ entry.info.height }}
                  </span>
                </div>
                <!-- Progress bar -->
                <div v-if="entry.status === 'converting'" class="mt-1.5">
                  <Progress :model-value="entry.progress" class="h-1.5" />
                </div>
              </div>

              <!-- Arrow → target format -->
              <div class="flex items-center gap-1.5 text-muted-foreground shrink-0">
                <span class="icon-[lucide--arrow-right] w-3.5 h-3.5" />
                <Badge variant="secondary" class="text-xs uppercase">{{ targetFormat || '...' }}</Badge>
              </div>

              <!-- Status -->
              <div :class="getStatusColor(entry.status)" class="shrink-0">
                <span :class="getStatusIcon(entry.status)" class="w-4 h-4" />
              </div>

              <!-- Remove button -->
              <Button
                v-if="!converting"
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                @click="removeFile(index)"
              >
                <span class="icon-[lucide--x] w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </ScrollArea>
      </div>

      <!-- Bottom fixed area: settings + action bar -->
      <div v-if="hasFiles" class="shrink-0 space-y-3">
        <!-- Conversion settings -->
        <div class="border rounded-xl p-4 bg-card/50 backdrop-blur-sm space-y-4">

          <!-- Target format + Quality row -->
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-2 flex-1">
              <span class="text-xs text-muted-foreground whitespace-nowrap">目标格式</span>
              <Select v-model="targetFormat">
                <SelectTrigger class="w-[120px] h-8">
                  <SelectValue :placeholder="targetFormat ? targetFormat.toUpperCase() : '选择格式'" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="fmt in availableFormats" :key="fmt" :value="fmt">
                    {{ fmt.toUpperCase() }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div v-if="dominantMediaType === 'image'" class="flex items-center gap-2 flex-1">
              <span class="text-xs text-muted-foreground whitespace-nowrap">质量</span>
              <Slider v-model="imageQuality" :min="1" :max="100" :step="1" class="flex-1" />
              <span class="text-xs text-muted-foreground w-8 text-right">{{ imageQuality[0] }}%</span>
            </div>
          </div>

          <!-- Output location -->
          <div class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground whitespace-nowrap">输出位置</span>
            <Select v-model="outputLocation">
              <SelectTrigger class="w-[140px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="original">原始位置</SelectItem>
                <SelectItem value="desktop">桌面</SelectItem>
                <SelectItem value="custom">自定义...</SelectItem>
              </SelectContent>
            </Select>
            <Button
              v-if="outputLocation === 'custom'"
              variant="outline"
              size="sm"
              class="h-8"
              @click="pickCustomDir"
            >
              <span class="icon-[lucide--folder] w-3.5 h-3.5 mr-1" />
              {{ customOutputDir ? customOutputDir.split('\\').pop() : '选择文件夹' }}
            </Button>
          </div>
        </div>

        <!-- Action bar -->
        <div class="flex items-center justify-between">
          <div v-if="converting" class="flex items-center gap-3 flex-1">
            <Progress :model-value="totalProgress" class="flex-1 h-2" />
            <span class="text-xs text-muted-foreground whitespace-nowrap">
              {{ totalProgress }}% ({{ doneCount }}/{{ files.length }})
            </span>
          </div>
          <div v-else class="flex-1">
            <span v-if="doneCount > 0" class="text-xs text-green-500">
              <span class="icon-[lucide--check] w-3 h-3 inline-block mr-0.5 align-text-bottom" />
              已完成 {{ doneCount }} 个
              <span v-if="errorCount > 0" class="text-destructive ml-2">
                {{ errorCount }} 个失败
              </span>
            </span>
          </div>

          <div class="flex gap-2">
            <Button
              v-if="converting"
              variant="destructive"
              size="sm"
              @click="cancelConvert"
            >
              <span class="icon-[lucide--square] w-3.5 h-3.5 mr-1.5" />
              取消
            </Button>
            <Button
              v-else
              :disabled="files.length === 0 || !targetFormat"
              size="sm"
              @click="startConvert"
            >
              <span class="icon-[lucide--play] w-3.5 h-3.5 mr-1.5" />
              开始转换
            </Button>
          </div>
        </div>
      </div>

    </div>
  </div>

  <!-- Batch Folder Dialog -->
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    leave-active-class="transition-opacity duration-150"
    leave-to-class="opacity-0"
  >
    <div
      v-if="batchDialogOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="batchDialogOpen = false"
    >
      <div class="w-[440px] max-h-[70vh] rounded-xl shadow-2xl bg-popover border flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <!-- Header -->
        <div class="p-5 pb-3 flex items-center justify-between">
          <div>
            <h3 class="font-medium">批量转换</h3>
            <p class="text-xs text-muted-foreground mt-0.5">{{ batchFolderPath.split('\\').pop() }}</p>
          </div>
          <Button variant="ghost" size="icon-sm" @click="batchDialogOpen = false">
            <span class="icon-[lucide--x] w-4 h-4" />
          </Button>
        </div>

        <!-- Format selection -->
        <div class="flex-1 overflow-y-auto px-5 pb-3">
          <p class="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-3">选择要转换的格式</p>

          <div v-if="batchScanning" class="py-8 text-center text-muted-foreground">
            <span class="icon-[lucide--loader-2] w-5 h-5 animate-spin inline-block mb-2" />
            <p class="text-sm">扫描中...</p>
          </div>

          <div v-else-if="batchScannedFormats.length === 0" class="py-8 text-center text-muted-foreground">
            <p class="text-sm">未找到支持的文件</p>
          </div>

          <div v-else class="space-y-2">
            <label
              v-for="item in batchScannedFormats"
              :key="item.ext"
              class="flex items-center gap-3 p-2.5 border rounded-lg hover:bg-muted/30 transition-colors cursor-pointer"
            >
              <Checkbox
                :checked="item.checked"
                @update:checked="(val: boolean) => item.checked = val"
              />
              <Badge variant="outline" class="text-xs uppercase">{{ item.ext }}</Badge>
              <span class="text-xs text-muted-foreground">{{ item.count }} 个文件</span>
            </label>
          </div>

          <!-- Target format -->
          <div v-if="batchScannedFormats.length > 0" class="mt-4 flex items-center gap-2">
            <span class="text-xs text-muted-foreground whitespace-nowrap">转换为</span>
            <Select v-model="batchTargetFormat">
              <SelectTrigger class="w-[120px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="fmt in batchAvailableFormats" :key="fmt" :value="fmt">
                  {{ fmt.toUpperCase() }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <!-- Footer -->
        <div class="p-4 pt-3 border-t flex items-center justify-between">
          <span class="text-xs text-muted-foreground">
            已选择 {{ batchSelectedCount }} 个文件
          </span>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" @click="batchDialogOpen = false">取消</Button>
            <Button size="sm" :disabled="batchSelectedCount === 0" @click="confirmBatch">
              确认添加
            </Button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
