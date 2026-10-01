import type {
  Inspection,
  InspectionConclusion,
  InspectionMeasure,
  OfflineSide,
} from '../types/inspection';
import type {
  MergeDispute,
  OfflineInspectionPack,
} from '../types/offline';
import { makeId, toPlain } from './format';
import { judgeInspection } from './routeCheck';

/**
 * 断网核验离线回传包合并引擎（纯计算部分）。
 *
 * 规则（需求口径）：
 * 1. 按「点位 + 同一时段（核验日期）」把 A / B 两侧回传包配对；
 * 2. 同一个点位两边补录的坡度、净宽都留下，督导员和采集时间分别标清；
 * 3. 两侧结论一致：直接生成正式核验记录；
 * 4. 两侧结论不同：先生成「待裁定」单，处理（裁定）前不写正式记录；
 * 5. 只有单边回传：保持 pending，等另一侧回传包到达后再合并。
 */

/** 时段键：同一点位同一核验日期视为同一时段 */
export function timeWindowKey(pointId: string, date: string): string {
  return `${pointId}@${date}`;
}

/** 采集时间 ISO 转可展示文本 */
export function formatCollectedAt(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/** 按实测值复算结论（两侧补录均以统一阈值口径结论入包，合并时再校一次） */
export function concludePack(
  pack: Pick<
    OfflineInspectionPack,
    'slope' | 'clearWidth' | 'hasHandrail' | 'tactileContinuous' | 'occupied'
  >,
): InspectionConclusion {
  return judgeInspection({
    slope: pack.slope,
    clearWidth: pack.clearWidth,
    hasHandrail: pack.hasHandrail,
    tactileContinuous: pack.tactileContinuous,
    occupied: pack.occupied,
  }).conclusion;
}

export function packToMeasure(pack: OfflineInspectionPack): InspectionMeasure {
  return {
    side: pack.side,
    inspector: pack.inspector,
    collectedAt: pack.collectedAt,
    slope: pack.slope,
    clearWidth: pack.clearWidth,
    hasHandrail: pack.hasHandrail,
    tactileContinuous: pack.tactileContinuous,
    occupied: pack.occupied,
    conclusion: pack.conclusion,
    problem: pack.problem,
  };
}

/** 采集时间较晚的一侧排在前面，结论一致时以其为正式记录取值依据；相同则 B 侧优先 */
export function orderMeasures(measures: InspectionMeasure[]): InspectionMeasure[] {
  return [...measures].sort((a, b) => {
    if (a.collectedAt !== b.collectedAt) return a.collectedAt < b.collectedAt ? 1 : -1;
    return a.side === b.side ? 0 : a.side === 'B' ? -1 : 1;
  });
}

/** 配对结果单元 */
export interface PairUnit {
  pointId: string;
  date: string;
  timeWindow: string;
  /** 该时段两侧包（0、1 或 2 个） */
  packs: OfflineInspectionPack[];
  /** 是否两侧到齐且结论一致，可直接合并 */
  agree: boolean;
  /** 是否两侧到齐但结论不一致，需待裁定 */
  conflict: boolean;
}

/**
 * 把待处理（pending / rejected）回传包按点位 + 时段分组配对。
 * rejected 的包同样参与：容量恢复后从这里继续处理。
 * 同一侧在同一时段有多包（重传/重复补录）时，每侧取采集时间最晚的一包配对，
 * 其余包保持原状（仍在清单中可见，不参与本次合并）。
 */
export function pairPacks(packs: OfflineInspectionPack[]): PairUnit[] {
  const waiting = packs.filter((p) => p.status === 'pending' || p.status === 'rejected');
  const groups = new Map<string, OfflineInspectionPack[]>();
  for (const pack of waiting) {
    const key = pack.timeWindow || timeWindowKey(pack.pointId, pack.date);
    groups.set(key, [...(groups.get(key) ?? []), pack]);
  }
  const units: PairUnit[] = [];
  groups.forEach((list, key) => {
    const latestOfSide = (side: OfflineSide) =>
      list
        .filter((p) => p.side === side)
        .sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1))[0];
    const a = latestOfSide('A');
    const b = latestOfSide('B');
    const paired = [a, b].filter(Boolean) as OfflineInspectionPack[];
    const unit: PairUnit = {
      pointId: list[0].pointId,
      date: list[0].date,
      timeWindow: key,
      packs: paired,
      agree: false,
      conflict: false,
    };
    if (a && b) {
      unit.agree = a.conclusion === b.conclusion;
      unit.conflict = a.conclusion !== b.conclusion;
    }
    units.push(unit);
  });
  return units.sort((x, y) => (x.date < y.date ? -1 : 1));
}

/** 结论一致：据两侧补录构造正式核验记录（不落库，由调用方在事务内写入） */
export function buildAgreedInspection(
  unit: PairUnit,
  nowIso: string,
): { inspection: Inspection; measures: InspectionMeasure[]; primary: InspectionMeasure } {
  const measures = orderMeasures(unit.packs.map(packToMeasure));
  const primary = measures[0];
  const inspection: Inspection = toPlain({
    id: `ins-merge-${unit.timeWindow}`,
    pointId: unit.pointId,
    date: unit.date,
    // 正式记录的核验人取主值一侧，两边督导员在 measures 内分别标清
    inspector: primary.inspector,
    slope: primary.slope,
    clearWidth: primary.clearWidth,
    hasHandrail: primary.hasHandrail,
    tactileContinuous: primary.tactileContinuous,
    occupied: primary.occupied,
    conclusion: primary.conclusion,
    problem: primary.problem,
    createdAt: nowIso,
    measures,
    mergedFromDispute: false,
  });
  return { inspection, measures, primary };
}

/** 结论不一致：构造待裁定单（不落正式记录） */
export function buildDispute(unit: PairUnit, nowIso: string): MergeDispute {
  const measures = orderMeasures(unit.packs.map(packToMeasure));
  const conclusions = [...new Set(unit.packs.map((p) => p.conclusion))] as InspectionConclusion[];
  return toPlain({
    id: makeId('dsp'),
    pointId: unit.pointId,
    date: unit.date,
    timeWindow: unit.timeWindow,
    measures,
    conclusions,
    status: '待裁定',
    packIds: [unit.packs[0].id, unit.packs[1].id] as [string, string],
    createdAt: nowIso,
  });
}

/** 督导员裁定：以被采用一侧的实测值生成正式记录（裁定人记录在待裁定单上） */
export function buildResolvedInspection(
  dispute: MergeDispute,
  side: OfflineSide,
  note: string,
  nowIso: string,
): Inspection {
  const measures = orderMeasures(dispute.measures);
  const primary = measures.find((m) => m.side === side) ?? measures[0];
  const otherNote = measures
    .filter((m) => m.side !== side)
    .map((m) => `${m.side} 侧（${m.inspector} ${formatCollectedAt(m.collectedAt)}）结论为 ${m.conclusion}，未采纳`)
    .join('；');
  return toPlain({
    id: `ins-merge-${dispute.timeWindow}`,
    pointId: dispute.pointId,
    date: dispute.date,
    inspector: primary.inspector,
    slope: primary.slope,
    clearWidth: primary.clearWidth,
    hasHandrail: primary.hasHandrail,
    tactileContinuous: primary.tactileContinuous,
    occupied: primary.occupied,
    conclusion: primary.conclusion,
    problem: [primary.problem, note ? `裁定说明：${note}` : '', otherNote].filter(Boolean).join('；'),
    createdAt: nowIso,
    measures,
    mergedFromDispute: true,
    disputeId: dispute.id,
  });
}
