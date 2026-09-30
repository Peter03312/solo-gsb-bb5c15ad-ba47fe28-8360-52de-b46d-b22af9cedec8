// 发布可行性评估：
// 1) 每个事件必须选定一条主张；
// 2) “先于”关系图必须无环；
// 3) 把年/月/日主张视为覆盖区间，沿有向无环图做最早日期传播，
//    只有每个事件都能在自身区间内取得严格晚于所有前驱的具体日期才可行。

import { claimInterval } from './dates.js';

const NEG_INF = Number.NEGATIVE_INFINITY;

/** 收集有向图中的所有环（迭代式 DFS），返回 [{events:[id...], relations:[id...]}] */
function findCycles(eventIds, adj) {
  // color: 0 未访问, 1 在当前递归栈中, 2 已完成
  const color = new Map();
  const cycles = [];
  const seen = new Set();

  for (const start of eventIds) {
    if (color.get(start) === 2) continue;
    const stack = [{ node: start, edge: null, nextIndex: 0 }];
    const pos = new Map();
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const { node } = frame;
      if (frame.nextIndex === 0) {
        color.set(node, 1);
        pos.set(node, stack.length - 1);
      }
      const neighbors = adj.get(node) ?? [];
      if (frame.nextIndex < neighbors.length) {
        const { to, relationId } = neighbors[frame.nextIndex++];
        if (color.get(to) === 1) {
          // 找到一条回到栈中节点的回边 -> 环
          const startIdx = pos.get(to);
          const events = stack.slice(startIdx).map((f) => f.node);
          events.push(to);
          // 每个非起点栈帧的 edge 即其与前一帧之间的边，末尾再加回边
          const relations = stack.slice(startIdx + 1).map((f) => f.edge);
          relations.push(relationId);
          const key = `${[...events].sort((a, b) => a - b).join(',')}`;
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push({ events, relations });
          }
        } else if (color.get(to) !== 2) {
          stack.push({ node: to, edge: relationId, nextIndex: 0 });
        }
      } else {
        color.set(node, 2);
        pos.delete(node);
        stack.pop();
      }
    }
  }
  return cycles;
}

/**
 * @param events    [{id, title}]
 * @param claims    [{id, event_id, year, month, day, precision, source, note}]
 * @param relations [{id, predecessor_id, successor_id, note}]
 * @param selections { eventId -> claimId }
 */
export function evaluateDraft({ events, claims, relations, selections }) {
  const eventById = new Map(events.map((e) => [e.id, e]));
  const claimsByEvent = new Map();
  for (const c of claims) {
    if (!claimsByEvent.has(c.event_id)) claimsByEvent.set(c.event_id, []);
    claimsByEvent.get(c.event_id).push(c);
  }

  // ---- 1) 选定主张校验 ----
  const missingSelections = [];
  const invalidSelections = [];
  const selectedClaim = new Map();
  for (const e of events) {
    const claimId = selections.get(e.id);
    if (claimId === undefined || claimId === null) {
      missingSelections.push({ event_id: e.id, title: e.title });
      continue;
    }
    const claim = (claimsByEvent.get(e.id) ?? []).find((c) => c.id === claimId);
    if (!claim) {
      invalidSelections.push({
        event_id: e.id,
        title: e.title,
        claim_id: claimId,
        reason: '该主张不存在或不属于此事件（可能已被删除）',
      });
    } else {
      selectedClaim.set(e.id, claim);
    }
  }

  // ---- 2) 建图并检测环 ----
  const adj = new Map(events.map((e) => [e.id, []]));
  for (const r of relations) {
    if (!eventById.has(r.predecessor_id) || !eventById.has(r.successor_id)) continue;
    adj.get(r.predecessor_id).push({ to: r.successor_id, relationId: r.id });
  }
  const orderedIds = events.map((e) => e.id).sort((a, b) => a - b);
  const cycles = findCycles(orderedIds, adj);

  // 区间
  const interval = new Map();
  for (const e of events) {
    const claim = selectedClaim.get(e.id);
    interval.set(e.id, claim ? claimInterval(claim) : { lo: NEG_INF, hi: Infinity });
  }

  // ---- 3) Kahn 拓扑 + 最早日期传播（仅在无环且无非法选择时有意义）----
  const unsatisfiable = [];
  const earliest = new Map(events.map((e) => [e.id, NEG_INF]));
  const predecessorOf = new Map(); // 记录决定性前驱，用于生成涉事关系链

  if (cycles.length === 0 && invalidSelections.length === 0) {
    const indegree = new Map(events.map((e) => [e.id, 0]));
    for (const r of relations) {
      if (!eventById.has(r.predecessor_id) || !eventById.has(r.successor_id)) continue;
      indegree.set(r.successor_id, (indegree.get(r.successor_id) ?? 0) + 1);
    }

    const ready = orderedIds.filter((id) => indegree.get(id) === 0);
    const queue = [...ready];
    const topo = [];
    while (queue.length > 0) {
      const id = queue.shift();
      topo.push(id);
      for (const { to } of adj.get(id)) {
        indegree.set(to, indegree.get(to) - 1);
        if (indegree.get(to) === 0) {
          // 按事件 id 确定性插入
          let lo = 0;
          while (lo < queue.length && queue[lo] < to) lo += 1;
          queue.splice(lo, 0, to);
        }
      }
    }

    for (const id of topo) {
      const isSelected = selectedClaim.has(id);
      if (isSelected) {
        const { lo, hi } = interval.get(id);
        const cur = earliest.get(id);
        const value = Math.max(lo, cur === NEG_INF || cur === undefined ? NEG_INF : cur);
        if (value > hi) {
          // 回溯决定性前驱链，标明涉事事件与关系
          const chain = [];
          let cur2 = id;
          const seenChain = new Set([cur2]);
          while (predecessorOf.has(cur2) && !seenChain.has(predecessorOf.get(cur2).from)) {
            const { from, relationId } = predecessorOf.get(cur2);
            chain.push({ event_id: from, relation_id: relationId });
            seenChain.add(from);
            cur2 = from;
          }
          chain.reverse();
          unsatisfiable.push({
            event_id: id,
            title: eventById.get(id).title,
            lower_bound: value,
            upper_bound: hi,
            chain,
          });
        } else {
          earliest.set(id, value);
        }
      }
      // 沿边传播严格先后：后继最早为 max(当前最早, 本事件最早 + 1)
      for (const { to, relationId } of adj.get(id)) {
        const fromValue = earliest.get(id);
        if (fromValue === NEG_INF || fromValue === undefined) continue;
        const candidate = fromValue + 1;
        const toValue = earliest.get(to);
        if (candidate > (toValue === undefined ? NEG_INF : toValue)) {
          earliest.set(to, candidate);
          predecessorOf.set(to, { from: id, relationId });
        }
      }
    }
  }

  const feasible =
    events.length > 0 &&
    missingSelections.length === 0 &&
    invalidSelections.length === 0 &&
    cycles.length === 0 &&
    unsatisfiable.length === 0;

  return {
    feasible,
    empty: events.length === 0,
    missingSelections,
    invalidSelections,
    cycles: cycles.map((c) => ({
      events: c.events.map((id) => ({ event_id: id, title: eventById.get(id)?.title ?? '' })),
      relations: c.relations,
    })),
    unsatisfiable,
    earliest: new Map(
      events.map((e) => [
        e.id,
        earliest.get(e.id) === NEG_INF ? null : earliest.get(e.id),
      ])
    ),
  };
}
