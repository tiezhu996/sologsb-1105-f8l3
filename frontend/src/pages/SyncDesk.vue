<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSyncStore } from '../stores/syncStore'
import { useSheetStore } from '../stores/sheetStore'
import type { SyncPackageRecord } from '../types/sync'
import { KIND_LABELS, PACKAGE_STATE_LABELS, itemTitle } from '../utils/syncMerge'
import { buildSamplePackFiles } from '../utils/samplePacks'
import { downloadJson } from '../utils/export'
import ConflictCard from '../components/sync/ConflictCard.vue'
import VacantHint from '../components/common/VacantHint.vue'

const syncStore = useSyncStore()
const sheetStore = useSheetStore()

const fileInput = ref<HTMLInputElement | null>(null)
const pasteOpen = ref(false)
const pasteText = ref('')
const sampleLoading = ref(false)
const busyId = ref('')

const globalPending = computed(() => syncStore.pendingConflicts)

const stateTagType = (state: SyncPackageRecord['state']): 'danger' | 'warning' | 'success' | 'info' | 'primary' => {
  switch (state) {
    case 'invalid':
      return 'danger'
    case 'conflicts':
    case 'failed':
      return 'warning'
    case 'applied':
      return 'success'
    case 'ready':
      return 'primary'
    default:
      return 'info'
  }
}

const orderedPackages = computed(() => syncStore.packages)

function pendingOf(record: SyncPackageRecord) {
  return syncStore.pendingConflictsForPackage(record.packageId)
}

function resolvedOf(record: SyncPackageRecord) {
  return syncStore.conflictsForPackage(record.packageId).filter((conflict) => conflict.status === 'resolved')
}

function summaryOf(record: SyncPackageRecord) {
  return syncStore.getSummary(record.packageId)
}

async function handleFiles(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const files = target.files ? Array.from(target.files) : []
  for (const file of files) {
    const text = await file.text()
    const outcome = await syncStore.importPack(text)
    ElMessage[outcome.state === 'invalid' ? 'error' : outcome.ok ? 'success' : 'warning'](
      `《${file.name}》${outcome.message}`,
    )
  }
  target.value = ''
}

async function importPasted(): Promise<void> {
  if (!pasteText.value.trim()) {
    ElMessage.warning('请先粘贴校勘包 JSON 文本。')
    return
  }
  const outcome = await syncStore.importPack(pasteText.value)
  ElMessage[outcome.state === 'invalid' ? 'error' : outcome.ok ? 'success' : 'warning'](outcome.message)
  if (outcome.state !== 'invalid') {
    pasteOpen.value = false
    pasteText.value = ''
  }
}

async function applyPack(record: SyncPackageRecord): Promise<void> {
  const pending = pendingOf(record)
  const confirmText = pending.length
    ? `仍有 ${pending.length} 项冲突未处理，确认前请先补证。`
    : '整包将在同一个事务内一起写入；中途失败会整体回滚并保留原包与进度。确认写入？'
  if (pending.length) {
    ElMessage.warning(confirmText)
    return
  }
  try {
    await ElMessageBox.confirm(confirmText, '整包写入确认', {
      confirmButtonText: '一起写入',
      cancelButtonText: '再检查一下',
      type: 'warning',
    })
  } catch {
    return
  }
  busyId.value = record.packageId
  const outcome = await syncStore.applyPackage(record.packageId)
  busyId.value = ''
  ElMessage[outcome.ok ? 'success' : 'error'](outcome.message)
}

async function reviewAgain(record: SyncPackageRecord): Promise<void> {
  busyId.value = record.packageId
  const outcome = await syncStore.reviewPackage(record.packageId)
  busyId.value = ''
  ElMessage[outcome.state === 'invalid' ? 'error' : outcome.ok ? 'success' : 'warning'](outcome.message)
}

