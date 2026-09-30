<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ConflictResolution, SyncConflict } from '../../types/sync'
import {
  CONFLICT_DESCRIPTIONS,
  CONFLICT_LABELS,
  itemTitle,
  KIND_LABELS,
} from '../../utils/syncMerge'
import { useSyncStore } from '../../stores/syncStore'
import { useSheetStore } from '../../stores/sheetStore'

const props = defineProps<{ conflict: SyncConflict }>()

const syncStore = useSyncStore()
const sheetStore = useSheetStore()

const FIELD_LABELS: Record<string, string> = {
  code: '图幅号',
  sheetCode: '所属图幅号',
  title: '图幅题名',
  year: '测绘年代',
  scale: '比例尺',
  projection: '投影方式',
  sheetSizeCm: '图幅尺寸',
  series: '所属图组',
  neighborCodes: '邻接图号',
  status: '整理状态',
  fileName: '扫描文件名',
  resolutionDpi: '分辨率 (dpi)',
  colorMode: '色彩模式',
  pieces: '分块数',
  quality: '图像质量',
  storageNote: '存放位置',
  importedAt: '登记时间',
  isPrimary: '主用件',
  oldName: '古名',
  newName: '今名',
  aliasList: '异写',
  placeType: '地名类型',
  coordNote: '图上方位',
  certainty: '确定度',
}

const form = reactive<{ resolution: ConflictResolution; bindToCode: string; note: string }>({
  resolution: 'keep',
  bindToCode: '',
  note: '',
})

watch(
  () => props.conflict.id,
  () => {
    form.resolution = props.conflict.type === 'association' ? 'bind' : 'keep'
    form.bindToCode = props.conflict.bindToCode ?? ''
    form.note = props.conflict.note ?? ''
  },
  { immediate: true },
)

const incoming = computed(() => props.conflict.item.payload as unknown as Record<string, unknown>)
const local = computed(() => props.conflict.localSnapshot as Record<string, unknown> | undefined)

const rows = computed(() =>
  Object.keys(incoming.value).map((key) => {
    const incomingValue = formatValue(incoming.value[key])
    const localValue = local.value ? formatValue(local.value[key]) : '—'
    return {
      key,
      label: FIELD_LABELS[key] ?? key,
      incoming: incomingValue,
      local: localValue,
      differs: local.value !== undefined && incomingValue !== localValue,
    }
  }),
)

const bindableSheets = computed(() => sheetStore.sheets)

const showTake = computed(() => props.conflict.type !== 'code-collision')
const showBind = computed(() => props.conflict.type === 'association')

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '—'
  }
  if (typeof value === 'boolean') {
    return value ? '是' : '否'
  }
  if (Array.isArray(value)) {
    return value.length ? value.join('、') : '—'
  }
  return String(value)
}

async function submit(): Promise<void> {
  if (form.resolution === 'bind' && !form.bindToCode) {
    ElMessage.warning('请先选择要绑定的本地图幅号。')
    return
  }
  const outcome = await syncStore.resolveConflict(
    props.conflict.packageId,
    props.conflict.kind,
    props.conflict.sourceKey,
    {
      resolution: form.resolution,
      bindToCode: form.resolution === 'bind' ? form.bindToCode : undefined,
      note: form.note,
    },
  )
  ElMessage[outcome.ok ? 'success' : 'warning'](outcome.message)
}

async function reopen(): Promise<void> {
  const outcome = await syncStore.reopenConflict(
    props.conflict.packageId,
    props.conflict.kind,
    props.conflict.sourceKey,
  )
  ElMessage.success(outcome.message)
}

const resolutionLabel = computed(() => {
  switch (props.conflict.resolution) {
    case 'take':
      return '采用馆方内容'
    case 'keep':
    case 'skip':
      return '保留本地内容'
    case 'bind':
      return `绑定到本地图幅 ${props.conflict.bindToCode ?? ''}`
    default:
      return ''
  }
})
</script>

<template>
  <article class="conflict-card" :data-testid="`conflict-${conflict.kind}-${conflict.sourceKey}`">
    <header class="conflict-card__head">
      <div>
        <el-tag type="danger" effect="dark" size="small">{{ CONFLICT_LABELS[conflict.type] }}</el-tag>
        <el-tag size="small" class="ml-8">{{ KIND_LABELS[conflict.kind] }}</el-tag>
        <h3>{{ itemTitle(conflict.item) }}</h3>
      </div>
      <div class="conflict-card__keys">
        <span>sourceKey：<code>{{ conflict.sourceKey }}</code></span>
        <span>baseHash：<code>{{ conflict.item.baseHash ? conflict.item.baseHash.slice(0, 16) + '…' : '无（新增项）' }}</code></span>
      </div>
    </header>

    <p class="conflict-card__desc">{{ CONFLICT_DESCRIPTIONS[conflict.type] }}</p>

    <div class="conflict-diff">
      <table>
        <thead>
          <tr>
            <th>字段</th>
            <th>本地（馆员修订）</th>
            <th>馆方包内</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" :class="{ 'is-diff': row.differs }">
            <td>{{ row.label }}</td>
            <td>{{ row.local }}</td>
            <td>{{ row.incoming }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <template v-if="conflict.status === 'pending'">
      <div class="conflict-form">
        <label class="conflict-choice">
          <input v-if="showTake" v-model="form.resolution" type="radio" value="take" />
          <span v-if="showTake">采用馆方内容，覆盖到本地（仅对本条，确认底本未被本地修订）</span>
        </label>
        <label v-if="showBind" class="conflict-choice">
          <input v-model="form.resolution" type="radio" value="bind" />
          <span>补证：绑定到本地图幅</span>
          <el-select
            v-if="showBind"
            v-model="form.bindToCode"
            :disabled="form.resolution !== 'bind'"
            placeholder="选择图幅号"
            style="width: 220px"
          >
            <el-option v-for="sheet in bindableSheets" :key="sheet.id" :label="`${sheet.code} · ${sheet.title}`" :value="sheet.code" />
          </el-select>
        </label>
        <label class="conflict-choice">
          <input v-model="form.resolution" type="radio" value="keep" />
          <span>保留本地内容，跳过馆方这一条</span>
        </label>
        <div class="conflict-note">
          <label for="`note-${conflict.id}`">处理说明（补证依据，离开页面再回来仍保留）</label>
          <textarea
            :id="`note-${conflict.id}`"
            v-model="form.note"
            class="native-field"
            rows="3"
            placeholder="例如：已核对 1935 年晒蓝本，本地改题名为馆员据原图标注，应保留。"
          ></textarea>
        </div>
        <div class="conflict-actions">
          <el-button type="primary" @click="submit">提交补证并重新核验</el-button>
        </div>
      </div>
    </template>

    <div v-else class="conflict-resolved">
      <el-tag type="success" effect="plain">已补证：{{ resolutionLabel }}</el-tag>
      <p v-if="conflict.note" class="conflict-note__text">{{ conflict.note }}</p>
      <el-button link type="primary" @click="reopen">退回待处理</el-button>
    </div>
  </article>
</template>
