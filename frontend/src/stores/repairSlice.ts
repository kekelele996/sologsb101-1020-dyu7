/**
 * 送修排期 slice（Redux Toolkit）
 * 维护修复室工位与送修 / 修复单集合：
 * - 编目员送修（pending 待排），可撤回未排上的单；
 * - 修复室按工位当日容量排期（scheduled 在修），损泐重的先排，满了排队；
 * - 在修单不参与重排、不会被新单挤下；修复室可退回 / 完成；
 * - 排期中途失败：逐条落库，已排的留着，没排上的保持待排等重试。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createId, db } from '@/utils/db';
import type { RepairOrder, RepairDraft, RepairStatus } from '@/types/repair';
import { ACTIVE_REPAIR_STATUS, CAPACITY_OCCUPYING_STATUS } from '@/types/repair';
import type { Workbench, WorkbenchDraft } from '@/types/workbench';
import { DEFAULT_DAILY_CAPACITY } from '@/types/workbench';
import { buildSchedulePlan, sortWorkbenches } from '@/utils/repairSchedule';
import type { RootState } from './store';

export interface RepairFilters {
  keyword: string;
  statuses: RepairStatus[];
  steleId: string | null;
}

export interface RepairState {
  workbenches: Workbench[];
  orders: RepairOrder[];
  loading: boolean;
  ready: boolean;
  scheduling: boolean;
  error: string;
  filters: RepairFilters;
}

const initialState: RepairState = {
  workbenches: [],
  orders: [],
  loading: false,
  ready: false,
  scheduling: false,
  error: '',
  filters: { keyword: '', statuses: [], steleId: null },
};

export const loadRepairs = createAsyncThunk('repair/load', async () => {
  const [workbenches, orders] = await Promise.all([db.workbenches.toArray(), db.repairs.toArray()]);
  return { workbenches: sortWorkbenches(workbenches), orders };
});

/* ------------------------------ 工位 ------------------------------ */

export const createWorkbench = createAsyncThunk('repair/createBench', async (draft: WorkbenchDraft, { dispatch }) => {
  const now = Date.now();
  const seqRows = await db.workbenches.toArray();
  const seqs = seqRows
    .map((row) => /^bench_(\d+)$/.exec(row.id)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => Number(value));
  const seq = seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
  const row: Workbench = {
    ...draft,
    id: `bench_${String(seq).padStart(2, '0')}`,
    dailyCapacity: draft.dailyCapacity > 0 ? Math.trunc(draft.dailyCapacity) : DEFAULT_DAILY_CAPACITY,
    createdAt: now,
    updatedAt: now,
  };
  await db.workbenches.put(row);
  await dispatch(loadRepairs());
  return row;
});

export const updateWorkbench = createAsyncThunk(
  'repair/updateBench',
  async (payload: { id: string; patch: Partial<Workbench> }, { dispatch }) => {
    const patch = { ...payload.patch };
    if (typeof patch.dailyCapacity === 'number') {
      patch.dailyCapacity = patch.dailyCapacity > 0 ? Math.trunc(patch.dailyCapacity) : DEFAULT_DAILY_CAPACITY;
    }
    await db.workbenches.update(payload.id, { ...patch, updatedAt: Date.now() } as never);
    await dispatch(loadRepairs());
  },
);

export const removeWorkbench = createAsyncThunk('repair/removeBench', async (id: string, { dispatch }) => {
  const occupied = await db.repairs
    .where('workbenchId')
    .equals(id)
    .toArray()
    .then((rows) => rows.filter((row) => CAPACITY_OCCUPYING_STATUS.includes(row.status)));
  if (occupied.length > 0) {
    throw new Error(`该工位还有 ${occupied.length} 件在修拓本，需先退回或完成后才能撤掉工位`);
  }
  await db.workbenches.delete(id);
  await dispatch(loadRepairs());
});

/* ------------------------------ 送修单 ------------------------------ */

