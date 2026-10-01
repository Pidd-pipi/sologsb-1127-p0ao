import type { Inspection, InspectionSide } from '../types/inspection';
import type {
  OfflinePackage,
  OfflinePackageItem,
  PendingAdjudication,
  AdjudicationSide,
} from '../types/offlinePackage';
import { makeId, toPlain } from './format';

export interface MergeResult {
  /** 生成（或更新）的正式核验记录 */
  inspections: Inspection[];
  /** 新增的待裁定条目 */
  adjudications: PendingAdjudication[];
  /** 受影响的点位 id（用于重算路线轮椅通行结论与整改状态） */
  affectedPointIds: Set<string>;
  /** 参与合并的条目数 */
  mergedItemCount: number;
  /** 待裁定条目数 */
  pendingCount: number;
  /** 已合并的回传包 id */
  mergedPackageIds: string[];
}

interface PeriodGroup {
  pointId: string;
  date: string;
  items: OfflinePackageItem[];
}

/** 把回传包条目按「点位 + 时段（核验日期）」分组 */
function groupByPeriod(items: OfflinePackageItem[]): PeriodGroup[] {
  const map = new Map<string, PeriodGroup>();
  for (const item of items) {
    const key = `${item.pointId}__${item.date}`;
    const group = map.get(key);
    if (group) {
      group.items.push(item);
    } else {
      map.set(key, { pointId: item.pointId, date: item.date, items: [item] });
    }
  }
  return Array.from(map.values());
}

function toSide(item: OfflinePackageItem, pkg: OfflinePackage | undefined): InspectionSide {
  return {
    packageId: item.packageId,
    side: pkg?.side ?? '未知采集方',
    inspector: item.inspector,
    collectedAt: item.collectedAt,
    slope: item.slope,
    clearWidth: item.clearWidth,
    hasHandrail: item.hasHandrail,
    tactileContinuous: item.tactileContinuous,
    occupied: item.occupied,
    conclusion: item.conclusion,
    problem: item.problem,
  };
}

function toAdjudicationSide(item: OfflinePackageItem, pkg: OfflinePackage | undefined): AdjudicationSide {
  return {
    itemId: item.id,
    packageId: item.packageId,
    side: pkg?.side ?? '未知采集方',
    inspector: item.inspector,
    collectedAt: item.collectedAt,
    slope: item.slope,
    clearWidth: item.clearWidth,
    hasHandrail: item.hasHandrail,
    tactileContinuous: item.tactileContinuous,
    occupied: item.occupied,
    conclusion: item.conclusion,
    problem: item.problem,
  };
}

/**
 * 合并离线回传包：按点位归并补录条目。
 *
 * 规则：
 * 1. 同一点位同一时段（核验日期）的条目归为一组；
 * 2. 组内结论一致 → 写一条正式核验记录，坡度、净宽都留下，
 *    督导员与采集时间通过 sides 分别标清；
 * 3. 组内结论不一致 → 先列待裁定，处理前不写正式核验记录；
 * 4. 已存在同点位同时段正式记录则原地更新，避免重复。
 *
 * 纯函数：不写库，返回待写入的结果。
 */
