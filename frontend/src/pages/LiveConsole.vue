<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import ChannelChip from '@/components/common/ChannelChip.vue'
import FadeBar from '@/components/common/FadeBar.vue'
import { useLiveStore } from '@/stores/liveStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useCueStore } from '@/stores/cueStore'
import type { LiveLogEntry, LiveLogType, LiveRun } from '@/types/live'
import { cueTotalSeconds, formatDateTime, formatSeconds, formatTransition } from '@/utils/fade'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const liveStore = useLiveStore()

const sessionId = computed(() => String(route.params.id ?? ''))
const session = computed(() => sessionStore.sessionById(sessionId.value))

const activeRun = computed(() => liveStore.activeRunOf(sessionId.value))
const pastRuns = computed(() => liveStore.runsOfSession(sessionId.value).filter((run) => run.status === 'ended'))

/** 当前提示与下一条（均来自开演快照） */
const currentCue = computed(() => (activeRun.value ? liveStore.currentCueOf(activeRun.value) : null))
const nextCue = computed(() => {
  const run = activeRun.value
  if (!run) return null
  const index = run.cursor + 1
  return index < run.cues.length ? run.cues[index] : null
})

const conflicts = computed(() => (activeRun.value ? liveStore.conflictsOf(activeRun.value.id) : []))
const pendingEdits = computed(() => (activeRun.value ? liveStore.pendingOf(activeRun.value.id) : []))
const activeLogs = computed(() => (activeRun.value ? liveStore.logsOfRun(activeRun.value.id) : []))

const progressText = computed(() => {
  const run = activeRun.value
  if (!run) return ''
  if (run.cursor < 0) return `未开始 · 共 ${run.cues.length} 条`
  return `${run.cursor + 1} / ${run.cues.length}`
})

/* ---------------- 开演 / 结束 ---------------- */

const consoleCueCount = computed(() => cueStore.cuesOfSession(sessionId.value).length)

async function openShow(): Promise<void> {
  try {
    const run = await liveStore.openRun(sessionId.value)
    if (!run) {
      message.warning('已有一场进行中的现场')
      return
    }
    message.success(`第 ${run.runSeq} 场开演：已固定 ${run.cues.length} 条 Cue 的顺序与电平`)
  } catch (error) {
    console.error('[gbcuesheet] 开演失败：', error)
    message.error('开演写入失败，请重试')
  }
}

function confirmEnd(): void {
  const run = activeRun.value
  if (!run) return
  const pending = pendingEdits.value
  const lines =
    pending.length > 0
      ? [
          `本场有 ${pending.length} 条待生效改动：`,
          ...pending.map((entry) => `· ${entry.edit ? describePayload(entry) : entry.note}`),
          '确认后这些改动将一次带入下一场开演快照；旧排演表快照不受影响。'
        ]
      : ['本场没有待生效改动。', '结束后可再次开演，旧排演表快照不受影响。']
  dialog.warning({
    title: `结束第 ${run.runSeq} 场现场`,
    content: () =>
      h(
        'div',
        { style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 8px' },
        lines.map((line, index) =>
          h(
            'p',
            {
              style: `margin: 0; line-height: 1.7;${index === 0 ? ' font-weight: 600;' : ''}${
                index === lines.length - 1 && pending.length > 0 ? ' color: rgba(255, 255, 255, 0.55); font-size: 12px;' : ''
              }`
            },
            line
          )
        )
      ),
    positiveText: pending.length > 0 ? '结束现场并带入下一场' : '结束现场',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await liveStore.endRun(run.id, pending.length > 0)
        message.success(pending.length > 0 ? `现场已结束，${pending.length} 条改动将带入下一场` : '现场已结束')
      } catch (error) {
        console.error('[gbcuesheet] 结束现场失败：', error)
        message.error('写入失败，已按日志检查点恢复')
      }
    }
  })
}

/* ---------------- 现场动作 ---------------- */

async function runAction(action: () => Promise<unknown>, failText: string): Promise<void> {
  try {
    await action()
  } catch (error) {
    console.error('[gbcuesheet] 现场动作写入失败：', error)
    message.error(`${failText}，已按日志检查点恢复到最后一次确认动作`)
  }
}

