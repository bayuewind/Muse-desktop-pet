(function(root) {
  'use strict';
  function cropBounds(rect, width, height) {
    const integer = (value, fallback) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
    const x = Math.max(0, Math.min(width - 1, integer(rect.x, 0)));
    const y = Math.max(0, Math.min(height - 1, integer(rect.y, 0)));
    return { x, y, width: Math.max(1, Math.min(width - x, integer(rect.width, width))),
      height: Math.max(1, Math.min(height - y, integer(rect.height, height))) };
  }
  function fromPoints(start, end, width, height) {
    return cropBounds({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }, width, height);
  }
  const api = Object.freeze({ cropBounds, fromPoints });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.museCrop = api;
})(typeof window !== 'undefined' ? window : globalThis);
