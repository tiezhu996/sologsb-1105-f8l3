<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useOfflineStore } from '../stores/offlineStore'
import { useSheetStore } from '../stores/sheetStore'
import { usePlaceStore } from '../stores/placeStore'
import { isConflictResolved, type ConflictDecision } from '../utils/offlineMerge'
import type { StagedPackage } from '../utils/db'
import { downloadJson } from '../utils/export'
import ConflictCard from '../components/offline/ConflictCard.vue'
import VacantHint from '../components/common/VacantHint.vue'

const offlineStore = useOfflineStore()
const sheetStore = useSheetStore()
const placeStore = usePlaceStore()

const fileInput = ref<HTMLInputElement | null>(null)
const committingId = ref('')
const showArchived = ref(false)

const SAMPLE_INDEX_URL = '/offline-pkgs/index.json'
const samples = ref<Array<{ file: string; title: string; description: string }>>([])

const activePackages = computed(() => offlineStore.pendingPackages)
const archivedPackages = computed(() =>
  offlineStore.packages.filter((staged) => staged.status === '已合并' || staged.status === '已丢弃'),
)

function itemSummary(staged: StagedPackage): Record<string, number> {
  const items = staged.items ?? []
  return {
    create: items.filter((item) => item.action === 'create').length,
    update: items.filter((item) => item.action === 'update').length,
    noop: items.filter((item) => item.action === 'noop').length,
    conflict: staged.conflicts.filter((item) => !isConflictResolved(item)).length,
  }
}

function pendingConflictsOf(staged: StagedPackage) {
  return staged.conflicts.filter((conflict) => !isConflictResolved(conflict))
}

function statusTagType(status: StagedPackage['status']): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  switch (status) {
    case '可合并':
      return 'success'
    case '待处理冲突':
      return 'warning'
    case '校验异常':
      return 'danger'
    case '已合并':
      return 'success'
    default:
      return 'info'
  }
}

async function handleFiles(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const files = target.files ? Array.from(target.files) : []
  for (const file of files) {
    const text = await file.text()
    const result = await offlineStore.importPackageFromText(text, file.name)
    if (result.duplicate) {
      ElMessage.info(`包 ${file.name} 已在待处理列表中，未重复登记。`)
    } else if (result.staged.status === '可合并') {
      ElMessage.success(`包 ${file.name} 校验通过，可以整包合并。`)
    } else if (result.staged.status === '待处理冲突') {
      ElMessage.warning(`包 ${file.name} 有冲突项，已留在待处理区。`)
    } else {
      ElMessage.error(`包 ${file.name} 校验未通过，原包已保留。`)
    }
  }
  if (target) {
    target.value = ''
  }
}

async function loadSample(file: string): Promise<void> {
  const response = await fetch(`/offline-pkgs/${file}`)
  if (!response.ok) {
    ElMessage.error('示例包读取失败。')
    return
  }
  const text = await response.text()
  const result = await offlineStore.importPackageFromText(text, file)
  if (result.duplicate) {
    ElMessage.info('该示例包已在待处理列表中。')
  } else if (result.staged.status === '可合并') {
    ElMessage.success('示例包校验通过，可以整包合并。')
  } else if (result.staged.status === '待处理冲突') {
    ElMessage.warning('示例包存在与本地修改的冲突，已留在待处理区补证。')
  } else {
    ElMessage.error('示例包校验未通过。')
  }
}

