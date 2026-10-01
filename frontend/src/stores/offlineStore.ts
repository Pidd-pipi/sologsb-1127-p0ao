import { create } from 'zustand';
import { db } from '../db';
import type { OfflineSide } from '../types/inspection';
import type {
  MergeDispute,
  OfflineInspectionPack,
  OfflinePackDraft,
  PackInput,
} from '../types/offline';
import type { RectifyPlan } from '../types/rectify';
import { makeId, toPlain, todayStr } from '../utils/format';
import { ensureCapacity, isQuotaError } from '../utils/storage';
import {
  buildAgreedInspection,
  buildDispute,
  buildResolvedInspection,
  concludePack,
  pairPacks,
  timeWindowKey,
  type PairUnit,
} from '../utils/mergePacks';
import { effectiveStatusMap, recalcRectifies, recalcRoutes } from '../utils/recalc';
import { usePointStore } from './pointStore';
import { useRouteStore } from './routeStore';

export interface MergeProcessReport {
  /** 直接合并（结论一致）的时段数 */
  merged: number;
  /** 新增待裁定单数 */
  disputes: number;
  /** 仍只有单边、等待另一侧的时段数 */
  waiting: number;
  /** 受影响并重算了结论的路线数 */
  routesRecalculated: number;
  /** 新建/更新的整改条目数 */
  rectifiesCreated: number;
  rectifiesUpdated: number;
  /** 被容量拦截的时段数（两边回传包原样保留） */
  rejected: number;
}

/** 合并后统一重算相关路线结论与整改状态（须在已完成的事务之后调用） */
async function recalcAffected(pointIds: string[]): Promise<{
  routesRecalculated: number;
  rectifiesCreated: number;
  rectifiesUpdated: number;
}> {
  const [allRoutes, allInspections, allDisputes, allRectifies, points] = await Promise.all([
    db.routes.toArray(),
    db.inspections.toArray(),
    db.mergeDisputes.toArray(),
    db.rectifies.toArray(),
    db.points.toArray(),
  ]);
  const statusMap = effectiveStatusMap(allInspections, allDisputes);
  const statusOf = (pid: string) => statusMap.get(pid) ?? '未核验';

  // 相关路线：只要任一路段端点落在受影响点位上就重算 wheelchairPassable
  const hit = new Set(pointIds);
  const affectedRoutes = allRoutes.filter(
    (s) => hit.has(s.fromPointId) || hit.has(s.toPointId),
  );
  const affectedRouteIds = new Set(affectedRoutes.map((s) => s.id));
  const routePatches = recalcRoutes(allRoutes, statusOf).filter((p) => affectedRouteIds.has(p.id));
  const changed = routePatches.filter((p) => {
    const cur = allRoutes.find((s) => s.id === p.id);
    return cur && cur.wheelchairPassable !== p.wheelchairPassable;
  });
  if (changed.length) {
    await db.routes.bulkPut(
      changed.map((p) => {
        const cur = allRoutes.find((s) => s.id === p.id)!;
        return { ...cur, wheelchairPassable: p.wheelchairPassable };
      }),
    );
  }

  // 整改状态跟着点位生效结论重算
  const rect = recalcRectifies(pointIds, {
    inspections: allInspections,
    disputes: allDisputes,
    rectifies: allRectifies,
    points,
  });
  const now = new Date().toISOString();
  const createdPlans: RectifyPlan[] = rect.toCreate.map((c) =>
    toPlain({
      ...c,
      id: makeId('rct'),
      recheckDate: '',
      status: '待整改' as const,
      createdAt: now,
    }),
  );
  if (createdPlans.length) await db.rectifies.bulkPut(createdPlans);
  if (rect.toUpdate.length) {
    await Promise.all(
      rect.toUpdate.map((u) => {
        const { id, ...patch } = u;
        return db.rectifies.update(id, toPlain(patch));
      }),
    );
  }

  return {
    routesRecalculated: new Set(affectedRoutes.map((s) => s.routeName)).size,
    rectifiesCreated: createdPlans.length,
    rectifiesUpdated: rect.toUpdate.length,
  };
}

/** 容量不足时把相关包标记 rejected 并写明原因（回传包不删除、恢复后可继续处理） */
async function markRejected(unit: PairUnit, note: string): Promise<void> {
  await Promise.all(unit.packs.map((p) => db.offlinePacks.update(p.id, { status: 'rejected', lastNote: note })));
}

