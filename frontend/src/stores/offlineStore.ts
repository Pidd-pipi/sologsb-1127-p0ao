import { create } from 'zustand';
import { db } from '../db';
import type { Inspection, InspectionConclusion } from '../types/inspection';
import type {
  OfflinePackage,
  OfflinePackageItem,
  PendingAdjudication,
} from '../types/offlinePackage';
import { makeId, toPlain } from '../utils/format';
import { mergePackages, resolveAdjudication, type MergeResult } from '../utils/mergePackages';
import { recalcAfterMerge, isQuotaError } from '../utils/recalcAfterMerge';
import { usePointStore } from './pointStore';
import { useRouteStore } from './routeStore';

interface OfflineState {
  packages: OfflinePackage[];
  items: OfflinePackageItem[];
  adjudications: PendingAdjudication[];
  loading: boolean;
  loaded: boolean;
  error: string;
  /** 最近一次合并是否因浏览器容量不足被拒绝 */
  quotaExceeded: boolean;
  /** 最近一次合并结果摘要（用于页面展示） */
  lastMerge: MergeResult | null;
  load: () => Promise<void>;
  uploadPackage: (
    pkg: Omit<OfflinePackage, 'id' | 'uploadedAt' | 'status'>,
    items: Omit<OfflinePackageItem, 'id' | 'packageId'>[],
  ) => Promise<OfflinePackage>;
  mergePackages: () => Promise<MergeResult>;
  resolveAdjudication: (
    id: string,
    resolution: {
      conclusion: InspectionConclusion;
      slope: number;
      clearWidth: number;
      hasHandrail: boolean;
      tactileContinuous: boolean;
      occupied: Inspection['occupied'];
      problem: string;
    },
  ) => Promise<void>;
  deletePackage: (id: string) => Promise<void>;
  clearQuotaFlag: () => void;
}