async function removeInvalid(record: SyncPackageRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除无法核验的登记《${record.label}》？原始包文本随之移除（防重台账保留）。`,
      '删除损坏登记',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  await syncStore.removeInvalidPackage(record.packageId)
  ElMessage.success('已删除损坏登记。')
}

async function downloadSamples(): Promise<void> {
  sampleLoading.value = true
  try {
    const files = await buildSamplePackFiles()
    for (const file of files) {
      downloadJson(file.fileName, JSON.parse(file.rawText))
    }
    ElMessage.success('已导出 4 个示例校勘包，可依次选择导入。')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '示例包生成失败')
  } finally {
    sampleLoading.value = false
  }
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return value
  }
}

function plannedTitle(mode: string): string {
  if (mode === 'skip') {
    return '跳过'
  }
  if (mode.startsWith('add')) {
    return '新增'
  }
  if (mode.startsWith('update')) {
    return '更新'
  }
  return mode
}

const totalMetrics = computed(() => ({
  packages: syncStore.packages.length,
  pending: syncStore.pendingCount,
  applied: syncStore.packages.filter((record) => record.state === 'applied').length,
}))

onMounted(async () => {
  await Promise.all([syncStore.init(), sheetStore.init()])
})
</script>

<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <span class="page-kicker">OFFLINE CORRECTIONS</span>
        <h1>离线校勘合并台</h1>
        <p>
          协作馆断网时随摆渡设备带来校勘包：图幅、扫描件与地名对照均带 sourceKey、baseHash
          并按当时的图幅号关联。整包校验通过且没有冲突后才一起写入；编目台仍是本地唯一写入方。
        </p>
      </div>
      <div style="display: flex; gap: 10px">
        <el-button @click="downloadSamples" :loading="sampleLoading">导出示例校勘包</el-button>
        <el-button @click="pasteOpen = !pasteOpen">粘贴包文本</el-button>
        <el-button type="primary" @click="fileInput?.click()">选择校勘包</el-button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          multiple
          hidden
          data-testid="file-pack"
          @change="handleFiles"
        />
      </div>
    </div>

    <div v-if="pasteOpen" class="inline-form">
      <h2>粘贴校勘包 JSON</h2>
      <textarea v-model="pasteText" class="native-field" rows="8" placeholder='{"formatVersion":1,"packageId":...}'></textarea>
      <div class="form-actions" style="margin-top: 12px">
        <el-button @click="pasteOpen = false">取消</el-button>
        <el-button type="primary" data-testid="paste-import" @click="importPasted">导入并核验</el-button>
      </div>
    </div>

    <div class="metrics-strip">
      <div class="metric"><span>已登记校勘包</span><strong>{{ totalMetrics.packages }}</strong><small>个</small></div>
      <div class="metric"><span>待处理冲突</span><strong>{{ totalMetrics.pending }}</strong><small>项</small></div>
      <div class="metric"><span>已合并包</span><strong>{{ totalMetrics.applied }}</strong><small>个</small></div>
    </div>

    <section v-if="globalPending.length" class="pending-zone panel" data-testid="pending-zone">
      <div class="panel__header">
        <h2>待处理区（{{ globalPending.length }} 项）</h2>
        <span class="muted">冲突项与处理说明保存在本地，离开页面再回来仍在；补证后可继续整包写入。</span>
      </div>
      <div class="panel__body pending-zone__list">
        <ConflictCard v-for="conflict in globalPending" :key="conflict.id" :conflict="conflict" />
      </div>
    </section>

    <section class="package-list">
      <div v-for="record in orderedPackages" :key="record.packageId" class="package-card panel" :data-testid="`package-${record.packageId}`">
        <div class="panel__header">
          <div>
            <h2>{{ record.label }}</h2>
            <div class="package-card__meta">
              <span>{{ record.origin || '来源未注明' }}</span>
              <span>打包 {{ formatTime(record.packedAt) }}</span>
              <span>包号 <code>{{ record.packageId }}</code></span>
              <el-tag :type="stateTagType(record.state)" effect="dark" size="small">
                {{ PACKAGE_STATE_LABELS[record.state] }}
              </el-tag>
            </div>
          </div>
          <div class="package-card__actions">
            <el-button size="small" :loading="busyId === record.packageId" @click="reviewAgain(record)">重新核验</el-button>
            <el-button
              v-if="record.state === 'invalid'"
              size="small"
              type="danger"
              plain
              @click="removeInvalid(record)"
            >
              删除登记
            </el-button>
            <el-button
              v-if="record.state === 'ready' || record.state === 'failed'"
              size="small"
              type="primary"
              :loading="busyId === record.packageId"
              data-testid="apply-pack"
              @click="applyPack(record)"
            >
              {{ record.state === 'failed' ? '重试整包写入' : '整包一起写入' }}
            </el-button>
          </div>
        </div>

        <div class="panel__body">
          <p class="package-card__message" :class="{ 'text-danger': record.state === 'invalid' }">
            {{ record.message || '等待核验。' }}
          </p>

          <template v-if="summaryOf(record)">
            <div class="plan-strip">
              <span class="plan-chip plan-chip--add">新增 {{ summaryOf(record)?.addCount }}</span>
              <span class="plan-chip plan-chip--update">更新 {{ summaryOf(record)?.updateCount }}</span>
              <span class="plan-chip plan-chip--skip">跳过 {{ summaryOf(record)?.skipCount }}</span>
              <span class="plan-chip plan-chip--conflict">待处理 {{ summaryOf(record)?.conflictCount }}</span>
            </div>

            <details class="plan-details" :open="record.state === 'conflicts'">
              <summary>查看条目清单（{{ summaryOf(record)?.plan.length }} 条）</summary>
              <ul class="plan-table">
                <li v-for="planned in summaryOf(record)?.plan" :key="`${planned.item.kind}:${planned.item.sourceKey}`">
                  <el-tag size="small" :type="planned.mode === 'skip' ? 'info' : planned.mode.startsWith('add') ? 'success' : 'warning'">
                    {{ plannedTitle(planned.mode) }}
                  </el-tag>
                  <span class="plan-table__kind">{{ KIND_LABELS[planned.item.kind] }}</span>
                  <span>{{ itemTitle(planned.item) }}</span>
                  <small v-if="planned.reason" class="muted">{{ planned.reason }}</small>
                </li>
              </ul>
            </details>
          </template>

          <div v-if="record.state === 'applied'" class="applied-note">
            已写入 {{ record.appliedItems.length }} 条并登记幂等台账；再次导入同一包不会多出记录。
          </div>

          <div v-if="resolvedOf(record).length" class="resolved-note">
            <strong>本包已补证 {{ resolvedOf(record).length }} 项（处理说明保存在冲突记录中）：</strong>
            <ul class="resolved-list">
              <li v-for="conflict in resolvedOf(record)" :key="conflict.id">
                <el-tag size="small" type="success" effect="plain">
                  {{ conflict.resolution === 'take' ? '采用馆方' : conflict.resolution === 'bind' ? `绑定 ${conflict.bindToCode}` : '保留本地' }}
                </el-tag>
                <span>{{ KIND_LABELS[conflict.kind] }} · {{ itemTitle(conflict.item) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <VacantHint
        v-if="!orderedPackages.length"
        title="还没有离线校勘包"
        description="请协作馆随摆渡设备带来 .json 校勘包；选择文件或粘贴文本后，先过整包校验，再处理冲突，最后一起写入。可以先用“导出示例校勘包”走一遍流程。"
      />
    </section>
  </section>
</template>
