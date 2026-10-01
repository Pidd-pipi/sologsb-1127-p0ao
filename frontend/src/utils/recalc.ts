import type { Inspection, InspectionConclusion } from '../types/inspection';
import type { MergeDispute } from '../types/offline';
import type { AccessPoint } from '../types/point';
import type { RectifyPlan } from '../types/rectify';
import type { RouteSegment, RouteVerdict } from '../types/route';
import { addDays, todayStr } from './format';
import { judgeSegment } from './routeCheck';

/**
 * 点位核验合并后的「生效核验状态」。
 *
 * 优先级：
 * 1. 存在「待裁定」单：同一点位同时段两边结论不一致尚未裁定 —— 待裁定；
 * 2. 否则取最新一条正式核验记录的结论（含离线合并落库的记录）；
 * 3. 没有任何记录：未核验。
 */
export type EffectiveStatus = InspectionConclusion | '待裁定' | '未核验';

/** 点位是否有待裁定的两边结论冲突 */
export function pointHasOpenDispute(pointId: string, disputes: MergeDispute[]): boolean {
  return disputes.some((d) => d.pointId === pointId && d.status === '待裁定');
}

/** 计算点位当前生效状态（合并后路线/整改重算都以此为准） */
export function effectivePointStatus(
  pointId: string,
  inspections: Inspection[],
  disputes: MergeDispute[],
): EffectiveStatus {
  if (pointHasOpenDispute(pointId, disputes)) return '待裁定';
  const list = inspections
    .filter((i) => i.pointId === pointId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1));
  return list.length ? list[0].conclusion : '未核验';
}

/** 批量计算点位生效状态映射 */
export function effectiveStatusMap(
  inspections: Inspection[],
  disputes: MergeDispute[],
): Map<string, EffectiveStatus> {
  const latest = new Map<string, Inspection>();
  for (const ins of inspections) {
    const cur = latest.get(ins.pointId);
    if (
      !cur ||
      ins.date > cur.date ||
      (ins.date === cur.date && ins.createdAt > cur.createdAt)
    ) {
      latest.set(ins.pointId, ins);
    }
  }
  const map = new Map<string, EffectiveStatus>();
  latest.forEach((ins, pid) => map.set(pid, ins.conclusion));
  for (const d of disputes) {
    if (d.status === '待裁定') map.set(d.pointId, '待裁定');
  }
  return map;
}

/**
 * 轮椅通行重算：点位核验合并后，相关路线结论跟着重算。
 *
 * 单段可轮椅通行需同时满足：
 * - 路段自身条件（路缘高差、台阶、障碍数）满足 judgeSegment；
 * - 起点、终点点位生效状态均不是「不合格」，也不存在「待裁定」冲突；
 *   限期整改仍可通行（整改状态单独跟踪），未核验不额外阻断（以路段实测为准）。
 */
export function recalcSegmentPassable(
  seg: Pick<RouteSegment, 'fromPointId' | 'toPointId' | 'curbHeight' | 'stepCount' | 'obstacleCount'>,
  statusOf: (pointId: string) => EffectiveStatus,
): { passable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const own = judgeSegment(seg);
  if (!own.passable) reasons.push(...own.reasons);

  const endpoints: Array<{ role: string; pointId: string }> = [
    { role: '起点', pointId: seg.fromPointId },
    { role: '终点', pointId: seg.toPointId },
  ];
  for (const ep of endpoints) {
    const status = statusOf(ep.pointId);
    if (status === '待裁定') {
      reasons.push(`${ep.role}点位两边结论冲突待裁定，暂不能确认轮椅通行`);
    } else if (status === '不合格') {
      reasons.push(`${ep.role}点位核验不合格，无法保障轮椅通行`);
    }
  }
  return { passable: reasons.length === 0, reasons };
}

/** 全线判定重算：在原路段实测汇总基础上，叠加点位生效状态 */
export function recalcRouteVerdict(
  routeName: string,
  segments: RouteSegment[],
  statusOf: (pointId: string) => EffectiveStatus,
): RouteVerdict {
  const ordered = [...segments].sort((a, b) => a.order - b.order);
  const totalLength = Math.round(ordered.reduce((n, s) => n + (Number(s.length) || 0), 0) * 10) / 10;
  const totalObstacles = ordered.reduce((n, s) => n + (Number(s.obstacleCount) || 0), 0);
  const totalSteps = ordered.reduce((n, s) => n + (Number(s.stepCount) || 0), 0);
  const maxCurbHeight = ordered.reduce((n, s) => Math.max(n, Number(s.curbHeight) || 0), 0);
  const reasons: string[] = [];
  ordered.forEach((s) => {
    const r = recalcSegmentPassable(s, statusOf);
    if (!r.passable) reasons.push(`第 ${s.order} 段：${r.reasons.join('；')}`);
  });
  return {
    routeName,
    passable: reasons.length === 0 && ordered.length > 0,
    totalLength,
    totalObstacles,
    totalSteps,
    maxCurbHeight,
    reasons: ordered.length === 0 ? ['尚未串联路段'] : reasons,
  };
}