async function go(): Promise<void> {
  const run = activeRun.value
  if (!run) return
  await runAction(() => liveStore.go(run.id), 'GO 写入失败')
}

async function back(): Promise<void> {
  const run = activeRun.value
  if (!run) return
  await runAction(() => liveStore.back(run.id), '回退写入失败')
}

/* ---------------- 跳演 ---------------- */

const skipTarget = ref<number | null>(null)

const skipOptions = computed(() => {
  const run = activeRun.value
  if (!run) return []
  return run.cues
    .map((cue, index) => ({ cue, index }))
    .filter(({ index }) => index > run.cursor + 1)
    .map(({ cue, index }) => ({
      label: `#${index + 1} ${cue.cueNo}${cue.label ? `「${cue.label}」` : ''}`,
      value: index
    }))
})

async function skip(): Promise<void> {
  const run = activeRun.value
  if (!run || skipTarget.value === null) return
  const target = skipTarget.value
  await runAction(async () => {
    await liveStore.skipTo(run.id, target)
  }, '跳演写入失败')
  skipTarget.value = null
}

/* ---------------- 展示辅助 ---------------- */

const LOG_TAG_TYPE: Record<LiveLogType, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  open: 'info',
  go: 'success',
  skip: 'warning',
  back: 'info',
  edit: 'warning',
  conflict: 'error',
  carryover: 'success',
  end: 'default'
}

const LOG_TAG_TEXT: Record<LiveLogType, string> = {
  open: '开演',
  go: 'GO',
  skip: '跳演',
  back: '回退',
  edit: '待生效',
  conflict: '冲突',
  carryover: '带入',
  end: '结束'
}

function describePayload(entry: LiveLogEntry): string {
  // note 形如「编排台改动（下一场待生效）：更新 Q5」，弹窗里只列改动本体
  const index = entry.note.indexOf('：')
  return index >= 0 ? entry.note.slice(index + 1) : entry.note
}

/** 历史场次日志展开状态 */
const expandedRuns = ref<Record<string, boolean>>({})

function toggleRunLog(runId: string): void {
  expandedRuns.value = { ...expandedRuns.value, [runId]: !expandedRuns.value[runId] }
}

function runStatText(run: LiveRun): string {
  const stat = liveStore.statOf(run.id)
  const parts = [`GO ${stat.goCount} 次`]
  if (stat.skipCount > 0) parts.push(`跳演 ${stat.skipCount}`)
  if (stat.backCount > 0) parts.push(`回退 ${stat.backCount}`)
  if (stat.editCount > 0) parts.push(`待生效改动 ${stat.editCount}`)
  if (stat.conflictCount > 0) parts.push(`冲突 ${stat.conflictCount}`)
  return parts.join(' · ')
}

function goCues(): void {
  void router.push(`/sessions/${sessionId.value}/cues`)
}

