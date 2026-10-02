<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import ChannelChip from '@/components/common/ChannelChip.vue'
import FadeBar from '@/components/common/FadeBar.vue'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useRunStore, RUN_ACTION_LABELS } from '@/stores/runStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { RunCueSnapshot } from '@/types/run'
import { cueTotalSeconds, formatDateTime, formatSeconds, formatTransition } from '@/utils/fade'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const fixtureStore = useFixtureStore()
const runStore = useRunStore()

const sessionId = computed(() => String(route.params.id ?? ''))
const session = computed(() => sessionStore.sessionById(sessionId.value))

/** 现场状态：直接订阅 store 的 runs，开演 / GO 后视图即时刷新 */
const run = computed(() => runStore.runOfSession(sessionId.value))
const isLive = computed(() => run.value?.status === 'live')
const isEnded = computed(() => run.value?.status === 'ended')
const applied = computed(() => run.value?.appliedAt !== null && run.value?.appliedAt !== undefined)

const current = computed(() => (run.value ? runStore.currentSnapshot(run.value) : null))
const conflicts = computed(() => (run.value ? runStore.conflictsOf(run.value) : []))

const orderedCueCount = computed(() => cueStore.sortedCuesOfSession(sessionId.value).length)
const fixtureCount = computed(() => fixtureStore.fixturesOfSession(sessionId.value).length)
const pendingCueCount = computed(() => run.value?.pendingCueIds.length ?? 0)
const pendingFixtureCount = computed(() => run.value?.pendingFixtureIds.length ?? 0)

const progressText = computed(() => {
  if (!run.value) return ''
  const total = run.value.cueSnapshots.length
  return run.value.currentIndex < 0 ? `未推进（共 ${total} 条）` : `第 ${run.value.currentIndex + 1} / ${total} 条`
})

const reversedLogs = computed(() => (run.value ? [...run.value.logs].reverse() : []))

/** 跳演下拉：固定的开演快照顺序，不读编排台 */
const jumpOptions = computed(() =>
  (run.value?.cueSnapshots ?? []).map((snap, index) => ({
    label: `${index + 1}. ${snap.cueNo}${snap.label ? ` ${snap.label}` : ''}`,
    value: index
  }))
)
const jumpTarget = ref<number | null>(null)

function isCurrent(index: number): boolean {
  return run.value?.currentIndex === index
}

function snapshotPending(snap: RunCueSnapshot): boolean {
  return run.value?.pendingCueIds.includes(snap.cueId) ?? false
}

function positionOf(fixtureId: string) {
  return fixtureStore.fixtureById(fixtureId)?.position ?? null
}

function goCues(): void {
  void router.push(`/sessions/${sessionId.value}/cues`)
}

async function start(): Promise<void> {
  try {
    const created = await runStore.startRun(sessionId.value)
    if (!created) {
      message.warning('本场还没有 Cue，无法开演')
      return
    }
    message.success(`已开演，固定 ${created.cueSnapshots.length} 条 Cue 的顺序与电平`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '开演失败')
  }
}

async function goNext(): Promise<void> {
  try {
    const result = await runStore.go(sessionId.value)
    if (result.deduped) message.info('该 GO 已确认，不重复记录')
    else message.success(`GO → ${result.run.cueSnapshots[result.run.currentIndex]?.cueNo ?? ''}`)
  } catch (error) {
    message.warning(error instanceof Error ? error.message : 'GO 失败')
  }
}

async function back(): Promise<void> {
  try {
    const result = await runStore.back(sessionId.value)
    if (result.deduped) message.info('该回退已确认，不重复记录')
    else message.success(`已回退至 ${result.run.cueSnapshots[result.run.currentIndex]?.cueNo ?? ''}`)
  } catch (error) {
    message.warning(error instanceof Error ? error.message : '回退失败')
  }
}

async function jump(): Promise<void> {
  if (jumpTarget.value === null) {
    message.warning('请先选择要跳演的 Cue')
    return
  }
  const target = jumpTarget.value
  try {
    const result = await runStore.jumpTo(sessionId.value, target)
    if (result.deduped) message.info('该跳演已确认，不重复记录')
    else message.success(`已跳演至 ${runStore.currentSnapshot(result.run)?.cueNo ?? ''}`)
  } catch (error) {
    message.warning(error instanceof Error ? error.message : '跳演失败')
  } finally {
    jumpTarget.value = null
  }
}

function confirmEnd(): void {
  dialog.warning({
    title: '结束现场',
    content: '结束后 GO / 跳演 / 回退将不可再用；编排台的待生效改动需在下一场确认带入。',
    positiveText: '确认结束',
    negativeText: '继续运行',
    onPositiveClick: async () => {
      try {
        await runStore.endRun(sessionId.value)
        message.success('现场已结束')
      } catch (error) {
        message.error(error instanceof Error ? error.message : '结束失败')
      }
    }
  })
}

