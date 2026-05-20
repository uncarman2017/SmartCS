import { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Select, Loading, MessagePlugin } from 'tdesign-react';
import { BarChart3, MessageSquare, Users, Star, TrendingUp } from 'lucide-react';

interface AdminOverview {
  total_sessions: number;
  active_sessions: number;
  total_messages: number;
  avg_satisfaction: number;
  today_sessions: number;
}

interface IntentDistItem {
  intent: string;
  count: number;
  avg_confidence: number;
}

interface SatisfactionStats {
  total_ratings: number;
  average_score: number;
  distribution: Array<{ score: number; count: number }>;
}

interface TrendItem {
  date: string;
  avg_score: number;
  count: number;
}

interface ConversationRecord {
  session_id: string;
  title: string;
  status: string;
  message_count: number;
  last_message: string | null;
  intent: string | null;
  avg_rating: number | null;
  created_at: string;
  updated_at: string;
}

const INTENT_LABELS: Record<string, string> = {
  refund: '退款/退货',
  order_inquiry: '订单查询',
  tech_support: '技术支持',
  transfer_to_human: '转人工',
  general: '一般咨询',
};

const INTENT_COLORS: Record<string, string> = {
  refund: '#f56c6c',
  order_inquiry: '#409eff',
  tech_support: '#e6a23c',
  transfer_to_human: '#67c23a',
  general: '#909399',
};

const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  resolved: '已解决',
  transferred: '已转人工',
};

const STATUS_THEMES: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'default'> = {
  active: 'primary',
  resolved: 'success',
  transferred: 'warning',
};