async function saveResolution(
  staged: StagedPackage,
  conflictId: string,
  decision: string,
  evidence: string,
): Promise<void> {
  try {
    const next = await offlineStore.resolveConflict(
      staged.packageId,
      conflictId,
      decision as ConflictDecision,
      evidence,
    )
    if (next.status === '可合并') {
      ElMessage.success('全部冲突已补证，整包可以合并写入。')
    } else {
      ElMessage.success('处理说明已保存。')
    }
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function withdrawResolution(staged: StagedPackage, conflictId: string): Promise<void> {
  await offlineStore.discardConflictResolution(staged.packageId, conflictId)
  ElMessage.info('已撤回处理说明。')
}

async function recheck(staged: StagedPackage): Promise<void> {
  const next = await offlineStore.reevaluate(staged.packageId)
  if (next.status === '可合并') {
    ElMessage.success('重新校验通过，可以整包合并。')
  } else if (next.status === '待处理冲突') {
    ElMessage.warning('仍存在未处理冲突。')
  } else {
    ElMessage.error('重新校验未通过。')
  }
}

async function commit(staged: StagedPackage): Promise<void> {
  committingId.value = staged.packageId
  try {
    const merged = await offlineStore.commitPackage(staged.packageId)
    if (merged.status === '已合并') {
      // 合并是唯一写入动作，刷新编目台两个内存视图。
      await Promise.all([sheetStore.reloadAfterMerge(), placeStore.reloadAfterMerge()])
      ElMessage.success('整包已写入编目台。')
    } else {
      ElMessage.warning('暂不能写入，请先处理冲突或校验错误。')
    }
  } catch (error) {
    ElMessage.error(`写入失败，已整体回滚：${(error as Error).message}`)
  } finally {
    committingId.value = ''
  }
}

async function discard(staged: StagedPackage): Promise<void> {
  await offlineStore.discardPackage(staged.packageId)
  ElMessage.info('包已移至已丢弃，原包与说明仍保留在本机。')
}

function exportPackage(staged: StagedPackage): void {
  downloadJson(staged.fileName.endsWith('.json') ? staged.fileName : `${staged.fileName}.json`, staged.rawPackage)
}

function formatTime(value?: string): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

onMounted(async () => {
  await Promise.all([
    offlineStore.init(),
    sheetStore.init(),
    placeStore.init(),
    fetch(SAMPLE_INDEX_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (Array.isArray(data)) {
          samples.value = data
        }
      })
      .catch(() => undefined),
  ])
})
</script>

<template>
  <section class="page" data-testid="offline-merge">
    <div class="page-heading">
      <div>
        <span class="page-kicker">OFFLINE CORRECTIONS</span>
        <h1>离线校勘包合并</h1>
        <p>
          协作馆断网带来的校勘包在此统一收口：整包校验通过、冲突全部补证后才一次性写入编目台。
          编目台始终是本地唯一写入方，包只暂存、不直接落库。
        </p>
      </div>
      <div>
        <input
          ref="fileInput"
          accept="application/json,.json"
          data-testid="input-package"
          hidden
          multiple
          type="file"
          @change="handleFiles"
        />
        <el-button type="primary" size="large" data-testid="btn-choose" @click="fileInput?.click()">
          选择校勘包
        </el-button>
      </div>
    </div>

    <div class="metrics-strip">
      <div class="metric">
        <span>待处理包</span>
        <strong>{{ activePackages.length }}</strong><small>个</small>
      </div>
      <div class="metric">
        <span>未决冲突</span>
        <strong>{{ offlineStore.pendingConflictCount }}</strong><small>项</small>
      </div>
      <div class="metric">
        <span>可直接合并</span>
        <strong>{{ activePackages.filter((item) => item.status === '可合并').length }}</strong><small>个</small>
      </div>
    </div>

    <section class="panel">
      <div class="panel__header">
        <h2>示例校勘包</h2>
        <span class="muted">首次使用可载入体验：一个可直接合并，一个含馆员本地修改冲突。</span>
      </div>
      <div class="panel__body sample-strip">
        <el-button
          v-for="sample in samples"
          :key="sample.file"
          plain
          :data-testid="`sample-${sample.file}`"
          @click="loadSample(sample.file)"
        >
          {{ sample.title }}
        </el-button>
        <span v-if="!samples.length" class="muted">示例包未就绪，也可以直接选择协作馆交付的 JSON 包。</span>
      </div>
    </section>

    <section v-if="activePackages.length" class="package-list">
      <article v-for="staged in activePackages" :key="staged.packageId" class="package-card" data-testid="staged-package">
        <header class="package-card__head">
          <div>
            <div class="package-card__title-row">
              <h2>{{ staged.origin }}</h2>
              <el-tag :type="statusTagType(staged.status)" effect="dark" data-testid="package-status">
                {{ staged.status }}
              </el-tag>
            </div>
            <p class="muted">
              {{ staged.fileName }} · 打包于 {{ formatTime(staged.preparedAt) }} · 接收于
              {{ formatTime(staged.receivedAt) }}
            </p>
            <p v-if="staged.note" class="package-card__note">随包说明：{{ staged.note }}</p>
          </div>
          <div class="package-card__actions">
            <el-button size="small" @click="recheck(staged)">重新校验</el-button>
            <el-button size="small" @click="exportPackage(staged)">下载原包</el-button>
            <el-button
              size="small"
              type="primary"
              :loading="committingId === staged.packageId"
              :disabled="staged.status !== '可合并'"
              data-testid="btn-commit"
              @click="commit(staged)"
            >
              整包合并写入
            </el-button>
            <el-button size="small" @click="discard(staged)">移至已丢弃</el-button>
          </div>
        </header>

        <div class="package-card__counts">
          <span>图幅 {{ staged.counts.sheets }} 件 / 扫描 {{ staged.counts.scans }} 件 / 地名
            {{ staged.counts.placePairs }} 条</span>
          <template v-if="staged.items?.length">
            <el-tag size="small" type="success">新增 {{ itemSummary(staged).create }}</el-tag>
            <el-tag size="small" type="primary">更新 {{ itemSummary(staged).update }}</el-tag>
            <el-tag size="small" type="info">内容一致 {{ itemSummary(staged).noop }}</el-tag>
            <el-tag v-if="itemSummary(staged).conflict" size="small" type="danger">
              未决冲突 {{ itemSummary(staged).conflict }}
            </el-tag>
          </template>
        </div>

        <el-alert
          v-for="error in staged.errors"
          :key="error"
          class="package-card__alert"
          type="error"
          :closable="false"
          show-icon
          :title="error"
        />
        <el-alert
          v-for="warning in staged.warnings"
          :key="warning"
          class="package-card__alert"
          type="warning"
          :closable="false"
          show-icon
          :title="warning"
        />

        <div v-if="pendingConflictsOf(staged).length || staged.conflicts.length" class="conflict-section">
          <div class="section-title">
            <div>
              <h2>待处理区（{{ pendingConflictsOf(staged).length }} 项未决）</h2>
              <span class="muted">冲突项不会自动覆盖馆员修改，补证保存后整包才允许写入。</span>
            </div>
          </div>
          <ConflictCard
            v-for="conflict in staged.conflicts"
            :key="conflict.id"
            :conflict="conflict"
            @resolve="(decision: string, evidence: string) => saveResolution(staged, conflict.id, decision, evidence)"
            @withdraw="withdrawResolution(staged, conflict.id)"
          />
        </div>

        <el-alert
          v-if="staged.status === '可合并'"
          class="package-card__alert"
          type="success"
          :closable="false"
          show-icon
          title="整包校验通过且没有未决冲突，合并将以单事务一次性写入；中途失败会整体回滚，重试不会产生重复记录。"
        />

        <details class="package-log">
          <summary>处理说明与进度（{{ staged.logs.length }} 条）</summary>
          <ol>
            <li v-for="(log, index) in staged.logs" :key="`${log.at}-${index}`">
              <el-tag size="small" effect="plain">{{ log.phase }}</el-tag>
              <time>{{ formatTime(log.at) }}</time>
              <span>{{ log.message }}</span>
            </li>
          </ol>
        </details>
      </article>
    </section>

    <VacantHint
      v-else
      title="暂无可处理的校勘包"
      description="协作馆断网交付 JSON 校勘包后，点击上方“选择校勘包”导入；原包、进度与补证说明都会保留在本机。"
    />

    <section v-if="archivedPackages.length" class="panel archived-panel">
      <div class="panel__header">
        <h2>已合并 / 已丢弃</h2>
        <el-button link type="primary" @click="showArchived = !showArchived">
          {{ showArchived ? '收起' : `展开 ${archivedPackages.length} 个` }}
        </el-button>
      </div>
      <div v-if="showArchived" class="panel__body">
        <ul class="archived-list">
          <li v-for="staged in archivedPackages" :key="staged.packageId">
            <el-tag size="small" :type="statusTagType(staged.status)" effect="dark">{{ staged.status }}</el-tag>
            <strong>{{ staged.origin }}</strong>
            <span class="muted">{{ staged.fileName }}</span>
            <time>{{ formatTime(staged.mergedAt ?? staged.updatedAt) }}</time>
            <el-button size="small" link @click="exportPackage(staged)">下载原包</el-button>
          </li>
        </ul>
      </div>
    </section>
  </section>
</template>