async function restoreCheckpoint(): Promise<void> {
  const restored = await runStore.restoreFromCheckpoint(sessionId.value)
  if (restored) message.success(`已恢复到最后一次确认动作（${RUN_ACTION_LABELS[restored.logs[restored.logs.length - 1]?.action ?? 'go']}）`)
  else message.info('没有找到已确认的现场检查点')
}

async function applyPending(): Promise<void> {
  const updated = await runStore.applyPendingToNextShow(sessionId.value)
  if (updated) {
    message.success('已确认：待生效改动一次带入下一场；旧排演表快照保持不动')
  }
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">现场运行单</h1>
        <p class="page__subtitle">
          {{ session ? `${session.order}. ${session.title}` : '场次不存在或已删除' }} ·
          开演后顺序与电平固定，GO / 跳演 / 回退只记现场日志；编排台改动标为下一场待生效。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goCues">返回 Cue 编排台</NButton>
      </div>
    </header>

    <NAlert v-if="!session" type="warning" :bordered="false">
      该场次不存在，可能已被删除。请返回场次编排重新选择。
    </NAlert>

    <template v-else-if="!run">
      <section class="panel">
        <h2 class="panel__title">开演前检查<span class="panel__title-tag">运行单与编排台分离</span></h2>
        <div class="stat-row">
          <div class="stat">
            <span class="stat__value mono">{{ orderedCueCount }}</span>
            <span class="stat__label">本次将固定的 Cue</span>
          </div>
          <div class="stat">
            <span class="stat__value mono">{{ fixtureCount }}</span>
            <span class="stat__label">灯位通道</span>
          </div>
        </div>
        <p class="idle-tip">
          点击「开演」会把当前编排台的顺序、过渡时间与全部通道电平冻结为本次现场快照；
          之后在另一个窗口或编排台的修改不会影响本场，只标记为下一场待生效。
        </p>
        <NButton type="primary" size="large" :disabled="orderedCueCount === 0" @click="start">开演并固定本次顺序与电平</NButton>
        <p v-if="orderedCueCount === 0" class="empty-line">本场还没有 Cue，请先到 Cue 编排台插入。</p>
      </section>
    </template>

    <template v-else>
      <!-- 写入失败：按日志检查点恢复 -->
      <NAlert v-if="run.lastWriteError" type="error" :bordered="false" class="live-alert">
        <div class="error-row">
          <span>{{ run.lastWriteError }}</span>
          <NButton size="small" type="error" ghost @click="restoreCheckpoint">按日志检查点恢复</NButton>
        </div>
      </NAlert>

      <!-- 当前提示与编排台的冲突：保留现场状态，列出冲突 -->
      <NAlert
        v-for="conflict in conflicts"
        :key="`${conflict.kind}-${conflict.fixtureId ?? conflict.cueId}`"
        type="warning"
        :bordered="false"
        class="live-alert"
      >
        {{ conflict.message }}
      </NAlert>

      <!-- 待生效改动提示 -->
      <NAlert
        v-if="isLive && (pendingCueCount > 0 || pendingFixtureCount > 0)"
        type="info"
        :bordered="false"
        class="live-alert"
      >
        编排台已有改动：{{ pendingCueCount }} 条 Cue、{{ pendingFixtureCount }} 个灯位通道标记为
        <strong>下一场待生效</strong>，本场运行单保持开演时状态。
      </NAlert>

      <!-- 结束后确认带入下一场 -->
      <NAlert v-if="isEnded" :type="applied ? 'success' : 'warning'" :bordered="false" class="live-alert">
        <div class="end-row">
          <span>
            现场已于 {{ formatDateTime(run.endedAt ?? '') }} 结束。
            <template v-if="applied">待生效改动已确认带入下一场，旧排演表快照未变动。</template>
            <template v-else>
              待生效：{{ pendingCueCount }} 条 Cue、{{ pendingFixtureCount }} 个灯位通道。确认后一次带入下一场；
              已导出的旧排演表快照不动。
            </template>
          </span>
          <NButton v-if="!applied" size="small" type="warning" ghost @click="applyPending">确认带入下一场</NButton>
        </div>
      </NAlert>

      <section class="panel">
        <div class="live-head">
          <div class="live-head__main">
            <div class="live-head__tags">
              <NTag :type="isLive ? 'success' : applied ? 'default' : 'warning'" size="small" round>
                {{ isLive ? '现场进行中' : applied ? '已带入下一场' : '现场已结束' }}
              </NTag>
              <span class="live-head__progress mono">{{ progressText }}</span>
            </div>
            <h2 class="current-title">
              <template v-if="current">{{ current.cueNo }} {{ current.label || '（无提示语）' }}</template>
              <template v-else>尚未 GO · 等待第一条提示</template>
            </h2>
            <p v-if="current" class="current-transition mono">{{ formatTransition(current) }}</p>
          </div>
          <div class="live-controls" :class="{ 'live-controls--locked': !isLive }">
            <NButton size="large" type="primary" :disabled="!isLive || run.currentIndex + 1 >= run.cueSnapshots.length" @click="goNext">
              GO
            </NButton>
            <NButton :disabled="!isLive || run.currentIndex <= 0" @click="back">回退</NButton>
            <div class="live-controls__jump">
              <NSelect
                v-model:value="jumpTarget"
                :options="jumpOptions"
                size="small"
                placeholder="跳演到…"
                :disabled="!isLive"
                style="width: 220px"
              />
              <NButton size="small" :disabled="!isLive" @click="jump">跳演</NButton>
            </div>
            <NButton type="error" ghost :disabled="!isLive" @click="confirmEnd">结束现场</NButton>
          </div>
        </div>

        <div v-if="current" class="current-body">
          <div v-if="current.channels.length > 0" class="current-channels">
            <ChannelChip
              v-for="channel in current.channels"
              :key="channel.fixtureId"
              :channel="channel.channel"
              :position="positionOf(channel.fixtureId)"
              :intensity="channel.intensity"
              size="small"
            />
          </div>
          <span v-else class="empty-line">该提示开演快照中未记录通道电平</span>
          <FadeBar
            :fade-in-sec="current.fadeInSec"
            :hold-sec="current.holdSec"
            :fade-out-sec="current.fadeOutSec"
            :height="14"
            compact
          />
          <span class="current-total mono">{{ formatSeconds(cueTotalSeconds(current)) }}</span>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel__title">
          本次运行单（开演固定）
          <span class="panel__title-tag">开演于 {{ formatDateTime(run.startedAt) }} · 共 {{ run.cueSnapshots.length }} 条</span>
        </h2>
        <div class="run-list">
          <article
            v-for="(snap, index) in run.cueSnapshots"
            :key="snap.cueId"
            class="run-row"
            :class="{ 'run-row--current': isCurrent(index) }"
          >
            <span class="run-row__index mono">{{ index + 1 }}</span>
            <span class="run-row__no mono">{{ snap.cueNo }}</span>
            <span class="run-row__label">{{ snap.label || '（无提示语）' }}</span>
            <span class="run-row__channels mono">{{ snap.channels.length }} 通道</span>
            <span class="run-row__total mono">{{ formatSeconds(cueTotalSeconds(snap)) }}</span>
            <NTag v-if="snapshotPending(snap)" size="tiny" type="warning">下一场待生效</NTag>
            <NTag v-else-if="isCurrent(index)" size="tiny" type="success">当前提示</NTag>
          </article>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel__title">
          现场日志
          <span class="panel__title-tag">仅记录运行动作 · {{ run.logs.length }} 条</span>
        </h2>
        <ol class="log-list">
          <li v-for="log in reversedLogs" :key="log.seq" class="log-row">
            <span class="log-row__seq mono">#{{ log.seq }}</span>
            <span class="log-row__action" :class="`log-row__action--${log.action}`">{{ RUN_ACTION_LABELS[log.action] }}</span>
            <span class="log-row__cue mono">{{ log.cueNo ?? '—' }}</span>
            <span class="log-row__detail">{{ log.detail || log.label || '' }}</span>
            <span class="log-row__time mono">{{ formatDateTime(log.at) }}</span>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>

<style scoped>
.idle-tip {
  margin: 12px 0 16px;
  max-width: 760px;
  font-size: 13px;
  line-height: 1.8;
  color: rgba(255, 255, 255, 0.5);
}

.live-alert {
  margin-bottom: 2px;
}

.error-row,
.end-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.live-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.live-head__tags {
  display: flex;
  align-items: center;
  gap: 10px;
}

.live-head__progress {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.current-title {
  margin: 10px 0 4px;
  font-size: 22px;
  font-weight: 600;
  color: #f2b544;
}

.current-transition {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.live-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.live-controls--locked {
  opacity: 0.72;
}

.live-controls__jump {
  display: flex;
  align-items: center;
  gap: 6px;
}

.current-body {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.current-channels {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1 1 100%;
}

.current-total {
  font-size: 13px;
  color: #f2b544;
}

.run-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.run-row--current {
  border-color: rgba(63, 191, 159, 0.6);
  background: rgba(63, 191, 159, 0.08);
}

.run-row__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.run-row--current .run-row__index {
  background: rgba(63, 191, 159, 0.2);
  color: #3fbf9f;
}

.run-row__no {
  width: 72px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
}

.run-row__label {
  flex: 1;
  min-width: 120px;
  font-size: 13px;
}

.run-row__channels,
.run-row__total {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  font-size: 12.5px;
}

.log-row__seq {
  width: 42px;
  color: rgba(255, 255, 255, 0.35);
}

.log-row__action {
  width: 42px;
  font-weight: 600;
}

.log-row__action--go {
  color: #3fbf9f;
}

.log-row__action--jump {
  color: #f2b544;
}

.log-row__action--back {
  color: #7c9ef0;
}

.log-row__action--start {
  color: #4ea1f2;
}

.log-row__action--end {
  color: #ff9a9a;
}

.log-row__cue {
  width: 72px;
  color: rgba(255, 255, 255, 0.8);
}

.log-row__detail {
  flex: 1;
  min-width: 120px;
  color: rgba(255, 255, 255, 0.55);
}

.log-row__time {
  color: rgba(255, 255, 255, 0.35);
}
</style>