export const useOfflineStore = create<OfflineState>((set, get) => ({
  packages: [],
  items: [],
  adjudications: [],
  loading: false,
  loaded: false,
  error: '',
  quotaExceeded: false,
  lastMerge: null,

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const [packages, items, adjudications] = await Promise.all([
        db.offlinePackages.toArray(),
        db.offlineItems.toArray(),
        db.adjudications.toArray(),
      ]);
      set({
        packages: packages.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1)),
        items,
        adjudications: adjudications.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  uploadPackage: async (pkgDraft, itemDrafts) => {
    const now = new Date().toISOString();
    const pkg: OfflinePackage = toPlain({
      ...pkgDraft,
      id: makeId('pkg'),
      uploadedAt: now,
      status: '待合并',
    });
    const rows: OfflinePackageItem[] = itemDrafts.map((it) =>
      toPlain({ ...it, id: makeId('oit'), packageId: pkg.id }),
    );
    // 容量不足时拒绝写入，保留两边回传包
    try {
      await db.transaction('rw', db.offlinePackages, db.offlineItems, async () => {
        await db.offlinePackages.add(pkg);
        await db.offlineItems.bulkAdd(rows);
      });
    } catch (e) {
      if (isQuotaError(e)) {
        set({ quotaExceeded: true });
        throw new Error('浏览器存储容量不足，回传包未写入，请清理空间后重试');
      }
      throw e;
    }
    set((s) => ({
      packages: [pkg, ...s.packages],
      items: [...rows, ...s.items],
      quotaExceeded: false,
    }));
    return pkg;
  },

  mergePackages: async () => {
    const { packages, items } = get();
    const pendingPkgs = packages.filter((p) => p.status === '待合并');
    const pendingPkgIds = new Set(pendingPkgs.map((p) => p.id));
    const pendingItems = items.filter((i) => pendingPkgIds.has(i.packageId));

    if (!pendingItems.length) {
      const empty: MergeResult = {
        inspections: [],
        adjudications: [],
        affectedPointIds: new Set(),
        mergedItemCount: 0,
        pendingCount: 0,
        mergedPackageIds: [],
      };
      set({ lastMerge: empty });
      return empty;
    }

    const now = new Date().toISOString();
    // 1. 内存中计算合并结果（不写库）
    const existingInspections = await db.inspections.toArray();
    const existingAdjudications = await db.adjudications.toArray();
    const result = mergePackages(
      pendingPkgs,
      pendingItems,
      existingInspections,
      existingAdjudications,
      now,
    );

    // 2. 重算受影响路线的轮椅通行结论与整改状态
    const routes = await db.routes.toArray();
    const rectifies = await db.rectifies.toArray();
    const recalc = recalcAfterMerge(
      result.affectedPointIds,
      result.inspections.length
        ? // 合并后的核验集合 = 已有 + 新增（原地更新的已包含在 result.inspections 中）
          mergeInspectionSets(existingInspections, result.inspections)
        : existingInspections,
      routes,
      rectifies,
      now,
    );

    // 3. 单事务写入：失败则整体回滚，保留两边回传包
    try {
      await db.transaction(
        'rw',
        db.inspections,
        db.adjudications,
        db.offlinePackages,
        db.routes,
        db.rectifies,
        async () => {
          if (result.inspections.length) await db.inspections.bulkPut(result.inspections);
          if (result.adjudications.length) await db.adjudications.bulkPut(result.adjudications);
          // 标记回传包已合并
          for (const pkg of pendingPkgs) {
            await db.offlinePackages.update(pkg.id, { status: '已合并' });
          }
          // 重算路线通行结论
          for (const upd of recalc.routeUpdates) {
            await db.routes.update(upd.id, { wheelchairPassable: upd.wheelchairPassable });
          }
          // 整改销项 / 补建
          for (const upd of recalc.rectifyUpdates) {
            await db.rectifies.update(upd.id, upd.patch);
          }
          if (recalc.newRectifies.length) await db.rectifies.bulkAdd(recalc.newRectifies);
        },
      );
    } catch (e) {
      if (isQuotaError(e)) {
        // 事务已整体回滚，回传包保持「待合并」，恢复后可接着处理
        set({ quotaExceeded: true });
        throw new Error('浏览器存储容量不足，已拒绝写入并保留两边回传包，请清理空间后点击「继续处理」');
      }
      throw e;
    }

    // 4. 刷新本地状态（核验/整改/路线由 pointStore、routeStore 管理，触发重新拉取）
    const [allPkgs, adjs] = await Promise.all([
      db.offlinePackages.toArray(),
      db.adjudications.toArray(),
    ]);
    set({
      packages: allPkgs.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1)),
      adjudications: adjs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      quotaExceeded: false,
      lastMerge: result,
    });
    // 通知 pointStore 与 routeStore 刷新核验/整改/路线数据
    void refreshPointStores();
    return result;
  },

  resolveAdjudication: async (id, resolution) => {
    const { adjudications } = get();
    const adj = adjudications.find((a) => a.id === id);
    if (!adj) return;
    const now = new Date().toISOString();
    const existingInspections = await db.inspections.toArray();
    const { inspection, adjudication } = resolveAdjudication(
      adj,
      resolution,
      existingInspections,
      now,
    );

    // 裁定后同样重算路线与整改
    const routes = await db.routes.toArray();
    const rectifies = await db.rectifies.toArray();
    const recalc = recalcAfterMerge(
      new Set([adj.pointId]),
      mergeInspectionSets(existingInspections, [inspection]),
      routes,
      rectifies,
      now,
    );

    try {
      await db.transaction(
        'rw',
        db.inspections,
        db.adjudications,
        db.routes,
        db.rectifies,
        async () => {
          await db.inspections.put(inspection);
          await db.adjudications.put(adjudication);
          for (const upd of recalc.routeUpdates) {
            await db.routes.update(upd.id, { wheelchairPassable: upd.wheelchairPassable });
          }
          for (const upd of recalc.rectifyUpdates) {
            await db.rectifies.update(upd.id, upd.patch);
          }
          if (recalc.newRectifies.length) await db.rectifies.bulkAdd(recalc.newRectifies);
        },
      );
    } catch (e) {
      if (isQuotaError(e)) {
        set({ quotaExceeded: true });
        throw new Error('浏览器存储容量不足，裁定结果未写入，请清理空间后重试');
      }
      throw e;
    }

    set((s) => ({
      adjudications: s.adjudications.map((a) => (a.id === id ? adjudication : a)),
      quotaExceeded: false,
    }));
    void refreshPointStores();
  },

  deletePackage: async (id) => {
    const { items } = get();
    const itemIds = items.filter((i) => i.packageId === id).map((i) => i.id);
    try {
      await db.transaction('rw', db.offlinePackages, db.offlineItems, async () => {
        await db.offlinePackages.delete(id);
        await db.offlineItems.bulkDelete(itemIds);
      });
    } catch (e) {
      if (isQuotaError(e)) {
        set({ quotaExceeded: true });
        throw new Error('浏览器存储容量不足，删除失败');
      }
      throw e;
    }
    set((s) => ({
      packages: s.packages.filter((p) => p.id !== id),
      items: s.items.filter((i) => i.packageId !== id),
    }));
  },

  clearQuotaFlag: () => set({ quotaExceeded: false }),
}));

/** 合并已有核验与新生成核验（按 id 去重，新记录覆盖同 id 旧记录） */
function mergeInspectionSets(existing: Inspection[], generated: Inspection[]): Inspection[] {
  const map = new Map<string, Inspection>();
  for (const i of existing) map.set(i.id, i);
  for (const i of generated) map.set(i.id, i);
  return Array.from(map.values());
}

/** 合并/裁定后通知 pointStore 与 routeStore 重新拉取，保持页面数据一致 */
async function refreshPointStores(): Promise<void> {
  await Promise.all([usePointStore.getState().load(), useRouteStore.getState().load()]);
}