export const submitRepair = createAsyncThunk('repair/submit', async (draft: RepairDraft, { dispatch }) => {
  const active = await db.repairs
    .where('rubbingId')
    .equals(draft.rubbingId)
    .toArray()
    .then((rows) => rows.filter((row) => ACTIVE_REPAIR_STATUS.includes(row.status)));
  if (active.length > 0) {
    throw new Error('该拓本已有待排或在修的送修单，不能重复送修');
  }
  const now = Date.now();
  const row: RepairOrder = {
    ...draft,
    id: createId('rep'),
    status: 'pending',
    workbenchId: '',
    scheduleDate: '',
    queueNo: 0,
    restorer: '',
    repairNote: '',
    batchNo: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.repairs.put(row);
  await dispatch(loadRepairs());
  return row;
});

export interface ScheduleResult {
  scheduled: number;
  queued: number;
  failed: number;
  scheduleDate: string;
  batchNo: number;
}

/**
 * 执行当天排期：损泐重的先排，按工位当日剩余容量落单。
 * 逐条独立写入：中途某条失败不影响已落的修复单，没排上 / 落单失败的保持待排，可直接重试。
 */
export const runSchedule = createAsyncThunk(
  'repair/schedule',
  async (payload: { scheduleDate: string; restorer?: string }, { dispatch }) => {
    const [benches, orders] = await Promise.all([db.workbenches.toArray(), db.repairs.toArray()]);
    const activeBenches = sortWorkbenches(benches).filter((bench) => bench.active !== false && bench.dailyCapacity > 0);
    const pending = orders.filter((row) => row.status === 'pending');

    // 当日在修占用（已经在修的不会被挤下）
    const occupancyMap = new Map<string, number>();
    orders
      .filter((row) => row.status === 'scheduled' && row.scheduleDate === payload.scheduleDate)
      .forEach((row) => {
        if (row.workbenchId) occupancyMap.set(row.workbenchId, (occupancyMap.get(row.workbenchId) ?? 0) + 1);
      });

    const batchNo = orders.reduce((max, row) => Math.max(max, row.batchNo ?? 0), 0) + 1;
    const plan = buildSchedulePlan({
      orders: pending,
      benches: activeBenches,
      occupancy: Array.from(occupancyMap, ([workbenchId, count]) => ({ workbenchId, count })),
    });

    const chosen = plan.filter((item) => item.workbenchId !== null);
    const queued = plan.filter((item) => item.workbenchId === null);
    const now = Date.now();

    // 逐条落修复单：单条失败不回滚已落的
    const results = await Promise.all(
      chosen.map(async (item) => {
        const current = await db.repairs.get(item.id);
        if (!current || current.status !== 'pending') return false;
        await db.repairs.update(item.id, {
          status: 'scheduled',
          workbenchId: item.workbenchId,
          scheduleDate: payload.scheduleDate,
          queueNo: item.queueNo,
          batchNo,
          restorer: payload.restorer ?? current.restorer,
          updatedAt: now,
        } as never);
        return true;
      }),
    );

    // 排队的单刷新排队序号（仍是待排；写入失败也不影响其可重试）
    await Promise.allSettled(
      queued.map((item) =>
        db.repairs.update(item.id, { queueNo: item.queueNo, updatedAt: now } as never),
      ),
    );

    await dispatch(loadRepairs());
    const scheduled = results.filter(Boolean).length;
    return {
      scheduled,
      queued: queued.length,
      failed: chosen.length - scheduled,
      scheduleDate: payload.scheduleDate,
      batchNo,
    } satisfies ScheduleResult;
  },
);

/** 编目员撤回：仅没排上（待排）的可撤 */
export const withdrawRepair = createAsyncThunk('repair/withdraw', async (id: string, { dispatch, getState }) => {
  const state = getState() as RootState;
  const order = state.repair.orders.find((row) => row.id === id);
  if (!order) throw new Error('送修单不存在');
  if (order.status !== 'pending') throw new Error('只有没排上的待排单可以撤回');
  await db.repairs.update(id, { status: 'withdrawn', workbenchId: '', scheduleDate: '', updatedAt: Date.now() } as never);
  await dispatch(loadRepairs());
});

/** 修复室退回：上了修复单（在修）的须修复室点头 */
export const returnRepair = createAsyncThunk(
  'repair/return',
  async (payload: { id: string; restorer: string; repairNote: string }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const order = state.repair.orders.find((row) => row.id === payload.id);
    if (!order) throw new Error('修复单不存在');
    if (order.status !== 'scheduled') throw new Error('只有在修的修复单可以退回');
    await db.repairs.update(payload.id, {
      status: 'returned',
      restorer: payload.restorer || order.restorer,
      repairNote: payload.repairNote,
      updatedAt: Date.now(),
    } as never);
    await dispatch(loadRepairs());
  },
);

/** 修复室完成在修单 */
export const completeRepair = createAsyncThunk(
  'repair/complete',
  async (payload: { id: string; restorer: string; repairNote: string }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const order = state.repair.orders.find((row) => row.id === payload.id);
    if (!order) throw new Error('修复单不存在');
    if (order.status !== 'scheduled') throw new Error('只有在修的修复单可以完成');
    await db.repairs.update(payload.id, {
      status: 'done',
      restorer: payload.restorer || order.restorer,
      repairNote: payload.repairNote,
      updatedAt: Date.now(),
    } as never);
    await dispatch(loadRepairs());
  },
);

export const removeRepair = createAsyncThunk('repair/remove', async (id: string, { dispatch }) => {
  await db.repairs.delete(id);
  await dispatch(loadRepairs());
});

const repairSlice = createSlice({
  name: 'repair',
  initialState,
  reducers: {
    setRepairKeyword(state, action: PayloadAction<string>) {
      state.filters.keyword = action.payload;
    },
    setRepairStatuses(state, action: PayloadAction<RepairStatus[]>) {
      state.filters.statuses = action.payload;
    },
    setRepairSteleFilter(state, action: PayloadAction<string | null>) {
      state.filters.steleId = action.payload;
    },
    resetRepairFilters(state) {
      state.filters = { keyword: '', statuses: [], steleId: null };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadRepairs.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadRepairs.fulfilled, (state, action) => {
        state.workbenches = action.payload.workbenches;
        state.orders = action.payload.orders;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadRepairs.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '送修数据读取失败';
      })
      .addCase(runSchedule.pending, (state) => {
        state.scheduling = true;
      })
      .addCase(runSchedule.fulfilled, (state) => {
        state.scheduling = false;
      })
      .addCase(runSchedule.rejected, (state, action) => {
        state.scheduling = false;
        state.error = action.error.message ?? '排期失败';
      });
  },
});

export const { setRepairKeyword, setRepairStatuses, setRepairSteleFilter, resetRepairFilters } = repairSlice.actions;

export const selectRepairState = (state: RootState): RepairState => state.repair;
export const selectWorkbenches = (state: RootState): Workbench[] => state.repair.workbenches;
export const selectRepairOrders = (state: RootState): RepairOrder[] => state.repair.orders;

/** 待排单：按送修优先级返回（损泐重 → 版次早 → 送修早） */
export function selectPendingOrders(state: RootState): RepairOrder[] {
  const list = state.repair.orders.filter((order) => order.status === 'pending');
  return [...list].sort((a, b) => {
    if (b.lossWeight !== a.lossWeight) return b.lossWeight - a.lossWeight;
    if (a.versionNo !== b.versionNo) return a.versionNo - b.versionNo;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

/** 已有待排 / 在修单的拓本 id（禁止重复送修） */
export function selectActiveRepairRubbingIds(state: RootState): Set<string> {
  return new Set(
    state.repair.orders.filter((order) => ACTIVE_REPAIR_STATUS.includes(order.status)).map((order) => order.rubbingId),
  );
}

export interface BenchCapacity {
  workbenchId: string;
  name: string;
  dailyCapacity: number;
  /** 当日在修占用 */
  used: number;
  /** 当日剩余 */
  free: number;
  active: boolean;
}

/** 各工位在指定日期的容量占用（只统计在修单） */
export function selectBenchCapacity(scheduleDate: string) {
  return (state: RootState): BenchCapacity[] =>
    sortWorkbenches(state.repair.workbenches).map((bench) => {
      const used = state.repair.orders.filter(
        (order) =>
          order.status === 'scheduled' && order.workbenchId === bench.id && order.scheduleDate === scheduleDate,
      ).length;
      return {
        workbenchId: bench.id,
        name: bench.name,
        dailyCapacity: bench.dailyCapacity,
        used,
        free: Math.max(0, bench.dailyCapacity - used),
        active: bench.active !== false,
      };
    });
}

/** 派生选择器：关键字 + 状态 + 碑刻过滤（关键字覆盖送修人/修复师/备注及碑名/收藏号/版本） */
export function selectFilteredRepairOrders(state: RootState): RepairOrder[] {
  const { orders, filters } = state.repair;
  const keyword = filters.keyword.trim();
  return orders.filter((order) => {
    if (filters.steleId !== null && order.steleId !== filters.steleId) return false;
    if (filters.statuses.length > 0 && !filters.statuses.includes(order.status)) return false;
    if (keyword.length > 0) {
      const rubbing = state.rubbing.items.find((item) => item.id === order.rubbingId);
      const steleTitle = state.stele.items.find((item) => item.id === order.steleId)?.title ?? '';
      const haystack = [
        order.submitter,
        order.restorer,
        order.repairNote,
        steleTitle,
        rubbing?.collectionNo ?? '',
        rubbing?.dateGuess ?? '',
        `第 ${order.versionNo} 版`,
      ].join('');
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

export default repairSlice.reducer;
