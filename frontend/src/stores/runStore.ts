import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  LiveRun,
  RunActionType,
  RunConflict,
  RunCueSnapshot,
  RunChannelSnapshot,
  RunLogEntry
} from '@/types/run'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { sortCues } from '@/utils/cueOrder'

/** 现场动作的中文名，供日志展示 */
export const RUN_ACTION_LABELS: Record<RunActionType, string> = {
  start: '开演',
  go: 'GO',
  jump: '跳演',
  back: '回退',
  end: '结束'
}

/** 首个检查点都未建立成功时的写入失败（内存中没有可恢复的现场） */
export class WriteFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteFailedError'
  }
}

/**
 * 落库前剥离 Pinia 的响应式代理：快照嵌套数组 / 日志对象均来自 store 的 reactive state，
 * 直接 put 会被 IndexedDB 的结构化克隆拒绝（DataCloneError）。
 */
function toPlainRun(run: LiveRun): LiveRun {
  return JSON.parse(JSON.stringify(run)) as LiveRun
}

/** 动作入参：动作类型、目标位次（0 基）与幂等令牌 */
interface AppendActionInput {
  action: Exclude<RunActionType, 'start'>
  targetIndex: number
  idempotencyKey: string
  detail?: string
}

/** 动作提交结果 */
export interface RunActionResult {
  ok: boolean
  deduped: boolean
  run: LiveRun
}

/**
 * 现场运行仓库：运行单与编排台分离的核心。
 * - 开演时固定本次顺序与电平（cueSnapshots 快照）；
 * - GO / 跳演 / 回退只追加现场日志，不回写 Cue 与电平；
 * - 编排台改动经 pendingCueIds / pendingFixtureIds 标为下一场待生效；
 * - 每次确认动作整体落库作为日志检查点，写入失败即回滚到上一检查点。
 */
