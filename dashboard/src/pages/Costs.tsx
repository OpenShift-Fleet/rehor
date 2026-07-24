import { useEffect, useState, useCallback } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid,
  Cell,
  PieChart,
  Pie,
} from 'recharts';
import type { CycleEntry, DailyAggregate, AnalyticsData } from '../types';
import { fetchCosts, fetchAnalytics } from '../api';
import { formatDuration, formatTokens, sourceUrl, displayKey } from '../utils';
import { useWS } from '../hooks/useWebSocket';
import {
  Card,
  CardBody,
  CardTitle,
  CardHeader,
  Flex,
  FlexItem,
  Label,
  ToggleGroup,
  ToggleGroupItem,
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectList,
  SelectOption,
  Content
} from '@patternfly/react-core';

const DAYS_OPTIONS = [7, 14, 30, 90];

type CycleMetric = 'cost' | 'output_tokens' | 'duration' | 'turns';

const METRIC_CONFIG: Record<CycleMetric, { label: string; color: string; format: (v: number) => string }> = {
  cost: { label: 'Cost', color: '#3fb950', format: v => '$' + v.toFixed(2) },
  output_tokens: { label: 'Output Tokens', color: '#58a6ff', format: v => formatTokens(v) },
  duration: { label: 'Duration', color: '#d29922', format: v => formatDuration(v) },
  turns: { label: 'Turns', color: '#bc8cff', format: v => String(v) },
};

interface CostsData {
  cycles: CycleEntry[];
  daily: DailyAggregate[];
}

const WORK_TYPE_COLORS: Record<string, string> = {
  new_ticket: '#3fb950',
  pr_review: '#58a6ff',
  ci_fix: '#f85149',
  investigation: '#d29922',
  cve: '#f0883e',
  memory_housekeeping: '#bc8cff',
  idle: '#484f58',
  error: '#f85149',
  other: '#8b949e',
};

const WORK_TYPE_LABELS: Record<string, string> = {
  new_ticket: 'New Ticket',
  implement: 'Implement',
  pr_review: 'PR Review',
  review: 'Review',
  ci_fix: 'CI Fix',
  'ci-fix': 'CI Fix',
  triage: 'Triage',
  investigation: 'Investigation',
  cve: 'CVE',
  memory_housekeeping: 'Housekeeping',
  idle: 'Idle',
  error: 'Error',
  other: 'Other',
};

const REPO_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff', '#f85149', '#79c0ff', '#56d364', '#e3b341', '#db6d28', '#d2a8ff', '#ff7b72'];

type DateMode = 'preset' | 'range';

function CycleChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const status = d.is_error ? 'error' : d.no_work ? 'idle' : 'work';
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{d.time}</div>
      {d.external_key && <div style={{ fontWeight: 600 }}>{d.external_key}{d.repo ? ` · ${d.repo}` : ''}</div>}
      {d.work_type && <div style={{ color: 'var(--accent)' }}>{WORK_TYPE_LABELS[d.work_type] || d.work_type}</div>}
      <div>${Number(d.cost).toFixed(2)} &middot; {d.turns} turns &middot; {formatDuration(d.duration)}</div>
      <div>{formatTokens(d.output_tokens)} output &middot; {formatTokens(d.cache_read)} cache</div>
      {d.summary && <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>{d.summary}</div>}
      <div style={{ color: d.is_error ? 'var(--red)' : d.no_work ? 'var(--text-dim)' : 'var(--green)' }}>{status}</div>
    </div>
  );
}

function DailyChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color }}>
          {p.name}: {p.dataKey === 'cost' ? '$' + Number(p.value).toFixed(2) : formatTokens(p.value)}
        </div>
      ))}
    </div>
  );
}

function PieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="chart-tooltip">
      <div style={{ fontWeight: 600, color: d.payload.fill }}>{d.name}</div>
      <div>{d.value} cycles · ${d.payload.total_cost?.toFixed(2)}</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>avg ${d.payload.avg_cost?.toFixed(2)}/cycle · {d.payload.avg_turns} turns</div>
    </div>
  );
}

function CycleDot(props: any) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  const wt = payload?.work_type || (payload?.no_work ? 'idle' : payload?.is_error ? 'error' : '');
  const color = WORK_TYPE_COLORS[wt] || '#8b949e';
  return <circle cx={cx} cy={cy} r={3} fill={color} stroke={color} strokeWidth={1} opacity={0.9} />;
}

function CycleActiveDot(props: any) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  const wt = payload?.work_type || (payload?.no_work ? 'idle' : payload?.is_error ? 'error' : '');
  const color = WORK_TYPE_COLORS[wt] || '#8b949e';
  return (
    <g>
      <circle cx={cx} cy={cy} r={7} fill={color} opacity={0.2} />
      <circle cx={cx} cy={cy} r={4} fill={color} stroke="#fff" strokeWidth={1} />
    </g>
  );
}

function CycleRow({ c }: { c: CycleEntry }) {
  const costColor = c.cost_usd > 2 ? 'var(--red)' : c.cost_usd > 1 ? 'var(--yellow)' : 'var(--green)';
  const statusLabel = c.is_error ? 'error' : c.no_work ? 'idle' : (WORK_TYPE_LABELS[c.work_type || ''] || c.work_type || 'work');
  const statusColor = c.is_error ? 'var(--red)' : c.no_work ? 'var(--text-dim)' : 'var(--green)';
  const ts = new Date(c.timestamp);

  return (
    <div className="cycle-row" title={c.summary || ''}>
      <div className="cycle-time" title={c.timestamp}>
        {ts.toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
        {ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="cycle-work">
        {displayKey(c) ? (
          <a href={sourceUrl(c) || '#'} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
            {displayKey(c)}
          </a>
        ) : (
          <span style={{ color: 'var(--text-dim)' }}>—</span>
        )}
        {c.repo && <span className="cycle-repo">{c.repo}</span>}
      </div>
      <div className="cycle-cost" style={{ color: costColor }}>${c.cost_usd.toFixed(2)}</div>
      <div className="cycle-turns">{c.num_turns} turns</div>
      <div className="cycle-duration">{formatDuration(c.duration_ms)}</div>
      <div className="cycle-tokens">
        <span title="Output tokens">{formatTokens(c.output_tokens)} out</span>
        <span className="cycle-tokens-dim" title="Cache read">{formatTokens(c.cache_read_tokens)} cache</span>
      </div>
      <div className="cycle-status" style={{ color: statusColor }}>{statusLabel}</div>
    </div>
  );
}

function SummaryCard({ value, label, sub, color }: { value: string; label: string; sub?: string; color?: string }) {
  return (
    <Card isCompact isGlass style={color ? { borderLeft: `3px solid ${color}` } : undefined}>
      <CardBody>
        <Content component="p" style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0, color: color || 'inherit' }}>{value}</Content>
        <Content component="p" style={{ margin: '4px 0 0', fontWeight: 500 }}>{label}</Content>
        {sub && <Content component="small" style={{ margin: 0, color: 'var(--pf-t--global--text--color--subtle, var(--text-dim))' }}>{sub}</Content>}
      </CardBody>
    </Card>
  );
}