export function AdminPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [intentDist, setIntentDist] = useState<IntentDistItem[]>([]);
  const [satisfactionStats, setSatisfactionStats] = useState<SatisfactionStats | null>(null);
  const [trend, setTrend] = useState<TrendItem[]>([]);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [totalConv, setTotalConv] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [page, setPage] = useState({ current: 1, pageSize: 20 });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch overview data
      const overviewRes = await fetch('/api/admin/overview');
      const overviewData = await overviewRes.json();
      setOverview(overviewData.overview);
      setIntentDist(overviewData.intent_distribution);
      setSatisfactionStats(overviewData.satisfaction_stats);
      setTrend(overviewData.satisfaction_trend || []);

      // Fetch conversations
      const convParams = new URLSearchParams({
        limit: String(page.pageSize),
        offset: String((page.current - 1) * page.pageSize),
      });
      if (statusFilter) convParams.set('status', statusFilter);
      const convRes = await fetch(`/api/admin/conversations?${convParams}`);
      const convData = await convRes.json();
      setConversations(convData.conversations || []);
      setTotalConv(convData.total || 0);
    } catch (err) {
      console.error('Admin data fetch error:', err);
      MessagePlugin.error('获取管理后台数据失败');
    } finally {
      setLoading(false);
    }
  }, [page.current, page.pageSize, statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const formatDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoStr;
    }
  };

  const renderSatisfactionStars = (score: number) => {
    const intScore = Math.round(score);
    return (
      <span style={{ color: '#f59e0b', fontSize: '14px' }}>
        {'★'.repeat(intScore)}{'☆'.repeat(5 - intScore)}
        <span style={{ color: 'var(--td-text-color-primary)', marginLeft: 4, fontWeight: 600 }}>{score}</span>
      </span>
    );
  };

  const columns = [
    {
      colKey: 'title',
      title: '会话标题',
      ellipsis: true,
      width: 200,
    },
    {
      colKey: 'intent',
      title: '意图',
      width: 110,
      cell: ({ row }: any) => {
        const intent = row.intent || 'general';
        return (
          <Tag
            size="small"
            style={{
              backgroundColor: `${INTENT_COLORS[intent] || '#909399'}20`,
              color: INTENT_COLORS[intent] || '#909399',
              border: `1px solid ${INTENT_COLORS[intent] || '#909399'}40`,
            }}
          >
            {INTENT_LABELS[intent] || intent}
          </Tag>
        );
      },
    },
    {
      colKey: 'status',
      title: '状态',
      width: 90,
      cell: ({ row }: any) => (
        <Tag size="small" theme={STATUS_THEMES[row.status] || 'default'} variant="light">
          {STATUS_LABELS[row.status] || row.status}
        </Tag>
      ),
    },
    {
      colKey: 'message_count',
      title: '消息数',
      width: 80,
      align: 'center' as const,
    },
    {
      colKey: 'avg_rating',
      title: '满意度',
      width: 140,
      cell: ({ row }: any) =>
        row.avg_rating ? renderSatisfactionStars(Number(row.avg_rating)) : <span style={{ color: 'var(--td-text-color-placeholder)' }}>-</span>,
    },
    {
      colKey: 'last_message',
      title: '最后消息',
      ellipsis: true,
      width: 250,
      cell: ({ row }: any) => (
        <span style={{ color: 'var(--td-text-color-secondary)', fontSize: '13px' }}>
          {row.last_message ? row.last_message.slice(0, 60) + (row.last_message.length > 60 ? '...' : '') : '-'}
        </span>
      ),
    },
    {
      colKey: 'updated_at',
      title: '更新时间',
      width: 140,
      cell: ({ row }: any) => formatDate(row.updated_at),
    },
  ];

  // Build a simple satisfaction trend chart using CSS bars
  const maxTrendCount = trend.length > 0 ? Math.max(...trend.map(t => t.count), 1) : 1;

  return (
    <div className="flex-1 overflow-y-auto p-6" style={{ backgroundColor: 'var(--td-bg-color-page)' }}>
      <div className="max-w-7xl mx-auto">
        {/* Page Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--td-text-color-primary)' }}>
            管理后台
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--td-text-color-secondary)' }}>
            对话记录 • 满意度统计 • 意图分析
          </p>
        </div>

        <Loading loading={loading} text="加载中...">
          {/* Overview Cards */}
          {overview && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
              <Card bordered style={{ borderRadius: 12 }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#eff6ff' }}>
                    <MessageSquare size={20} color="#3b82f6" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" style={{ color: 'var(--td-text-color-primary)' }}>{overview.total_sessions}</div>
                    <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>总会话数</div>
                  </div>
                </div>
              </Card>
              <Card bordered style={{ borderRadius: 12 }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#fef3c7' }}>
                    <Users size={20} color="#f59e0b" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" style={{ color: 'var(--td-text-color-primary)' }}>{overview.today_sessions}</div>
                    <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>今日会话</div>
                  </div>
                </div>
              </Card>
              <Card bordered style={{ borderRadius: 12 }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#dcfce7' }}>
                    <BarChart3 size={20} color="#16a34a" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" style={{ color: 'var(--td-text-color-primary)' }}>{overview.active_sessions}</div>
                    <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>活跃会话</div>
                  </div>
                </div>
              </Card>
              <Card bordered style={{ borderRadius: 12 }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#f3e8ff' }}>
                    <Star size={20} color="#8b5cf6" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" style={{ color: 'var(--td-text-color-primary)' }}>{overview.avg_satisfaction}</div>
                    <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>平均满意度</div>
                  </div>
                </div>
              </Card>
              <Card bordered style={{ borderRadius: 12 }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#ffe4e6' }}>
                    <MessageSquare size={20} color="#e11d48" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" style={{ color: 'var(--td-text-color-primary)' }}>{overview.total_messages}</div>
                    <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>总消息数</div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            {/* Satisfaction Distribution */}
            {satisfactionStats && (
              <Card title="满意度分布" bordered style={{ borderRadius: 12 }}>
                <div className="space-y-3">
                  {[5, 4, 3, 2, 1].map(score => {
                    const item = satisfactionStats.distribution.find(d => d.score === score);
                    const count = item?.count || 0;
                    const maxCount = Math.max(...satisfactionStats.distribution.map(d => d.count), 1);
                    const pct = (count / maxCount) * 100;
                    return (
                      <div key={score} className="flex items-center gap-3">
                        <div className="flex items-center gap-1 w-16" style={{ color: '#f59e0b' }}>
                          {'★'.repeat(score)}{'☆'.repeat(5 - score)}
                        </div>
                        <div className="flex-1 h-6 rounded-full relative overflow-hidden" style={{ backgroundColor: 'var(--td-bg-color-component)' }}>
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${pct}%`, backgroundColor: score >= 4 ? '#22c55e' : score >= 3 ? '#eab308' : '#ef4444' }}
                          />
                        </div>
                        <span className="w-10 text-right text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>{count}</span>
                      </div>
                    );
                  })}
                  <div className="text-center pt-2" style={{ color: 'var(--td-text-color-secondary)' }}>
                    共 {satisfactionStats.total_ratings} 条评分 · 平均 {satisfactionStats.average_score} 分
                  </div>
                </div>
              </Card>
            )}

            {/* Satisfaction Trend */}
            {trend.length > 0 && (
              <Card title="满意度趋势（近30天）" bordered style={{ borderRadius: 12 }}>
                <div className="flex items-end gap-1 h-40">
                  {trend.map((item, i) => {
                    const height = (item.avg_score / 5) * 100;
                    const barColor = item.avg_score >= 4 ? '#22c55e' : item.avg_score >= 3 ? '#eab308' : '#ef4444';
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1" title={`${item.date}: ${item.avg_score}分 (${item.count}评)`}>
                        <span className="text-xs font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                          {item.avg_score.toFixed(1)}
                        </span>
                        <div className="w-full rounded-t transition-all" style={{
                          height: `${Math.max(height, 2)}%`,
                          backgroundColor: barColor,
                          minHeight: 4,
                          opacity: 0.8,
                        }} />
                        {i % 7 === 0 && (
                          <span className="text-[10px] mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                            {item.date.slice(5)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>

          {/* Intent Distribution */}
          {intentDist.length > 0 && (
            <Card title="意图分布" bordered style={{ borderRadius: 12 }} className="mb-6">
              <div className="flex flex-wrap gap-4">
                {intentDist.map(item => (
                  <div
                    key={item.intent}
                    className="flex items-center gap-3 px-4 py-3 rounded-lg"
                    style={{
                      backgroundColor: `${INTENT_COLORS[item.intent] || '#909399'}10`,
                      border: `1px solid ${INTENT_COLORS[item.intent] || '#909399'}30`,
                    }}
                  >
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: INTENT_COLORS[item.intent] || '#909399' }} />
                    <div>
                      <div className="font-medium text-sm" style={{ color: 'var(--td-text-color-primary)' }}>
                        {INTENT_LABELS[item.intent] || item.intent}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                        {item.count} 次 · 置信度 {(item.avg_confidence * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div className="text-xl font-bold ml-2" style={{ color: INTENT_COLORS[item.intent] || '#909399' }}>
                      {item.count}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Conversation Records Table */}
          <Card
            title="对话记录"
            bordered
            style={{ borderRadius: 12 }}
            actions={
              <div className="flex items-center gap-3">
                <Select
                  value={statusFilter}
                  onChange={(val) => { setStatusFilter(val as string); setPage({ current: 1, pageSize: page.pageSize }); }}
                  placeholder="全部状态"
                  clearable
                  style={{ width: 140 }}
                  options={[
                    { label: '全部状态', value: '' },
                    { label: '进行中', value: 'active' },
                    { label: '已解决', value: 'resolved' },
                    { label: '已转人工', value: 'transferred' },
                  ]}
                />
              </div>
            }
          >
            <Table
              data={conversations}
              columns={columns}
              rowKey="session_id"
              size="medium"
              hover
              stripe
              pagination={{
                current: page.current,
                pageSize: page.pageSize,
                total: totalConv,
                showJumper: true,
                onChange: (pageInfo: any) => {
                  setPage({ current: pageInfo.current, pageSize: pageInfo.pageSize });
                },
              }}
              empty="暂无对话记录"
            />
          </Card>
        </Loading>
      </div>
    </div>
  );
}
