<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton } from 'naive-ui'
import { useLiveStore } from '@/stores/liveStore'

/**
 * LiveNoticeBar 现场运行提示条：场次 运行期间在编排台各页面顶部提示
 * 「改动只标记为下一场待生效」，并提供回到运行台的入口。
 */
const props = defineProps<{
  /** 当前页面所属场次 */
  sessionId: string
}>()

const router = useRouter()
const liveStore = useLiveStore()

const activeRun = computed(() => (props.sessionId ? liveStore.activeRunOf(props.sessionId) : null))

const currentText = computed(() => {
  const run = activeRun.value
  if (!run) return ''
  const current = liveStore.currentCueOf(run)
  if (!current) return `尚未 GO，共 ${run.cues.length} 条`
  return `当前 ${current.cueNo}（${run.cursor + 1}/${run.cues.length}）`
})

const pendingCount = computed(() => (activeRun.value ? liveStore.pendingOf(activeRun.value.id).length : 0))

function goLive(): void {
  if (!activeRun.value) return
  void router.push(`/sessions/${props.sessionId}/live`)
}
</script>

<template>
  <NAlert v-if="activeRun" type="warning" :bordered="false" class="live-notice">
    <div class="live-notice__body">
      <span>
        现场运行中：第 {{ activeRun.runSeq }} 场 · {{ currentText }}。此处的改动不会影响本场，已标记为下一场待生效{{
          pendingCount > 0 ? `（已积压 ${pendingCount} 条）` : ''
        }}。
      </span>
      <NButton size="tiny" type="warning" ghost @click="goLive">打开现场运行台</NButton>
    </div>
  </NAlert>
</template>

<style scoped>
.live-notice__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
