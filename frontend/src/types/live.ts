import type { CueTrigger } from '@/types/cue'
import type { FixturePosition } from '@/types/fixture'

/** 现场运行单状态：进行中 / 已结束 */
export const LIVE_RUN_STATUSES = ['running', 'ended'] as const
export type LiveRunStatus = (typeof LIVE_RUN_STATUSES)[number]

/** 开演时冻结的通道电平（通道号与灯位一并快照，编排台改号不影响现场） */
export interface LiveLevelSnapshot {
  /** 来源灯位通道，编排台删除后仅作追溯 */
  fixtureId: string
  channel: number
  position: FixturePosition
  intensity: number
  colorTempK: number
}

/** 开演时冻结的 Cue 条目：本次顺序与电平以快照为准 */
export interface LiveCueSnapshot {
  /** 来源 Cue，编排台删除后仅作追溯 */
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  fadeOutSec: number
  holdSec: number
  note: string
  /** 该 Cue 的通道电平快照，按通道号升序 */
  levels: LiveLevelSnapshot[]
}

/**
 * 现场运行单（LiveRun）：一次开演的独立执行单元。
 * 与 Cue 编排台完全分离：开演时冻结顺序与电平，运行中只追加现场日志。
 */
export interface LiveRun {
  /** 主键 */
  id: string
  /** 所属场次 */
  sessionId: string
  /** 第几场（该场次内从 1 开始） */
  runSeq: number
  status: LiveRunStatus
  /** 开演快照 */
  cues: LiveCueSnapshot[]
  /** 当前提示在快照中的位次，-1 表示尚未 GO */
  cursor: number
  /** 已落库的最后一条日志序号 */
  lastSeq: number
  /** 检查点：光标状态已确认到的日志序号，恢复时从其后回放 */
  checkpointSeq: number
  startedAt: number
  endedAt: number | null
}

/** 现场日志条目类型 */
export const LIVE_LOG_TYPES = ['open', 'go', 'skip', 'back', 'edit', 'conflict', 'carryover', 'end'] as const
export type LiveLogType = (typeof LIVE_LOG_TYPES)[number]

/** 编排台改动类别（运行中只标记，下一场开演才生效） */
export const LIVE_EDIT_KINDS = [
  'cue-add',
  'cue-update',
  'cue-remove',
  'cue-reorder',
  'level-upsert',
  'level-remove',
  'fixture-add',
  'fixture-update',
  'fixture-remove'
] as const
export type LiveEditKind = (typeof LIVE_EDIT_KINDS)[number]

/** 编排台改动标记：调用方带上编号 / 通道号快照，删除后日志仍可读 */
export interface LiveEditPayload {
  kind: LiveEditKind
  cueId?: string
  cueNo?: string
  fixtureId?: string
  channel?: number
  /** 补充说明，例如「批量偏移 +0.5s」 */
  detail?: string
}

/**
 * 现场日志条目：只增不改，是现场状态的唯一事实来源。
 * go / skip / back 记录执行后的光标位次，最后一条即检查点。
 */
export interface LiveLogEntry {
  /** 主键 */
  id: string
  /** 所属运行单 */
  runId: string
  /** 运行单内单调递增序号，从 1 开始 */
  seq: number
  type: LiveLogType
  /** 幂等键：同一动作重试 / 重复 GO 不重复记录 */
  actionId: string
  /** go / skip / back 执行后的光标位次，其余类型为 null */
  cursorAfter: number | null
  /** 执行前的光标位次 */
  cursorBefore: number | null
  /** 目标快照位次 */
  targetIndex: number | null
  /** 目标 Cue 编号快照 */
  targetCueNo: string
  /** edit 条目的改动内容 */
  edit: LiveEditPayload | null
  /** conflict 条目的冲突键，用于去重 */
  conflictKey: string
  /** 展示文本（落库时生成，之后不随编排台改动） */
  note: string
  at: number
}

/** 现场冲突类别 */
export type LiveConflictKind = 'cue-removed' | 'channel-missing' | 'channel-renumbered'

/** 当前提示维度的现场冲突：保留现场状态，仅列出提示 */
export interface LiveConflict {
  /** 稳定键，用于日志去重 */
  key: string
  kind: LiveConflictKind
  message: string
}
