(() => {
  'use strict';
  const select = document.querySelector('#session-select'), status = document.querySelector('#session-status');
  let snapshot = { activeId: null, title: '主会话', ready: false, rows: [] }, signature = '', busy = false;
  function receive(value) {
    if (!value) return;
    const changed = snapshot.activeId !== value.activeId || (snapshot.selection ?? 0) !== (value.selection ?? 0);
    snapshot = value;
    if (changed) document.dispatchEvent(new CustomEvent('composer:session-change', { detail: value }));
    document.dispatchEvent(new CustomEvent('composer:session-state', { detail: value }));
    const nextSignature = JSON.stringify([value.activeId, value.rows]);
    if (nextSignature !== signature) {
      signature = nextSignature; select.replaceChildren();
      const main = document.createElement('option'); main.value = ''; main.textContent = '主会话'; select.append(main);
      const rows = value.rows.filter(row => row.thread && !row.primary && !row.archived);
      if (value.activeId && !rows.some(row => row.id === value.activeId))
        rows.push({ id: value.activeId, title: value.title || '当前旁聊（未在列表中）' });
      for (const row of rows) {
        const option = document.createElement('option'); option.value = row.id;
        option.textContent = row.title + (row.unread ? ` (${row.unread})` : ''); select.append(option);
      }
    }
    select.value = value.activeId ?? ''; select.title = value.title;
    status.hidden = value.ready && value.fresh && !value.partial;
    status.textContent = value.restriction === 'approval' ? '当前旁聊需要批准，请在 Muse 中处理。'
      : value.restriction === 'limited' ? '当前旁聊用量受限，请在 Muse 中处理。'
      : value.restriction === 'unknown' ? '当前旁聊状态未识别，暂不能发送。'
      : !value.ready ? value.phase === 'connecting' ? '正在连接当前会话…' : '当前会话未就绪，可同步近期回复重连。'
      : !value.fresh ? '会话列表待更新。' : value.partial ? '仅显示部分会话。' : '';
    document.querySelector('#library-scope').textContent = `近期${value.activeId ? '旁聊' : '主会话'}附件`;
  }
  async function refresh() {
    if (busy) return;
    const button = document.querySelector('#refresh-sessions');
    button.disabled = true;
    try {
      const result = await window.composer.refreshSessions();
      if (!result?.ok) { status.hidden = false; status.textContent = '会话列表暂不可用，请稍后刷新。'; }
    } catch { status.hidden = false; status.textContent = '会话列表同步失败。'; }
    finally { button.disabled = false; }
  }
  select.onchange = async () => {
    const id = select.value || null;
    if (id === snapshot.activeId) return;
    if (!window.museDraft.beginSwitch()) { select.value = snapshot.activeId ?? ''; return; }
    busy = true; status.hidden = false; status.textContent = '正在切换会话…';
    try {
      const result = await window.composer.selectSession(id);
      if (result?.session) receive(result.session);
      if (result?.ok) await window.draftFiles.sync();
      else {
        status.hidden = false;
        status.textContent = result?.reason === 'attachment_session_capacity'
          ? '已有 8 个会话保留附件，请先发送或移除其中的附件。' : '切换未完成，请刷新会话列表后重试。';
      }
    } catch { status.hidden = false; status.textContent = '切换失败，草稿已保留。'; }
    finally { busy = false; select.value = snapshot.activeId ?? ''; window.museDraft.endSwitch(); }
  };
  document.querySelector('#refresh-sessions').onclick = refresh;
  window.composer.onSessions(receive);
  void window.composer.sessions().then(receive);
})();