/** 按点位合并后，落库路段 wheelchairPassable 的重算结果 */
export function recalcRoutes(
  segments: RouteSegment[],
  statusOf: (pointId: string) => EffectiveStatus,
): Array<{ id: string; wheelchairPassable: boolean }> {
  return segments.map((seg) => ({
    id: seg.id,
    wheelchairPassable: recalcSegmentPassable(seg, statusOf).passable,
  }));
}

/** 找出受某点位影响的全部路线名（含该点位的任一路段） */
export function affectedRouteNames(segments: RouteSegment[], pointIds: string[]): string[] {
  const hit = new Set(pointIds);
  const names = new Set<string>();
  for (const s of segments) {
    if (hit.has(s.fromPointId) || hit.has(s.toPointId)) names.add(s.routeName);
  }
  return [...names];
}

export interface RectifyRecalcResult {
  /** 需要新建整改条目的点位及建议内容 */
  toCreate: Array<{
    pointId: string;
    requirement: string;
    unit: string;
    deadline: string;
  }>;
  /** 需要更新状态/复检日期的既有条目 */
  toUpdate: Array<Pick<RectifyPlan, 'id'> & Partial<RectifyPlan>>;
}

/**
 * 整改状态重算：点位核验合并后，整改状态跟着最新生效结论走。
 *
 * - 合格：该点位未结案条目置「已整改」并补复检日期（今天）；
 * - 不合格 / 限期整改：存在未结案条目则保留；曾结案的最新条目复发；没有则新建；
 * - 待裁定 / 未核验：不动整改条目（裁定后再重算）。
 */
export function recalcRectifies(
  pointIds: string[],
  context: {
    inspections: Inspection[];
    disputes: MergeDispute[];
    rectifies: RectifyPlan[];
    points: AccessPoint[];
  },
): RectifyRecalcResult {
  const { inspections, disputes, rectifies, points } = context;
  const statusMap = effectiveStatusMap(inspections, disputes);
  const today = todayStr();
  const toCreate: RectifyRecalcResult['toCreate'] = [];
  const toUpdate: RectifyRecalcResult['toUpdate'] = [];

  for (const pointId of pointIds) {
    const status = statusMap.get(pointId) ?? '未核验';
    const pointPlans = rectifies
      .filter((r) => r.pointId === pointId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const open = pointPlans.filter((r) => r.status !== '已整改');

    if (status === '合格') {
      for (const plan of open) {
        toUpdate.push({ id: plan.id, status: '已整改', recheckDate: plan.recheckDate || today });
      }
      continue;
    }

    if (status === '不合格' || status === '限期整改') {
      const latest = inspections
        .filter((i) => i.pointId === pointId)
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      const requirement =
        status === '不合格'
          ? `按 ${latest?.date ?? today} 核验结论整改：${latest?.problem || '坡度、净宽或占用问题'}`
          : `按 ${latest?.date ?? today} 核验结论限期整改：${
              latest?.problem || '坡度、净宽等指标需达到推荐值'
            }`;
      if (open.length === 0) {
        const newest = pointPlans[0];
        if (newest && newest.status === '已整改') {
          // 曾整改完成、复核再次发现问题：标记复发，沿用原整改要求与责任单位
          toUpdate.push({
            id: newest.id,
            status: '复发',
            recheckDate: '',
            requirement: newest.requirement || requirement,
          });
        } else {
          const point = points.find((p) => p.id === pointId);
          toCreate.push({
            pointId,
            requirement,
            unit: point?.maintainUnit || '待指派责任单位',
            deadline: status === '不合格' ? today : addDays(today, 30),
          });
        }
      }
      // 已有未结案条目时保留现状（不重复新建、不改期限）

    }
    // 待裁定 / 未核验：不触碰整改状态
  }

  return { toCreate, toUpdate };
}
