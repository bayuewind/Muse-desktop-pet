(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const node = (tag, value, className) => {
    const element = document.createElement(tag);
    if (value != null) element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  const BUSY = new Set(['working', 'responding', 'composing', 'compacting', 'making_something', 'waiting_for_subagents']);
  const statuses = { running: '运行中', pending: '待执行', queued: '排队中', succeeded: '已完成', completed: '已完成',
    failed: '失败', timed_out: '超时', cancelled: '已取消', canceled: '已取消', skipped: '已跳过',
    working: '工作中', responding: '回复中', composing: '撰写中', compacting: '整理上下文',
    making_something: '制作中', waiting_for_subagents: '等待子任务', needs_approval: '等待批准',
    waiting_for_user: '等待回应', out_of_credits: '用量不足', online: '在线' };
  let workspace = null, replies = { messages: [] }, taskFilter = 'schedules', libraryFilter = 'all';
  let taskSignature = '', librarySignature = '', prefs = null, feedbackTimer;
  let spaces = null, spaceKind = 'goals', spacesBusy = false, spacesSignature = '';
  const expandedSpaces = new Set();
  const expanded = new Set();
  function formatTime(value) {
    if (!Number.isFinite(value)) return '时间未知';
    return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function showFeedback(message) {
    clearTimeout(feedbackTimer);
    $('#workspace-feedback').textContent = message; $('#workspace-feedback').hidden = false;
    feedbackTimer = setTimeout(() => { $('#workspace-feedback').hidden = true; }, 6000);
  }
  function selectView(view, focus = false) {
    if (!['chat', 'tasks', 'spaces', 'library', 'settings'].includes(view)) return;
    const changed = document.body.dataset.view !== view;
    document.body.dataset.view = view;
    for (const tab of all('[role=tab]')) {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    for (const panel of all('[role=tabpanel]')) panel.hidden = panel.id !== `panel-${view}`;
    if (changed) document.dispatchEvent(new CustomEvent('composer:view-change', { detail: view }));
    if (view === 'tasks') renderWorkspace();
    if (view === 'library') renderLibrary();
    if (view === 'settings') renderPreferences();
    if (view === 'spaces') {
      renderSpaces();
      if (changed && !spaces?.[spaceKind]?.fresh) void refreshSpaces();
    }
  }
  for (const tab of all('[role=tab]')) {
    tab.onclick = () => selectView(tab.dataset.view);
    tab.onkeydown = event => {
      const tabs = all('[role=tab]'), at = tabs.indexOf(tab);
      const target = event.key === 'ArrowRight' ? (at + 1) % tabs.length : event.key === 'ArrowLeft'
        ? (at + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (target >= 0) { event.preventDefault(); selectView(tabs[target].dataset.view, true); }
    };
  }
  function row(item, category) {
    const key = `${category}:${item.id}`;
    const details = node('details', null, 'task-row');
    details.open = expanded.has(key);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) expanded.add(key); else expanded.delete(key);
    });
    const head = node('summary'), label = node('div', null, 'task-label');
    label.append(node('strong', item.title));
    const status = category === 'schedule' ? item.enabled ? '已启用' : '已暂停' : statuses[item.status] || '状态未知';
    const badge = node('span', status, 'status-pill');
    badge.dataset.status = category === 'schedule' ? item.enabled ? 'enabled' : 'paused' : item.status;
    label.append(badge);
    head.append(label);
    const time = category === 'schedule'
      ? item.nextRunAt ? `下次 ${formatTime(item.nextRunAt)}` : item.enabled ? '下次执行时间未提供' : '计划已暂停'
      : formatTime(item.scheduledAt ?? item.at);
    head.append(node('small', time));
    details.append(head);
    const content = node('div', null, 'task-detail');
    if (item.summary) content.append(node('p', item.summary));
    if (item.error) content.append(node('p', item.error, 'task-error'));
    if (category === 'schedule') {
      content.append(node('p', item.heartbeat ? '守望计划' : '定时计划'));
      if (item.timezone) content.append(node('p', `计划时区：${item.timezone}；列表时间为本机时间。`));
    }
    if (!content.childElementCount) content.append(node('p', '暂无更多详情'));
    const open = node('button', '在 Muse 中查看', 'text-button');
    open.onclick = () => openOfficial('chat');
    content.append(open); details.append(content);
    return details;
  }
  function renderWorkspace() {
    if (!workspace) return;
    const fresh = workspace.fresh;
    $('#workspace-updated').textContent = workspace.updatedAt ? `更新于 ${formatTime(workspace.updatedAt)}` : '等待首次同步';
    $('#workspace-warning').hidden = fresh;
    $('#workspace-warning').textContent = !workspace.online ? '连接未就绪。云端任务可能仍在运行。'
      : '任务数据待同步，以下记录可能已过期。';
    const attention = workspace.agents.filter(agent => ['needs_approval', 'waiting_for_user', 'out_of_credits'].includes(agent.code));
    $('#attention').hidden = !fresh || !attention.length;
    $('#attention-text').textContent = attention.some(agent => agent.code === 'needs_approval') ? '有活动需要你的批准'
      : attention.some(agent => agent.code === 'out_of_credits') ? 'Muse 用量需要处理' : 'Muse 正在等你回应';
    const activeRuns = workspace.runs.filter(run => run.status === 'running');
    const busyAgents = workspace.agents.filter(agent => BUSY.has(agent.code));
    const active = activeRuns.length + busyAgents.length;
    $('#task-count').hidden = !fresh || !(active || attention.length);
    $('#task-count').textContent = String(active || attention.length);
    $('#metric-running').textContent = fresh ? String(activeRuns.length) : '—';
    $('#metric-schedules').textContent = fresh ? String(workspace.schedules.filter(item => item.enabled).length) : '—';
    const dates = workspace.schedules.filter(item => item.enabled && item.nextRunAt).map(item => item.nextRunAt);
    const next = dates.length ? Math.min(...dates) : null;
    $('#metric-next').textContent = !fresh || !next ? '—' : next <= Date.now() ? '待更新'
      : new Date(next).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    $('#task-scope').textContent = taskFilter === 'activities'
      ? `${workspace.activities.length} 条近期动态${workspace.activityFresh ? '' : ' · 待同步'}`
      : `${workspace.runs.length} 条近期运行记录 · 非全量历史`;
    if (workspace.invalidSchedules) $('#task-scope').textContent += ` · ${workspace.invalidSchedules} 个计划异常`;
    let entries = taskFilter === 'schedules' ? workspace.schedules.map(item => ({ item, category: 'schedule' }))
      : taskFilter === 'runs' ? [...workspace.runs].sort((a, b) => (b.scheduledAt || 0) - (a.scheduledAt || 0)).map(item => ({ item, category: 'run' }))
      : taskFilter === 'activities' ? workspace.activities.map(item => ({ item, category: 'activity' }))
      : [...busyAgents.map(agent => ({ item: { id: agent.id, title: agent.title || 'Muse 会话活动', status: agent.code }, category: 'agent' })),
        ...activeRuns.map(item => ({ item, category: 'run' }))];
    const query = $('#task-search').value.trim().toLocaleLowerCase();
    entries = entries.filter(({ item }) => [item.title, item.summary, item.error].some(value => value?.toLocaleLowerCase().includes(query)));
    const signature = JSON.stringify([taskFilter, query, entries, fresh, workspace.subagents, workspace.activityFresh]);
    if (signature === taskSignature) return;
    taskSignature = signature;
    const list = $('#task-list'); list.replaceChildren();
    if (taskFilter === 'running' && workspace.subagents > 0) list.append(node('p', `${workspace.subagents} 个子任务${fresh ? '活跃' : '（上次同步）'}`, 'muted'));
    if (!entries.length) list.append(node('p', query ? '没有匹配的任务' : !workspace.updatedAt ? '等待同步'
      : taskFilter === 'running' ? fresh ? '当前未见运行任务' : '当前运行状态未知'
      : taskFilter === 'schedules' ? '暂无计划' : taskFilter === 'activities' && !workspace.activityFresh ? '动态尚未同步' : '暂无记录', 'empty'));
    for (const entry of entries) list.append(row(entry.item, entry.category));
  }
  for (const button of all('[data-task-filter]')) button.onclick = () => {
    taskFilter = button.dataset.taskFilter;
    for (const item of all('[data-task-filter]')) item.setAttribute('aria-pressed', String(item === button));
    renderWorkspace();
  };
  $('#task-search').oninput = renderWorkspace;
  $('#refresh-workspace').onclick = async () => {
    const button = $('#refresh-workspace'); button.disabled = true;
    try {
      const result = await window.composer.refreshWorkspace();
      showFeedback(result?.ok ? '任务已同步' : '暂时无法同步，请检查连接或稍后重试');
    } catch { showFeedback('同步失败，请稍后重试'); }
    finally { button.disabled = false; }
  };
  function renderSpaces() {
    const state = spaces?.[spaceKind];
    $('#spaces-title').textContent = spaceKind === 'goals' ? '目标' : '灵感';
    $('#spaces-status').parentElement.hidden = spaceKind !== 'goals';
    $('#spaces-updated').textContent = state?.updatedAt ? `更新于 ${formatTime(state.updatedAt)}` : '尚未同步';
    $('#spaces-warning').hidden = !!state?.fresh;
    $('#spaces-warning').textContent = spacesBusy ? '正在同步…' : !state?.online ? '连接未就绪，以下内容可能已过期。'
      : state.failed ? '本次同步失败，保留上次结果。' : '内容待同步，以下记录可能已过期。';
    $('#spaces-scope').textContent = `${state?.rows.length ?? 0} 项已载入${state?.partial ? ' · 列表不完整' : ''} · 非全量历史`;
    const query = $('#spaces-search').value.trim().toLocaleLowerCase(), filter = $('#spaces-status').value;
    const entries = (state?.rows ?? []).filter(row =>
      (spaceKind !== 'goals' || filter === 'all' || (filter === 'completed' ? row.status === 'completed' : row.source === filter)) &&
      [row.title, row.summary, row.description, row.section].some(value => value?.toLocaleLowerCase().includes(query)));
    const signature = JSON.stringify([spaceKind, query, filter, entries, state?.updatedAt]);
    if (signature === spacesSignature) return;
    spacesSignature = signature;
    const list = $('#spaces-list'); list.replaceChildren();
    if (!entries.length) list.append(node('p', query || filter !== 'all' && spaceKind === 'goals' ? '没有匹配的内容'
      : state?.updatedAt ? '暂无返回内容' : '等待同步', 'empty'));
    for (const item of entries) {
      const kind = spaceKind, key = `${kind}:${item.id}`;
      const details = node('details', null, 'task-row');
      details.open = expandedSpaces.has(key);
      details.addEventListener('toggle', () => {
        if (details.isConnected) { if (details.open) expandedSpaces.add(key); else expandedSpaces.delete(key); }
      });
      const head = node('summary'), label = node('div', null, 'task-label');
      label.append(node('strong', item.title));
      if (kind === 'goals') {
        const status = { active: '进行中', in_progress: '进行中', completed: '已完成', paused: '已暂停', archived: '已归档' };
        label.append(node('span', status[item.status] || '状态未识别', 'status-pill'));
      }
      head.append(label, node('small', kind === 'ideas' ? item.section || '灵感'
        : item.source === 'user_goal' ? '我的目标' : item.source === 'assistant_tracking' ? 'Muse 跟进' : '目标'));
      details.append(head);
      const content = node('div', null, 'task-detail');
      for (const value of [item.summary, item.description, item.prerequisite].filter(Boolean)) content.append(node('p', value));
      if (!content.childElementCount) content.append(node('p', '暂无更多详情'));
      const discuss = node('button', '加入聊天草稿', 'text-button');
      discuss.onclick = () => {
        const context = [kind === 'goals' ? '我想讨论这个目标：' : '我想讨论这个灵感：',
          item.title, item.summary || item.description].filter(Boolean).join('\n');
        const result = window.museDraft.appendContext(context);
        if (result.ok) selectView('chat', true);
        else showFeedback(result.reason === 'length' ? '加入后会超过 8000 字，原草稿未改动。' : '请等待当前输入或发送结束，原草稿未改动。');
      };
      content.append(discuss); details.append(content); list.append(details);
    }
  }
  async function refreshSpaces() {
    if (spacesBusy) return;
    spacesBusy = true; $('#refresh-spaces').disabled = true; renderSpaces();
    try {
      const result = await window.composer.refreshSpaces();
      if (!result?.ok) showFeedback('部分内容未能同步，请检查连接或稍后重试。');
    } catch { showFeedback('目标与灵感同步失败。'); }
    finally { spacesBusy = false; $('#refresh-spaces').disabled = false; renderSpaces(); }
  }
  for (const button of all('[data-space-kind]')) button.onclick = () => {
    spaceKind = button.dataset.spaceKind;
    for (const item of all('[data-space-kind]')) item.setAttribute('aria-pressed', String(item === button));
    renderSpaces();
  };
  $('#spaces-search').oninput = renderSpaces;
  $('#spaces-status').onchange = renderSpaces;
  $('#refresh-spaces').onclick = refreshSpaces;
  $('#spaces-official').onclick = () => openOfficial(spaceKind);
  function renderLibrary() {
    const assets = replies.messages.flatMap(message => message.attachments.map(asset => ({ message, asset }))).reverse();
    $('#library-count').textContent = `当前会话 · ${assets.length} 个附件`;
    const query = $('#library-search').value.trim().toLocaleLowerCase();
    const selected = assets.filter(({ asset }) => (libraryFilter === 'all' || asset.kind === libraryFilter) && asset.name.toLocaleLowerCase().includes(query));
    const signature = JSON.stringify([libraryFilter, query, selected.map(({ message, asset }) => [message.id, asset])]);
    if (signature === librarySignature) return;
    librarySignature = signature;
    window.museAttachments.clear('library');
    const list = $('#library-list'); list.replaceChildren();
    if (!selected.length) list.append(node('p', assets.length ? '没有匹配的附件' : '暂无收到的附件', 'empty'));
    for (const { message, asset } of selected) list.append(window.museAttachments.create(message, asset, 'library'));
  }
  $('#library-search').oninput = renderLibrary;
  for (const button of all('[data-library-filter]')) button.onclick = () => {
    libraryFilter = button.dataset.libraryFilter;
    for (const item of all('[data-library-filter]')) item.setAttribute('aria-pressed', String(item === button));
    renderLibrary();
  };
  async function openOfficial(key) {
    try { if (!(await window.composer.officialPage(key))?.ok) showFeedback('未能打开 Muse，请稍后重试'); }
    catch { showFeedback('未能打开 Muse'); }
  }
  for (const button of all('[data-official]')) button.onclick = () => openOfficial(button.dataset.official);
  function renderPreferences() {
    if (!prefs) return;
    $('#notifications-enabled').checked = prefs.notifications;
    const quiet = prefs.quietUntil > Date.now();
    const remaining = prefs.quietUntil - Date.now();
    $('#quiet-duration').value = quiet ? remaining > 3600000 ? '28800000' : '3600000' : '0';
    $('#quiet-status').textContent = quiet ? `免打扰至 ${formatTime(prefs.quietUntil)}` : '免打扰已关闭';
  }
  async function savePreferences(patch) {
    const controls = [$('#notifications-enabled'), $('#quiet-duration')];
    controls.forEach(control => { control.disabled = true; });
    try {
      const result = await window.composer.setPreferences(patch);
      if (result?.ok) prefs = result.value;
      else showFeedback('设置未能保存');
    } catch { showFeedback('设置未能保存'); }
    finally { controls.forEach(control => { control.disabled = false; }); renderPreferences(); }
  }
  $('#notifications-enabled').onchange = event => void savePreferences({ notifications: event.target.checked });
  $('#quiet-duration').onchange = event => {
    const duration = Number(event.target.value);
    void savePreferences({ quietUntil: duration ? Date.now() + duration : 0 });
  };
  function receiveWorkspace(value) { if (value) { workspace = value; renderWorkspace(); } }
  function receiveReplies(value) { if (value) { replies = value; renderLibrary(); } }
  window.composer.onWorkspace(receiveWorkspace);
  function receiveSpaces(value) { if (value) { spaces = value; renderSpaces(); } }
  window.composer.onSpaces(receiveSpaces);
  window.composer.onReplies(receiveReplies);
  window.composer.onView(view => selectView(view));
  void window.composer.workspace().then(receiveWorkspace);
  void window.composer.spaces().then(receiveSpaces);
  void window.composer.replies().then(receiveReplies);
  void window.composer.preferences().then(value => { prefs = value; renderPreferences(); });
  window.lucide.createIcons();
})();
