import type { Inspection } from '../types/inspection';
import type { RouteSegment } from '../types/route';
import type { RectifyPlan, RectifyStatus } from '../types/rectify';
import { judgeSegment } from './routeCheck';
import { makeId, toPlain, todayStr } from './format';

export interface RecalcResult {
  /** 需要更新 wheelchairPassable 的路段 */
  routeUpdates: { id: string; wheelchairPassable: boolean }[];
  /** 需要新建的整改条目 */
  newRectifies: RectifyPlan[];
  /** 需要更新状态的整改条目 */
  rectifyUpdates: { id: string; patch: Partial<RectifyPlan> }[];
}

/** 取每个点位最新一次核验（按核验日期，同日按采集时间） */
function latestByPoint(inspections: Inspection[]): Map<string, Inspection> {
  const map = new Map<string, Inspection>();
  for (const insp of inspections) {
    const cur = map.get(insp.pointId);
    if (!cur) {
      map.set(insp.pointId, insp);
      continue;
    }
    if (
      cur.date < insp.date ||
      (cur.date === insp.date && (cur.collectedAt ?? cur.createdAt) < (insp.collectedAt ?? insp.createdAt))
    ) {
      map.set(insp.pointId, insp);
    }
  }
  return map;
}

/**
 * 点位核验合并后重算：
 * 1. 相关路线的轮椅通行结论（途经点位最新核验不合格则该段不可通行）；
 * 2. 相关点位的整改状态（最新合格则销项，不合格/限期整改则补建整改条目）。
 *
 * 纯函数：不写库，返回待写入的结果。
 */
export function recalcAfterMerge(
  affectedPointIds: Set<string>,
  inspections: Inspection[],
  routes: RouteSegment[],
  rectifies: RectifyPlan[],
  now: string,
): RecalcResult {
  const latest = latestByPoint(inspections);
  const routeUpdates: { id: string; wheelchairPassable: boolean }[] = [];
  const newRectifies: RectifyPlan[] = [];
  const rectifyUpdates: { id: string; patch: Partial<RectifyPlan> }[] = [];

  // 1. 重算受影响路线的轮椅通行结论
  const affectedRoutes = routes.filter(
    (seg) => affectedPointIds.has(seg.fromPointId) || affectedPointIds.has(seg.toPointId),
  );
  for (const seg of affectedRoutes) {
    const segJudge = judgeSegment(seg);
    const fromLatest = latest.get(seg.fromPointId);
    const toLatest = latest.get(seg.toPointId);
    // 途经点位最新核验不合格 → 该段不可通行
    const fromBlocked = fromLatest?.conclusion === '不合格';
    const toBlocked = toLatest?.conclusion === '不合格';
    const passable = segJudge.passable && !fromBlocked && !toBlocked;
    if (passable !== seg.wheelchairPassable) {
      routeUpdates.push({ id: seg.id, wheelchairPassable: passable });
    }
  }

  // 2. 重算受影响点位的整改状态
  for (const pointId of affectedPointIds) {
    const insp = latest.get(pointId);
    if (!insp) continue;
    const activePlans = rectifies.filter((r) => r.pointId === pointId && r.status !== '已整改');

    if (insp.conclusion === '合格') {
      // 最新合格 → 销项
      for (const plan of activePlans) {
        rectifyUpdates.push({
          id: plan.id,
          patch: { status: '已整改', recheckDate: todayStr() },
        });
      }
    } else {
      // 不合格 / 限期整改 → 确保有在跟的整改条目
      if (activePlans.length === 0) {
        newRectifies.push(
          toPlain({
            id: makeId('rct'),
            pointId,
            requirement: `按 ${insp.date} 核验结论整改：${insp.problem || '坡度、净宽或占用问题'}`,
            unit: '待指派责任单位',
            deadline: todayStr(),
            recheckDate: '',
            status: '待整改' as RectifyStatus,
            createdAt: now,
          }),
        );
      }
    }
  }

  return { routeUpdates, newRectifies, rectifyUpdates };
}

/**
 * 判定浏览器存储容量不足（QuotaExceededError）。
 * Dexie 在事务超出配额时抛 DOMException，name 为 QuotaExceededError。
 */
export function isQuotaError(e: unknown): boolean {
  if (e instanceof DOMException) {
    return e.name === 'QuotaExceededError' || e.code === 22;
  }
  if (e instanceof Error) {
    return /quota|storage|容量|配额/i.test(e.message);
  }
  return false;
}