interface OfflineState {
  packs: OfflineInspectionPack[];
  disputes: MergeDispute[];
  loaded: boolean;
  loading: boolean;
  error: string;
  /** 容量不足演练开关：打开后所有合并/裁定写入都会被预检拦截 */
  simulateFull: boolean;
  lastReport: MergeProcessReport | null;
  load: () => Promise<void>;
  setSimulateFull: (v: boolean) => void;
  ingestPack: (input: PackInput) => Promise<OfflineInspectionPack>;
  processPacks: () => Promise<MergeProcessReport>;
  resolveDispute: (disputeId: string, side: OfflineSide, resolvedBy: string, note: string) => Promise<void>;
  resetLastReport: () => void;
}

function sortPacks(rows: OfflineInspectionPack[]): OfflineInspectionPack[] {
  return [...rows].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
}

function sortDisputes(rows: MergeDispute[]): MergeDispute[] {
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function refreshStores(): Promise<void> {
  await Promise.all([usePointStore.getState().load(), useRouteStore.getState().load()]);
}

export const useOfflineStore = create<OfflineState>((set, get) => ({
  packs: [],
  disputes: [],
  loaded: false,
  loading: false,
  error: '',
  simulateFull: false,
  lastReport: null,

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const [packs, disputes] = await Promise.all([
        db.offlinePacks.toArray(),
        db.mergeDisputes.toArray(),
      ]);
      set({ packs: sortPacks(packs), disputes: sortDisputes(disputes), loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setSimulateFull: (v) => set({ simulateFull: v }),

  resetLastReport: () => set({ lastReport: null }),

  ingestPack: async (input) => {
    const now = new Date().toISOString();
    const draft: OfflinePackDraft = {
      pointId: input.pointId,
      side: input.side,
      date: input.date || todayStr(),
      inspector: input.inspector.trim() || `未署名督导员（${input.side} 侧）`,
      collectedAt: input.collectedAt || now,
      slope: input.slope,
      clearWidth: input.clearWidth,
      hasHandrail: input.hasHandrail,
      tactileContinuous: input.tactileContinuous,
      occupied: input.occupied,
      problem: input.problem.trim(),
      // 以统一阈值复算，保证「同一时段两边结论不同」判定口径一致
      conclusion: concludePack(input),
    };
    const pack: OfflineInspectionPack = toPlain({
      ...draft,
      id: makeId('pck'),
      timeWindow: timeWindowKey(draft.pointId, draft.date),
      uploadedAt: now,
      status: 'pending',
    });

    // 单包入库本身也要过容量检查；容量不足时连包都不写（界面提示先清理后重试），
    // 已经在两侧的回传包永远不会被删除。
    await ensureCapacity([pack], get().simulateFull);
    await db.offlinePacks.put(pack);
    set((s) => ({ packs: sortPacks([...s.packs, pack]) }));
    return pack;
  },

  processPacks: async () => {
    const report: MergeProcessReport = {
      merged: 0,
      disputes: 0,
      waiting: 0,
      routesRecalculated: 0,
      rectifiesCreated: 0,
      rectifiesUpdated: 0,
      rejected: 0,
    };
    // 结论一致与进入待裁定都会改变点位生效状态，路线都要跟着重算
    const affectedPointIds = new Set<string>();
    const units = pairPacks(get().packs);
    const forceFull = get().simulateFull;

    for (const unit of units) {
      if (unit.packs.length < 2) {
        report.waiting += 1;
        continue;
      }
      const now = new Date().toISOString();

      try {
        if (unit.agree) {
          const { inspection } = buildAgreedInspection(unit, now);
          // 预检通过后再开事务；容量不足直接拒绝写入，两边回传包原样保留
          await ensureCapacity([inspection], forceFull);
          try {
            await db.transaction('rw', db.inspections, db.offlinePacks, async () => {
              await db.inspections.put(inspection);
              await Promise.all(
                unit.packs.map((p) =>
                  db.offlinePacks.update(p.id, {
                    status: 'merged',
                    pairedPackId: unit.packs.find((q) => q.id !== p.id)?.id,
                    mergedInspectionId: inspection.id,
                    lastNote: '两侧结论一致，已合并为正式核验记录',
                  }),
                ),
              );
            });
          } catch (e) {
            if (isQuotaError(e)) {
              await markRejected(unit, '浏览器容量不足，已拒绝写入正式记录，两边回传包保留待恢复后处理');
              report.rejected += 1;
              continue;
            }
            throw e;
          }
          report.merged += 1;
          affectedPointIds.add(unit.pointId);
        } else if (unit.conflict) {
          const dispute = buildDispute(unit, now);
          await ensureCapacity([dispute], forceFull);
          try {
            await db.transaction('rw', db.mergeDisputes, db.offlinePacks, async () => {
              await db.mergeDisputes.put(dispute);
              await Promise.all(
                unit.packs.map((p) =>
                  db.offlinePacks.update(p.id, {
                    // 结论不一致先列待裁定：不写正式核验记录
                    status: 'dispute',
                    pairedPackId: unit.packs.find((q) => q.id !== p.id)?.id,
                    disputeId: dispute.id,
                    lastNote: '两侧结论不一致，已生成待裁定单，裁定前不写正式记录',
                  }),
                ),
              );
            });
          } catch (e) {
            if (isQuotaError(e)) {
              await markRejected(unit, '浏览器容量不足，待裁定单未写入，两边回传包保留待恢复后处理');
              report.rejected += 1;
              continue;
            }
            throw e;
          }
          report.disputes += 1;
          affectedPointIds.add(unit.pointId);
        }
      } catch (e) {
        // ensureCapacity 预检抛出（StorageFullError）：拒绝写入、两边包保留为 rejected
        if (isQuotaError(e)) {
          await markRejected(unit, e instanceof Error ? e.message : '浏览器容量不足，已拒绝写入');
          report.rejected += 1;
          continue;
        }
        throw e;
      }
    }

    if (affectedPointIds.size) {
      const r = await recalcAffected([...affectedPointIds]);
      report.routesRecalculated = r.routesRecalculated;
      report.rectifiesCreated = r.rectifiesCreated;
      report.rectifiesUpdated = r.rectifiesUpdated;
    }

    const [packs, disputes] = await Promise.all([db.offlinePacks.toArray(), db.mergeDisputes.toArray()]);
    set({ packs: sortPacks(packs), disputes: sortDisputes(disputes), lastReport: report });
    await refreshStores();
    return report;
  },

  resolveDispute: async (disputeId, side, resolvedBy, note) => {
    const dispute = get().disputes.find((d) => d.id === disputeId);
    if (!dispute) throw new Error('待裁定单不存在');
    if (dispute.status !== '待裁定') throw new Error('该待裁定单已处理');

    const now = new Date().toISOString();
    const inspector = resolvedBy.trim() || '督导员';
    const inspection = buildResolvedInspection(dispute, side, note.trim(), now);
    const resolvedDispute: MergeDispute = toPlain({
      ...dispute,
      status: '已裁定',
      resolvedSide: side,
      resolvedBy: inspector,
      resolvedNote: note.trim(),
      resolvedAt: now,
      mergedInspectionId: inspection.id,
    });

    // 容量不足：拒绝写入，待裁定单与两边回传包原样保留，恢复后接着裁定
    await ensureCapacity([inspection, resolvedDispute], get().simulateFull);
    try {
      await db.transaction('rw', db.inspections, db.mergeDisputes, db.offlinePacks, async () => {
        // 处理前不写正式记录；裁定完成此刻才落正式核验记录
        await db.inspections.put(inspection);
        await db.mergeDisputes.put(resolvedDispute);
        await Promise.all(
          dispute.packIds.map((pid) =>
            db.offlinePacks.update(pid, {
              status: 'merged',
              mergedInspectionId: inspection.id,
              lastNote: `已经督导员裁定采纳 ${side} 侧结论，正式记录已写入`,
            }),
          ),
        );
      });
    } catch (e) {
      if (isQuotaError(e)) {
        throw new Error('浏览器容量不足，已拒绝写入：待裁定单与两边回传包均保留，容量恢复后可继续裁定');
      }
      throw e;
    }

    const r = await recalcAffected([dispute.pointId]);
    const [packs, disputes] = await Promise.all([db.offlinePacks.toArray(), db.mergeDisputes.toArray()]);
    set({
      packs: sortPacks(packs),
      disputes: sortDisputes(disputes),
      lastReport: {
        merged: 1,
        disputes: 0,
        waiting: 0,
        routesRecalculated: r.routesRecalculated,
        rectifiesCreated: r.rectifiesCreated,
        rectifiesUpdated: r.rectifiesUpdated,
        rejected: 0,
      },
    });
    await refreshStores();
  },
}));