export default function Costs() {
  const [dateMode, setDateMode] = useState<DateMode>('preset');
  const [days, setDays] = useState(30);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState<CostsData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [metric, setMetric] = useState<CycleMetric>('cost');
  const [isDaysOpen, setIsDaysOpen] = useState(false);

  const { onEvent } = useWS();

  const load = useCallback(async () => {
    const from = dateMode === 'range' ? dateFrom || undefined : undefined;
    const to = dateMode === 'range' ? dateTo || undefined : undefined;
    const [costsRes, analyticsRes] = await Promise.all([
      fetchCosts(days, 500, from, to),
      fetchAnalytics(days, from, to),
    ]);
    setData({ cycles: costsRes.items || [], daily: costsRes.daily || [] });
    setAnalytics(analyticsRes);
  }, [days, dateMode, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    return onEvent((event) => {
      if (event.type === 'cycle_recorded') load();
    });
  }, [onEvent, load]);

  if (!data || !analytics) return <div className="empty-state">Loading...</div>;

  const { cycles, daily } = data;
  const { summary, work_types, repos, tickets, feedback } = analytics;

  const totalDuration = cycles.reduce((s, c) => s + c.duration_ms, 0);
  const totalOutput = cycles.reduce((s, c) => s + c.output_tokens, 0);
  const totalCacheRead = cycles.reduce((s, c) => s + c.cache_read_tokens, 0);

  // Per-cycle chart data (reversed so oldest is left)
  const cycleChartData = [...cycles].reverse().map((c, i) => {
    const ts = new Date(c.timestamp);
    return {
      idx: i,
      time: ts.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      cost: c.cost_usd,
      output_tokens: c.output_tokens,
      cache_read: c.cache_read_tokens,
      duration: c.duration_ms,
      turns: c.num_turns,
      is_error: c.is_error,
      no_work: c.no_work,
      external_key: displayKey(c),
      repo: c.repo,
      work_type: c.work_type,
      summary: c.summary,
    };
  });

  const mc = METRIC_CONFIG[metric];

  // Daily chart data
  const sorted = [...daily].sort((a, b) => a.day.localeCompare(b.day));
  const dailyCostData = sorted.map(d => ({ day: d.day.slice(5), cost: Number(d.total_cost.toFixed(2)) }));
  const dailyTokenData = sorted.map(d => ({ day: d.day.slice(5), output: d.output_tokens, cache_read: d.cache_read }));

  // Work type pie data (exclude idle)
  const pieData = work_types
    .filter(w => w.category !== 'idle' && w.category !== 'error')
    .map(w => ({
      name: WORK_TYPE_LABELS[w.category] || w.category,
      value: w.cycles,
      total_cost: w.total_cost,
      avg_cost: w.avg_cost,
      avg_turns: w.avg_turns,
      fill: WORK_TYPE_COLORS[w.category] || '#8b949e',
    }));

  // Repo bar data
  const repoBarData = repos.slice(0, 12).map(r => ({
    repo: r.repo.length > 20 ? r.repo.slice(0, 18) + '...' : r.repo,
    fullRepo: r.repo,
    tickets: r.tickets,
    cycles: r.cycles,
    total_cost: r.total_cost,
  }));

  // Ticket lifecycle stacked bar
  const ticketBarData = tickets.slice(0, 15).map(t => ({
    key: displayKey(t),
    title: t.title ? (t.title.length > 40 ? t.title.slice(0, 38) + '...' : t.title) : displayKey(t),
    impl: t.impl_cycles,
    review: t.review_cycles,
    total_cost: t.total_cost,
    hours: t.hours_span,
  }));

  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div className="costs-page">
      {/* Date controls */}
      <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }} style={{ marginBottom: '16px' }}>
        <FlexItem>
          <ToggleGroup aria-label="Date mode">
            <ToggleGroupItem text="Preset" isSelected={dateMode === 'preset'} onChange={() => setDateMode('preset')} />
            <ToggleGroupItem text="Date Range" isSelected={dateMode === 'range'} onChange={() => setDateMode('range')} />
          </ToggleGroup>
        </FlexItem>
        <FlexItem>
          {dateMode === 'preset' ? (
            <Select
              isOpen={isDaysOpen}
              selected={String(days)}
              onSelect={(_e, val) => { setDays(Number(val)); setIsDaysOpen(false); }}
              onOpenChange={setIsDaysOpen}
              toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                <MenuToggle ref={toggleRef} onClick={() => setIsDaysOpen(!isDaysOpen)} isExpanded={isDaysOpen}>
                  {days} days
                </MenuToggle>
              )}
            >
              <SelectList>
                {DAYS_OPTIONS.map(d => <SelectOption key={d} value={String(d)}>{d} days</SelectOption>)}
              </SelectList>
            </Select>
          ) : (
            <Flex gap={{ default: 'gapSm' }} alignItems={{ default: 'alignItemsCenter' }}>
              <FlexItem>
                <Label variant="outline">From</Label>
              </FlexItem>
              <FlexItem>
                <input type="date" value={dateFrom} max={dateTo || todayStr} onChange={e => setDateFrom(e.target.value)} className="date-range-picker-input" />
              </FlexItem>
              <FlexItem>
                <Label variant="outline">To</Label>
              </FlexItem>
              <FlexItem>
                <input type="date" value={dateTo} min={dateFrom} max={todayStr} onChange={e => setDateTo(e.target.value)} className="date-range-picker-input" />
              </FlexItem>
            </Flex>
          )}
        </FlexItem>
      </Flex>

      {/* Summary cards */}
      <div className="summary-grid">
        <SummaryCard value={String(summary.tickets_resolved)} label="Tickets Resolved" sub={`${summary.unique_tickets} unique worked on`} color="var(--green)" />
        <SummaryCard value={`$${summary.total_cost.toFixed(2)}`} label="Total Cost" sub={`$${summary.avg_cost_per_work_cycle.toFixed(2)} avg/work cycle`} color="var(--green)" />
        <SummaryCard value={String(summary.work_cycles)} label="Work Cycles" sub={`${summary.idle_cycles} idle · ${summary.error_cycles} error`} />
        <SummaryCard value={formatDuration(summary.avg_duration_ms)} label="Avg Cycle Duration" sub={`${summary.avg_turns} avg turns`} />
        <SummaryCard value={`${feedback.avg_review_rounds}`} label="Avg Review Rounds" sub={`${feedback.zero_review} first-pass · ${feedback.multi_review} multi-round`} color="var(--accent)" />
        <SummaryCard value={String(summary.repos_touched)} label="Repos Touched" />
      </div>

      {/* Analytics charts row */}
      <div className="analytics-charts">
        {/* Work type pie */}
        {pieData.length > 0 && (
          <Card isCompact isGlass>
            <CardHeader><CardTitle>Work Breakdown</CardTitle></CardHeader>
            <CardBody>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  innerRadius={40}
                  paddingAngle={2}
                  label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {pieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Pie>
                <Tooltip content={<PieTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="work-type-legend">
              {pieData.map((d) => (
                <span key={d.name} className="cycle-legend-item">
                  <span className="cycle-legend-dot" style={{ background: d.fill }} />
                  {d.name}: {d.value} ({`$${d.total_cost.toFixed(2)}`})
                </span>
              ))}
            </div>
            </CardBody>
          </Card>
        )}

        {/* Repo breakdown bar */}
        {repoBarData.length > 0 && (
          <Card isCompact isGlass>
            <CardHeader><CardTitle>Repos</CardTitle></CardHeader>
            <CardBody>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={repoBarData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,61,0.5)" horizontal={false} />
                <XAxis type="number" stroke="var(--text-dim)" fontSize={11} />
                <YAxis type="category" dataKey="repo" stroke="var(--text-dim)" fontSize={11} width={140} tick={{ fill: 'var(--text-dim)' }} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload;
                  return (
                    <div className="chart-tooltip">
                      <div style={{ fontWeight: 600 }}>{d.fullRepo}</div>
                      <div>{d.tickets} tickets · {d.cycles} cycles</div>
                      <div style={{ color: 'var(--green)' }}>${d.total_cost.toFixed(2)}</div>
                    </div>
                  );
                }} />
                <Bar dataKey="cycles" name="Cycles" radius={[0, 4, 4, 0]}>
                  {repoBarData.map((_, i) => <Cell key={i} fill={REPO_COLORS[i % REPO_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            </CardBody>
          </Card>
        )}
      </div>

      {/* Ticket lifecycle */}
      {ticketBarData.length > 0 && (
        <Card isCompact isGlass style={{ marginBottom: '16px' }}>
          <CardHeader><CardTitle>Ticket Lifecycle — Cycles per Ticket</CardTitle></CardHeader>
          <CardBody>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
            Implementation vs review cycles. Hover for cost & time details.
          </div>
          <ResponsiveContainer width="100%" height={Math.max(200, ticketBarData.length * 28 + 40)}>
            <BarChart data={ticketBarData} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,61,0.5)" horizontal={false} />
              <XAxis type="number" stroke="var(--text-dim)" fontSize={11} allowDecimals={false} />
              <YAxis type="category" dataKey="key" stroke="var(--text-dim)" fontSize={11} width={130} tick={{ fill: 'var(--accent)' }} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload;
                  const hoveredKey = payload.find(p => p.value && Number(p.value) > 0)?.dataKey;
                  return (
                    <div className="chart-tooltip">
                      <div style={{ fontWeight: 600 }}>{d.key}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', maxWidth: 250 }}>{d.title}</div>
                      <div style={{ marginTop: 4 }}>
                        <span style={{ color: WORK_TYPE_COLORS.new_ticket, fontWeight: hoveredKey === 'impl' ? 700 : 400 }}>
                          {d.impl} impl
                        </span>
                        {' + '}
                        <span style={{ color: WORK_TYPE_COLORS.pr_review, fontWeight: hoveredKey === 'review' ? 700 : 400 }}>
                          {d.review} review
                        </span>
                        {' = '}{d.impl + d.review} total
                      </div>
                      <div style={{ color: 'var(--green)' }}>${d.total_cost.toFixed(2)}</div>
                      {d.hours > 0 && <div style={{ color: 'var(--text-dim)' }}>{d.hours.toFixed(1)}h elapsed</div>}
                    </div>
                  );
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="impl" name="Implementation" stackId="a" fill={WORK_TYPE_COLORS.new_ticket} radius={[0, 0, 0, 0]} />
              <Bar dataKey="review" name="Review" stackId="a" fill={WORK_TYPE_COLORS.pr_review} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
          </CardBody>
        </Card>
      )}

      {/* Per-Cycle Chart */}
      <Card isCompact isGlass style={{ marginBottom: '16px' }}>
        <CardBody>
        <div className="cycle-header-row">
          <h3>Cycles</h3>
          <div className="cycle-summary-inline">
            <span>{cycles.length} total</span>
            <span className="dot-sep" />
            <span style={{ color: 'var(--green)' }}>{summary.work_cycles} work</span>
            <span className="dot-sep" />
            <span style={{ color: 'var(--text-dim)' }}>{summary.idle_cycles} idle</span>
            {summary.error_cycles > 0 && <><span className="dot-sep" /><span style={{ color: 'var(--red)' }}>{summary.error_cycles} error</span></>}
            <span className="dot-sep" />
            <span style={{ color: 'var(--green)' }}>${summary.total_cost.toFixed(2)} total</span>
            <span className="dot-sep" />
            <span>${summary.work_cycles > 0 ? summary.avg_cost_per_work_cycle.toFixed(2) : '0.00'} avg/work</span>
          </div>
        </div>

        <ToggleGroup aria-label="Metric" style={{ marginBottom: '12px' }}>
          {(Object.keys(METRIC_CONFIG) as CycleMetric[]).map(m => (
            <ToggleGroupItem key={m} text={METRIC_CONFIG[m].label} isSelected={m === metric} onChange={() => setMetric(m)} />
          ))}
        </ToggleGroup>

        {cycleChartData.length > 1 && (
          <>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={cycleChartData}>
                <defs>
                  <linearGradient id="cycleGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={mc.color} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={mc.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,61,0.5)" />
                <XAxis dataKey="time" stroke="var(--text-dim)" fontSize={10} interval="preserveStartEnd" tick={false} />
                <YAxis stroke="var(--text-dim)" fontSize={10} tickFormatter={mc.format} width={60} />
                <Tooltip content={<CycleChartTooltip />} />
                <Area type="monotone" dataKey={metric} stroke={mc.color} fill="url(#cycleGrad)" strokeWidth={2} dot={<CycleDot />} activeDot={<CycleActiveDot />} />
              </AreaChart>
            </ResponsiveContainer>
            <div className="cycle-chart-legend">
              {Object.entries(WORK_TYPE_LABELS).map(([key, label]) => (
                <span key={key} className="cycle-legend-item">
                  <span className="cycle-legend-dot" style={{ background: WORK_TYPE_COLORS[key] }} />
                  {label}
                </span>
              ))}
            </div>
          </>
        )}

        <div className="cycle-list">
          <div className="cycle-row cycle-row-header">
            <div>Time</div>
            <div>Work</div>
            <div>Cost</div>
            <div>Turns</div>
            <div>Duration</div>
            <div>Tokens</div>
            <div>Type</div>
          </div>
          {cycles.length === 0 && <div className="empty-state">No cycles recorded</div>}
          {cycles.map(c => <CycleRow key={c.id} c={c} />)}
        </div>
        </CardBody>
      </Card>

      {/* Daily Summary */}
      {daily.length > 0 && (
        <>
          <div className="costs-daily-header">
            <h3>Daily Summary</h3>
            <div className="costs-daily-stats">
              <span>{formatDuration(totalDuration)} runtime</span>
              <span className="dot-sep" />
              <span>{formatTokens(totalOutput)} output</span>
              <span className="dot-sep" />
              <span>{formatTokens(totalCacheRead)} cache read</span>
            </div>
          </div>
          <div className="costs-charts">
            <Card isCompact isGlass>
              <CardHeader><CardTitle>Cost per Day</CardTitle></CardHeader>
              <CardBody>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={dailyCostData}>
                  <defs>
                    <linearGradient id="dailyCostGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3fb950" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3fb950" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,61,0.5)" />
                  <XAxis dataKey="day" stroke="var(--text-dim)" fontSize={11} />
                  <YAxis stroke="var(--text-dim)" fontSize={11} tickFormatter={v => '$' + v} />
                  <Tooltip content={<DailyChartTooltip />} />
                  <Area type="monotone" dataKey="cost" name="Cost ($)" stroke="#3fb950" fill="url(#dailyCostGrad)" strokeWidth={2} dot={{ r: 3, fill: '#3fb950' }} />
                </AreaChart>
              </ResponsiveContainer>
              </CardBody>
            </Card>
            <Card isCompact isGlass>
              <CardHeader><CardTitle>Tokens per Day</CardTitle></CardHeader>
              <CardBody>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={dailyTokenData}>
                  <defs>
                    <linearGradient id="dailyOutGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3fb950" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3fb950" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="dailyCacheGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#58a6ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,61,0.5)" />
                  <XAxis dataKey="day" stroke="var(--text-dim)" fontSize={11} />
                  <YAxis stroke="var(--text-dim)" fontSize={11} tickFormatter={v => formatTokens(v)} />
                  <Tooltip content={<DailyChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="output" name="Output" stroke="#3fb950" fill="url(#dailyOutGrad)" strokeWidth={2} dot={{ r: 3, fill: '#3fb950' }} />
                  <Area type="monotone" dataKey="cache_read" name="Cache Read" stroke="#58a6ff" fill="url(#dailyCacheGrad)" strokeWidth={2} dot={{ r: 3, fill: '#58a6ff' }} />
                </AreaChart>
              </ResponsiveContainer>
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
