<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ConflictRecord } from '../../utils/offlineMerge'

const props = defineProps<{
  conflict: ConflictRecord
  disabled?: boolean
}>()

const emit = defineEmits<{
  resolve: [decision: string, evidence: string]
  withdraw: []
}>()

const decision = ref('')
const evidence = ref('')
const formError = ref('')

watch(
  () => props.conflict.id,
  () => {
    decision.value = props.conflict.resolution?.decision ?? ''
    evidence.value = props.conflict.resolution?.evidence ?? ''
    formError.value = ''
  },
  { immediate: true },
)

const typeLabel = computed(() =>
  props.conflict.type === 'sheet' ? '图幅' : props.conflict.type === 'scan' ? '扫描件' : '地名对照',
)

const kindLabel = computed(() =>
  props.conflict.kind === 'code-collision'
    ? '图幅号撞号：本地已有另一来源的同号图幅，不能覆盖'
    : '馆员在协作馆打包之后改过本地内容',
)

const kindTagType = computed(() => (props.conflict.kind === 'code-collision' ? 'danger' : 'warning'))

const options = computed(() => {
  if (props.conflict.kind === 'code-collision') {
    return [{ value: 'skip-item', label: '跳过该条，维持本地现状' }]
  }
  return [
    { value: 'keep-local', label: '保留本地修改（不采用包项）' },
    { value: 'take-package', label: '采用协作馆包项（补证确认后覆盖）' },
  ]
})

const resolvedDecision = computed(() => props.conflict.resolution?.decision)
const resolutionStale = computed(
  () => Boolean(props.conflict.resolution) && props.conflict.resolution?.basedOnLocalHash !== props.conflict.localHash,
)

function submit(): void {
  if (!decision.value) {
    formError.value = '请选择处理方式。'
    return
  }
  if (!evidence.value.trim()) {
    formError.value = '冲突项必须补证：请填写依据后再继续。'
    return
  }
  formError.value = ''
  emit('resolve', decision.value, evidence.value)
}
</script>

<template>
  <article class="conflict-card" :class="{ 'conflict-card--resolved': resolvedDecision && !resolutionStale }">
    <header class="conflict-card__head">
      <div>
        <el-tag size="small" :type="kindTagType" effect="dark">{{ kindLabel }}</el-tag>
        <h4>
          <span class="muted">[{{ typeLabel }}]</span>
          {{ conflict.label || conflict.sourceKey }}
        </h4>
        <p class="muted">sourceKey：{{ conflict.sourceKey }} · 图幅号 {{ conflict.sheetCode }}</p>
      </div>
      <el-tag v-if="resolvedDecision && !resolutionStale" type="success" effect="dark">已补证</el-tag>
      <el-tag v-else-if="resolutionStale" type="danger" effect="dark">补证后本地又改动，需重新处理</el-tag>
      <el-tag v-else type="warning" effect="dark">待处理</el-tag>
    </header>

    <table v-if="conflict.fieldDiffs.length" class="diff-table">
      <thead>
        <tr><th>字段</th><th>本地现状（馆员已改）</th><th>协作馆包项</th></tr>
      </thead>
      <tbody>
        <tr v-for="diff in conflict.fieldDiffs" :key="diff.field">
          <td>{{ diff.label }}</td>
          <td class="diff-table__local">{{ diff.local }}</td>
          <td class="diff-table__incoming">{{ diff.incoming }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted">字段值无文字差异（可能为来源或图幅号挂接冲突）。</p>

    <div v-if="conflict.resolution" class="conflict-evidence">
      <strong>处理说明：</strong>
      <el-tag size="small" :type="conflict.resolution.decision === 'take-package' ? 'primary' : 'info'">
        {{
          conflict.resolution.decision === 'keep-local'
            ? '保留本地'
            : conflict.resolution.decision === 'take-package'
              ? '采用包项'
              : '跳过该条'
        }}
      </el-tag>
      <span>{{ conflict.resolution.evidence }}</span>
      <small class="muted">{{ new Date(conflict.resolution.at).toLocaleString('zh-CN') }}</small>
    </div>

    <div v-if="!disabled" class="conflict-form">
      <el-radio-group v-model="decision" class="conflict-form__options">
        <el-radio v-for="option in options" :key="option.value" :value="option.value">
          {{ option.label }}
        </el-radio>
      </el-radio-group>
      <el-input
        v-model="evidence"
        type="textarea"
        :rows="2"
        placeholder="补证依据：核对了哪份档案、哪位馆员确认、依据图版编号等"
      />
      <div class="conflict-form__actions">
        <el-button
          v-if="conflict.resolution"
          size="small"
          data-testid="withdraw-resolution"
          @click="emit('withdraw')"
        >
          撤回补证
        </el-button>
        <el-button size="small" type="primary" data-testid="save-resolution" @click="submit">
          保存处理说明
        </el-button>
      </div>
      <p v-if="formError" class="text-danger">{{ formError }}</p>
    </div>
  </article>
</template>
