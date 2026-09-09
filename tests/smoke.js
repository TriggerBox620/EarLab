'use strict';
const app = document.getElementById('app');
const run = document.getElementById('run');
const summary = document.getElementById('summary');
app.addEventListener('load', () => { run.disabled = false; summary.textContent = '就绪'; });
if (app.contentDocument?.readyState === 'complete') { run.disabled = false; summary.textContent = '就绪'; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
run.addEventListener('click', async () => {
  run.disabled = true;
  document.getElementById('results').replaceChildren();
  const w = app.contentWindow, d = w.document, el = id => d.getElementById(id);
  const media = w.navigator.mediaDevices;
  const originalMic = media.getUserMedia.bind(media);
  const originalShare = media.getDisplayMedia?.bind(media);
  const originalEnum = media.enumerateDevices.bind(media);
  const failures = [], errors = [];
  const onError = event => errors.push(event.message || event.reason?.message || 'Unhandled error');
  w.addEventListener('error', onError); w.addEventListener('unhandledrejection', onError);
  let count = 0;
  async function test(name, action) {
    const li = document.createElement('li'); document.getElementById('results').appendChild(li);
    try { await action(); count++; li.className = 'pass'; li.textContent = `PASS · ${name}`; }
    catch (error) { failures.push(name); li.className = 'fail'; li.textContent = `FAIL · ${name}: ${error.message}`; }
  }
  // Silent synthetic streams use real browser track and AudioNode lifecycles.
  const contexts = [];
  function silentStream() {
    const ctx = new w.AudioContext(); contexts.push(ctx);
    const destination = ctx.createMediaStreamDestination();
    return destination.stream;
  }
  function input(id, value) { el(id).value = value; el(id).dispatchEvent(new w.Event('input', { bubbles: true })); }
  async function withAppWidth(width, action) {
    const previous = app.style.width;
    app.style.width = `${width}px`;
    await delay(80);
    try { await action(); }
    finally { app.style.width = previous; await delay(80); }
  }
  try {
    w.stopAll(false);
    if (el('mute').getAttribute('aria-pressed') !== 'true') el('mute').click();
    await test('核心布局在桌面与窄屏都有清晰的操作空间', async () => {
      const hero = d.querySelector('.hero-grid');
      const output = d.querySelector('.output');
      const firstCard = d.querySelector('.card');
      const safety = d.querySelector('.safety-bar');
      await withAppWidth(1280, async () => {
        const columns = w.getComputedStyle(hero).gridTemplateColumns.split(' ').map(parseFloat).filter(Number.isFinite);
        assert(columns.length >= 2, 'Desktop hero collapsed too early');
        assert(output.getBoundingClientRect().width >= 310, 'Output panel is too narrow for controls');
        assert(parseFloat(w.getComputedStyle(firstCard).borderRadius) <= 8, 'Cards are too rounded for compact tool UI');
        assert(safety.getBoundingClientRect().height >= 48, 'Safety bar touch target is too short');
      });
      await withAppWidth(390, async () => {
        assert(d.documentElement.scrollWidth <= d.documentElement.clientWidth + 1, 'Mobile layout has horizontal overflow');
        assert(w.getComputedStyle(hero).gridTemplateColumns.split(' ').length === 1, 'Mobile hero should be one column');
        assert(el('stop-all').getBoundingClientRect().height >= 40, 'Mobile stop action is too small');
      });
    });
    await test('惊喜增强组合会更新 DSP 参数并本地保存', async () => {
      const game = d.querySelector('[data-scene="game"]');
      assert(game, 'Enhancement scenes missing');
      game.click();
      assert(el('enhancement-mode').textContent.includes('游戏'), 'Scene label did not update');
      const gameGains = w.effectiveGains();
      assert(gameGains[4] > gameGains[0], 'Game scene should prioritize detail over bass');
      input('taste-bass', '3'); input('taste-clarity', '2'); input('balance', '30');
      const tunedGains = w.effectiveGains();
      assert(tunedGains[0] > gameGains[0] && tunedGains[3] > gameGains[3], 'Taste sliders did not affect EQ');
      assert(el('balance-value').textContent.includes('右'), 'Balance label did not show right shift');
      el('dynamic-eq').click();
      assert(el('dynamic-state').textContent.includes('关闭'), 'Dynamic EQ state did not update');
      el('safe-limit').click();
      assert(el('protection-state').textContent.includes('轻量'), 'Protection state did not update');
      const saved = JSON.parse(w.localStorage.getItem('earlab-enhancement-v1'));
      assert(saved.scene === 'game' && saved.bass === 3 && saved.clarity === 2 && saved.balance === 30 && !saved.dynamic && !saved.protect, 'Enhancement settings were not saved');
      d.querySelector('[data-scene="daily"]').click();
      input('taste-bass', '0'); input('taste-clarity', '0'); input('balance', '0');
      if (!el('dynamic-eq').checked) el('dynamic-eq').click();
      if (!el('safe-limit').checked) el('safe-limit').click();
    });
    await test('惊喜增强提供原声直通与器乐表现预设', async () => {
      const raw = d.querySelector('[data-scene="raw"]');
      const instrumental = d.querySelector('[data-scene="instrumental"]');
      assert(raw && instrumental, '新增增强场景缺失');

      d.querySelector('[data-preset="flat"]').click();
      raw.click();
      assert(el('enhancement-mode').textContent.includes('原声'), '原声直通场景未激活');
      const rawGains = w.effectiveGains();
      assert(rawGains.every(gain => gain === 0), '原声直通不应添加场景增益');
      input('taste-bass', '2');
      assert(w.effectiveGains()[0] > 0, '原声直通仍应允许个性化设置叠加');

      instrumental.click();
      assert(el('enhancement-mode').textContent.includes('器乐'), '器乐表现场景未激活');
      const instrumentalGains = w.effectiveGains();
      assert(instrumentalGains[4] > instrumentalGains[0], '器乐表现应突出中高频细节');
      const saved = JSON.parse(w.localStorage.getItem('earlab-enhancement-v1'));
      assert(saved.scene === 'instrumental', '新增场景未本地保存');

      d.querySelector('[data-scene="daily"]').click();
      input('taste-bass', '0');
    });
    await test('引擎可启动，重复调用复用同一上下文', async () => {
      const [a, b] = await Promise.all([w.ensureEngine(), w.ensureEngine()]);
      assert(a === b && a.state === 'running', 'Engine was duplicated or failed to run');
    });
    await test('真实 BiquadFilter 的低音预设改变频响，旁路恢复平直', async () => {
      d.querySelector('[data-preset="bass"]').click();
      const ctx = new w.OfflineAudioContext(2, 48000, 48000), graph = w.makeGraph(ctx);
      const frequencies = new Float32Array([60]), magnitude = new Float32Array(1), phase = new Float32Array(1);
      graph.filters[0].getFrequencyResponse(frequencies, magnitude, phase);
      assert(magnitude[0] > 1.2, 'Bass filter has no gain');
      el('eq-enabled').click();
      const bypass = w.makeGraph(ctx);
      bypass.filters[0].getFrequencyResponse(frequencies, magnitude, phase);
      assert(Math.abs(magnitude[0] - 1) < 0.001, 'Bypass is not flat');
      el('eq-enabled').click(); el('eq-reset').click();
    });
    await test('离线渲染验证完整音乐处理链有输出', async () => {
      el('mute').click();
      try {
        const ctx = new w.OfflineAudioContext(1, 24000, 48000), graph = w.makeGraph(ctx), osc = ctx.createOscillator();
        osc.frequency.value = 440; osc.connect(graph.music); osc.start();
        const result = await ctx.startRendering();
        const peak = result.getChannelData(0).reduce((p, n) => Math.max(p, Math.abs(n)), 0);
        assert(peak > 0.01 && peak < 0.3, `Unexpected peak ${peak}`);
      } finally { el('mute').click(); }
    });
    await test('离线渲染验证静音确实输出零信号', async () => {
      const ctx = new w.OfflineAudioContext(1, 8000, 48000), graph = w.makeGraph(ctx), osc = ctx.createOscillator();
      osc.connect(graph.music); osc.start();
      const result = await ctx.startRendering();
      assert(result.getChannelData(0).every(sample => sample === 0), 'Muted graph produced audio');
    });
    await test('通透采集可启动，关闭时释放所有轨道', async () => {
      const stream = silentStream(); media.getUserMedia = async () => stream;
      await w.startMic(); assert(el('transparency').checked && stream.active, 'Mic did not start');
      input('ambient', '23'); input('highpass', '250');
      assert(el('ambient-value').textContent === '23%' && el('highpass-value').textContent === '250 Hz', 'Mic controls failed');
      w.releaseMic(); assert(!stream.active && !el('transparency').checked, 'Mic tracks not stopped');
    });
    await test('麦克风权限拒绝时，开关与错误提示恢复', async () => {
      media.getUserMedia = async () => { throw new w.DOMException('Denied', 'NotAllowedError'); };
      await w.startMic(); assert(!el('transparency').checked && el('toast').textContent.includes('权限'), 'Denied mic state is wrong');
    });
    await test('权限请求未完成时停止，迟到的麦克风流立即释放', async () => {
      const stream = silentStream(), request = deferred(), entered = deferred();
      media.getUserMedia = () => { entered.resolve(); return request.promise; };
      const pending = w.startMic(); await entered.promise;
      w.stopAll(false); request.resolve(stream); await pending;
      assert(!stream.active && !el('transparency').checked, 'Late mic capture survived stop');
    });
    await test('共享没有音轨时，视频轨道也被释放', async () => {
      const canvas = d.createElement('canvas'); canvas.width = canvas.height = 4;
      const stream = canvas.captureStream(); media.getDisplayMedia = async () => stream;
      await w.startSystem(); assert(!stream.active && el('system-state').textContent === '未连接', 'Video-only capture leaked');
    });
    await test('共享成功后结束事件清理流与界面', async () => {
      const stream = silentStream(); media.getDisplayMedia = async () => stream;
      await w.startSystem(); assert(el('system-state').textContent === '已连接', 'Share did not start');
      stream.getAudioTracks()[0].dispatchEvent(new w.Event('ended'));
      assert(!stream.active && el('system-state').textContent === '未连接', 'Ended share leaked');
    });
    await test('停止后到达的共享流被丢弃并释放', async () => {
      const stream = silentStream(), request = deferred();
      media.getDisplayMedia = () => request.promise;
      const pending = w.startSystem(); w.stopAll(false); request.resolve(stream); await pending;
      assert(!stream.active && !el('system-connect').disabled, 'Late share capture leaked');
    });
    await test('输出切换失败回滚，下拉框与实际输出一致', async () => {
      const ctx = await w.ensureEngine();
      const old = ctx.setSinkId;
      try {
        media.enumerateDevices = async () => [];
        await w.refreshDevices();
        ctx.setSinkId = async () => { throw new w.DOMException('Disconnected', 'NotFoundError'); };
        await w.changeOutput('missing-output');
        assert(el('output-device').value === '' && !el('output-device').disabled, 'Failed sink was not rolled back');
        const calls = []; ctx.setSinkId = async id => { calls.push(id); };
        await w.changeOutput(''); assert(calls[0] === '', 'Default sink did not call setSinkId with empty string');
      } finally { ctx.setSinkId = old; media.enumerateDevices = originalEnum; }
    });
    await test('真实 WAV 解码、播放、暂停以及引擎重启后重播', async () => {
      const length = 48000, bytes = new ArrayBuffer(44 + length * 2), view = new DataView(bytes);
      const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
      text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      text(36, 'data'); view.setUint32(40, length * 2, true);
      for (let i = 0; i < length; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 440 / 48000) * 2000, true);
      await w.loadFile(new w.File([bytes], 'smoke-test.wav', { type: 'audio/wav' }));
      assert(!el('file-play').disabled && el('file-name').textContent.includes('smoke-test.wav'), 'File decode failed');
      await w.playFile(); assert(el('file-state').textContent === '播放中', 'File did not play');
      w.stopFile(true); assert(el('file-play').textContent === '播放文件', 'Pause failed');
      w.stopAll(false); await w.playFile(); assert(el('file-state').textContent === '播放中', 'File failed after new context');
      w.stopFile(false);
    });
    await test('切换到测试旋律会停止文件，旋律 4 秒自动结束', async () => {
      await w.playFile(); await w.playTest();
      assert(el('file-state').textContent !== '播放中' && el('test-sound').textContent.includes('停止试听'), 'Source exclusivity failed');
      await delay(4400);
      assert(el('test-sound').textContent.includes('试听旋律'), 'Melody did not end');
    });
    await test('Esc 同时释放麦克风、共享流并关闭引擎', async () => {
      const mic = silentStream(), system = silentStream();
      media.getUserMedia = async () => mic; media.getDisplayMedia = async () => system;
      await w.startMic(); await w.startSystem(); const ctx = await w.ensureEngine();
      d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(30);
      assert(!mic.active && !system.active && ctx.state === 'closed', 'Esc did not fully release audio');
    });
    await test('ANC 数学模型：零延迟抵消、半周期延迟放大', async () => {
      w.location.hash = '#anc'; await delay(30);
      input('anc-frequency', '200'); input('anc-delay', '0'); input('anc-strength', '100');
      assert(el('anc-residual').textContent === '0%', 'Zero delay incorrect');
      input('anc-delay', '2.5'); assert(el('anc-residual').textContent === '200%', 'Half-period delay incorrect');
      el('anc-reset').click();
    });
    await test('反相测试的实际滤波输出与同路径正相信号极性相反', async () => {
      async function render(sign) {
        const ctx = new w.OfflineAudioContext(1, 12000, 48000);
        const graph = w.makeAncLiveGraph(ctx, ctx.destination), source = ctx.createOscillator();
        graph.nodes[2].gain.value = sign; graph.level.gain.value = 0.05;
        source.frequency.value = 200; source.connect(graph.head); source.start();
        return (await ctx.startRendering()).getChannelData(0);
      }
      const [positive, negative] = await Promise.all([render(1), render(-1)]);
      assert(positive.some(n => Math.abs(n) > 0.01), 'No test signal');
      assert(positive.every((n, i) => Math.abs(n + negative[i]) < 1e-6), 'Output was not inverted');
    });
    await test('测试开关启用后可关闭，轨道释放，通透互斥且音乐保留', async () => {
      let stream = silentStream(); media.getUserMedia = async () => stream;
      await w.startMic(); const transparencyStream = stream;
      stream = silentStream(); await w.playFile(); await w.startAncLive();
      assert(!transparencyStream.active && !el('transparency').checked, 'Transparency still active');
      assert(el('anc-live-toggle').textContent === '关闭测试' && stream.active, 'Live test did not start');
      assert(el('file-state').textContent === '播放中', 'Music was stopped');
      el('anc-live-toggle').click();
      assert(!stream.active && el('anc-live-toggle').getAttribute('aria-pressed') === 'false', 'Toggle did not release test');
      assert(el('file-state').textContent === '播放中', 'Stopping test stopped music');
      w.stopFile(false);
    });
    await test('测试权限等待中取消、权限拒绝均恢复关闭状态', async () => {
      const stream = silentStream(), request = deferred(), entered = deferred();
      media.getUserMedia = () => { entered.resolve(); return request.promise; };
      const pending = w.startAncLive(); await entered.promise;
      el('anc-live-toggle').click(); request.resolve(stream); await pending;
      assert(!stream.active && el('anc-live-toggle').textContent === '启用测试', 'Late test stream leaked');
      media.getUserMedia = async () => { throw new w.DOMException('Denied', 'NotAllowedError'); };
      await w.startAncLive();
      assert(el('anc-live-toggle').getAttribute('aria-pressed') === 'false', 'Denied test stayed enabled');
    });
    await test('Esc 与设备断开均关闭反相测试，重启不自动开启', async () => {
      let stream = silentStream(); media.getUserMedia = async () => stream;
      await w.startAncLive();
      stream.getTracks()[0].dispatchEvent(new w.Event('ended'));
      assert(!stream.active && el('anc-live-toggle').textContent === '启用测试', 'Ended test leaked');
      stream = silentStream(); await w.startAncLive();
      d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(!stream.active && el('anc-live-toggle').textContent === '启用测试', 'Esc left test active');
      await w.ensureEngine();
      assert(el('anc-live-toggle').getAttribute('aria-pressed') === 'false', 'Engine restart resumed test');
    });
    await test('无未捕获的 JavaScript 错误', async () => { assert(errors.length === 0, errors.join('; ')); });
  } finally {
    w.stopAll(false); input('ambient', '15'); input('highpass', '120');
    if (el('mute').getAttribute('aria-pressed') === 'true') el('mute').click();
    el('eq-reset').click(); w.location.hash = '#studio';
    media.getUserMedia = originalMic; media.getDisplayMedia = originalShare; media.enumerateDevices = originalEnum;
    w.removeEventListener('error', onError); w.removeEventListener('unhandledrejection', onError);
    await Promise.all(contexts.map(ctx => ctx.close().catch(() => {})));
    summary.textContent = `${count} 项通过 / ${failures.length} 项失败。真实设备权限与声学体验需在目标耳机上验证。`;
    run.disabled = false;
  }
});