function goFixtures(): void {
  void router.push(`/sessions/${sessionId.value}/fixtures`)
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">现场运行台</h1>
        <p class="page__subtitle">
          {{ session ? `${session.order}. ${session.title}` : '场次不存在或已删除' }} ·
          开演后顺序与电平固定，GO / 跳演 / 回退只记现场日志，编排台改动下一场才生效。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goFixtures">灯位通道</NButton>
        <NButton @click="goCues">Cue 编排</NButton>
        <NButton v-if="activeRun" type="error" ghost @click="confirmEnd">结束现场</NButton>
      </div>
    </header>

    <NAlert v-if="!session" type="warning" :bordered="false">
      该场次不存在，可能已被删除。请返回场次编排重新选择。
    </NAlert>

    <template v-else>
      <!-- 进行中现场 -->
      <template v-if="activeRun">
        <section class="panel live-status">
          <div class="live-status__head">
            <NTag type="success" :bordered="false">第 {{ activeRun.runSeq }} 场 · 进行中</NTag>
            <span class="mono live-status__progress">{{ progressText }}</span>
            <span class="muted">开演于 {{ formatDateTime(activeRun.startedAt) }}</span>
            <span v-if="pendingEdits.length > 0" class="live-status__pending">
              待生效改动 {{ pendingEdits.length }} 条（下一场生效）
            </span>
          </div>

          <div v-if="currentCue" class="live-current">
            <div class="live-current__head">
              <span class="live-current__no mono">{{ currentCue.cueNo }}</span>
              <span class="live-current__label">{{ currentCue.label || '（无提示语）' }}</span>
              <NTag size="small" :bordered="false">{{ currentCue.trigger }}</NTag>
            </div>
            <div class="live-current__fade">
              <FadeBar :fade-in-sec="currentCue.fadeInSec" :hold-sec="currentCue.holdSec" :fade-out-sec="currentCue.fadeOutSec" />
              <span class="mono muted">{{ formatTransition(currentCue) }}（合计 {{ formatSeconds(cueTotalSeconds(currentCue)) }}）</span>
            </div>
            <p v-if="currentCue.note" class="live-current__note">备注：{{ currentCue.note }}</p>
            <div v-if="currentCue.levels.length > 0" class="live-current__channels">
              <ChannelChip
                v-for="level in currentCue.levels"
                :key="level.fixtureId"
                :channel="level.channel"
                :position="level.position"
                :intensity="level.intensity"
                size="small"
              />
            </div>
            <p v-else class="empty-line">该 Cue 未设定通道电平</p>
          </div>

          <div v-else class="live-current live-current--idle">
            <p class="live-current__idle-text">
              尚未 GO。第一条：<span class="accent mono">{{ nextCue ? nextCue.cueNo : '—' }}</span>
              {{ nextCue?.label ? `「${nextCue.label}」` : '' }}
            </p>
          </div>

          <div class="live-controls">
            <NButton size="large" :disabled="activeRun.cursor <= 0 || liveStore.acting" @click="back">回退</NButton>
            <NButton
              size="large"
              type="primary"
              class="live-controls__go"
              :disabled="!nextCue || liveStore.acting"
              @click="go"
            >
              {{ nextCue ? `GO ▶ ${nextCue.cueNo}` : '已到最后一条' }}
            </NButton>
            <div class="live-controls__skip">
              <NSelect
                v-model:value="skipTarget"
                :options="skipOptions"
                placeholder="跳演到…"
                size="medium"
                style="width: 240px"
                :disabled="liveStore.acting"
              />
              <NButton size="large" :disabled="skipTarget === null || liveStore.acting" @click="skip">跳演</NButton>
            </div>
          </div>

          <NAlert v-if="conflicts.length > 0" type="error" :bordered="false" class="live-conflicts">
            <p class="live-conflicts__title">当前提示冲突（现场状态已保留，按开演快照继续执行）</p>
            <p v-for="conflict in conflicts" :key="conflict.key" class="live-conflicts__item">· {{ conflict.message }}</p>
          </NAlert>
        </section>

        <section v-if="pendingEdits.length > 0" class="panel">
          <h2 class="panel__title">待生效改动<span class="panel__title-tag">编排台已保存，下一场开演生效</span></h2>
          <ul class="log-list">
            <li v-for="entry in pendingEdits" :key="entry.id" class="log-list__row">
              <NTag size="small" type="warning" :bordered="false">待生效</NTag>
              <span class="log-list__note">{{ describePayload(entry) }}</span>
              <span class="log-list__time mono">{{ formatDateTime(entry.at) }}</span>
            </li>
          </ul>
        </section>

        <section class="panel">
          <h2 class="panel__title">现场日志<span class="panel__title-tag">只增不改 · 最后一条即检查点</span></h2>
          <ul class="log-list">
            <li v-for="entry in activeLogs" :key="entry.id" class="log-list__row">
              <NTag size="small" :type="LOG_TAG_TYPE[entry.type]" :bordered="false">{{ LOG_TAG_TEXT[entry.type] }}</NTag>
              <span class="log-list__note">{{ entry.note }}</span>
              <span class="log-list__time mono">#{{ entry.seq }} · {{ formatDateTime(entry.at) }}</span>
            </li>
          </ul>
        </section>
      </template>

      <!-- 未开演 -->
      <template v-else>
        <section class="panel open-panel">
          <h2 class="panel__title">开演<span class="panel__title-tag">固定本次顺序与电平</span></h2>
          <p class="muted open-panel__tip">
            开演会把当前 {{ consoleCueCount }} 条 Cue 的顺序与通道电平冻结为本场运行单；运行中 GO、跳演、回退只记现场日志，
            编排台继续改动不会影响本场，仅标记为下一场待生效。
          </p>
          <NButton type="primary" size="large" :disabled="consoleCueCount === 0" @click="openShow">
            开演（固定当前 {{ consoleCueCount }} 条 Cue）
          </NButton>
          <p v-if="consoleCueCount === 0" class="empty-line">本场还没有 Cue，请先到 Cue 编排时间轴插入提示点。</p>
        </section>

        <BlankHint
          v-if="pastRuns.length === 0"
          title="还没有历史现场"
          description="开演后这里会留存每一场的运行单与现场日志，便于复盘；重开窗口会回到最后一次确认动作。"
          tip="现场运行单与排演表互不影响，旧排演表快照保持不变。"
        />
      </template>

      <!-- 历史现场 -->
      <section v-if="pastRuns.length > 0" class="panel">
        <h2 class="panel__title">历史现场<span class="panel__title-tag">共 {{ pastRuns.length }} 场</span></h2>
        <div class="past-list">
          <article v-for="run in pastRuns" :key="run.id" class="past-run">
            <div class="past-run__head">
              <NTag size="small" :bordered="false">第 {{ run.runSeq }} 场</NTag>
              <span class="mono">{{ formatDateTime(run.startedAt) }} ~ {{ run.endedAt ? formatDateTime(run.endedAt) : '—' }}</span>
              <span class="muted">{{ runStatText(run) }}</span>
              <NButton size="tiny" quaternary @click="toggleRunLog(run.id)">
                {{ expandedRuns[run.id] ? '收起日志' : '查看日志' }}
              </NButton>
            </div>
            <ul v-if="expandedRuns[run.id]" class="log-list">
              <li v-for="entry in liveStore.logsOfRun(run.id)" :key="entry.id" class="log-list__row">
                <NTag size="small" :type="LOG_TAG_TYPE[entry.type]" :bordered="false">{{ LOG_TAG_TEXT[entry.type] }}</NTag>
                <span class="log-list__note">{{ entry.note }}</span>
                <span class="log-list__time mono">#{{ entry.seq }} · {{ formatDateTime(entry.at) }}</span>
              </li>
            </ul>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.live-status {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.live-status__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.live-status__progress {
  font-size: 15px;
  color: #f2b544;
  font-weight: 600;
}

.live-status__pending {
  font-size: 12px;
  color: #f2b544;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(242, 181, 68, 0.12);
  border: 1px solid rgba(242, 181, 68, 0.35);
}

.live-current {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 12px;
  background: rgba(242, 181, 68, 0.06);
  border: 1px solid rgba(242, 181, 68, 0.28);
}

.live-current--idle {
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(255, 255, 255, 0.08);
}

.live-current__idle-text {
  margin: 0;
  font-size: 14px;
}

.live-current__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.live-current__no {
  font-size: 22px;
  font-weight: 700;
  color: #f2b544;
}

.live-current__label {
  font-size: 16px;
  font-weight: 600;
}

.live-current__fade {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 640px;
}

.live-current__note {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.live-current__channels {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.live-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.live-controls__go {
  min-width: 220px;
  font-weight: 700;
}

.live-controls__skip {
  display: flex;
  align-items: center;
  gap: 8px;
}

.live-conflicts__title {
  margin: 0 0 6px;
  font-weight: 600;
}

.live-conflicts__item {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
}

.open-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}

.open-panel__tip {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
}

.log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log-list__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.log-list__note {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-list__time {
  flex: none;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
}

.past-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.past-run {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.past-run__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}
</style>
