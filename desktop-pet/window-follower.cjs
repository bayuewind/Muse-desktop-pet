'use strict';
// One-way movement: the pet leads; the independently positioned chat follows.
class WindowFollower {
  constructor({ anchor, follower, enabled = () => true }) {
    Object.assign(this, { anchor, follower, enabled });
    this.muted = 0; this.rebase();
  }
  rebase() {
    const window = this.anchor();
    this.previous = window && !window.isDestroyed() ? window.getBounds() : null;
  }
  moveSilently(change) {
    this.muted++;
    try { change(); } finally { this.rebase(); this.muted--; }
  }
  moved() {
    const previous = this.previous; this.rebase();
    if (this.muted || !previous || !this.previous) return;
    const dx = this.previous.x-previous.x, dy = this.previous.y-previous.y;
    if ((!dx && !dy) || !this.enabled()) return;
    const window = this.follower();
    if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return;
    const bounds = window.getBounds();
    // Read its CURRENT position so a manual chat-window drag establishes the
    // new relative offset without moving the pet or creating a feedback loop.
    window.setPosition(bounds.x+dx, bounds.y+dy, false);
  }
}
module.exports = { WindowFollower };
