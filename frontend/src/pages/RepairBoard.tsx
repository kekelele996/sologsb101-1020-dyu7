/**
 * /repairs 送修排期台
 * 把编目室台账与修复室工位接起来：
 * - 编目员勾选损泐字位多、版次早的拓本送修（落待排修复单）
 * - 修复室维护工位每日件数，按容量执行排期（损泐重的先排，在修不腾位）
 * - 待排可由编目员撤回；在修须修复室点头退回；中途失败可重试
 * 消费 RepairOrder、RepairStation、Rubbing、Loss、Stele；
 * 复用 <FilterBar>、<StatBadge>、<EmptyPanel>、<LossTag>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
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
import dayjs, { type Dayjs } from 'dayjs';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RollbackOutlined,
  SendOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import LossTag from '@/components/common/LossTag';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles, setCurrentStele } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import { selectLosses } from '@/stores/lossSlice';
import {
  createStation,
  loadRepairs,
  removeStation,
  returnRepairOrder,
  runRepairSchedule,
  selectFilteredRepairOrders,
  selectOccupiedRubbingIds,
  selectPendingQueue,
  selectRepairStations,
  selectStationUsage,
  sendRepair,
  setRepairKeyword,
  setRepairStatuses,
  setRepairSteleFilter,
  updateStation,
  withdrawRepairOrder,
  type ScheduleSummary,
} from '@/stores/repairSlice';
import {
  DEFAULT_STATION_DAILY_CAPACITY,
  createEmptyStationDraft,
  type RepairStation,
  type RepairStationDraft,
} from '@/types/station';
import {
  REPAIR_ORDER_STATUS_COLOR,
  REPAIR_ORDER_STATUS_LABEL,
  REPAIR_ORDER_STATUS_OPTIONS,
  type RepairOrder,
  type RepairOrderStatus,
} from '@/types/repair';
import { RUBBING_METHOD_LABEL } from '@/types/rubbing';
import { summarizeDamage } from '@/utils/repair';

const FILTER_KEYS = ['status'] as const;

interface SendCandidate {
  rubbingId: string;
  steleId: string;
  versionNo: number;
  collectionNo: string;
  dateGuess: string;
  lossCount: number;
  severityScore: number;
}

export default function RepairBoard() {
  const { message, modal } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const [stationForm] = Form.useForm<RepairStationDraft>();
  const [sendForm] = Form.useForm<{ requester: string; reason: string }>();
  const [returnForm] = Form.useForm<{ repairer: string; returnNote: string }>();

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const losses = useAppSelector(selectLosses);
  const stations = useAppSelector(selectRepairStations);
  const orders = useAppSelector(selectFilteredRepairOrders);
  const pendingQueue = useAppSelector(selectPendingQueue);
  const occupied = useAppSelector(selectOccupiedRubbingIds);
  const steleFilterId = useAppSelector((state) => state.repair.filters.steleId);

  const url = useFilterQuery(FILTER_KEYS);
  const [scheduleDay, setScheduleDay] = useState<Dayjs>(dayjs());
  const [stationOpen, setStationOpen] = useState(false);
  const [editingStation, setEditingStation] = useState<RepairStation | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendSteleId, setSendSteleId] = useState<string>('');
  const [selectedRubbingIds, setSelectedRubbingIds] = useState<string[]>([]);
  const [returning, setReturning] = useState<RepairOrder | null>(null);
  const [scheduling, setScheduling] = useState(false);

  useEffect(() => {
    dispatch(setRepairStatuses((url.values.status ?? []) as RepairOrderStatus[]));
  }, [dispatch, url.values]);

  useEffect(() => {
    dispatch(setRepairKeyword(url.keyword));
  }, [dispatch, url.keyword]);

  useEffect(() => {
    if (sendSteleId.length === 0) setSendSteleId(steles[0]?.id ?? '');
  }, [sendSteleId, steles]);

  const scheduleDate = scheduleDay.format('YYYY-MM-DD');
  const usage = useAppSelector((state) => selectStationUsage(state, scheduleDate));

  const steleTitle = (id: string): string => steles.find((stele) => stele.id === id)?.title ?? id;
  const stationName = (id: string): string => stations.find((station) => station.id === id)?.name ?? '未指工位';

  const stat = useMemo(() => {
    const active = orders.filter((order) => order.status === 'active').length;
    const pending = orders.filter((order) => order.status === 'pending').length;
    const returned = orders.filter((order) => order.status === 'returned').length;
    const totalCapacity = stations.filter((station) => station.enabled).reduce((sum, station) => sum + station.dailyCapacity, 0);
    const usedToday = usage.reduce((sum, item) => sum + item.used, 0);
    return { active, pending, returned, totalCapacity, usedToday };
  }, [orders, stations, usage]);

  /** 可送修拓本：按损泐条数 → 严重度 → 版次排好，已有待排 / 在修单的不可重复送修 */
  const candidates = useMemo<Array<SendCandidate & { collectionNo: string; dateGuess: string }>>(() => {
    return rubbings
      .filter((rubbing) => rubbing.steleId === sendSteleId)
      .filter((rubbing) => !occupied.has(rubbing.id))
      .map((rubbing) => {
        const damage = summarizeDamage(losses.filter((loss) => loss.rubbingId === rubbing.id));
        return {
          rubbingId: rubbing.id,
          steleId: rubbing.steleId,
          versionNo: rubbing.versionNo,
          collectionNo: rubbing.collectionNo,
          dateGuess: rubbing.dateGuess,
          lossCount: damage.lossCount,
          severityScore: damage.severityScore,
        };
      })
      .sort((a, b) =>
        a.lossCount !== b.lossCount
          ? b.lossCount - a.lossCount
          : a.severityScore !== b.severityScore
            ? b.severityScore - a.severityScore
            : a.versionNo - b.versionNo,
      );
  }, [losses, occupied, rubbings, sendSteleId]);

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      { key: 'status', label: '单据状态', options: REPAIR_ORDER_STATUS_OPTIONS.map((item) => ({ value: item.value, label: item.label })) },
    ],
    [],
  );

  const openCreateStation = (): void => {
    setEditingStation(null);
    stationForm.setFieldsValue(createEmptyStationDraft());
    setStationOpen(true);
  };

  const openEditStation = (station: RepairStation): void => {
    setEditingStation(station);
    stationForm.setFieldsValue({
      name: station.name,
      keeper: station.keeper,
      note: station.note,
      dailyCapacity: station.dailyCapacity,
      enabled: station.enabled,
    });
    setStationOpen(true);
  };

  const submitStation = async (): Promise<void> => {
    const values = await stationForm.validateFields();
    if (editingStation) {
      await dispatch(updateStation({ id: editingStation.id, patch: values })).unwrap();
      message.success(`已更新工位「${values.name}」`);
    } else {
      await dispatch(createStation(values)).unwrap();
      message.success(`已新增工位「${values.name}」`);
    }
    setStationOpen(false);
  };

  const openSend = (): void => {
    if (stations.filter((station) => station.enabled).length === 0) {
      message.warning('修复室还没有可用工位，请先登记工位并设置每日件数');
      return;
    }
    setSelectedRubbingIds([]);
    sendForm.setFieldsValue({ requester: '', reason: '' });
    setSendOpen(true);
  };

  const submitSend = async (): Promise<void> => {
    if (selectedRubbingIds.length === 0) {
      message.warning('请勾选要送修的拓本');
      return;
    }
    const values = await sendForm.validateFields();
    const result = await dispatch(
      sendRepair({ rubbingIds: selectedRubbingIds, requester: values.requester, reason: values.reason }),
    ).unwrap();
    message.success(`已送修 ${result.created.length} 份${result.skipped > 0 ? `，${result.skipped} 份因已有修复单跳过` : ''}`);
    setSendOpen(false);
  };

  const runSchedule = async (): Promise<void> => {
    if (pendingQueue.length === 0) {
      message.info('当前没有待排的修复单');
      return;
    }
    setScheduling(true);
    try {
      const summary = await dispatch(runRepairSchedule({ scheduleDate })).unwrap();
      reportSchedule(summary);
    } catch (error) {
      // 中途失败：已排的留着，未排的等重试
      const failure = error as { summary?: ScheduleSummary; message?: string };
      if (failure.summary) reportSchedule(failure.summary, failure.message);
      else message.error(failure.message ?? '排期失败，待排单已保留可重试');
    } finally {
      setScheduling(false);
    }
  };

  const reportSchedule = (summary: ScheduleSummary, failureMessage?: string): void => {
    if (summary.failedId) {
      modal.warning({
        title: '排期中途失败',
        content: `已排上 ${summary.assigned.length} 件并保留修复单；${summary.waiting.length} 件退回待排等腾位 / 重试。${failureMessage ? `原因：${failureMessage}` : ''}`,
        okText: '知道了',
      });
    } else if (summary.assigned.length === 0) {
      message.info('工位当日容量已满，全部待排单排队等腾位');
    } else {
      message.success(`已为 ${summary.assigned.length} 件落修复单，${summary.waiting.length} 件继续排队`);
    }
  };

  const openReturn = (order: RepairOrder): void => {
    setReturning(order);
    returnForm.setFieldsValue({ repairer: order.repairer, returnNote: '' });
  };

  const submitReturn = async (): Promise<void> => {
    if (!returning) return;
    const values = await returnForm.validateFields();
    await dispatch(
      returnRepairOrder({ id: returning.id, repairer: values.repairer, returnNote: values.returnNote }),
    ).unwrap();
    message.success('修复室已确认退回');
    setReturning(null);
  };

  const orderColumns: ColumnsType<RepairOrder> = [
    {
      title: '单据',
      dataIndex: 'status',
      width: 170,
      render: (value: RepairOrderStatus, record) => (
        <Space direction="vertical" size={0}>
          <Tag color={REPAIR_ORDER_STATUS_COLOR[value]}>{REPAIR_ORDER_STATUS_LABEL[value]}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.scheduleDate ? `排期 ${record.scheduleDate}` : '未排期'}
            {record.stationId ? ` · ${stationName(record.stationId)}` : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '碑刻 / 版本',
      key: 'rubbing',
      width: 180,
      render: (_value, record) => {
        const rubbing = rubbings.find((item) => item.id === record.rubbingId);
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{steleTitle(record.steleId)}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              第 {record.versionNo} 版{rubbing ? ` · ${RUBBING_METHOD_LABEL[rubbing.method]}` : ''}
              {rubbing?.collectionNo ? ` · ${rubbing.collectionNo}` : ''}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '损泐',
      key: 'damage',
      width: 150,
      sorter: (a, b) => a.lossCount - b.lossCount,
      render: (_value, record) => (
        <Space size={4}>
          <Tag color="#b03a2e">{record.lossCount} 字位</Tag>
          <Tooltip title={`严重度权重 ${record.severityScore}（轻=1 / 中=2 / 重=3）`}>
            <Tag>权重 {record.severityScore}</Tag>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '送修说明',
      dataIndex: 'reason',
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <span>{value || '—'}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            送修人：{record.requester}
            {record.repairer ? ` · 修复师：${record.repairer}` : ''}
          </Typography.Text>
          {record.returnNote ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              退回意见：{record.returnNote}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_value, record) => {
        if (record.status === 'pending') {
          return (
            <Popconfirm
              title="编目员撤回送修"
              description="该单还没排上，撤回后不留修复单。"
              okText="确认撤回"
              cancelText="取消"
              onConfirm={() =>
                void dispatch(withdrawRepairOrder(record.id))
                  .unwrap()
                  .then(() => message.success('已撤回到待送修'))
                  .catch((err: Error) => message.error(err.message))
              }
            >
              <Button size="small" type="link" icon={<UndoOutlined />}>
                编目撤回
              </Button>
            </Popconfirm>
          );
        }
        if (record.status === 'active') {
          return (
            <Button size="small" type="link" icon={<RollbackOutlined />} onClick={() => openReturn(record)}>
              修复室退回
            </Button>
          );
        }
        return <Typography.Text type="secondary" style={{ fontSize: 12 }}>已退回归档</Typography.Text>;
      },
    },
  ];

  const queueColumns: ColumnsType<RepairOrder> = [
    {
      title: '排队序',
      key: 'order',
      width: 70,
      render: (_value, _record, index) => <Tag>{index + 1}</Tag>,
    },
    {
      title: '碑刻 / 版本',
      key: 'rubbing',
      render: (_value, record) => `${steleTitle(record.steleId)} · 第 ${record.versionNo} 版`,
    },
    { title: '损泐字位', dataIndex: 'lossCount', width: 100, sorter: (a, b) => a.lossCount - b.lossCount },
    { title: '严重度权重', dataIndex: 'severityScore', width: 110 },
    { title: '送修说明', dataIndex: 'reason', render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_value, record) => (
        <Popconfirm
          title="编目员撤回送修"
          okText="确认撤回"
          cancelText="取消"
          onConfirm={() =>
            void dispatch(withdrawRepairOrder(record.id))
              .unwrap()
              .then(() => message.success('已撤回到待送修'))
              .catch((err: Error) => message.error(err.message))
          }
        >
          <Button size="small" type="link" danger icon={<UndoOutlined />}>
            撤回
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>送修排期台</h2>
          <p>编目室把损泐字位多、版次早的拓本送修；修复室按工位每日件数排，损泐重的先排，容量满了排队等腾位。</p>
        </div>
        <Space wrap>
          <Select
            allowClear
            style={{ minWidth: 180 }}
            placeholder="全部碑刻"
            value={steleFilterId ?? undefined}
            options={steles.map((stele) => ({ value: stele.id, label: stele.title }))}
            onChange={(value: string | undefined) => {
              dispatch(setRepairSteleFilter(value ?? null));
              if (value) dispatch(setCurrentStele(value));
            }}
          />
          <Button icon={<PlusOutlined />} onClick={openCreateStation}>
            登记工位
          </Button>
          <Button type="primary" icon={<SendOutlined />} onClick={openSend}>
            拓本送修
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="在修拓本" value={stat.active} suffix="件" tone="success" />
        <StatBadge label="待排排队" value={stat.pending} suffix="件" tone="warning" />
        <StatBadge label="已退回" value={stat.returned} suffix="件" />
        <StatBadge label="工位今日容量" value={`${stat.usedToday}/${stat.totalCapacity}`} suffix="件" tone="info" />
        <StatBadge label="可用工位" value={stations.filter((station) => station.enabled).length} suffix="个" tone="primary" />
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={15}>
          <Card
            className="gb-table-card"
            title="修复单台账"
            extra={
              <Space wrap>
                <DatePicker
                  size="small"
                  value={scheduleDay}
                  allowClear={false}
                  onChange={(value) => value && setScheduleDay(value)}
                />
                <Button
                  size="small"
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  loading={scheduling}
                  onClick={() => void runSchedule()}
                >
                  执行排期
                </Button>
                <Tooltip title="中途失败时已排的留着、未排的退回待排，可点此按库内现状重试">
                  <Button
                    size="small"
                    icon={<UndoOutlined />}
                    disabled={pendingQueue.length === 0}
                    onClick={() => void runSchedule()}
                  >
                    重试排期
                  </Button>
                </Tooltip>
              </Space>
            }
            styles={{ body: { padding: 0 } }}
          >
            <div style={{ padding: '10px 14px' }}>
              <FilterBar
                keyword={url.keyword}
                onKeywordChange={url.setKeyword}
                selects={selects}
                values={url.values}
                onValuesChange={url.setValues}
                onReset={url.reset}
                keywordPlaceholder="搜索送修人 / 说明 / 修复师…"
                actions={<Typography.Text type="secondary">{orders.length} 张修复单</Typography.Text>}
              />
            </div>
            {orders.length === 0 ? (
              <EmptyPanel
                title="还没有修复单"
                description="编目员在右上方「拓本送修」勾选损泐重、版次早的拓本，排上后即落修复单。"
                size="small"
              />
            ) : (
              <Table<RepairOrder> rowKey="id" size="small" pagination={{ pageSize: 7 }} columns={orderColumns} dataSource={orders} />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card size="small" title={`工位容量 · ${scheduleDate}`} style={{ marginBottom: 16 }}>
            {stations.length === 0 ? (
              <EmptyPanel
                title="修复室还没有工位"
                description="先登记工位并填写每天能修几件，排期才有名额。"
                actionText="登记工位"
                onAction={openCreateStation}
                size="small"
              />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {usage.map(({ station, used, remaining }) => {
                  const percent = station.dailyCapacity === 0 ? 0 : Math.round((used / station.dailyCapacity) * 100);
                  return (
                    <div key={station.id} className="gb-panel" style={{ padding: 12 }}>
                      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                        <Space>
                          <Typography.Text strong>{station.name}</Typography.Text>
                          {station.enabled ? <Tag color="green">在用</Tag> : <Tag>停用</Tag>}
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {station.keeper || '未派修复师'}
                          </Typography.Text>
                        </Space>
                        <Space size={4}>
                          <Typography.Text strong>{used}</Typography.Text>
                          <Typography.Text type="secondary">/ {station.dailyCapacity} 件</Typography.Text>
                          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditStation(station)}>
                            编辑
                          </Button>
                          <Popconfirm
                            title={`删除工位「${station.name}」`}
                            okText="确认"
                            cancelText="取消"
                            onConfirm={() =>
                              void dispatch(removeStation(station.id))
                                .unwrap()
                                .then(() => {
                                  void dispatch(loadRepairs());
                                  message.success('已删除工位');
                                })
                                .catch((err: Error) => message.error(err.message))
                            }
                          >
                            <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </Space>
                      </Space>
                      <Progress
                        percent={percent}
                        size="small"
                        strokeColor={remaining === 0 ? '#b03a2e' : '#2f6f4f'}
                        trailColor="rgba(140,47,31,0.12)"
                        style={{ marginTop: 6, marginBottom: 0 }}
                      />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {remaining > 0 ? `今日还能接 ${remaining} 件` : '今日已满，后来的排队等腾位'}
                        {station.note ? ` · ${station.note}` : ''}
                      </Typography.Text>
                    </div>
                  );
                })}
              </Space>
            )}
          </Card>

          <Card
            size="small"
            title={`待排队列（损泐重者先）· ${pendingQueue.length} 件`}
            styles={{ body: { padding: 0 } }}
          >
            {pendingQueue.length === 0 ? (
              <EmptyPanel title="队列已空" description="没有待排拓本；工位腾位后送修的单子会自动排在最前。" size="small" />
            ) : (
              <Table<RepairOrder>
                rowKey="id"
                size="small"
                pagination={false}
                columns={queueColumns}
                dataSource={pendingQueue}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* 工位登记 / 编辑 */}
      <Modal
        open={stationOpen}
        title={editingStation ? `编辑工位「${editingStation.name}」` : '登记修复工位'}
        onCancel={() => setStationOpen(false)}
        onOk={() => void submitStation()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={stationForm} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="name" label="工位名称" rules={[{ required: true, message: '请填写工位名称' }]} style={{ flex: 2 }}>
              <Input placeholder="如：修字一号" />
            </Form.Item>
            <Form.Item
              name="dailyCapacity"
              label="每日件数"
              rules={[{ required: true, message: '请填写每天能修几件' }]}
              tooltip="工位当天容量上限；在修拓本不腾位，满了后来的排队"
              style={{ flex: 1 }}
            >
              <InputNumber min={1} max={20} style={{ width: '100%' }} placeholder={`默认 ${DEFAULT_STATION_DAILY_CAPACITY}`} />
            </Form.Item>
          </Space>
          <Form.Item name="keeper" label="负责修复师">
            <Input placeholder="如：苏裱工" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="擅长纸绢 / 装裱方向" />
          </Form.Item>
          <Form.Item name="enabled" label="参与排期" valuePropName="checked">
            <Switch checkedChildren="在用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 拓本送修 */}
      <Modal
        open={sendOpen}
        title="拓本送修"
        width={760}
        onCancel={() => setSendOpen(false)}
        onOk={() => void submitSend()}
        okText={`送修 ${selectedRubbingIds.length} 份`}
        cancelText="取消"
        destroyOnClose
      >
        <Space style={{ marginBottom: 10 }} wrap>
          <Select
            style={{ minWidth: 200 }}
            value={sendSteleId || undefined}
            placeholder="选择碑刻"
            options={steles.map((stele) => ({ value: stele.id, label: stele.title }))}
            onChange={(value: string) => setSendSteleId(value)}
          />
          <Checkbox
            checked={candidates.length > 0 && selectedRubbingIds.length === candidates.length}
            indeterminate={selectedRubbingIds.length > 0 && selectedRubbingIds.length < candidates.length}
            onChange={(event) => setSelectedRubbingIds(event.target.checked ? candidates.map((item) => item.rubbingId) : [])}
          >
            全选可送修 {candidates.length} 份
          </Checkbox>
          <Typography.Text type="secondary">已按损泐字数、严重度、版次早者优先排序</Typography.Text>
        </Space>

        <Table<SendCandidate & { collectionNo: string; dateGuess: string }>
          rowKey="rubbingId"
          size="small"
          pagination={false}
          dataSource={candidates}
          rowSelection={{
            selectedRowKeys: selectedRubbingIds,
            onChange: (keys) => setSelectedRubbingIds(keys.map((key) => String(key))),
          }}
          columns={[
            { title: '版本', dataIndex: 'versionNo', width: 80, render: (value: number) => `第 ${value} 版` },
            { title: '收藏号', dataIndex: 'collectionNo', width: 110, render: (value: string) => value || '未编' },
            { title: '年代', dataIndex: 'dateGuess', width: 100, render: (value: string) => value || '待考' },
            {
              title: '损泐',
              key: 'damage',
              render: (_value, record) => (
                <Space size={4}>
                  <Tag color="#b03a2e">{record.lossCount} 字位</Tag>
                  <Tag>权重 {record.severityScore}</Tag>
                </Space>
              ),
            },
            {
              title: '字位预览',
              key: 'preview',
              render: (_value, record) => (
                <Space size={2} wrap>
                  {losses
                    .filter((loss) => loss.rubbingId === record.rubbingId)
                    .slice(0, 4)
                    .map((loss) => (
                      <LossTag key={loss.id} type={loss.type} severity={loss.severity} lineNo={loss.lineNo} charNo={loss.charNo} size="small" />
                    ))}
                </Space>
              ),
            },
          ]}
          locale={{ emptyText: '该碑刻下没有可送修拓本（可能已全部有待排 / 在修单）' }}
        />

        <Form form={sendForm} layout="vertical" preserve={false} style={{ marginTop: 14 }}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="requester" label="送修人（编目员）" style={{ flex: 1 }}>
              <Input placeholder="如：傅砚" />
            </Form.Item>
            <Form.Item name="reason" label="送修说明" style={{ flex: 2 }}>
              <Input placeholder="如：早本缺笔需补 / 碑裂托裱" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 修复室退回 */}
      <Modal
        open={returning !== null}
        title={
          returning
            ? `修复室退回 · ${steleTitle(returning.steleId)} 第 ${returning.versionNo} 版`
            : '修复室退回'
        }
        onCancel={() => setReturning(null)}
        onOk={() => void submitReturn()}
        okText="确认退回"
        cancelText="取消"
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="上了修复单的在修拓本，须修复室点头才能退回编目室。"
        />
        <Form form={returnForm} layout="vertical" preserve={false}>
          <Form.Item name="repairer" label="经手修复师" rules={[{ required: true, message: '请填写经手修复师' }]}>
            <Input placeholder="如：苏裱工" />
          </Form.Item>
          <Form.Item name="returnNote" label="退回 / 完工意见" rules={[{ required: true, message: '请填写退回意见' }]}>
            <Input.TextArea rows={3} placeholder="如：已补笔托裱，退回编目室复查" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
