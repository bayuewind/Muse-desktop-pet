(() => {
  'use strict';
  function create(url, name, onError) {
    const player = document.createElement('div'); player.className = 'audio-player';
    const audio = document.createElement('audio');
    audio.controls = true; audio.preload = 'metadata'; audio.src = url;
    audio.setAttribute('aria-label', name); audio.onerror = onError;
    const tools = document.createElement('div'); tools.className = 'audio-tools';
    const replay = document.createElement('button');
    replay.className = 'icon-button'; replay.title = '重新播放'; replay.setAttribute('aria-label', '重新播放');
    const icon = document.createElement('i'); icon.dataset.lucide = 'rotate-ccw'; replay.append(icon);
    const speed = document.createElement('select');
    speed.setAttribute('aria-label', '播放速度'); speed.title = '播放速度';
    for (const value of [0.75, 1, 1.25, 1.5, 2]) {
      const option = document.createElement('option'); option.value = String(value); option.textContent = `${value}×`;
      option.selected = value === 1; speed.append(option);
    }
    function seekComplete() {
      if (!audio.seeking) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('audio_seek_timeout')), 5000);
        const done = () => finish();
        const finish = error => {
          clearTimeout(timer); audio.removeEventListener('seeked', done);
          error ? reject(error) : resolve();
        };
        audio.addEventListener('seeked', done, { once: true });
      });
    }
    replay.onclick = async () => {
      if (replay.disabled) return;
      replay.disabled = true; let timer;
      try {
        for (const other of document.querySelectorAll('audio')) if (other !== audio) other.pause();
        await seekComplete();
        if (!player.isConnected || audio.getAttribute('src') !== url) return;
        audio.currentTime = 0; await seekComplete();
        if (!player.isConnected || audio.getAttribute('src') !== url) return;
        await Promise.race([audio.play(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('audio_play_timeout')), 5000);
        })]);
      } catch { audio.pause(); onError(); }
      finally { clearTimeout(timer); replay.disabled = false; }
    };
    audio.addEventListener('play', () => {
      for (const other of document.querySelectorAll('audio')) if (other !== audio) other.pause();
    });
    speed.onchange = () => { audio.playbackRate = Number(speed.value); };
    tools.append(replay, speed); player.append(audio, tools);
    return player;
  }
  window.museAudio = Object.freeze({ create });
})();
