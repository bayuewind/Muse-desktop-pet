'use strict';
const { text, timestamp } = require('./workspace.cjs');
const MAX_ROWS = 200;
function identifier(value) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error('spaces_schema_changed');
  return text(value, 512);
}
class SpacesModel {
  constructor() { this.reset(); }
  reset() {
    this.goals = []; this.ideas = [];
    this.meta = Object.fromEntries(['goals', 'ideas'].map(key => [key,
      { updatedAt: 0, failed: false, partial: false, invalidated: true }]));
  }
  reconnect() { for (const meta of Object.values(this.meta)) meta.invalidated = true; }
  failed(kind) { this.meta[kind].failed = true; }
  update(kind, response, now = Date.now()) {
    let rows, partial;
    if (kind === 'goals') {
      if (!Array.isArray(response?.goals)) throw new Error('spaces_schema_changed');
      rows = response.goals.slice(0, MAX_ROWS).map(row => ({
        id: identifier(row?.goal_id), title: text(row.title, 200) || '未命名目标',
        summary: text(row.summary, 2000), description: text(row.description, 3000),
        status: text(row.status, 80), source: text(row.source, 80),
        updatedAt: timestamp(row.updated_at), thread: row.is_thread === true,
      }));
      partial = response.pagination?.has_next_page !== false || response.goals.length > MAX_ROWS ||
        (Array.isArray(response.warnings) && response.warnings.length > 0);
    } else if (kind === 'ideas') {
      if (!Array.isArray(response?.sections)) throw new Error('spaces_schema_changed');
      rows = []; partial = response.pagination?.hasNextPage !== false || response.sections.length > MAX_ROWS;
      for (const section of response.sections.slice(0, MAX_ROWS)) {
        if (!Array.isArray(section?.cards)) throw new Error('spaces_schema_changed');
        if (section.cards.length > MAX_ROWS - rows.length) partial = true;
        for (const row of section.cards.slice(0, MAX_ROWS - rows.length)) rows.push({
          id: identifier(row?.ideaCardId || row?.id), title: text(row.title, 200) || '未命名灵感',
          summary: text(row.summary, 3000), section: text(section.title, 200),
          status: text(row.buildStatus, 80), prerequisite: text(row.prerequisiteNotes, 1000),
        });
      }
    } else throw new Error('invalid_space');
    const unique = new Map(rows.map(row => [row.id, row]));
    this[kind] = [...unique.values()];
    this.meta[kind] = { updatedAt: now, failed: false, partial: partial || unique.size !== rows.length, invalidated: false };
  }
  snapshot(connection = {}, now = Date.now()) {
    const online = connection.phase === 'connected' && connection.pingAt > 0 &&
      now >= connection.pingAt && now - connection.pingAt <= 45000;
    return Object.fromEntries(['goals', 'ideas'].map(kind => {
      const meta = this.meta[kind];
      return [kind, { ...meta, online, fresh: online && !meta.failed && !meta.invalidated &&
        meta.updatedAt > 0 && now >= meta.updatedAt && now - meta.updatedAt < 120000,
      rows: this[kind].map(row => ({ ...row })) }];
    }));
  }
}
module.exports = { SpacesModel };
