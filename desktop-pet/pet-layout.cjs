'use strict';
const CLOSED = { width:256, height:306 }, OPEN = { width:352, height:354 };
function fit(bounds, area) {
  return { ...bounds,
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x+area.width-bounds.width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y+area.height-bounds.height))) };
}
function expand(bounds, area) { return fit({x:bounds.x,y:bounds.y-48,...OPEN},area); }
function collapse(bounds, original, opened, area) {
  return fit({x:original.x+bounds.x-opened.x,y:original.y+bounds.y-opened.y,...CLOSED},area);
}
module.exports = { expand, collapse };