export function mergePackages(
  packages: OfflinePackage[],
  items: OfflinePackageItem[],
  existingInspections: Inspection[],
  existingAdjudications: PendingAdjudication[],
  now: string,
): MergeResult {
  const pkgMap = new Map(packages.map((p) => [p.id, p]));
  const inspections: Inspection[] = [];
  const adjudications: PendingAdjudication[] = [];
  const affectedPointIds = new Set<string>();
  let mergedItemCount = 0;

  const groups = groupByPeriod(items);

  for (const group of groups) {
    const { pointId, date } = group;
    // 按采集时间排序，最早的作为主口径
    const sorted = [...group.items].sort((a, b) =>
      a.collectedAt < b.collectedAt ? -1 : a.collectedAt > b.collectedAt ? 1 : 0,
    );
    const conclusions = new Set(sorted.map((i) => i.conclusion));
    affectedPointIds.add(pointId);
    mergedItemCount += sorted.length;

    if (conclusions.size === 1) {
      // 结论一致：写正式核验记录，双边测量都留下
      const primary = sorted[0];
      const sides = sorted.map((it) => toSide(it, pkgMap.get(it.packageId)));
      const packageIds = Array.from(new Set(sorted.map((it) => it.packageId)));

      // 已存在同点位同时段记录则原地更新，避免重复
      const existing = existingInspections.find(
        (i) => i.pointId === pointId && i.date === date,
      );
      const record: Inspection = toPlain({
        id: existing?.id ?? `ins-merge-${pointId}-${date}`,
        pointId,
        date,
        inspector: primary.inspector,
        slope: primary.slope,
        clearWidth: primary.clearWidth,
        hasHandrail: primary.hasHandrail,
        tactileContinuous: primary.tactileContinuous,
        occupied: primary.occupied,
        conclusion: primary.conclusion,
        problem: primary.problem,
        createdAt: existing?.createdAt ?? now,
        collectedAt: primary.collectedAt,
        sides,
        packageIds,
      });
      inspections.push(record);
    } else {
      // 结论不一致：先列待裁定，处理前不写正式记录
      // 已存在同点位同时段待裁定则不重复生成
      const already = existingAdjudications.some(
        (a) => a.pointId === pointId && a.date === date && a.status === '待裁定',
      );
      if (!already) {
        const [a, b] = sorted;
        adjudications.push(
          toPlain({
            id: `adj-${pointId}-${date}`,
            pointId,
            date,
            conclusionA: a.conclusion,
            conclusionB: b.conclusion,
            sideA: toAdjudicationSide(a, pkgMap.get(a.packageId)),
            sideB: toAdjudicationSide(b, pkgMap.get(b.packageId)),
            status: '待裁定',
            createdAt: now,
          }),
        );
      }
    }
  }

  return {
    inspections,
    adjudications,
    affectedPointIds,
    mergedItemCount,
    pendingCount: adjudications.length,
    mergedPackageIds: Array.from(new Set(items.map((i) => i.packageId))),
  };
}

/**
 * 裁定待裁定条目：采纳裁定结论，生成正式核验记录。
 */
export function resolveAdjudication(
  adj: PendingAdjudication,
  resolution: {
    conclusion: Inspection['conclusion'];
    slope: number;
    clearWidth: number;
    hasHandrail: boolean;
    tactileContinuous: boolean;
    occupied: Inspection['occupied'];
    problem: string;
  },
  existingInspections: Inspection[],
  now: string,
): { inspection: Inspection; adjudication: PendingAdjudication } {
  const existing = existingInspections.find(
    (i) => i.pointId === adj.pointId && i.date === adj.date,
  );
  const sides: InspectionSide[] = [
    {
      packageId: adj.sideA.packageId,
      side: adj.sideA.side,
      inspector: adj.sideA.inspector,
      collectedAt: adj.sideA.collectedAt,
      slope: adj.sideA.slope,
      clearWidth: adj.sideA.clearWidth,
      hasHandrail: adj.sideA.hasHandrail,
      tactileContinuous: adj.sideA.tactileContinuous,
      occupied: adj.sideA.occupied,
      conclusion: adj.sideA.conclusion,
      problem: adj.sideA.problem,
    },
    {
      packageId: adj.sideB.packageId,
      side: adj.sideB.side,
      inspector: adj.sideB.inspector,
      collectedAt: adj.sideB.collectedAt,
      slope: adj.sideB.slope,
      clearWidth: adj.sideB.clearWidth,
      hasHandrail: adj.sideB.hasHandrail,
      tactileContinuous: adj.sideB.tactileContinuous,
      occupied: adj.sideB.occupied,
      conclusion: adj.sideB.conclusion,
      problem: adj.sideB.problem,
    },
  ];
  const inspection: Inspection = toPlain({
    id: existing?.id ?? `ins-merge-${adj.pointId}-${adj.date}`,
    pointId: adj.pointId,
    date: adj.date,
    inspector: adj.sideA.inspector,
    slope: resolution.slope,
    clearWidth: resolution.clearWidth,
    hasHandrail: resolution.hasHandrail,
    tactileContinuous: resolution.tactileContinuous,
    occupied: resolution.occupied,
    conclusion: resolution.conclusion,
    problem: resolution.problem,
    createdAt: existing?.createdAt ?? now,
    collectedAt: adj.sideA.collectedAt,
    sides,
    packageIds: [adj.sideA.packageId, adj.sideB.packageId],
  });
  const resolved: PendingAdjudication = toPlain({
    ...adj,
    status: '已裁定',
    resolvedConclusion: resolution.conclusion,
    resolvedSlope: resolution.slope,
    resolvedClearWidth: resolution.clearWidth,
    resolvedHasHandrail: resolution.hasHandrail,
    resolvedTactileContinuous: resolution.tactileContinuous,
    resolvedOccupied: resolution.occupied,
    resolvedProblem: resolution.problem,
    resolvedAt: now,
  });
  return { inspection, adjudication: resolved };
}

export { makeId };
