/**
 * 修复室工位（Workbench）数据模型
 * 修复室按工位排期，每个工位有「每日件数」容量上限；
 * 旧数据的工位没有每日件数，升级时按默认件数回填。
 */

/** 旧工位升级时回填的默认每日件数 */
export const DEFAULT_DAILY_CAPACITY = 2;

/** 工位名称序号上限（仅用于生成默认名称） */
export interface Workbench {
  id: string;
  /** 工位名称，如「修复一室 · 一号工位」 */
  name: string;
  /** 负责人（修复师） */
  keeper: string;
  /** 当日可修件数上限 */
  dailyCapacity: number;
  /** 是否启用；停用的工位不参与排期 */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export type WorkbenchDraft = Omit<Workbench, 'id' | 'createdAt' | 'updatedAt'>;

/** 生成默认工位：升级旧库 / 空工位时兜底，保证修复室当天可排 */
export function createDefaultWorkbench(seq: number, now: number = Date.now()): Workbench {
  return {
    id: `bench_${String(seq).padStart(2, '0')}`,
    name: `修复工位 ${seq} 号`,
    keeper: '',
    dailyCapacity: DEFAULT_DAILY_CAPACITY,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function createEmptyWorkbenchDraft(seq: number): WorkbenchDraft {
  return {
    name: `修复工位 ${seq} 号`,
    keeper: '',
    dailyCapacity: DEFAULT_DAILY_CAPACITY,
    active: true,
  };
}
