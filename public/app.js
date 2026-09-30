// 访客年表：只读最新已发布版本
const statusEl = document.getElementById('status');
const timelineEl = document.getElementById('timeline');
const metaEl = document.getElementById('version-meta');

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const GRANULARITY = { year: '年', month: '月', day: '日' };

function claimLabel(c) {
  if (c.precision === 'day') return `${c.year}年${c.month}月${c.day}日`;
  if (c.precision === 'month') return `${c.year}年${c.month}月`;
  return `${c.year}年`;
}

function render(data) {
  timelineEl.innerHTML = '';
  statusEl.innerHTML = '';

  if (!data) {
    statusEl.append(
      el('div', { className: 'alert warn' },
        el('h4', {}, '尚无已发布年表'),
        el('p', {}, '年表还未发布任何版本。已发布后此页会显示最新版本。'))
    );
    metaEl.textContent = '';
    return;
  }

  const { version, events, relations } = data;
  metaEl.textContent =
    `版本 #${version.id} · 发布于 ${version.created_at}${version.note ? ' · ' + version.note : ''}`;

  if (events.length === 0) {
    statusEl.append(el('div', { className: 'alert warn' }, '当前已发布版本不包含任何事件。'));
    return;
  }

  const titleById = new Map(events.map((e) => [e.event_id, e.title]));

  for (const e of events) {
    const claim = e.claim;
    const outEdges = relations.filter((r) => r.predecessor_id === e.event_id);

    const claimLine = el('div', { className: 'source' },
      el('strong', {}, '出处：'), claim.source,
      claim.note ? `（${claim.note}）` : '',
      el('span', { className: 'badge gran', style: 'margin-left:8px' },
        `记录精度：${GRANULARITY[claim.precision]}`),
    );

    const inferred = el('div', { className: 'inferred' },
      `所选主张“${claimLabel(claim)}”覆盖 ${e.resolved_date}；`,
      claim.precision !== 'day'
        ? '该具体日期是为满足全部严格先后关系而在覆盖区间内确定的最早可行日期。'
        : '具体日期即主张日期。',
    );

    const afterLine = outEdges.length > 0
      ? el('div', { className: 'source muted' },
          '先于：' + outEdges.map((r) => titleById.get(r.successor_id) ?? `事件#${r.successor_id}`).join('、'))
      : null;

    timelineEl.append(
      el('div', { className: 'event' },
        el('div', { className: 'date' }, claimLabel(claim)),
        el('div', { className: 'title' }, e.title),
        e.description ? el('div', { className: 'desc' }, e.description) : null,
        claimLine,
        inferred,
        afterLine)
    );
  }
}

async function load() {
  try {
    const res = await fetch('/api/timeline');
    render(await res.json());
  } catch (err) {
    statusEl.append(el('div', { className: 'alert err' }, '加载失败：' + err.message));
  }
}

load();
