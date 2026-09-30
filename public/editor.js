// 编辑工作台
const $ = (sel) => document.querySelector(sel);

const state = {
  events: [],
  claims: [],
  relations: [],
  baseVersion: null,
  selections: new Map(),
  validation: null,
  conflict: null,
};

let token = localStorage.getItem('editor-token') || '';
const storeKey = 'chronicle-selections';
function loadStoredSelections() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(storeKey) || '{}')).map(
      ([k, v]) => [Number(k), Number(v)]
    ));
  } catch {
    return new Map();
  }
}
function saveSelections() {
  const obj = Object.fromEntries([...state.selections].map(([k, v]) => [k, v]));
  localStorage.setItem(storeKey, JSON.stringify(obj));
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['X-Editor-Token'] = token;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ---------- 口令 ----------
async function ensureAuth() {
  const config = await api('/api/config').catch(() => ({ authRequired: false }));
  if (!config.authRequired) return true;
  if (token && await tryLoadDraft()) return true;

  return new Promise((resolve) => {
    const modal = $('#auth-modal');
    modal.hidden = false;
    $('#token-input').focus();
    const submit = async () => {
      token = $('#token-input').value.trim();
      const ok = await tryLoadDraft();
      if (ok) {
        localStorage.setItem('editor-token', token);
        modal.hidden = true;
        $('#auth-error').hidden = true;
        resolve(true);
      } else {
        const box = $('#auth-error');
        box.hidden = false;
        box.textContent = '口令不正确，请重试。';
      }
    };
    $('#token-submit').onclick = submit;
    $('#token-input').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  });
}

async function tryLoadDraft() {
  try {
    const draft = await api('/api/draft');
    applyDraft(draft);
    return true;
  } catch (err) {
    return err.status !== 401;
  }
}

function applyDraft(draft) {
  state.events = draft.events;
  state.claims = draft.claims;
  state.relations = draft.relations;
  state.baseVersion = draft.baseVersion;

  const stored = loadStoredSelections();
  state.selections = new Map();
  const validClaimIds = new Set(state.claims.map((c) => c.id));
  const eventIds = new Set(state.events.map((e) => e.id));
  for (const [eventId, claimId] of stored) {
    if (eventIds.has(eventId) && validClaimIds.has(claimId)) state.selections.set(eventId, claimId);
  }
  saveSelections();
  state.conflict = null;
  $('#conflict-box').hidden = true;
  renderAll();
}

// ---------- 渲染 ----------
function eventName(id) {
  return state.events.find((e) => e.id === id)?.title ?? `事件#${id}`;
}

function claimLabel(c) {
  if (c.precision === 'day') return `${c.year}年${c.month}月${c.day}日`;
  if (c.precision === 'month') return `${c.year}年${c.month}月`;
  return `${c.year}年`;
}

function renderEvents() {
  const container = $('#events');
  container.innerHTML = '';
  if (state.events.length === 0) {
    container.append(el('div', { className: 'empty' }, '尚无事件，请先新增。'));
  }
  for (const e of state.events) {
    const eventClaims = state.claims.filter((c) => c.event_id === e.id);
    const selectedId = state.selections.get(e.id);

    const claimNodes = eventClaims.map((c) => {
      const selected = c.id === selectedId;
      return el('label', { className: 'claim' + (selected ? ' selected' : '') },
        el('input', {
          type: 'radio',
          name: `select-${e.id}`,
          value: c.id,
          checked: selected,
          onchange: () => selectClaim(e.id, c.id),
        }),
        el('div', { className: 'body' },
          el('div', { className: 'when' },
            claimLabel(c),
            el('span', { className: 'badge gran', style: 'margin-left:8px' },
              { year: '精确到年', month: '精确到月', day: '精确到日' }[c.precision])),
          el('div', { className: 'src' }, `出处：${c.source}${c.note ? `（${c.note}）` : ''}`)),
        el('button', {
          className: 'small danger',
          onclick: () => deleteClaim(c.id),
        }, '删除'));
    });

    const form = el('form', {
      className: 'row',
      style: 'margin-top:8px',
      onsubmit: (ev) => { ev.preventDefault(); addClaim(e.id, form); },
    },
      el('input', { type: 'number', name: 'year', min: '1', max: '9999', placeholder: '年*', required: true, style: 'width:90px' }),
      el('input', { type: 'number', name: 'month', min: '1', max: '12', placeholder: '月', style: 'width:70px' }),
      el('input', { type: 'number', name: 'day', min: '1', max: '31', placeholder: '日', style: 'width:70px' }),
      el('input', { type: 'text', name: 'source', placeholder: '出处*（访谈编号/档案/页码）', required: true, style: 'flex:2' }),
      el('input', { type: 'text', name: 'note', placeholder: '备注', style: 'flex:1' }),
      el('button', { className: 'small', type: 'submit' }, '加主张'));

    const card = el('div', { className: 'card', style: 'box-shadow:none;margin-bottom:10px' },
      el('div', { className: 'row between' },
        el('h3', { style: 'margin:0' }, `#${e.id} ${e.title}`,
          e.description ? el('span', { className: 'muted', style: 'font-weight:400;margin-left:10px' }, e.description) : null),
        el('button', { className: 'small danger', onclick: () => deleteEvent(e.id) }, '删除事件')),
      eventClaims.length === 0
        ? el('div', { className: 'empty' }, '还没有时间主张。同一事件可保留多条互相矛盾的主张，发布时单选其一。')
        : el('div', {}, ...claimNodes),
      form);
    container.append(card);
  }

  // 同步关系表单的下拉项
  for (const name of ['predecessor_id', 'successor_id']) {
    const select = document.querySelector(`#relation-form [name=${name}]`);
    const prev = select.value;
    select.innerHTML = '';
    select.append(el('option', { value: '' }, name === 'predecessor_id' ? '较早事件' : '较晚事件'));
    for (const e of state.events) select.append(el('option', { value: e.id }, `#${e.id} ${e.title}`));
    select.value = prev;
  }
}

function renderRelations() {
  const container = $('#relations');
  container.innerHTML = '';
  if (state.relations.length === 0) {
    container.append(el('div', { className: 'empty' }, '尚无先后关系。'));
    return;
  }
  for (const r of state.relations) {
    container.append(
      el('div', { className: 'relation-item' },
        el('span', {},
          el('strong', {}, eventName(r.predecessor_id)),
          ' 先于 ',
          el('strong', {}, eventName(r.successor_id)),
          r.note ? el('span', { className: 'muted' }, `（${r.note}）`) : null),
        el('button', { className: 'small danger', onclick: () => deleteRelation(r.id) }, '删除'))
    );
  }
}

function renderValidation() {
  const v = state.validation;
  const box = $('#validation');
  box.innerHTML = '';
  if (!v) return;

  if (v.empty) {
    box.append(el('div', { className: 'alert warn' },
      el('h4', {}, '草稿中还没有任何事件，无法发布。')));
    return;
  }

  if (v.feasible) {
    box.append(el('div', { className: 'alert ok' },
      el('h4', {}, '✓ 可以发布：所有事件都已选定主张，关系无环，且存在满足全部严格先后关系的具体日期。')));
    return;
  }

  if (v.missingSelections?.length) {
    box.append(el('div', { className: 'alert err' },
      el('h4', {}, `缺少主张选择（${v.missingSelections.length}）：发布要求每个事件选定一条主张`),
      el('ul', {}, ...v.missingSelections.map((m) =>
        el('li', {}, `事件 #${m.event_id} ${m.title}`)))));
  }

  if (v.invalidSelections?.length) {
    box.append(el('div', { className: 'alert err' },
      el('h4', {}, '所选主张已失效'),
      el('ul', {}, ...v.invalidSelections.map((m) =>
        el('li', {}, `事件 #${m.event_id} ${m.title}：${m.reason}`)))));
  }

  if (v.cycles?.length) {
    box.append(el('div', { className: 'alert err' },
      el('h4', {}, `“先于”关系成环（${v.cycles.length}）：严格先后不允许循环`),
      el('ul', {}, ...v.cycles.map((c) =>
        el('li', {},
          c.events.map((e) => `#${e.event_id} ${e.title}`).join(' → '),
          `；涉事关系 ID：${[...new Set(c.relations)].join('、')}`)))));
  }

  if (v.unsatisfiable?.length) {
    box.append(el('div', { className: 'alert err' },
      el('h4', {}, `时间无解（${v.unsatisfiable.length}）：以下事件在其主张覆盖区间内无法安排日期`),
      el('ul', {}, ...v.unsatisfiable.map((u) =>
        el('li', {},
          `事件 #${u.event_id} ${u.title}：所有前驱严格发生后最早为 ${fmtBound(u.lower_bound)}，`,
          `但所选主张只覆盖到 ${fmtBound(u.upper_bound)}。`,
          u.chain.length
            ? '涉事事件链：' +
              u.chain.map((c) => `#${c.event_id} ${eventName(c.event_id)}`).join(' → ') +
              ` → #${u.event_id} ${u.title}；`
            : '',
          u.chain.length ? `涉事关系 ID：${u.chain.map((c) => c.relation_id).join('、')}` : '')))));
  }
}

function fmtBound(b) {
  return b == null ? '（无界）' : b;
}

function renderBaseVersion() {
  const text = state.baseVersion
    ? `#${state.baseVersion.id}（${state.baseVersion.created_at}）`
    : '无（将作为首个版本）';
  $('#base-version').textContent = '当前已发布：' + text;
  $('#publish-base').textContent = text;
  $('#publish-button').disabled = state.events.length === 0;
}

function renderAll() {
  renderEvents();
  renderRelations();
  renderValidation();
  renderBaseVersion();
}

// ---------- 操作 ----------
let validateTimer = null;
function scheduleValidate() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(doValidate, 250);
}

