import { mergePackages, resolveAdjudication } from '../src/utils/mergePackages';
import { recalcAfterMerge } from '../src/utils/recalcAfterMerge';
import type { OfflinePackage, OfflinePackageItem } from '../src/types/offlinePackage';
import type { Inspection } from '../src/types/inspection';
import type { RouteSegment } from '../src/types/route';
import type { RectifyPlan } from '../src/types/rectify';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL: ${msg}`);
  }
}

const now = '2026-10-01T00:00:00.000Z';

function pkg(id: string, side: string): OfflinePackage {
  return { id, code: `PKG-${id}`, side, collectedAt: now, uploadedAt: now, status: '待合并', note: '' };
}

function item(
  id: string,
  packageId: string,
  pointId: string,
  date: string,
  inspector: string,
  slope: number,
  clearWidth: number,
  conclusion: Inspection['conclusion'],
  collectedAt: string,
): OfflinePackageItem {
  return {
    id,
    packageId,
    pointId,
    date,
    inspector,
    collectedAt,
    slope,
    clearWidth,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    conclusion,
    problem: '',
  };
}

// Test 1: 同点位同时段两边结论一致 → 写一条正式记录，双边测量都留下
{
  const pkgs = [pkg('p1', '督导员 A 组'), pkg('p2', '督导员 B 组')];
  const items = [
    item('i1', 'p1', 'pt-1', '2026-09-01', '督导员 甲', 3.2, 150, '合格', '2026-09-01T09:00:00.000Z'),
    item('i2', 'p2', 'pt-1', '2026-09-01', '督导员 乙', 3.4, 148, '合格', '2026-09-01T10:00:00.000Z'),
  ];
  const result = mergePackages(pkgs, items, [], [], now);
  assert(result.inspections.length === 1, 'test1: 生成一条正式记录');
  assert(result.adjudications.length === 0, 'test1: 无待裁定');
  const insp = result.inspections[0];
  assert(insp.sides?.length === 2, 'test1: 双边测量都留下 (sides.length=2)');
  assert(insp.slope === 3.2 && insp.clearWidth === 150, 'test1: 主口径为甲方（先采集方）');
  assert(insp.inspector === '督导员 甲', 'test1: 督导员分别标清（甲方）');
  assert(insp.sides?.[1].inspector === '督导员 乙', 'test1: 督导员分别标清（乙方）');
  assert(insp.sides?.[0].collectedAt === '2026-09-01T09:00:00.000Z', 'test1: 采集时间分别标清（甲方）');
  assert(insp.sides?.[1].collectedAt === '2026-09-01T10:00:00.000Z', 'test1: 采集时间分别标清（乙方）');
  assert(insp.packageIds?.length === 2, 'test1: 来源包 id 列表');
  console.log('test1 pass');
}

// Test 2: 同点位同时段两边结论不一致 → 列待裁定，不写正式记录
{
  const pkgs = [pkg('p1', '督导员 A 组'), pkg('p2', '督导员 B 组')];
  const items = [
    item('i1', 'p1', 'pt-2', '2026-09-02', '督导员 甲', 3.2, 150, '合格', '2026-09-02T09:00:00.000Z'),
    item('i2', 'p2', 'pt-2', '2026-09-02', '督导员 乙', 9.5, 82, '不合格', '2026-09-02T10:00:00.000Z'),
  ];
  const result = mergePackages(pkgs, items, [], [], now);
  assert(result.inspections.length === 0, 'test2: 不写正式记录');
  assert(result.adjudications.length === 1, 'test2: 生成一条待裁定');
  const adj = result.adjudications[0];
  assert(adj.status === '待裁定', 'test2: 待裁定状态');
  assert(adj.conclusionA === '合格' && adj.conclusionB === '不合格', 'test2: 两边结论分别记录');
  assert(adj.sideA.inspector === '督导员 甲' && adj.sideB.inspector === '督导员 乙', 'test2: 两边督导员分别标清');
  console.log('test2 pass');
}

// Test 3: 不同点位各自合并
{
  const pkgs = [pkg('p1', '督导员 A 组')];
  const items = [
    item('i1', 'p1', 'pt-1', '2026-09-01', '督导员 甲', 3.2, 150, '合格', '2026-09-01T09:00:00.000Z'),
    item('i2', 'p1', 'pt-2', '2026-09-01', '督导员 甲', 9.5, 82, '不合格', '2026-09-01T09:05:00.000Z'),
  ];
  const result = mergePackages(pkgs, items, [], [], now);
  assert(result.inspections.length === 2, 'test3: 不同点位各自生成记录');
  assert(result.affectedPointIds.size === 2, 'test3: 受影响点位 2 个');
  console.log('test3 pass');
}

// Test 4: 裁定后写正式记录
{
  const pkgs = [pkg('p1', '督导员 A 组'), pkg('p2', '督导员 B 组')];
  const items = [
    item('i1', 'p1', 'pt-3', '2026-09-03', '督导员 甲', 3.2, 150, '合格', '2026-09-03T09:00:00.000Z'),
    item('i2', 'p2', 'pt-3', '2026-09-03', '督导员 乙', 9.5, 82, '不合格', '2026-09-03T10:00:00.000Z'),
  ];
  const merge = mergePackages(pkgs, items, [], [], now);
  const adj = merge.adjudications[0];
  const { inspection, adjudication } = resolveAdjudication(
    adj,
    {
      conclusion: '不合格',
      slope: 9.5,
      clearWidth: 82,
      hasHandrail: false,
      tactileContinuous: false,
      occupied: '长期占用',
      problem: '盲道被占用',
    },
    [],
    now,
  );
  assert(adjudication.status === '已裁定', 'test4: 裁定状态已更新');
  assert(inspection.conclusion === '不合格', 'test4: 裁定结论写入正式记录');
  assert(inspection.sides?.length === 2, 'test4: 双边测量保留');
  console.log('test4 pass');
}

// Test 5: 重算路线轮椅通行结论 — 途经点位最新不合格 → 路段不可通行
{
  const inspections: Inspection[] = [
    {
      id: 'ins-1',
      pointId: 'pt-1',
      date: '2026-09-01',
      inspector: '甲',
      slope: 3,
      clearWidth: 150,
      hasHandrail: true,
      tactileContinuous: true,
      occupied: '无',
      conclusion: '合格',
      problem: '',
      createdAt: now,
    },
    {
      id: 'ins-2',
      pointId: 'pt-2',
      date: '2026-09-01',
      inspector: '乙',
      slope: 9.5,
      clearWidth: 82,
      hasHandrail: false,
      tactileContinuous: false,
      occupied: '长期占用',
      conclusion: '不合格',
      problem: '',
      createdAt: now,
    },
  ];
  const routes: RouteSegment[] = [
    {
      id: 'rts-1',
      routeName: '路线一',
      fromPointId: 'pt-1',
      toPointId: 'pt-2',
      length: 100,
      obstacleCount: 0,
      stepCount: 0,
      curbHeight: 2,
      wheelchairPassable: true,
      order: 1,
      createdAt: now,
    },
  ];
  const rectifies: RectifyPlan[] = [];
  const result = recalcAfterMerge(new Set(['pt-2']), inspections, routes, rectifies, now);
  assert(result.routeUpdates.length === 1, 'test5: 路线通行结论需重算');
  assert(result.routeUpdates[0].wheelchairPassable === false, 'test5: 途经不合格点位 → 不可通行');
  assert(result.newRectifies.length === 1, 'test5: 不合格点位补建整改条目');
  assert(result.newRectifies[0].pointId === 'pt-2', 'test5: 整改条目对应点位');
  console.log('test5 pass');
}

// Test 6: 重算整改状态 — 最新合格 → 销项
{
  const inspections: Inspection[] = [
    {
      id: 'ins-1',
      pointId: 'pt-1',
      date: '2026-09-01',
      inspector: '甲',
      slope: 3,
      clearWidth: 150,
      hasHandrail: true,
      tactileContinuous: true,
      occupied: '无',
      conclusion: '合格',
      problem: '',
      createdAt: now,
    },
  ];
  const routes: RouteSegment[] = [];
  const rectifies: RectifyPlan[] = [
    {
      id: 'rct-1',
      pointId: 'pt-1',
      requirement: '整改',
      unit: '单位',
      deadline: '2026-09-10',
      recheckDate: '',
      status: '待整改',
      createdAt: now,
    },
  ];
  const result = recalcAfterMerge(new Set(['pt-1']), inspections, routes, rectifies, now);
  assert(result.rectifyUpdates.length === 1, 'test6: 整改条目需更新');
  assert(result.rectifyUpdates[0].patch.status === '已整改', 'test6: 最新合格 → 销项');
  console.log('test6 pass');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
