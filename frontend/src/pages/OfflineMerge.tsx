import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
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
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudSyncOutlined,
  MergeCellsOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import EmptyState from '../components/common/EmptyState';
import StatusBadge from '../components/common/StatusBadge';
import { useOfflineStore, type MergeProcessReport } from '../stores/offlineStore';
import { usePointStore } from '../stores/pointStore';
import { OCCUPIED_LEVELS, type OfflineSide } from '../types/inspection';
import type { MergeDispute, OfflineInspectionPack, PackInput } from '../types/offline';
import { formatCollectedAt } from '../utils/mergePacks';
import { todayStr } from '../utils/format';

const PACK_STATUS_BADGE: Record<OfflineInspectionPack['status'], string> = {
  pending: '待配对',
  dispute: '待裁定',
  merged: '已合并',
  rejected: '已拒绝',
};

interface PackFormState {
  pointId: string;
  side: OfflineSide;
  date: string;
  inspector: string;
  collectedAt: dayjs.Dayjs;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: PackInput['occupied'];
  problem: string;
}

export default function OfflineMerge() {
  const { message, modal } = App.useApp();
  const points = usePointStore((s) => s.points);
  const {
    packs,
    disputes,
    loaded,
    load,
    ingestPack,
    processPacks,
    resolveDispute,
    simulateFull,
    setSimulateFull,
    lastReport,
  } = useOfflineStore();

  const [form] = Form.useForm<PackFormState>();
  const [submitting, setSubmitting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [activeDispute, setActiveDispute] = useState<MergeDispute | null>(null);
  const [resolveSide, setResolveSide] = useState<OfflineSide>('A');
  const [resolvedBy, setResolvedBy] = useState('督导员 李维');
  const [resolveNote, setResolveNote] = useState('');
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const pointName = useMemo(
    () => (id: string) => points.find((p) => p.id === id)?.name ?? id,
    [points],
  );

  const stats = useMemo(() => {
    const pending = packs.filter((p) => p.status === 'pending' || p.status === 'rejected').length;
    const dispute = packs.filter((p) => p.status === 'dispute').length;
    const openDisputes = disputes.filter((d) => d.status === '待裁定').length;
    const merged = packs.filter((p) => p.status === 'merged').length;
    const rejected = packs.filter((p) => p.status === 'rejected').length;
    return { pending, dispute, openDisputes, merged, rejected };
  }, [packs, disputes]);

  const pointOptions = useMemo(
    () => points.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
    [points],
  );

  const fillDemo = (side: OfflineSide) => {
    const pt = points[0]?.id;
    form.setFieldsValue({
      pointId: pt,
      side,
      date: todayStr(),
      inspector: side === 'A' ? '督导员 李维' : '督导员 王岚',
      collectedAt: dayjs(),
      slope: side === 'A' ? 3.2 : 9.1,
      clearWidth: side === 'A' ? 150 : 86,
      hasHandrail: true,
      tactileContinuous: true,
      occupied: '无',
      problem: side === 'A' ? '' : '坡道被长期占用，坡度过大、净宽不足',
    });
  };

  const handleIngest = async () => {
    try {
      const v = await form.validateFields();
      setSubmitting(true);
      await ingestPack({
        pointId: v.pointId,
        side: v.side,
        date: v.date || todayStr(),
        inspector: v.inspector,
        collectedAt: (v.collectedAt ?? dayjs()).toISOString(),
        slope: Number(v.slope),
        clearWidth: Number(v.clearWidth),
        hasHandrail: v.hasHandrail,
        tactileContinuous: v.tactileContinuous,
        occupied: v.occupied,
        problem: v.problem,
      });
      message.success(`已接收 ${v.side} 侧离线回传包（${v.date || todayStr()}）`);
    } catch (e) {
      if (e instanceof Error) message.error(`回传包接收失败：${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleProcess = async () => {
    setProcessing(true);
    try {
      const r = await processPacks();
      message.success(buildReportText(r));
    } catch (e) {
      message.error(`合并处理失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProcessing(false);
    }
  };

  const openResolve = (d: MergeDispute) => {
    setActiveDispute(d);
    setResolveSide(d.measures[0]?.side ?? 'A');
    setResolveNote('');
  };

  const handleResolve = async () => {
    if (!activeDispute) return;
    setResolving(true);
    try {
      await resolveDispute(activeDispute.id, resolveSide, resolvedBy, resolveNote);
      message.success(`已采纳 ${resolveSide} 侧结论，正式核验记录已写入，相关路线与整改状态已重算`);
      setActiveDispute(null);
    } catch (e) {
      modal.error({
        title: '写入被拒绝',
        content: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setResolving(false);
    }
  };

  const packColumns: ColumnsType<OfflineInspectionPack> = [
    {
      title: '点位',
      dataIndex: 'pointId',
      render: (v: string) => pointName(v),
    },
    { title: '侧别', dataIndex: 'side', width: 70, render: (v: OfflineSide) => <Tag color={v === 'A' ? 'blue' : 'purple'}>{v} 侧</Tag> },
    { title: '核验日期', dataIndex: 'date', width: 110 },
    { title: '督导员', dataIndex: 'inspector', width: 130 },
    {
      title: '采集时间',
      dataIndex: 'collectedAt',
      width: 160,
      render: (v: string) => formatCollectedAt(v),
    },
    { title: '坡度', dataIndex: 'slope', width: 80, render: (v: number) => `${v}%` },
    { title: '净宽', dataIndex: 'clearWidth', width: 90, render: (v: number) => `${v} cm` },
    {
      title: '结论',
      dataIndex: 'conclusion',
      width: 100,
      render: (v: string) => <StatusBadge value={v} kind="conclusion" />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: OfflineInspectionPack['status']) => (
        <StatusBadge value={PACK_STATUS_BADGE[v]} kind="generic" />
      ),
    },
    {
      title: '处理说明',
      dataIndex: 'lastNote',
      ellipsis: true,
      render: (v: string) =>
        v ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {v}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  const disputeColumns: ColumnsType<MergeDispute> = [
    {
      title: '点位',
      dataIndex: 'pointId',
      render: (v: string) => pointName(v),
    },
    { title: '时段', dataIndex: 'date', width: 120 },
    {
      title: '两边结论',
      width: 220,
      render: (_, row) => (
        <Space size={6} wrap>
          {row.measures.map((m) => (
            <Space key={m.side} size={4}>
              <Tag color={m.side === 'A' ? 'blue' : 'purple'}>{m.side}</Tag>
              <StatusBadge value={m.conclusion} kind="conclusion" />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {m.inspector} · 坡度{m.slope}% · 净宽{m.clearWidth}cm
              </Typography.Text>
            </Space>
          ))}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => <StatusBadge value={v} kind="generic" />,
    },
    {
      title: '裁定结果',
      width: 200,
      render: (_, row) =>
        row.status === '已裁定' ? (
          <Space size={4} direction="vertical" style={{ lineHeight: 1.4 }}>
            <Typography.Text>
              采纳 <Tag color={row.resolvedSide === 'A' ? 'blue' : 'purple'}>{row.resolvedSide} 侧</Tag>
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.resolvedBy} · {row.resolvedAt ? formatCollectedAt(row.resolvedAt) : ''}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">尚未裁定，未写正式记录</Typography.Text>
        ),
    },
    {
      title: '操作',
      width: 120,
      render: (_, row) =>
        row.status === '待裁定' ? (
          <Button type="primary" size="small" onClick={() => openResolve(row)} data-testid="open-resolve">
            去裁定
          </Button>
        ) : (
          <Typography.Link onClick={() => openResolve(row)}>查看</Typography.Link>
        ),
    },
  ];

  const activePoint = activeDispute ? points.find((p) => p.id === activeDispute.pointId) : undefined;

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">
            <CloudSyncOutlined /> 断网回传合并
          </h1>
          <Typography.Text type="secondary">
            按点位与同一时段合并 A / B 两侧离线回传包：两边补录的坡度、净宽各自留档；结论一致直接落正式记录，
            结论不同先列待裁定、裁定前不写正式记录；合并后相关路线轮椅通行结论与整改状态自动重算。
          </Typography.Text>
        </div>
        <Space wrap>
          <Space size={6}>
            <Switch checked={simulateFull} onChange={setSimulateFull} data-testid="simulate-full" />
            <Typography.Text type="warning">
              <SafetyCertificateOutlined /> 容量不足演练
            </Typography.Text>
          </Space>
          <Button
            type="primary"
            icon={<MergeCellsOutlined />}
            loading={processing}
            onClick={handleProcess}
            data-testid="process-packs"
          >
            按点位合并回传包
          </Button>
        </Space>
      </div>

      {simulateFull && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="容量不足演练已开启"
          description="此时合并与裁定写入都会被拒绝，两边回传包与待裁定单原样保留为「已拒绝」；关闭开关（模拟容量恢复）后可再次合并，接着处理。"
        />
      )}

      {stats.rejected > 0 && !simulateFull && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={`有 ${stats.rejected} 组回传包因浏览器容量不足被拒绝写入`}
          description="两边回传包均已保留。请清理浏览器存储后再次点击「按点位合并回传包」，系统会接着处理这些包。"
        />
      )}

      {lastReport && <ReportCard report={lastReport} />}

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small" data-testid="stat-packs-pending">
            <Statistic title="待配对/重试" value={stats.pending} suffix="包" />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small" data-testid="stat-disputes">
            <Statistic title="待裁定" value={stats.openDisputes} suffix="单" valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic title="已合并" value={stats.merged} suffix="包" />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic title="已拒绝" value={stats.rejected} suffix="组" valueStyle={{ color: stats.rejected ? '#cf1322' : undefined }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic title="回传包总数" value={packs.length} suffix="包" />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic title="裁定单总数" value={disputes.length} suffix="单" />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={10}>
          <Card
            title="接收离线回传包"
            size="small"
            extra={
              <Space>
                <Button size="small" onClick={() => fillDemo('A')} data-testid="demo-a">
                  填 A 侧示例
                </Button>
                <Button size="small" onClick={() => fillDemo('B')} data-testid="demo-b">
                  填 B 侧示例
                </Button>
              </Space>
            }
          >
            <Form
              form={form}
              layout="vertical"
              initialValues={{
                side: 'A',
                date: todayStr(),
                collectedAt: dayjs(),
                slope: 3,
                clearWidth: 150,
                hasHandrail: true,
                tactileContinuous: true,
                occupied: '无',
                inspector: '督导员 李维',
                problem: '',
              }}
            >
              <Row gutter={12}>
                <Col span={24}>
                  <Form.Item
                    label="点位"
                    name="pointId"
                    rules={[{ required: true, message: '请选择点位' }]}
                  >
                    <Select options={pointOptions} placeholder="选择回传包所属点位" showSearch optionFilterProp="label" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="侧别" name="side">
                    <Select
                      options={[
                        { value: 'A', label: 'A 队' },
                        { value: 'B', label: 'B 队' },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="核验日期" name="date">
                    <Input placeholder="YYYY-MM-DD" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="采集时间" name="collectedAt">
                    <DatePicker showTime style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="督导员" name="inspector" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="坡度(%)" name="slope">
                    <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="净宽(cm)" name="clearWidth">
                    <InputNumber min={0} max={500} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="扶手" name="hasHandrail" valuePropName="checked">
                    <Switch checkedChildren="有" unCheckedChildren="无" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="盲道连续" name="tactileContinuous" valuePropName="checked">
                    <Switch checkedChildren="连续" unCheckedChildren="断续" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="占用情况" name="occupied">
                    <Select options={OCCUPIED_LEVELS.map((o) => ({ value: o, label: o }))} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="问题描述" name="problem">
                    <Input.TextArea rows={2} placeholder="断网期间现场补录的问题" />
                  </Form.Item>
                </Col>
              </Row>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={submitting}
                onClick={handleIngest}
                data-testid="ingest-pack"
                block
              >
                接收回传包
              </Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card title="待裁定单（结论不同，先列待裁定）" size="small">
            {disputes.length ? (
              <Table<MergeDispute>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 5, hideOnSinglePage: true }}
                dataSource={[...disputes].sort((a, b) =>
                  a.status === b.status ? 0 : a.status === '待裁定' ? -1 : 1,
                )}
                columns={disputeColumns}
              />
            ) : (
              <EmptyState
                title="暂无待裁定单"
                description="同一时段两边结论不同时，合并后在此列出，裁定前不写正式核验记录"
                compact
              />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="离线回传包清单" size="small" style={{ marginTop: 16 }}>
        {loaded && packs.length ? (
          <Table<OfflineInspectionPack>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={packs}
            columns={packColumns}
          />
        ) : (
          <EmptyState title="暂无离线回传包" description="断网核验恢复联网后，在左上录入或模拟两侧回传包" />
        )}
      </Card>

      <Modal
        title={activeDispute ? `待裁定 · ${pointName(activeDispute.pointId)} · ${activeDispute.date}` : ''}
        open={Boolean(activeDispute)}
        onCancel={() => setActiveDispute(null)}
        width={720}
        footer={
          activeDispute?.status === '待裁定'
            ? [
                <Button key="cancel" onClick={() => setActiveDispute(null)}>
                  暂不裁定
                </Button>,
                <Button
                  key="ok"
                  type="primary"
                  loading={resolving}
                  onClick={handleResolve}
                  data-testid="confirm-resolve"
                >
                  确认裁定并写入正式记录
                </Button>,
              ]
            : [
                <Button key="close" type="primary" onClick={() => setActiveDispute(null)}>
                  关闭
                </Button>,
              ]
        }
      >
        {activeDispute && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {activePoint && (
              <Descriptions size="small" column={2}>
                <Descriptions.Item label="点位编号">{activePoint.code}</Descriptions.Item>
                <Descriptions.Item label="设施类型">{activePoint.facilityType}</Descriptions.Item>
              </Descriptions>
            )}
            <Alert
              type="info"
              showIcon
              message="两边补录数据均保留；裁定仅决定正式核验记录采用哪一侧结论，另一侧数据仍随记录留档。"
            />
            <Row gutter={12}>
              {activeDispute.measures.map((m) => {
                const chosen = resolveSide === m.side && activeDispute.status === '待裁定';
                return (
                  <Col span={12} key={m.side}>
                    <Card
                      size="small"
                      style={{
                        borderColor: chosen ? '#1677ff' : undefined,
                        borderWidth: chosen ? 2 : 1,
                        cursor: activeDispute.status === '待裁定' ? 'pointer' : 'default',
                      }}
                      onClick={() => activeDispute.status === '待裁定' && setResolveSide(m.side)}
                      data-testid={`resolve-option-${m.side}`}
                    >
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Space>
                          <Tag color={m.side === 'A' ? 'blue' : 'purple'}>{m.side} 侧</Tag>
                          <StatusBadge value={m.conclusion} kind="conclusion" />
                          {activeDispute.status === '待裁定' && (
                            <Tag color={chosen ? 'blue' : 'default'}>{chosen ? '拟采纳' : '点击采纳'}</Tag>
                          )}
                          {activeDispute.status === '已裁定' && activeDispute.resolvedSide === m.side && (
                            <Tag color="green">裁定采纳</Tag>
                          )}
                        </Space>
                        <Descriptions size="small" column={1}>
                          <Descriptions.Item label="督导员">{m.inspector}</Descriptions.Item>
                          <Descriptions.Item label="采集时间">{formatCollectedAt(m.collectedAt)}</Descriptions.Item>
                          <Descriptions.Item label="坡度">{m.slope}%</Descriptions.Item>
                          <Descriptions.Item label="净宽">{m.clearWidth} cm</Descriptions.Item>
                          <Descriptions.Item label="扶手 / 盲道 / 占用">
                            {m.hasHandrail ? '有扶手' : '无扶手'} / {m.tactileContinuous ? '盲道连续' : '盲道断续'} /{' '}
                            {m.occupied}
                          </Descriptions.Item>
                          <Descriptions.Item label="问题">{m.problem || '无'}</Descriptions.Item>
                        </Descriptions>
                      </Space>
                    </Card>
                  </Col>
                );
              })}
            </Row>
            {activeDispute.status === '待裁定' ? (
              <>
                <Form layout="vertical">
                  <Form.Item label="裁定督导员">
                    <Input value={resolvedBy} onChange={(e) => setResolvedBy(e.target.value)} data-testid="resolve-by" />
                  </Form.Item>
                  <Form.Item label="裁定说明">
                    <Input.TextArea
                      rows={2}
                      value={resolveNote}
                      onChange={(e) => setResolveNote(e.target.value)}
                      placeholder="如：经现场复核，以 B 侧复测数据为准"
                      data-testid="resolve-note"
                    />
                  </Form.Item>
                </Form>
                <Typography.Text type="secondary" className="gb-muted">
                  确认前不写正式核验记录；确认后点位合并完成，相关路线轮椅通行结论与整改状态立即重算。
                </Typography.Text>
              </>
            ) : (
              <Timeline
                items={[
                  {
                    color: 'blue',
                    children: `两边回传包结论不一致（${activeDispute.conclusions.join(' / ')}），生成待裁定单`,
                  },
                  {
                    color: 'green',
                    children: `${activeDispute.resolvedAt ? formatCollectedAt(activeDispute.resolvedAt) : ''} ${
                      activeDispute.resolvedBy
                    } 裁定采纳 ${activeDispute.resolvedSide} 侧结论${
                      activeDispute.resolvedNote ? `：${activeDispute.resolvedNote}` : ''
                    }`,
                  },
                ]}
              />
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
}

function buildReportText(r: MergeProcessReport): string {
  const parts: string[] = [];
  if (r.merged) parts.push(`直接合并 ${r.merged} 组`);
  if (r.disputes) parts.push(`待裁定 ${r.disputes} 单`);
  if (r.waiting) parts.push(`${r.waiting} 组仍只到单边、继续等待`);
  if (r.routesRecalculated) parts.push(`重算 ${r.routesRecalculated} 条路线`);
  if (r.rectifiesCreated) parts.push(`新建整改 ${r.rectifiesCreated} 条`);
  if (r.rectifiesUpdated) parts.push(`更新整改 ${r.rectifiesUpdated} 条`);
  if (r.rejected) parts.push(`${r.rejected} 组因容量不足拒绝写入、回传包保留`);
  return parts.length ? parts.join('，') : '没有可合并的回传包';
}

function ReportCard({ report }: { report: MergeProcessReport }) {
  return (
    <Alert
      style={{ marginBottom: 16 }}
      type={report.rejected ? 'warning' : 'success'}
      showIcon
      message="本次合并处理结果"
      description={<Typography.Text style={{ fontSize: 13 }}>{buildReportText(report)}</Typography.Text>}
      data-testid="merge-report"
    />
  );
}