async function doValidate() {
  try {
    state.validation = await api('/api/draft/validate', {
      method: 'POST',
      body: JSON.stringify({ selections: Object.fromEntries(state.selections) }),
    });
    renderValidation();
  } catch (err) {
    if (err.status === 401) showAuthLoss();
  }
}

function selectClaim(eventId, claimId) {
  state.selections.set(eventId, claimId);
  saveSelections();
  scheduleValidate();
  renderEvents();
}

async function refreshDraft() {
  applyDraft(await api('/api/draft'));
  await doValidate();
}

async function addClaim(eventId, form) {
  const fd = new FormData(form);
  try {
    await api('/api/draft/claims', {
      method: 'POST',
      body: JSON.stringify({
        event_id: eventId,
        year: fd.get('year'),
        month: fd.get('month'),
        day: fd.get('day'),
        source: fd.get('source'),
        note: fd.get('note'),
      }),
    });
    form.reset();
    await refreshDraft();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteClaim(id) {
  if (!confirm('删除这条时间主张？')) return;
  await api(`/api/draft/claims/${id}`, { method: 'DELETE' });
  await refreshDraft();
}

async function deleteEvent(id) {
  if (!confirm('删除该事件及其全部主张、相关关系？')) return;
  await api(`/api/draft/events/${id}`, { method: 'DELETE' });
  await refreshDraft();
}

async function deleteRelation(id) {
  await api(`/api/draft/relations/${id}`, { method: 'DELETE' });
  await refreshDraft();
}

$('#event-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    await api('/api/draft/events', {
      method: 'POST',
      body: JSON.stringify({ title: fd.get('title'), description: fd.get('description') }),
    });
    ev.target.reset();
    await refreshDraft();
  } catch (err) {
    alert(err.message);
  }
});

