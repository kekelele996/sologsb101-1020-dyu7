/**
 * /repairs 送修排期
 * 编目室台账与修复室工位在此接起来：
 * - 编目员把损泐多、版次早的拓本送修（待排），未排上可自行撤回；
 * - 修复室按工位当日件数排期，损泐重的先排，容量到顶就排队；
 * - 上了修复单（在修）的须修复室点头才能退回，亦可完成；
 * - 排期逐条落单，中途失败时已排保留、未排留待排，可直接重试。
 * 消费 RepairOrder、Workbench、Rubbing、Loss；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  RollbackOutlined,
  SendOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import { selectLosses } from '@/stores/lossSlice';
import {
  completeRepair,
  createWorkbench,
  removeRepair,
  removeWorkbench,
  resetRepairFilters,
  returnRepair,
  runSchedule,
  selectBenchCapacity,
  selectFilteredRepairOrders,
  selectPendingOrders,
  selectRepairOrders,
  selectWorkbenches,
  setRepairKeyword,
  setRepairStatuses,
  submitRepair,
  updateWorkbench,
  withdrawRepair,
} from '@/stores/repairSlice';
import {
  REPAIR_STATUS_COLOR,
  REPAIR_STATUS_LABEL,
  REPAIR_STATUS_OPTIONS,
  todayString,
  type RepairOrder,
  type RepairStatus,
} from '@/types/repair';
import { DEFAULT_DAILY_CAPACITY, type Workbench, type WorkbenchDraft } from '@/types/workbench';
import { summarizeLosses } from '@/utils/repairSchedule';

const FILTER_KEYS = ['status'] as const;

export default function RepairBoard() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const losses = useAppSelector(selectLosses);
  const workbenches = useAppSelector(selectWorkbenches);
  const orders = useAppSelector(selectRepairOrders);
  const pendingOrders = useAppSelector(selectPendingOrders);
  const filteredOrders = useAppSelector(selectFilteredRepairOrders);

  const [scheduleDate, setScheduleDate] = useState<string>(todayString());
  const capacities = useAppSelector(selectBenchCapacity(scheduleDate));
  const scheduling = useAppSelector((state) => state.repair.scheduling);

  const url = useFilterQuery(FILTER_KEYS);
  useEffect(() => {
    dispatch(setRepairStatuses((url.values.status ?? []) as RepairStatus[]));
    dispatch(setRepairKeyword(url.keyword));
  }, [dispatch, url.keyword, url.values]);

  const [submitOpen, setSubmitOpen] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);
  const [editingBench, setEditingBench] = useState<Workbench | null>(null);
  const [actionOrder, setActionOrder] = useState<RepairOrder | null>(null);
  const [actionKind, setActionKind] = useState<'return' | 'complete'>('return');

  const [submitForm] = Form.useForm<{ rubbingIds: string[]; submitter: string; submitDate: string }>();
  const [benchForm] = Form.useForm<WorkbenchDraft>();
  const [actionForm] = Form.useForm<{ restorer: string; repairNote: string }>();

  /** 拓本 id → 损泐摘要（条数 / 权重，重 3 / 中 2 / 轻 1） */
  const lossSummaryMap = useMemo(() => {
    const map = new Map<string, { count: number; weight: number }>();
    const weightOf = { heavy: 3, medium: 2, light: 1 } as const;
    losses.forEach((loss) => {
      const prev = map.get(loss.rubbingId) ?? { count: 0, weight: 0 };
      map.set(loss.rubbingId, { count: prev.count + 1, weight: prev.weight + weightOf[loss.severity] });
    });
    return map;
  }, [losses]);

  const activeRubbingIds = useMemo(
    () => new Set(orders.filter((order) => order.status === 'pending' || order.status === 'scheduled').map((o) => o.rubbingId)),
    [orders],
  );

  const steleTitle = (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? steleId;
  const rubbingOf = (rubbingId: string) => rubbings.find((rubbing) => rubbing.id === rubbingId);

  const stat = useMemo(() => {
    const pending = orders.filter((o) => o.status === 'pending').length;
    const scheduled = orders.filter((o) => o.status === 'scheduled').length;
    const done = orders.filter((o) => o.status === 'done').length;
    const closed = orders.filter((o) => o.status === 'returned' || o.status === 'withdrawn').length;
    const totalCapacity = capacities.filter((c) => c.active).reduce((sum, c) => sum + c.dailyCapacity, 0);
    const usedToday = capacities.reduce((sum, c) => sum + c.used, 0);
    return { pending, scheduled, done, closed, totalCapacity, usedToday, freeToday: Math.max(0, totalCapacity - usedToday) };
  }, [capacities, orders]);

  const statusSelects: FilterSelectConfig[] = [
    { key: 'status', label: '单据状态', options: REPAIR_STATUS_OPTIONS.map((item) => ({ value: item.value, label: item.label })) },
  ];

  /* ------------------------------ 送修 ------------------------------ */

  const submittableRubbings = useMemo(
    () =>
      rubbings
        .map((rubbing) => ({ rubbing, summary: lossSummaryMap.get(rubbing.id) ?? { count: 0, weight: 0 } }))
        .filter(({ rubbing, summary }) => summary.count > 0 && !activeRubbingIds.has(rubbing.id))
        .sort((a, b) =>
          b.summary.weight !== a.summary.weight
            ? b.summary.weight - a.summary.weight
            : a.rubbing.versionNo - b.rubbing.versionNo,
        ),
    [activeRubbingIds, lossSummaryMap, rubbings],
  );

  const openSubmit = (): void => {
    submitForm.setFieldsValue({ rubbingIds: [], submitter: '', submitDate: todayString() });
    setSubmitOpen(true);
  };

  const doSubmit = async (): Promise<void> => {
    const values = await submitForm.validateFields();
    let created = 0;
    for (const rubbingId of values.rubbingIds) {
      const rubbing = rubbingOf(rubbingId);
      if (!rubbing) continue;
      const summary = lossSummaryMap.get(rubbingId) ?? summarizeLosses(losses.filter((loss) => loss.rubbingId === rubbingId));
      try {
        await dispatch(
          submitRepair({
            rubbingId,
            steleId: rubbing.steleId,
            lossCount: summary.count,
            lossWeight: summary.weight,
            versionNo: rubbing.versionNo,
            submitter: values.submitter,
            submitDate: values.submitDate,
          }),
        ).unwrap();
        created += 1;
      } catch (error) {
        message.error(`「${steleTitle(rubbing.steleId)} 第 ${rubbing.versionNo} 版」送修失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    }
    setSubmitOpen(false);
    if (created > 0) message.success(`已送出 ${created} 份拓本等待排期`);
  };

  /* ------------------------------ 排期 ------------------------------ */

  const doSchedule = async (): Promise<void> => {
    if (workbenches.filter((b) => b.active !== false).length === 0) {
      message.warning('还没有可用工位，请先在「工位管理」中设置工位与每日件数');
      return;
    }
    try {
      const result = await dispatch(runSchedule({ scheduleDate })).unwrap();
      if (result.failed > 0) {
        message.warning(`排期中途有 ${result.failed} 单写入失败：已排的 ${result.scheduled} 单保留，其余仍待排，可重试排期`);
      } else if (result.scheduled > 0 && result.queued > 0) {
        message.success(`已排上 ${result.scheduled} 单（${scheduleDate}），${result.queued} 单因工位容量到顶继续排队`);
      } else if (result.scheduled > 0) {
        message.success(`已排上 ${result.scheduled} 单（${scheduleDate}），修复单已落账`);
      } else {
        message.info('工位当日容量已满，待排单继续排队等腾位');
      }
    } catch (error) {
      message.error(`排期失败，未排上的仍是待排：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  /* ------------------------------ 撤回 / 退回 / 完成 ------------------------------ */

  const openAction = (order: RepairOrder, kind: 'return' | 'complete'): void => {
    setActionOrder(order);
    setActionKind(kind);
    actionForm.setFieldsValue({ restorer: order.restorer, repairNote: order.repairNote });
  };

  const doAction = async (): Promise<void> => {
    if (!actionOrder) return;
    const values = await actionForm.validateFields();
    try {
      if (actionKind === 'return') {
        await dispatch(returnRepair({ id: actionOrder.id, ...values })).unwrap();
        message.success('修复室已退回，拓本回到编目室');
      } else {
        await dispatch(completeRepair({ id: actionOrder.id, ...values })).unwrap();
        message.success('修复完成，已归还编目室');
      }
      setActionOrder(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  /* ------------------------------ 工位 ------------------------------ */

  const openBenchCreate = (): void => {
    setEditingBench(null);
    benchForm.setFieldsValue({
      name: `修复工位 ${workbenches.length + 1} 号`,
      keeper: '',
      dailyCapacity: DEFAULT_DAILY_CAPACITY,
      active: true,
    });
    setBenchOpen(true);
  };

  const openBenchEdit = (bench: Workbench): void => {
    setEditingBench(bench);
    benchForm.setFieldsValue({ name: bench.name, keeper: bench.keeper, dailyCapacity: bench.dailyCapacity, active: bench.active });
    setBenchOpen(true);
  };

  const doBenchSubmit = async (): Promise<void> => {
    const values = await benchForm.validateFields();
    if (editingBench) {
      await dispatch(updateWorkbench({ id: editingBench.id, patch: values })).unwrap();
      message.success('工位已更新');
    } else {
      await dispatch(createWorkbench(values)).unwrap();
      message.success('工位已增设');
    }
    setBenchOpen(false);
  };

  const pendingColumns: ColumnsType<RepairOrder> = [
    { title: '排队序', dataIndex: 'queueNo', width: 70, render: (value: number) => (value > 0 ? `#${value}` : '—') },
    {
      title: '拓本',
      key: 'rubbing',
      render: (_v, record) => {
        const rubbing = rubbingOf(record.rubbingId);
        return (
          <Space size={4} direction="vertical">
            <Space size={4}>
              <Tag color="#2f3a34">第 {rubbing?.versionNo ?? record.versionNo} 版</Tag>
              <span>{steleTitle(record.steleId)}</span>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {rubbing?.collectionNo || '收藏号未编'} · {rubbing?.dateGuess || '年代待考'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '损泐',
      key: 'loss',
      width: 130,
      sorter: (a, b) => b.lossWeight - a.lossWeight,
      render: (_v, record) => (
        <Tooltip title="权重合计：重 3 / 中 2 / 轻 1">
          <Space size={4}>
            <Tag color="#b03a2e">{record.lossCount} 字位</Tag>
            <Tag color="gold">权重 {record.lossWeight}</Tag>
          </Space>
        </Tooltip>
      ),
    },
    { title: '送修人', dataIndex: 'submitter', width: 90, render: (v: string) => v || '未填' },
    { title: '送修日期', dataIndex: 'submitDate', width: 110 },
    {
      title: '编目员操作',
      key: 'action',
      width: 110,
      render: (_v, record) => (
        <Popconfirm
          title="撤回送修"
          description="该拓本尚未排上工位，撤回后回到编目室台账。"
          okText="确认撤回"
          cancelText="取消"
          onConfirm={() =>
            void dispatch(withdrawRepair(record.id))
              .unwrap()
              .then(() => message.success('已撤回送修'))
              .catch((error: unknown) => message.error(error instanceof Error ? error.message : '撤回失败'))
          }
        >
          <Button size="small" type="link" icon={<UndoOutlined />}>
            撤回
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const orderColumns: ColumnsType<RepairOrder> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: RepairStatus) => <Tag color={REPAIR_STATUS_COLOR[value]}>{REPAIR_STATUS_LABEL[value]}</Tag>,
    },
    {
      title: '拓本',
      key: 'rubbing',
      render: (_v, record) => {
        const rubbing = rubbingOf(record.rubbingId);
        return (
          <Space size={4}>
            <Tag color="#2f3a34">第 {rubbing?.versionNo ?? record.versionNo} 版</Tag>
            <span>{steleTitle(record.steleId)}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              损泐 {record.lossCount} · 权重 {record.lossWeight}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '工位',
      dataIndex: 'workbenchId',
      width: 120,
      render: (v: string) => (v ? workbenches.find((bench) => bench.id === v)?.name ?? v : '—'),
    },
    { title: '排期', dataIndex: 'scheduleDate', width: 110, render: (v: string) => v || '—' },
    { title: '修复师', dataIndex: 'restorer', width: 90, render: (v: string) => v || '—' },
    { title: '备注', dataIndex: 'repairNote', ellipsis: true, render: (v: string) => v || '—' },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_v, record) => {
        if (record.status === 'scheduled') {
          return (
            <Space size={2}>
              <Button size="small" type="link" icon={<RollbackOutlined />} onClick={() => openAction(record, 'return')}>
                修复室退回
              </Button>
              <Button size="small" type="link" icon={<CheckCircleOutlined />} onClick={() => openAction(record, 'complete')}>
                完成
              </Button>
            </Space>
          );
        }
        if (record.status === 'pending') {
          return (
            <Popconfirm
              title="撤回送修"
              okText="确认撤回"
              cancelText="取消"
              onConfirm={() =>
                void dispatch(withdrawRepair(record.id))
                  .unwrap()
                  .then(() => message.success('已撤回送修'))
                  .catch((error: unknown) => message.error(error instanceof Error ? error.message : '撤回失败'))
              }
            >
              <Button size="small" type="link" icon={<UndoOutlined />}>
                编目员撤回
              </Button>
            </Popconfirm>
          );
        }
        return (
          <Popconfirm
            title="删除该历史单据"
            okText="删除"
            cancelText="取消"
            onConfirm={() => void dispatch(removeRepair(record.id)).then(() => message.success('已删除单据'))}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>送修排期</h2>
          <p>编目室按损泐轻重与版次早晚送修，修复室按工位当日件数排期；容量到顶即排队，在修拓本不被挤下。</p>
        </div>
        <Space wrap>
          <Input
            type="date"
            value={scheduleDate}
            onChange={(event) => setScheduleDate(event.target.value || todayString())}
            style={{ width: 150 }}
          />
          <Button icon={<ToolOutlined />} onClick={openBenchCreate}>
            增设工位
          </Button>
          <Button type="primary" icon={<SendOutlined />} onClick={openSubmit}>
            送修登记
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="待排" value={stat.pending} suffix="单" tone="warning" />
        <StatBadge label="在修" value={stat.scheduled} suffix="单" tone="success" />
        <StatBadge label={`当日空余工位（${scheduleDate}）`} value={stat.freeToday} suffix={`/ ${stat.totalCapacity} 件`} tone="primary" />
        <StatBadge label="已完成" value={stat.done} suffix="单" tone="info" />
        <StatBadge label="退回 / 撤回" value={stat.closed} suffix="单" />
        <Button type="primary" ghost icon={<ThunderboltOutlined />} loading={scheduling} onClick={() => void doSchedule()} style={{ alignSelf: 'center' }}>
          执行当天排期
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="排期规则"
        description="送修单按损泐权重（重 3 / 中 2 / 轻 1）降序、版次早者优先、送修早者优先依次占位；各工位只按当日件数扣减，已经在修的单先占位不退，后来者只能排队等腾位。"
      />

      <Row gutter={16}>
        <Col xs={24} xl={10}>
          <Card size="small" title={`工位容量 · ${scheduleDate}`} style={{ marginBottom: 14 }}
            extra={<Button size="small" type="link" onClick={openBenchCreate}>增设工位</Button>}
          >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {workbenches.length === 0 ? (
                <EmptyPanel title="还没有工位" description="旧数据升级时会按现有工位编出默认每日件数；也可手动增设。" size="small" actionText="增设工位" onAction={openBenchCreate} />
              ) : (
                capacities.map((cap) => (
                  <div key={cap.workbenchId} style={{ borderBottom: '1px dashed rgba(47,58,52,0.12)', paddingBottom: 8 }}>
                    <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                      <Space size={6}>
                        <Typography.Text strong>{cap.name}</Typography.Text>
                        {cap.active ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
                      </Space>
                      <Space size={6}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {cap.used}/{cap.dailyCapacity} 件
                        </Typography.Text>
                        <Button size="small" type="link" onClick={() => openBenchEdit(workbenches.find((b) => b.id === cap.workbenchId)!)}>
                          编辑
                        </Button>
                      </Space>
                    </Space>
                    <Progress
                      percent={cap.dailyCapacity === 0 ? 0 : Math.round((cap.used / cap.dailyCapacity) * 100)}
                      size="small"
                      strokeColor={cap.free > 0 ? '#2f6f4f' : '#b03a2e'}
                      format={() => (cap.active ? `余 ${cap.free} 件` : '已停用')}
                    />
                  </div>
                ))
              )}
            </Space>
          </Card>

          <Card size="small" title={`待排队列（${pendingOrders.length}）· 损泐重者在前`} styles={{ body: { padding: 0 } }}>
            {pendingOrders.length === 0 ? (
              <EmptyPanel title="没有待排拓本" description="编目员可在右上「送修登记」把损泐多、版次早的拓本送来。" size="small" />
            ) : (
              <Table<RepairOrder> rowKey="id" size="small" pagination={{ pageSize: 5 }} columns={pendingColumns} dataSource={pendingOrders} />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={14}>
          <FilterBar
            keyword={url.keyword}
            onKeywordChange={url.setKeyword}
            selects={statusSelects}
            values={url.values}
            onValuesChange={url.setValues}
            onReset={() => {
              url.reset();
              dispatch(resetRepairFilters());
            }}
            keywordPlaceholder="搜索送修人 / 修复师 / 备注…"
            actions={<Typography.Text type="secondary">单据 {filteredOrders.length} 张</Typography.Text>}
          />
          <Card className="gb-table-card" style={{ marginTop: 14 }} styles={{ body: { padding: 0 } }}>
            {filteredOrders.length === 0 ? (
              <EmptyPanel title="没有符合条件的修复单" description="执行排期后，排上的拓本会在此落一份修复单。" size="small" />
            ) : (
              <Table<RepairOrder> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={orderColumns} dataSource={filteredOrders} />
            )}
          </Card>
        </Col>
      </Row>

      {/* 送修登记 */}
      <Modal
        open={submitOpen}
        title="送修登记（编目室）"
        onCancel={() => setSubmitOpen(false)}
        onOk={() => void doSubmit()}
        okText="送出待排"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={submitForm} layout="vertical" preserve={false}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="只列损泐字位多于 0 且当前没有待排 / 在修单的拓本；排序即排期优先级（损泐重、版次早在前）。"
          />
          <Form.Item name="rubbingIds" label="选择送修拓本（可多选）" rules={[{ required: true, message: '请至少选择一份拓本' }]}>
            <Select
              mode="multiple"
              placeholder="选择拓本"
              style={{ width: '100%' }}
              options={submittableRubbings.map(({ rubbing, summary }) => ({
                value: rubbing.id,
                label: `${steleTitle(rubbing.steleId)} · 第 ${rubbing.versionNo} 版（损泐 ${summary.count} 字位 / 权重 ${summary.weight}）${rubbing.collectionNo ? ` · ${rubbing.collectionNo}` : ''}`,
              }))}
              notFoundContent="暂无可送修拓本（均已在流程中或没有损泐标注）"
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="submitter" label="送修人（编目员）" style={{ flex: 1 }}>
              <Input placeholder="如：傅砚" />
            </Form.Item>
            <Form.Item name="submitDate" label="送修日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 工位增设 / 编辑 */}
      <Modal
        open={benchOpen}
        title={editingBench ? '编辑工位' : '增设工位'}
        onCancel={() => setBenchOpen(false)}
        onOk={() => void doBenchSubmit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={benchForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="工位名称" rules={[{ required: true, message: '请填写工位名称' }]}>
            <Input placeholder="如：修复工位 4 号" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="keeper" label="负责人（修复师）" style={{ flex: 1 }}>
              <Input placeholder="如：苏裱" />
            </Form.Item>
            <Form.Item name="dailyCapacity" label="每日件数" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={20} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="active" label="参与排期" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
          {editingBench ? (
            <Popconfirm
              title="撤掉该工位"
              description="若仍有在修拓本则不能删除。"
              okText="确认删除"
              cancelText="取消"
              onConfirm={() =>
                void dispatch(removeWorkbench(editingBench.id))
                  .unwrap()
                  .then(() => {
                    message.success('工位已撤');
                    setBenchOpen(false);
                  })
                  .catch((error: unknown) => message.error(error instanceof Error ? error.message : '删除失败'))
              }
            >
              <Button danger>删除该工位</Button>
            </Popconfirm>
          ) : null}
        </Form>
      </Modal>

      {/* 修复室退回 / 完成 */}
      <Modal
        open={actionOrder !== null}
        title={actionKind === 'return' ? '修复室退回（需修复师确认）' : '修复完成'}
        onCancel={() => setActionOrder(null)}
        onOk={() => void doAction()}
        okText={actionKind === 'return' ? '确认退回' : '确认完成'}
        cancelText="取消"
        destroyOnClose
      >
        {actionOrder ? (
          <Form form={actionForm} layout="vertical" preserve={false}>
            <Alert
              type={actionKind === 'return' ? 'warning' : 'success'}
              showIcon
              style={{ marginBottom: 12 }}
              message={
                actionKind === 'return'
                  ? '上了修复单的拓本须修复室点头才能退回编目室。'
                  : `${steleTitle(actionOrder.steleId)} 第 ${rubbingOf(actionOrder.rubbingId)?.versionNo ?? actionOrder.versionNo} 版修复完成后归还。`
              }
            />
            <Form.Item name="restorer" label="修复师" rules={[{ required: true, message: '请填写修复师' }]}>
              <Input placeholder="如：苏裱" />
            </Form.Item>
            <Form.Item name="repairNote" label={actionKind === 'return' ? '退回原因 / 备注' : '修复说明'}>
              <Input.TextArea rows={3} placeholder={actionKind === 'return' ? '如：拓片脆化超出本工位条件，退回另议' : '如：缺笔补墨、覆托完成'} />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
