/**
 * 送修排期算法（纯函数）
 * - 优先级：损泐重（lossWeight 大）→ 版次早（versionNo 小）→ 送修早（createdAt 小）
 * - 容量：按工位当日可修件数扣减，已经在修的占用不退，后来者只能排队
 * 落库与状态流转在 repairSlice 中完成，本文件只负责「谁排上、谁排队」的计算。
 */
import { severityWeight } from './collate';
import type { Loss } from '@/types/loss';
import type { Workbench } from '@/types/workbench';

/** 参与排序的修复单字段（RepairOrder 结构子集） */
export interface ScheduleOrderInfo {
  id: string;
  lossWeight: number;
  versionNo: number;
  createdAt: number;
}

export interface ScheduleBenchInfo {
  id: string;
  dailyCapacity: number;
}

/** 工位当日已被在修单占用的件数 */
export interface ScheduleOccupancy {
  workbenchId: string;
  count: number;
}

export interface SchedulePlanItem extends ScheduleOrderInfo {
  /** 排上的工位 id；为 null 表示容量到顶，排队等腾位 */
  workbenchId: string | null;
  /** 排队序号（按优先级先后，从 1 开始） */
  queueNo: number;
}

export interface BuildScheduleInput {
  /** 待排单（调用方保证只传 pending 且仍有效的单） */
  orders: ScheduleOrderInfo[];
  /** 参与排期的工位，数组顺序即分配顺序（调用方按启用、序号排好） */
  benches: ScheduleBenchInfo[];
  /** 当日各工位已占用件数（在修单，不可挤下） */
  occupancy: ScheduleOccupancy[];
}

/** 送修优先级排序：损泐重 → 版次早 → 送修早 → id 兜底稳定 */
export function orderRepairCandidates<T extends ScheduleOrderInfo>(orders: T[]): T[] {
  return [...orders].sort((a, b) => {
    if (b.lossWeight !== a.lossWeight) return b.lossWeight - a.lossWeight;
    if (a.versionNo !== b.versionNo) return a.versionNo - b.versionNo;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

/**
 * 排出当天方案：损泐重的先占位，工位容量一到顶后来的全部排队。
 * 已在修单不参与本计算（其占用由 occupancy 传入），因此不会被新单挤下去。
 */
export function buildSchedulePlan(input: BuildScheduleInput): SchedulePlanItem[] {
  const remaining = new Map<string, number>();
  input.benches.forEach((bench) => {
    const used = input.occupancy.find((item) => item.workbenchId === bench.id)?.count ?? 0;
    const capacity = Number.isFinite(bench.dailyCapacity) && bench.dailyCapacity > 0 ? Math.trunc(bench.dailyCapacity) : 0;
    remaining.set(bench.id, Math.max(0, capacity - used));
  });

  return orderRepairCandidates(input.orders).map((order, index) => {
    let workbenchId: string | null = null;
    for (const bench of input.benches) {
      const left = remaining.get(bench.id) ?? 0;
      if (left > 0) {
        workbenchId = bench.id;
        remaining.set(bench.id, left - 1);
        break;
      }
    }
    return { ...order, workbenchId, queueNo: index + 1 };
  });
}

/** 统计一份拓本的损泐条数与权重合计（重 3 / 中 2 / 轻 1），送修时快照到修复单 */
export function summarizeLosses(losses: Loss[]): { count: number; weight: number } {
  return losses.reduce(
    (acc, loss) => ({ count: acc.count + 1, weight: acc.weight + severityWeight(loss.severity) }),
    { count: 0, weight: 0 },
  );
}

/** 工位展示排序：固定编号（bench_01）优先，其余按创建时间 */
export function sortWorkbenches(benches: Workbench[]): Workbench[] {
  return [...benches].sort((a, b) => {
    const seqA = /^bench_(\d+)$/.exec(a.id)?.[1];
    const seqB = /^bench_(\d+)$/.exec(b.id)?.[1];
    if (seqA && seqB) return Number(seqA) - Number(seqB);
    if (seqA) return -1;
    if (seqB) return 1;
    return a.createdAt - b.createdAt;
  });
}