export const useRunStore = defineStore('run', () => {
  const runs = ref<LiveRun[]>([])
  const hydrated = ref(false)

  /**
   * 每个现场当前在途动作的 Promise；GO 连点（双击）的第二个同步调用直接复用先到者。
   * 先到者在 await 前同步推进内存并登记此槽，后到者不再基于推进后的位次重新计算（结果标记 deduped）；
   * 槽位在落库 settle 后释放。
   */
  const inFlightByRun = new Map<string, Promise<RunActionResult>>()

  /**
   * 每个现场的待生效标记串行队列：一次插入/批量偏移可能同时标记多条 Cue，
   * 并行落库会互相覆盖（后写的基于旧内存快照），因此按现场排队顺序合并落库。
   */
  const pendingWriteChain = new Map<string, Promise<void>>()

  /** 同步动作合并：该现场有动作在途时，重复调用复用先到者的 Promise */
  function coalesceAction(runId: string, persist: () => Promise<RunActionResult>): Promise<RunActionResult> {
    const pending = inFlightByRun.get(runId)
    if (pending) return pending.then((result) => ({ ...result, deduped: true }))
    const promise = persist()
    inFlightByRun.set(runId, promise)
    void promise.then(
      () => inFlightByRun.delete(runId),
      () => inFlightByRun.delete(runId)
    )
    return promise
  }
  /** 一场历次现场中最近的一条（按开始时间倒序） */
  function runOfSession(sessionId: string): LiveRun | null {
    const matched = runs.value.filter((run) => run.sessionId === sessionId)
    if (matched.length === 0) return null
    return matched.reduce((latest, run) => (run.startedAt > latest.startedAt ? run : latest))
  }

  /** 正在进行的现场（status === live）；编排台冻结标记只认进行中的现场 */
  function liveRunOfSession(sessionId: string): LiveRun | null {
    const run = runOfSession(sessionId)
    return run && run.status === 'live' ? run : null
  }

  const liveRunCount = computed(() => runs.value.filter((run) => run.status === 'live').length)

  function liveSessionIds(): string[] {
    return runs.value.filter((run) => run.status === 'live').map((run) => run.sessionId)
  }

  /** 开演时按当前编排顺序与电平构建单条 Cue 快照 */
  function buildCueSnapshot(cueId: string): RunCueSnapshot {
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    const cue = cueStore.cueById(cueId)
    const channels: RunChannelSnapshot[] = []
    if (cue) {
      levelStore.levelsOfCue(cueId).forEach((level) => {
        const fixture = fixtureStore.fixtureById(level.fixtureId)
        if (!fixture) return
        channels.push({
          fixtureId: level.fixtureId,
          channel: fixture.channel,
          intensity: level.intensity,
          colorTempK: level.colorTempK
        })
      })
      channels.sort((a, b) => a.channel - b.channel)
    }
    return {
      cueId,
      cueNo: cue?.cueNo ?? 'Q?',
      label: cue?.label ?? '',
      trigger: cue?.trigger ?? '手动',
      fadeInSec: cue?.fadeInSec ?? 0,
      fadeOutSec: cue?.fadeOutSec ?? 0,
      holdSec: cue?.holdSec ?? 0,
      note: cue?.note ?? '',
      channels
    }
  }

  /** 开演时固定全场快照（顺序以编排台当前 orderIndex 为准） */
  function buildSessionSnapshots(sessionId: string): RunCueSnapshot[] {
    const cueStore = useCueStore()
    return sortCues(cueStore.cuesOfSession(sessionId)).map((cue) => buildCueSnapshot(cue.id))
  }

  async function hydrate(): Promise<void> {
    runs.value = await db.runs.toArray()
    hydrated.value = true
  }

  /**
   * 把已确认的运行状态落库为日志检查点。
   * 调用方负责先把 next 同步写入内存（保证并发动作只确认一条）；
   * 成功：内存记录检查点；失败：内存回滚到上一检查点并保留错误信息。
   */
  async function commitRun(previous: LiveRun | null, next: LiveRun): Promise<LiveRun> {
    try {
      await db.runs.put(toPlainRun(next))
      const checked: LiveRun = { ...next, lastWriteError: null, checkpointAt: next.updatedAt }
      runs.value = [...runs.value.filter((run) => run.id !== checked.id), checked]
      return checked
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (previous) {
        // 写入失败：按日志检查点恢复内存现场，未确认的动作不保留
        const restored: LiveRun = {
          ...previous,
          lastWriteError: `写入失败，已按日志检查点恢复：${reason}`
        }
        runs.value = [...runs.value.filter((run) => run.id !== restored.id), restored]
      } else {
        // 现场尚无任何检查点（如开演首写失败）：从内存移除，等待重试
        runs.value = runs.value.filter((run) => run.id !== next.id)
        throw new WriteFailedError(`写入失败，现场未能建立检查点：${reason}`)
      }
      throw error
    }
  }

  /** 开演：固定本次顺序与电平，并写入第一条现场日志 */
  async function startRun(sessionId: string): Promise<LiveRun | null> {
    const existing = liveRunOfSession(sessionId)
    if (existing) return existing
    const snapshots = buildSessionSnapshots(sessionId)
    if (snapshots.length === 0) return null

    const now = Date.now()
    const firstLog: RunLogEntry = {
      seq: 1,
      action: 'start',
      at: now,
      cueIndex: -1,
      cueId: null,
      cueNo: null,
      label: null,
      detail: `开演固定 ${snapshots.length} 条 Cue 的顺序与电平`,
      idempotencyKey: 'start'
    }
    const run: LiveRun = {
      id: createId('run'),
      sessionId,
      status: 'live',
      startedAt: now,
      endedAt: null,
      cueSnapshots: snapshots,
      logs: [firstLog],
      currentIndex: -1,
      lastIdempotencyKey: 'start',
      checkpointAt: null,
      lastWriteError: null,
      pendingCueIds: [],
      pendingFixtureIds: [],
      appliedAt: null,
      updatedAt: now
    }
    // 先同步写入内存（尚无历史检查点），再落库；失败由 commitRun 移除
    runs.value = [...runs.value, run]
    await commitRun(null, run)
    return run
  }

  /** 当前快照条目（位次越界或未推进时为 null） */
  function currentSnapshot(run: LiveRun): RunCueSnapshot | null {
    if (run.currentIndex < 0 || run.currentIndex >= run.cueSnapshots.length) return null
    return run.cueSnapshots[run.currentIndex]
  }

  /**
   * 同步确认一条现场日志动作并开始落库。
   * - 在 await 之前同步推进内存现场，保证连续动作读到最新位次；
   * - 幂等令牌含「上一条日志序号」：回退后再 GO 等同一位次属于新动作，重开窗口重发才去重。
   */
  function confirmAction(sessionId: string, input: AppendActionInput): Promise<RunActionResult> {
    const run = liveRunOfSession(sessionId)
    if (!run) return Promise.reject(new Error('现场尚未开演或已结束'))
    const prevSeq = run.logs.length
    const idempotencyKey = `${input.idempotencyKey}@${prevSeq}`
    if (idempotencyKey === run.lastIdempotencyKey) {
      return Promise.resolve({ ok: true, deduped: true, run })
    }
    const target = run.cueSnapshots[input.targetIndex]
    if (!target) return Promise.reject(new Error('目标提示不在本次运行单内'))

    const now = Date.now()
    const entry: RunLogEntry = {
      seq: run.logs.length + 1,
      action: input.action,
      at: now,
      cueIndex: input.targetIndex,
      cueId: target.cueId,
      cueNo: target.cueNo,
      label: target.label,
      detail: input.detail ?? '',
      idempotencyKey
    }
    const confirmed: LiveRun = {
      ...run,
      logs: [...run.logs, entry],
      currentIndex: input.targetIndex,
      lastIdempotencyKey: idempotencyKey,
      updatedAt: now
    }
    // 同步确认：立刻更新内存，后续同步调用（含连点）读到的是推进后的现场
    runs.value = [...runs.value.filter((item) => item.id !== confirmed.id), confirmed]
    return commitRun(run, confirmed).then((checked) => ({ ok: true as const, deduped: false as const, run: checked }))
  }

  /** GO：推进到下一条；同一 GO 在途时连点合并为一条 */
  function go(sessionId: string): Promise<RunActionResult> {
    const run = liveRunOfSession(sessionId)
    if (!run) return Promise.reject(new Error('现场尚未开演或已结束'))
    return coalesceAction(run.id, () => {
      const current = liveRunOfSession(sessionId)
      if (!current) throw new Error('现场尚未开演或已结束')
      const targetIndex = current.currentIndex + 1
      if (targetIndex >= current.cueSnapshots.length) throw new Error('已是最后一条 Cue')
      return confirmAction(sessionId, {
        action: 'go',
        targetIndex,
        idempotencyKey: `go:${current.currentIndex}->${targetIndex}`
      })
    })
  }

  /** 回退到上一条（只记现场日志） */
  function back(sessionId: string): Promise<RunActionResult> {
    const run = liveRunOfSession(sessionId)
    if (!run) return Promise.reject(new Error('现场尚未开演或已结束'))
    return coalesceAction(run.id, () => {
      const current = liveRunOfSession(sessionId)
      if (!current) throw new Error('现场尚未开演或已结束')
      const targetIndex = current.currentIndex - 1
      if (targetIndex < 0) throw new Error('已经是第一条，无法回退')
      return confirmAction(sessionId, {
        action: 'back',
        targetIndex,
        idempotencyKey: `back:${current.currentIndex}->${targetIndex}`,
        detail: '回退至上一条'
      })
    })
  }

  /** 跳演到指定位次的 Cue（只记现场日志）；在途时连点合并 */
  function jumpTo(sessionId: string, targetIndex: number): Promise<RunActionResult> {
    const run = liveRunOfSession(sessionId)
    if (!run) return Promise.reject(new Error('现场尚未开演或已结束'))
    return coalesceAction(run.id, () => {
      const current = liveRunOfSession(sessionId)
      if (!current) throw new Error('现场尚未开演或已结束')
      if (targetIndex < 0 || targetIndex >= current.cueSnapshots.length) throw new Error('目标提示不在本次运行单内')
      if (targetIndex === current.currentIndex) return Promise.resolve({ ok: true as const, deduped: true as const, run: current })
      const target = current.cueSnapshots[targetIndex]
      return confirmAction(sessionId, {
        action: 'jump',
        targetIndex,
        idempotencyKey: `jump:${current.currentIndex}->${targetIndex}`,
        detail: `跳演至 ${target.cueNo}`
      })
    })
  }

  /** 结束现场：记一条结束日志，此后 GO/回退/跳演不再可用 */
  async function endRun(sessionId: string): Promise<LiveRun> {
    const run = liveRunOfSession(sessionId)
    if (!run) throw new Error('现场尚未开演或已结束')
    const current = currentSnapshot(run)
    const now = Date.now()
    const entry: RunLogEntry = {
      seq: run.logs.length + 1,
      action: 'end',
      at: now,
      cueIndex: run.currentIndex,
      cueId: current?.cueId ?? null,
      cueNo: current?.cueNo ?? null,
      label: current?.label ?? null,
      detail: '现场结束，待生效改动尚未带入下一场',
      idempotencyKey: `end:${run.logs.length + 1}`
    }
    const next: LiveRun = {
      ...run,
      status: 'ended',
      endedAt: now,
      logs: [...run.logs, entry],
      updatedAt: now
    }
    // 同步确认：双击结束时第二次调用看到的已是 ended，不会重复记日志
    runs.value = [...runs.value.filter((item) => item.id !== next.id), next]
    return commitRun(run, next)
  }

  /**
   * 结束现场后确认：待生效改动本就落在编排数据里（开演后编辑从未触碰运行单），
   * 这里一次性清掉待生效标记并关闭本次现场；旧排演表快照不参与、不变动。
   */
  async function applyPendingToNextShow(sessionId: string): Promise<LiveRun | null> {
    const run = runOfSession(sessionId)
    if (!run || run.status !== 'ended' || run.appliedAt) return null
    const next: LiveRun = {
      ...run,
      pendingCueIds: [],
      pendingFixtureIds: [],
      appliedAt: Date.now(),
      updatedAt: Date.now()
    }
    // 同步确认：双击确认时第二次直接走 appliedAt 守卫，不会重复处理
    runs.value = [...runs.value.filter((item) => item.id !== next.id), next]
    return commitRun(run, next)
  }

  /**
   * 把一批 Cue 标记为下一场待生效（仅现场进行中）。
   * 同步合并内存并串行落库，避免批量操作时多个标记互相覆盖。
   */
  function markCuesPending(sessionId: string, cueIds: Iterable<string>): Promise<void> {
    const run = liveRunOfSession(sessionId)
    if (!run) return Promise.resolve()
    const merged = [...new Set([...run.pendingCueIds, ...cueIds])]
    if (merged.length === run.pendingCueIds.length) return Promise.resolve()
    const next: LiveRun = { ...run, pendingCueIds: merged, updatedAt: Date.now() }
    runs.value = [...runs.value.filter((item) => item.id !== next.id), next]
    return enqueuePendingWrite(run.id)
  }

  /** 标记某条 Cue 的编排台改动为下一场待生效（仅现场进行中记录） */
  function markCuePending(sessionId: string, cueId: string): Promise<void> {
    return markCuesPending(sessionId, [cueId])
  }

  /** Cue 所属场次由仓库反查，电平编辑保存时调用 */
  async function markCueChanged(cueId: string): Promise<void> {
    const cueStore = useCueStore()
    const cue = cueStore.cueById(cueId)
    if (cue) await markCuesPending(cue.sessionId, [cueId])
  }

  /**
   * 把一批灯位通道标记为下一场待生效（仅现场进行中），串行落库。
   */
  function markFixturesPending(sessionId: string, fixtureIds: Iterable<string>): Promise<void> {
    const run = liveRunOfSession(sessionId)
    if (!run) return Promise.resolve()
    const merged = [...new Set([...run.pendingFixtureIds, ...fixtureIds])]
    if (merged.length === run.pendingFixtureIds.length) return Promise.resolve()
    const next: LiveRun = { ...run, pendingFixtureIds: merged, updatedAt: Date.now() }
    runs.value = [...runs.value.filter((item) => item.id !== next.id), next]
    return enqueuePendingWrite(run.id)
  }

  /** 标记灯位通道改动为下一场待生效 */
  function markFixturePending(sessionId: string, fixtureId: string): Promise<void> {
    return markFixturesPending(sessionId, [fixtureId])
  }

  /** 按现场串行排队落库：始终写当前内存的最新现场，失败不阻断编排台保存 */
  function enqueuePendingWrite(runId: string): Promise<void> {
    const previousChain = pendingWriteChain.get(runId) ?? Promise.resolve()
    const chain = previousChain.then(async () => {
      const current = runs.value.find((item) => item.id === runId) ?? null
      if (!current) return
      try {
        await db.runs.put(toPlainRun(current))
        const checked: LiveRun = { ...current, lastWriteError: null, checkpointAt: current.updatedAt }
        runs.value = [...runs.value.filter((item) => item.id !== runId), checked]
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const latest = runs.value.find((item) => item.id === runId)
        if (latest) {
          const marked: LiveRun = { ...latest, lastWriteError: `待生效标记写入失败：${reason}` }
          runs.value = [...runs.value.filter((item) => item.id !== runId), marked]
        }
      }
    })
    pendingWriteChain.set(runId, chain)
    void chain.finally(() => {
      if (pendingWriteChain.get(runId) === chain) pendingWriteChain.delete(runId)
    })
    return chain
  }

  function isCuePending(sessionId: string, cueId: string): boolean {
    return runOfSession(sessionId)?.pendingCueIds.includes(cueId) ?? false
  }

  function isFixturePending(sessionId: string, fixtureId: string): boolean {
    return runOfSession(sessionId)?.pendingFixtureIds.includes(fixtureId) ?? false
  }

  /**
   * 现场冲突：当前提示在编排台被删，或其快照通道在灯位台失效（删除 / 改通道号）。
   * 现场一律保留开演快照状态，只把冲突列出。
   */
  function conflictsOf(run: LiveRun): RunConflict[] {
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const current = currentSnapshot(run)
    if (!current) return []

    const conflicts: RunConflict[] = []
    const liveCue = cueStore.cueById(current.cueId)
    if (!liveCue) {
      conflicts.push({
        kind: 'cue-deleted',
        cueId: current.cueId,
        cueNo: current.cueNo,
        message: `当前提示 ${current.cueNo} 已在编排台删除，现场保留开演时状态（${current.label || '无提示语'}）`
      })
    }
    current.channels.forEach((snap) => {
      const fixture = fixtureStore.fixtureById(snap.fixtureId)
      if (!fixture) {
        conflicts.push({
          kind: 'fixture-invalid',
          cueId: current.cueId,
          cueNo: current.cueNo,
          fixtureId: snap.fixtureId,
          channel: snap.channel,
          message: `当前提示的 CH${snap.channel} 对应灯位通道已删除，现场保持快照电平 ${snap.intensity}%`
        })
      } else if (fixture.channel !== snap.channel) {
        conflicts.push({
          kind: 'fixture-invalid',
          cueId: current.cueId,
          cueNo: current.cueNo,
          fixtureId: snap.fixtureId,
          channel: snap.channel,
          message: `CH${snap.channel} 已在灯位台改配为 CH${fixture.channel}，本场仍按 CH${snap.channel} 输出`
        })
      }
    })
    return conflicts
  }

  /** 手动按日志检查点恢复：丢弃未落库的内存动作，重读最后一次确认状态 */
  async function restoreFromCheckpoint(sessionId: string): Promise<LiveRun | null> {
    const persisted = await db.runs.where('sessionId').equals(sessionId).sortBy('startedAt')
    const latest = persisted.length > 0 ? persisted[persisted.length - 1] : null
    if (!latest) {
      const memoryIds = new Set(runs.value.filter((run) => run.sessionId === sessionId).map((run) => run.id))
      runs.value = runs.value.filter((run) => !memoryIds.has(run.id))
      return null
    }
    runs.value = [...runs.value.filter((run) => run.id !== latest.id), latest]
    return latest
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const removing = runs.value.filter((run) => run.sessionId === sessionId)
    if (removing.length === 0) return
    const ids = new Set(removing.map((run) => run.id))
    await db.runs.bulkDelete([...ids])
    runs.value = runs.value.filter((run) => !ids.has(run.id))
  }

  return {
    runs,
    hydrated,
    liveRunCount,
    runOfSession,
    liveRunOfSession,
    liveSessionIds,
    currentSnapshot,
    hydrate,
    startRun,
    go,
    back,
    jumpTo,
    endRun,
    applyPendingToNextShow,
    markCuesPending,
    markCuePending,
    markCueChanged,
    markFixturesPending,
    markFixturePending,
    isCuePending,
    isFixturePending,
    conflictsOf,
    restoreFromCheckpoint,
    removeBySession
  }
})
