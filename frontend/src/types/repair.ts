/**
 * 送修 / 修复单（RepairOrder）数据模型
 * 一条记录贯穿拓本送修排期的全流程：
 * pending 待排（编目室台账送出，尚未排上工位）
 * scheduled 已排（已落修复单，分配工位与排期，在修中，不可被后来者挤下）
 * done 已完成（修复室归还）
 * returned 退回（修复室点头，把上了修复单的拓本退回编目室）
 * withdrawn 撤回（编目员对没排上的拓本自行撤回）
 */

/** 修复单状态 */
export type RepairStatus = 'pending' | 'scheduled' | 'done' | 'returned' | 'withdrawn';

export interface RepairOrder {
  id: string;
  /** 送修拓本 id */
  rubbingId: string;
  /** 所属碑刻 id（冗余，便于按碑筛选与台账回显） */
  steleId: string;
  /** 送修时登记的损泐字位条数（排期优先级快照） */
  lossCount: number;
  /** 送修时登记的损泐权重合计（重 3 / 中 2 / 轻 1，越大越重，优先排） */
  lossWeight: number;
  /** 送修时的版本序号（版次早的优先，数值小者优先） */
  versionNo: number;
  /** 送修人（编目员） */
  submitter: string;
  /** 送修日期 yyyy-MM-dd */
  submitDate: string;
  /** 状态 */
  status: RepairStatus;
  /** 排上的工位 id（pending 时为空；落修复单后回填） */
  workbenchId: string;
  /** 排期日期 yyyy-MM-dd（落修复单时确定） */
  scheduleDate: string;
  /** 排队序号（同批排期内的先后，1 起） */
  queueNo: number;
  /** 修复室处理人（落单 / 退回 / 完成时登记） */
  restorer: string;
  /** 修复备注 */
  repairNote: string;
  /** 排期尝试批次号；排期中途失败时用于区分「已排留着 / 未排留待排」 */
  batchNo: number;
  createdAt: number;
  updatedAt: number;
}

export type RepairDraft = Pick<
  RepairOrder,
  'rubbingId' | 'steleId' | 'lossCount' | 'lossWeight' | 'versionNo' | 'submitter' | 'submitDate'
>;

export const REPAIR_STATUS_LABEL: Record<RepairStatus, string> = {
  pending: '待排',
  scheduled: '在修',
  done: '已完成',
  returned: '已退回',
  withdrawn: '已撤回',
};

export const REPAIR_STATUS_COLOR: Record<RepairStatus, string> = {
  pending: '#c9963c',
  scheduled: '#2f6f4f',
  done: '#3a6ea5',
  returned: '#a8623a',
  withdrawn: '#8c8c8c',
};

export const REPAIR_STATUS_OPTIONS: ReadonlyArray<{ value: RepairStatus; label: string }> = [
  { value: 'pending', label: '待排' },
  { value: 'scheduled', label: '在修' },
  { value: 'done', label: '已完成' },
  { value: 'returned', label: '已退回' },
  { value: 'withdrawn', label: '已撤回' },
];

/** 仍在修复室流转中的状态（待排 + 在修） */
export const ACTIVE_REPAIR_STATUS: readonly RepairStatus[] = ['pending', 'scheduled'];

/** 编目员可自行撤回的状态：仅没排上（待排）的 */
export const WITHDRAWABLE_REPAIR_STATUS: readonly RepairStatus[] = ['pending'];

/** 需要修复室点头才能退回的状态：上了修复单（在修）的 */
export const RESTORER_RETURN_STATUS: readonly RepairStatus[] = ['scheduled'];

/** 排期时占用工位当日容量的状态：在修不可被挤下 */
export const CAPACITY_OCCUPYING_STATUS: readonly RepairStatus[] = ['scheduled'];

export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createRepairDraft(input: {
  rubbingId: string;
  steleId: string;
  lossCount: number;
  lossWeight: number;
  versionNo: number;
  submitter?: string;
  submitDate?: string;
}): RepairDraft {
  return {
    rubbingId: input.rubbingId,
    steleId: input.steleId,
    lossCount: input.lossCount,
    lossWeight: input.lossWeight,
    versionNo: input.versionNo,
    submitter: input.submitter ?? '',
    submitDate: input.submitDate ?? todayString(),
  };
}
