'use strict';
// Latest intent wins, including clicks during first load or an exit animation.
class ComposerVisibility {
  constructor({ ensure, show, hide, animate, focus, closing, timeoutMs = 550 }) {
    Object.assign(this, { ensure, show, hide, animate, focus, closing, timeoutMs });
    this.open = false; this.id = 0; this.pending = null;
  }
  reset() {
    this.open = false; ++this.id;
    clearTimeout(this.pending?.timer); this.pending = null;
  }
  async set(open) {
    this.open = open; const id = ++this.id;
    clearTimeout(this.pending?.timer); this.pending = null;
    if (!open) this.closing();
    let window;
    try { window = await this.ensure(open); }
    catch (error) { if (id === this.id) this.open = false; throw error; }
    if (id !== this.id || !window || window.isDestroyed()) return;
    if (open) this.show(window);
    this.pending = { id, open, window, timer: setTimeout(() => this.complete(id), this.timeoutMs) };
    this.animate(window, { id, open });
  }
  complete(id) {
    const pending = this.pending;
    if (!pending || pending.id !== id || id !== this.id) return;
    clearTimeout(pending.timer); this.pending = null;
    if (pending.window.isDestroyed()) return;
    if (pending.open) this.focus(pending.window);
    else this.hide(pending.window);
  }
}
module.exports = { ComposerVisibility };
