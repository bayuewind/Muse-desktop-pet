(() => {
  'use strict';
  const panel=document.querySelector('main'), reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let animation=null;
  window.composer.onTransition(({id,open,origin}) => {
    const current=getComputedStyle(panel);
    const from={opacity:current.opacity,transform:current.transform};
    animation?.cancel();
    if(origin)panel.style.transformOrigin=`${origin.x}% ${origin.y}%`;
    panel.inert=!open;
    const to=open?{opacity:1,transform:'translateX(0) scale(1)'}:
      {opacity:0,transform:`translateX(${origin?.x>50?22:-22}px) scale(.84)`};
    const next=animation=panel.animate([from,to],{
      duration:reduced.matches?0:open?240:180,
      easing:open?'cubic-bezier(.16,1,.3,1)':'cubic-bezier(.4,0,1,1)',fill:'forwards',
    });
    next.finished.then(()=>{
      if(animation!==next)return;
      panel.style.opacity=String(to.opacity);panel.style.transform=to.transform;
      next.cancel();animation=null;window.composer.transitionDone(id);
    }).catch(()=>{});
  });
})();
