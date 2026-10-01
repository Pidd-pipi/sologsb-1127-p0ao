import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  MergeCellsOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useOfflineStore } from '../stores/offlineStore';
import { usePointStore } from '../stores/pointStore';
import type { PendingAdjudication } from '../types/offlinePackage';
import { CONCLUSIONS, OCCUPIED_LEVELS, type InspectionConclusion, type OccupiedLevel } from '../types/inspection';
import { judgeInspection } from '../utils/routeCheck';
import { todayStr } from '../utils/format';
import StatusBadge from '../components/common/StatusBadge';
import EmptyState from '../components/common/EmptyState';

interface ItemForm {
  pointId: string;
  date: string;
  inspector: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  conclusion: InspectionConclusion;
  problem: string;
}

function defaultItemForm(): ItemForm {
  return {
    pointId: '',
    date: todayStr(),
    inspector: '督导员 李维',
    slope: 2.5,
    clearWidth: 150,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    conclusion: '合格',
    problem: '',
  };
}

export default function OfflineMerge() {
  const { message, modal } = App.useApp();
  const points = usePointStore((s) => s.points);
  const pointMap = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const {
    packages,
    items,
    adjudications,
    loaded,
    quotaExceeded,
    lastMerge,
    load,
    uploadPackage,
    mergePackages,
    resolveAdjudication,
    deletePackage,
    clearQuotaFlag,
  } = useOfflineStore();

  const [pkgSide, setPkgSide] = useState('督导员 A 组');
  const [pkgNote, setPkgNote] = useState('');
  const [draftItems, setDraftItems] = useState<ItemForm[]>([]);
  const [itemForm, setItemForm] = useState<ItemForm>(defaultItemForm);
  const [merging, setMerging] = useState(false);
  const [resolving, setResolving] = useState<PendingAdjudication | null>(null);
  const [resolution, setResolution] = useState<{
    conclusion: InspectionConclusion;
    slope: number;
    clearWidth: number;
    hasHandrail: boolean;
    tactileContinuous: boolean;
    occupied: OccupiedLevel;
    problem: string;
  }>({
    conclusion: '合格',
    slope: 2.5,
    clearWidth: 150,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  });

  useEffect(() => {
    void load();
  }, [load]);

  const pendingPkgs = packages.filter((p) => p.status === '待合并');
  const pendingAdjs = adjudications.filter((a) => a.status === '待裁定');

  const itemJudgement = useMemo(
    () =>
      judgeInspection({
        slope: itemForm.slope,
        clearWidth: itemForm.clearWidth,
        hasHandrail: itemForm.hasHandrail,
        tactileContinuous: itemForm.tactileContinuous,
        occupied: itemForm.occupied,
      }),
    [itemForm.slope, itemForm.clearWidth, itemForm.hasHandrail, itemForm.tactileContinuous, itemForm.occupied],
  );

  const addDraftItem = () => {
    if (!itemForm.pointId) {
      message.warning('请选择点位');
      return;
    }
    setDraftItems((cur) => [...cur, { ...itemForm }]);
    setItemForm(defaultItemForm());
    message.success('已加入回传条目');
  };

  const removeDraftItem = (idx: number) => {
    setDraftItems((cur) => cur.filter((_, i) => i !== idx));
  };

  const handleUpload = async () => {
    if (!draftItems.length) {
      message.warning('请先添加至少一条回传条目');
      return;
    }
    try {
      await uploadPackage(
        {
          code: `PKG-${todayStr().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
          side: pkgSide.trim() || '未署名采集方',
          collectedAt: new Date().toISOString(),
          note: pkgNote.trim(),
        },
        draftItems.map((it) => ({ ...it, collectedAt: new Date().toISOString() })),
      );
      message.success(`回传包已上传（${draftItems.length} 条），等待合并`);
      setDraftItems([]);
      setPkgNote('');
      clearQuotaFlag();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleMerge = async () => {
    setMerging(true);
    try {
      const result = await mergePackages();
      if (result.mergedItemCount === 0) {
        message.info('没有待合并的回传包');
      } else {
        message.success(
          `合并完成：${result.inspections.length} 条正式记录，${result.pendingCount} 条待裁定`,
        );
      }
      clearQuotaFlag();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
    }
  };

  const openResolve = (adj: PendingAdjudication) => {
    setResolving(adj);
    // 默认采纳甲方（先采集方）结论
    setResolution({
      conclusion: adj.conclusionA,
      slope: adj.sideA.slope,
      clearWidth: adj.sideA.clearWidth,
      hasHandrail: adj.sideA.hasHandrail,
      tactileContinuous: adj.sideA.tactileContinuous,
      occupied: adj.sideA.occupied,
      problem: adj.sideA.problem,
    });
  };

  const handleResolve = async () => {
    if (!resolving) return;
    try {
      await resolveAdjudication(resolving.id, resolution);
      message.success('裁定已处理，正式核验记录已写入');
      setResolving(null);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = (id: string) => {
    modal.confirm({
      title: '删除回传包',
      content: '删除后该包内的补录条目将一并移除，且不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deletePackage(id);
          message.success('回传包已删除');
        } catch (e) {
          message.error(e instanceof Error ? e.message : String(e));
        }
      },
    });
  };

  const packageColumns: ColumnsType<(typeof packages)[number]> = [
    { title: '包编号', dataIndex: 'code', width: 180 },
    { title: '采集方', dataIndex: 'side', width: 140 },
    {
      title: '条目数',
      width: 90,
      render: (_, row) => items.filter((i) => i.packageId === row.id).length,
    },
    {
      title: '采集时间',
      dataIndex: 'collectedAt',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '回传时间',
      dataIndex: 'uploadedAt',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => <StatusBadge value={v} kind="generic" />,
    },
    {
      title: '操作',
      width: 90,
      render: (_, row) =>
        row.status === '待合并' ? (
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row.id)} />
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  const draftColumns: ColumnsType<ItemForm & { key?: string }> = [
    {
      title: '点位',
      width: 180,
      render: (_, row) => pointMap.get(row.pointId)?.name ?? row.pointId,
    },
    { title: '核验日期', dataIndex: 'date', width: 120 },
    { title: '核验人', dataIndex: 'inspector', width: 130 },
    { title: '坡度', dataIndex: 'slope', width: 80, render: (v: number) => `${v}%` },
    { title: '净宽', dataIndex: 'clearWidth', width: 90, render: (v: number) => `${v}cm` },
    {
      title: '结论',
      dataIndex: 'conclusion',
      width: 110,
      render: (v: string) => <StatusBadge value={v} kind="conclusion" />,
    },
    {
      title: '操作',
      width: 70,
      render: (_, __, idx) => (
        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeDraftItem(idx)} />
      ),
    },
  ];

  const adjudicationColumns: ColumnsType<PendingAdjudication> = [
    {
      title: '点位',
      width: 180,
      render: (_, row) => pointMap.get(row.pointId)?.name ?? row.pointId,
    },
    { title: '时段', dataIndex: 'date', width: 120 },
    {
      title: '甲方结论',
      width: 110,
      render: (_, row) => <StatusBadge value={row.conclusionA} kind="conclusion" />,
    },
    {
      title: '乙方结论',
      width: 110,
      render: (_, row) => <StatusBadge value={row.conclusionB} kind="conclusion" />,
    },
    {
      title: '状态',
      width: 100,
      render: (_, row) => <StatusBadge value={row.status} kind="generic" />,
    },
    {
      title: '操作',
      width: 110,
      render: (_, row) =>
        row.status === '待裁定' ? (
          <Button size="small" type="primary" ghost onClick={() => openResolve(row)}>
            裁定处理
          </Button>
        ) : (
          <Typography.Text type="secondary">已裁定</Typography.Text>
        ),
    },
  ];

  if (!loaded) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Typography.Text type="secondary">正在读取回传包数据…</Typography.Text>
      </div>
    );
  }

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">离线回传合并</h1>
          <Typography.Text type="secondary">
            断网核验后按点位合并回传包：同点位两边补录的坡度、净宽都留下，督导员与采集时间分别标清；
            结论不一致先列待裁定，处理前不写正式记录。
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<MergeCellsOutlined />}
            loading={merging}
            onClick={handleMerge}
            disabled={!pendingPkgs.length}
            data-testid="merge-packages"
          >
            合并待合并回传包（{pendingPkgs.length}）
          </Button>
        </Space>
      </div>

      {quotaExceeded ? (
        <Alert
          type="error"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message="浏览器存储容量不足，已拒绝写入"
          description={
            <Space direction="vertical" size={4}>
              <span>
                合并写入已整体回滚，两边回传包均已保留（状态仍为「待合并」）。请清理浏览器存储空间后点击「继续处理」。
              </span>
              <Button
                size="small"
                type="primary"
                onClick={handleMerge}
                loading={merging}
                data-testid="continue-merge"
              >
                继续处理
              </Button>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="待合并回传包" value={pendingPkgs.length} suffix="个" />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="待裁定条目" value={pendingAdjs.length} suffix="条" />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic
              title="累计回传条目"
              value={items.length}
              suffix="条"
              valueStyle={{ color: '#389e0d' }}
            />
          </Card>
        </Col>
      </Row>

      {lastMerge && lastMerge.mergedItemCount > 0 ? (
        <Alert
          type="success"
          showIcon
          message="最近一次合并结果"
          description={
            <Space wrap>
              <Tag color="success">正式记录 {lastMerge.inspections.length} 条</Tag>
              <Tag color="warning">待裁定 {lastMerge.pendingCount} 条</Tag>
              <Tag>涉及点位 {lastMerge.affectedPointIds.size} 个</Tag>
            </Space>
          }
          style={{ marginTop: 16 }}
        />
      ) : null}

      <Card
        title="上传离线回传包"
        size="small"
        style={{ marginTop: 16 }}
        extra={
          <Button type="primary" icon={<CloudUploadOutlined />} onClick={handleUpload} data-testid="upload-package">
            上传回传包（{draftItems.length} 条）
          </Button>
        }
      >
        <Row gutter={12}>
          <Col xs={24} md={8}>
            <Form.Item label="采集方标识">
              <Input value={pkgSide} onChange={(e) => setPkgSide(e.target.value)} placeholder="如 督导员 A 组" />
            </Form.Item>
          </Col>
          <Col xs={24} md={16}>
            <Form.Item label="备注">
              <Input value={pkgNote} onChange={(e) => setPkgNote(e.target.value)} placeholder="选填" />
            </Form.Item>
          </Col>
        </Row>
        <Divider style={{ margin: '8px 0 12px' }} />
        <Form layout="vertical">
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item label="点位" required>
                <Select
                  value={itemForm.pointId || undefined}
                  onChange={(v) => setItemForm((c) => ({ ...c, pointId: v }))}
                  options={points.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
                  placeholder="选择补录点位"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="核验日期">
                <DatePicker
                  value={itemForm.date ? dayjs(itemForm.date) : null}
                  onChange={(d) => setItemForm((c) => ({ ...c, date: d ? d.format('YYYY-MM-DD') : todayStr() }))}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={5}>
              <Form.Item label="核验人">
                <Input
                  value={itemForm.inspector}
                  onChange={(e) => setItemForm((c) => ({ ...c, inspector: e.target.value }))}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={3}>
              <Form.Item label="坡度(%)">
                <InputNumber
                  min={0}
                  max={100}
                  step={0.1}
                  value={itemForm.slope}
                  onChange={(v) => setItemForm((c) => ({ ...c, slope: Number(v ?? 0) }))}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={3}>
              <Form.Item label="净宽(cm)">
                <InputNumber
                  min={0}
                  max={500}
                  value={itemForm.clearWidth}
                  onChange={(v) => setItemForm((c) => ({ ...c, clearWidth: Number(v ?? 0) }))}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={3}>
              <Form.Item label="结论">
                <Select
                  value={itemForm.conclusion}
                  onChange={(v) => setItemForm((c) => ({ ...c, conclusion: v }))}
                  options={CONCLUSIONS.map((c) => ({ value: c, label: c }))}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={3}>
              <Form.Item label="扶手">
                <Switch
                  checked={itemForm.hasHandrail}
                  onChange={(v) => setItemForm((c) => ({ ...c, hasHandrail: v }))}
                  checkedChildren="有"
                  unCheckedChildren="无"
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={3}>
              <Form.Item label="盲道连续">
                <Switch
                  checked={itemForm.tactileContinuous}
                  onChange={(v) => setItemForm((c) => ({ ...c, tactileContinuous: v }))}
                  checkedChildren="连续"
                  unCheckedChildren="断续"
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="占用情况">
                <Select
                  value={itemForm.occupied}
                  onChange={(v) => setItemForm((c) => ({ ...c, occupied: v }))}
                  options={OCCUPIED_LEVELS.map((o) => ({ value: o, label: o }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="问题描述">
                <Input
                  value={itemForm.problem}
                  onChange={(e) => setItemForm((c) => ({ ...c, problem: e.target.value }))}
                  placeholder="选填"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={3}>
              <Form.Item label="建议结论">
                <StatusBadge value={itemJudgement.conclusion} kind="conclusion" bordered />
              </Form.Item>
            </Col>
          </Row>
          <Button onClick={addDraftItem} data-testid="add-draft-item">
            加入回传条目
          </Button>
        </Form>

        <div style={{ marginTop: 12 }}>
          {draftItems.length ? (
            <Table<ItemForm>
              rowKey={(_, idx) => String(idx)}
              size="small"
              pagination={false}
              dataSource={draftItems}
              columns={draftColumns}
            />
          ) : (
            <EmptyState title="暂无待上传条目" description="在上方录入补录实测值后加入" compact />
          )}
        </div>
      </Card>

      <Card title="回传包列表" size="small" style={{ marginTop: 16 }}>
        {packages.length ? (
          <Table
            rowKey="id"
            size="small"
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            dataSource={packages}
            columns={packageColumns}
          />
        ) : (
          <EmptyState title="暂无回传包" description="上传离线回传包后在此列出" compact />
        )}
      </Card>

      <Card title="待裁定条目" size="small" style={{ marginTop: 16 }}>
        {pendingAdjs.length ? (
          <Table<PendingAdjudication>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={pendingAdjs}
            columns={adjudicationColumns}
            expandable={{
              expandedRowRender: (row) => (
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Card size="small" title={`甲方（${row.sideA.side}）`}>
                      <Descriptions column={1} size="small">
                        <Descriptions.Item label="督导员">{row.sideA.inspector}</Descriptions.Item>
                        <Descriptions.Item label="采集时间">
                          {new Date(row.sideA.collectedAt).toLocaleString('zh-CN')}
                        </Descriptions.Item>
                        <Descriptions.Item label="坡度">{row.sideA.slope}%</Descriptions.Item>
                        <Descriptions.Item label="净宽">{row.sideA.clearWidth}cm</Descriptions.Item>
                        <Descriptions.Item label="结论">
                          <StatusBadge value={row.conclusionA} kind="conclusion" />
                        </Descriptions.Item>
                      </Descriptions>
                    </Card>
                  </Col>
                  <Col xs={24} md={12}>
                    <Card size="small" title={`乙方（${row.sideB.side}）`}>
                      <Descriptions column={1} size="small">
                        <Descriptions.Item label="督导员">{row.sideB.inspector}</Descriptions.Item>
                        <Descriptions.Item label="采集时间">
                          {new Date(row.sideB.collectedAt).toLocaleString('zh-CN')}
                        </Descriptions.Item>
                        <Descriptions.Item label="坡度">{row.sideB.slope}%</Descriptions.Item>
                        <Descriptions.Item label="净宽">{row.sideB.clearWidth}cm</Descriptions.Item>
                        <Descriptions.Item label="结论">
                          <StatusBadge value={row.conclusionB} kind="conclusion" />
                        </Descriptions.Item>
                      </Descriptions>
                    </Card>
                  </Col>
                </Row>
              ),
            }}
          />
        ) : (
          <EmptyState title="暂无待裁定条目" description="同点位两边结论不一致时在此列出" compact />
        )}
      </Card>

      <Modal
        title="裁定处理"
        open={Boolean(resolving)}
        onCancel={() => setResolving(null)}
        onOk={handleResolve}
        okText="采纳并写入正式记录"
        destroyOnClose
      >
        {resolving ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={`点位：${pointMap.get(resolving.pointId)?.name ?? resolving.pointId} · 时段：${resolving.date}`}
              description="两边结论不一致，裁定前不写正式记录。请选择采纳的结论与实测值。"
            />
            <Row gutter={12}>
              <Col span={12}>
                <Button
                  block
                  type={resolution.conclusion === resolving.conclusionA ? 'primary' : 'default'}
                  onClick={() =>
                    setResolution((c) => ({
                      ...c,
                      conclusion: resolving.conclusionA,
                      slope: resolving.sideA.slope,
                      clearWidth: resolving.sideA.clearWidth,
                      hasHandrail: resolving.sideA.hasHandrail,
                      tactileContinuous: resolving.sideA.tactileContinuous,
                      occupied: resolving.sideA.occupied,
                      problem: resolving.sideA.problem,
                    }))
                  }
                >
                  采纳甲方（{resolving.conclusionA}）
                </Button>
              </Col>
              <Col span={12}>
                <Button
                  block
                  type={resolution.conclusion === resolving.conclusionB ? 'primary' : 'default'}
                  onClick={() =>
                    setResolution((c) => ({
                      ...c,
                      conclusion: resolving.conclusionB,
                      slope: resolving.sideB.slope,
                      clearWidth: resolving.sideB.clearWidth,
                      hasHandrail: resolving.sideB.hasHandrail,
                      tactileContinuous: resolving.sideB.tactileContinuous,
                      occupied: resolving.sideB.occupied,
                      problem: resolving.sideB.problem,
                    }))
                  }
                >
                  采纳乙方（{resolving.conclusionB}）
                </Button>
              </Col>
            </Row>
            <Form layout="vertical">
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="裁定结论">
                    <Select
                      value={resolution.conclusion}
                      onChange={(v) => setResolution((c) => ({ ...c, conclusion: v }))}
                      options={CONCLUSIONS.map((c) => ({ value: c, label: c }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="占用情况">
                    <Select
                      value={resolution.occupied}
                      onChange={(v) => setResolution((c) => ({ ...c, occupied: v }))}
                      options={OCCUPIED_LEVELS.map((o) => ({ value: o, label: o }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="坡度(%)">
                    <InputNumber
                      min={0}
                      max={100}
                      step={0.1}
                      value={resolution.slope}
                      onChange={(v) => setResolution((c) => ({ ...c, slope: Number(v ?? 0) }))}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="净宽(cm)">
                    <InputNumber
                      min={0}
                      max={500}
                      value={resolution.clearWidth}
                      onChange={(v) => setResolution((c) => ({ ...c, clearWidth: Number(v ?? 0) }))}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="扶手">
                    <Switch
                      checked={resolution.hasHandrail}
                      onChange={(v) => setResolution((c) => ({ ...c, hasHandrail: v }))}
                      checkedChildren="有"
                      unCheckedChildren="无"
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="盲道连续">
                    <Switch
                      checked={resolution.tactileContinuous}
                      onChange={(v) => setResolution((c) => ({ ...c, tactileContinuous: v }))}
                      checkedChildren="连续"
                      unCheckedChildren="断续"
                    />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="问题描述">
                    <Input.TextArea
                      rows={2}
                      value={resolution.problem}
                      onChange={(e) => setResolution((c) => ({ ...c, problem: e.target.value }))}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