$('#relation-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    await api('/api/draft/relations', {
      method: 'POST',
      body: JSON.stringify({
        predecessor_id: Number(fd.get('predecessor_id')),
        successor_id: Number(fd.get('successor_id')),
        note: fd.get('note'),
      }),
    });
    ev.target.reset();
    await refreshDraft();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 发布与冲突处理 ----------
$('#publish-button').addEventListener('click', () => doPublish(false));

async function doPublish(isRetry) {
  if (state.conflict && !isRetry) return;
  if (isRetry && !$('#conflict-ack').checked) {
    alert('请先勾选确认，再重新发布。');
    return;
  }

  try {
    const result = await api('/api/draft/publish', {
      method: 'POST',
      body: JSON.stringify({
        baseVersionId: state.conflict ? state.conflict.latestVersionId : (state.baseVersion?.id ?? null),
        selections: Object.fromEntries(state.selections),
        note: $('#publish-note').value,
      }),
    });
    state.conflict = null;
    $('#conflict-box').hidden = true;
    $('#publish-note').value = '';
    flash('ok', `已发布不可变版本 #${result.versionId}。访客年表已更新。`);
    await refreshDraft();
  } catch (err) {
    if (err.status === 401) return showAuthLoss();
    if (err.status === 409 && err.body.conflict) {
      showConflict(err.body.conflict);
    } else if (err.status === 422 && err.body.result) {
      state.validation = err.body.result;
      renderValidation();
      flash('err', '发布被拒绝：请先解决上方校验问题；上一已发布版本保持不变。');
    } else {
      flash('err', err.message);
    }
  }
}

function showConflict(conflict) {
  state.conflict = { latestVersionId: conflict.currentVersion?.id ?? null };
  const box = $('#conflict-box');
  box.hidden = false;
  $('#conflict-ack').checked = false;

  $('#conflict-detail').textContent = conflict.currentVersion
    ? `最新版本为 #${conflict.currentVersion.id}（发布于 ${conflict.currentVersion.created_at}）。`
    : '最新状态为无已发布版本。';

  const tl = $('#conflict-timeline');
  tl.innerHTML = '';
  tl.append(el('h4', { style: 'margin:0 0 8px' }, '他人已发布的最新年表：'));
  if (!conflict.timeline || conflict.timeline.events.length === 0) {
    tl.append(el('div', { className: 'empty' }, '（空版本）'));
  } else {
    for (const e of conflict.timeline.events) {
      tl.append(el('div', { className: 'relation-item' },
        el('span', {}, `${e.resolved_date} · ${e.title}（出处：${e.claim.source}）`)));
    }
  }

  const btn = el('button', {
    style: 'margin-top:10px',
    onclick: () => doPublish(true),
  }, '我已重新确认，按最新版本重新发布');
  tl.append(btn);

  flash('err', '版本冲突：你的提交基于旧版本，未写入任何数据。请查看最新版本并重新确认选择。');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function flash(kind, message) {
  const box = $('#global-message');
  box.innerHTML = '';
  const div = el('div', { className: `alert ${kind}` }, message);
  box.append(div);
  setTimeout(() => { if (box.contains(div)) div.remove(); }, 8000);
}

function showAuthLoss() {
  token = '';
  localStorage.removeItem('editor-token');
  location.reload();
}

// ---------- 启动 ----------
(async function main() {
  await ensureAuth();
  renderAll();
  await doValidate();
})();
