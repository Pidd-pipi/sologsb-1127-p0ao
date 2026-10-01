// 端到端核验脚本（不入仓库、不进构建）：node --import tsx ...
import 'fake-indexeddb/auto';
import { db } from '../src/db/index.ts';
import { useOfflineStore } from '../src/stores/offlineStore.ts';
import { usePointStore } from '../src/stores/pointStore.ts';
import { useRouteStore } from '../src/stores/routeStore.ts';
import { effectiveStatusMap } from '../src/utils/recalc.ts';

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await db.open();
  await usePointStore.getState().load();
  await useRouteStore.getState().load();
  await useOfflineStore.getState().load();

  const pt = 'pt-1001'; // 已有一条「合格」历史核验；路线 东单—王府井 经过 pt-1001/pt-1002
  const date = '2026-09-30';
  const t = (h, m) => new Date(`2026-09-30T${h}:${m}:00+08:00`).toISOString();

  // ---------- 场景 1：结论一致（都合格）----------
  console.log('\n[1] 同点位同时段两侧结论一致 → 直接合并落正式记录');
  await useOfflineStore.getState().ingestPack({
    pointId: pt, side: 'A', date, inspector: '督导员 甲', collectedAt: t('09', '10'),
    slope: 2.0, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', problem: '',
  });
  await useOfflineStore.getState().ingestPack({
    pointId: pt, side: 'B', date, inspector: '督导员 乙', collectedAt: t('10', '05'),
    slope: 2.8, clearWidth: 142, hasHandrail: true, tactileContinuous: true, occupied: '无', problem: '',
  });
  let r = await useOfflineStore.getState().processPacks();
  assert(r.merged === 1, '直接合并 1 组');
  assert(r.disputes === 0, '无待裁定');
  let insp = await db.inspections.where('pointId').equals(pt).toArray();
  const merged = insp.find((i) => i.id === `ins-merge-${pt}@${date}`);
  assert(!!merged, '正式核验记录已写入');
  assert(merged.measures.length === 2, '两边坡度/净宽均留档（2 条 measures）');
  assert(merged.inspector === '督导员 乙', '正式记录取采集时间较晚一侧（乙）');
  assert(merged.slope === 2.8 && merged.clearWidth === 142, '正式值取较晚一侧实测');
  const sides = merged.measures.map((m) => m.side).sort().join('');
  assert(sides === 'AB', '两侧侧别 A/B 分别标清');

  // ---------- 场景 2：结论不一致 → 待裁定，处理前不写正式记录 ----------
  console.log('\n[2] 两侧结论不同 → 先列待裁定，不写正式记录，点位/路线阻断');
  const d2 = '2026-10-01';
  await useOfflineStore.getState().ingestPack({
    pointId: 'pt-1002', side: 'A', date: d2, inspector: '督导员 甲', collectedAt: t('08', '30'),
    slope: 3, clearWidth: 130, hasHandrail: true, tactileContinuous: true, occupied: '无', problem: '',
  });
  await useOfflineStore.getState().ingestPack({
    pointId: 'pt-1002', side: 'B', date: d2, inspector: '督导员 乙', collectedAt: t('08', '50'),
    slope: 9.8, clearWidth: 80, hasHandrail: false, tactileContinuous: false, occupied: '长期占用', problem: '严重',
  });
  const inspCountBefore = (await db.inspections.toArray()).length;
  r = await useOfflineStore.getState().processPacks();
  const inspCountAfter = (await db.inspections.toArray()).length;
  assert(r.disputes === 1 && r.merged === 0, '生成 1 张待裁定单、未直接合并');
  assert(inspCountBefore === inspCountAfter, '裁定前未新增正式核验记录');
  const disputes = await db.mergeDisputes.toArray();
  const open = disputes.find((d) => d.pointId === 'pt-1002' && d.status === '待裁定');
  assert(!!open, '待裁定单存在且状态为「待裁定」');
  assert(open.measures.length === 2, '待裁定单保留两边补录值与督导员/采集时间');

  // 点位生效状态 = 待裁定；相关路线重算为不可通行
  await usePointStore.getState().load();
  await useRouteStore.getState().load();
  await useOfflineStore.getState().load();
  const smap = effectiveStatusMap(usePointStore.getState().inspections, useOfflineStore.getState().disputes);
  assert(smap.get('pt-1002') === '待裁定', 'pt-1002 生效状态为待裁定');
  const segs = await db.routes.toArray();
  const seg = segs.find((s) => s.routeName === '东单—王府井轮椅通道');
  assert(seg.wheelchairPassable === false, '相关路线段已重算为不可轮椅通行（端点待裁定）');

  // ---------- 场景 3：容量不足 → 拒绝写入、两边包保留 ----------
  console.log('\n[3] 容量不足演练 → 拒绝写入、回传包保留，关闭后可继续');
  const d3 = '2026-10-02';
  await useOfflineStore.getState().ingestPack({
    pointId: 'pt-1003', side: 'A', date: d3, inspector: '督导员 甲', collectedAt: t('09', '00'),
    slope: 2, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', problem: '',
  });
  await useOfflineStore.getState().ingestPack({
    pointId: 'pt-1003', side: 'B', date: d3, inspector: '督导员 乙', collectedAt: t('09', '20'),
    slope: 2.4, clearWidth: 148, hasHandrail: true, tactileContinuous: true, occupied: '无', problem: '',
  });
  useOfflineStore.getState().setSimulateFull(true);
  r = await useOfflineStore.getState().processPacks();
  assert(r.rejected === 1, '1 组因容量不足被拒绝');
  let p3 = await db.offlinePacks.where('pointId').equals('pt-1003').toArray();
  assert(p3.every((p) => p.status === 'rejected'), '两边回传包均保留为 rejected');
  assert(!(await db.inspections.get(`ins-merge-pt-1003@${d3}`)), '没有写入正式记录');

  // 容量恢复 → 再次处理成功
  useOfflineStore.getState().setSimulateFull(false);
  r = await useOfflineStore.getState().processPacks();
  assert(r.merged === 1 && r.rejected === 0, '容量恢复后接着处理：合并成功');
  p3 = await db.offlinePacks.where('pointId').equals('pt-1003').toArray();
  assert(p3.every((p) => p.status === 'merged'), '两边包转为已合并');

  // ---------- 场景 4：裁定后落正式记录、路线恢复、整改重算 ----------
  console.log('\n[4] 完成裁定 → 写正式记录，路线与整改状态重算');
  // 采 B 侧（不合格）→ 应产生整改条目；路线仍不可通行
  await useOfflineStore.getState().resolveDispute(open.id, 'B', '督导组长', '现场复核以 B 侧为准');
  const resolved = await db.mergeDisputes.get(open.id);
  assert(resolved.status === '已裁定' && resolved.resolvedSide === 'B', '待裁定单已裁定，采纳 B 侧');
  const finalInsp = await db.inspections.get(`ins-merge-pt-1002@${d2}`);
  assert(!!finalInsp && finalInsp.conclusion === '不合格', '正式记录已写入且结论为不合格');
  assert(finalInsp.mergedFromDispute === true, '正式记录标记来自冲突裁定');
  assert(finalInsp.measures.length === 2, '正式记录仍保留两边补录数据');
  const rct = await db.rectifies.where('pointId').equals('pt-1002').toArray();
  assert(rct.some((x) => x.status !== '已整改'), '不合格点位已补建/保留整改条目');

  // 改裁 A 侧不行（已裁定）→ 报错
  let threw = false;
  try {
    await useOfflineStore.getState().resolveDispute(open.id, 'A', 'x', '');
  } catch {
    threw = true;
  }
  assert(threw, '已裁定单不能重复裁定');

  // 容量不足时裁定被拒绝且待裁定单保留
  // 再造一个冲突
  const d5 = '2026-10-03';
  await useOfflineStore.getState().ingestPack({
    pointId: 'pt-1004', side: 'A', date: d5, inspector: '甲', collectedAt: t('09', '00'),
    slope: 3, clearWidth: 130, hasHandrail: true, tactileContinuous: true, occupied: '无', problem: '',
  });
  await useOfflineStore.getState().ingestPack({
    pointId: 'pt-1004', side: 'B', date: d5, inspector: '乙', collectedAt: t('09', '10'),
    slope: 9, clearWidth: 80, hasHandrail: false, tactileContinuous: false, occupied: '长期占用', problem: '',
  });
  await useOfflineStore.getState().processPacks();
  const d5list = (await db.mergeDisputes.toArray()).filter((x) => x.pointId === 'pt-1004');
  useOfflineStore.getState().setSimulateFull(true);
  let resolveRejected = false;
  try {
    await useOfflineStore.getState().resolveDispute(d5list[0].id, 'A', '组长', '');
  } catch (e) {
    resolveRejected = /容量不足/.test(e.message);
  }
  assert(resolveRejected, '容量不足时裁定被拒绝并提示回传包保留');
  const stillOpen = await db.mergeDisputes.get(d5list[0].id);
  assert(stillOpen.status === '待裁定', '待裁定单原样保留，恢复后可继续裁定');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
