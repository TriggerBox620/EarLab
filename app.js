'use strict';

// No network requests, audio uploads, external libraries, or background workers.
const $ = id => document.getElementById(id);
const FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000, 20000];
const PRESETS = {
  flat: { gains: [0, 0, 0, 0, 0, 0], text: '忠于原声，保留每一个细节。' },
  bass: { gains: [5, 3, 0, -1, 0, 1], text: '多一点低频，保留清晰的轮廓。' },
  vocal: { gains: [-2, -1, 1, 3, 2, 0], text: '把人声拉近，让对白更清楚。' },
  soft: { gains: [1, 0, 0, -1, -3, -2], text: '收敛高频，适合轻松聆听。' }
};
const SCENES = {
  daily: { label: '日常增强', gains: [2, 1, 0, 0, 1, 1], text: '轻微抬升低频和空气感，让普通有线耳机更饱满。', protect: [-12, 8] },
  voice: { label: '人声清晰', gains: [-3, -2, 1, 3, 2, -1], text: '把对白和会议人声推到前面，压住浑浊低频。', protect: [-14, 10] },
  game: { label: '游戏定位', gains: [-2, -1, 1, 2, 4, 1], text: '收敛轰鸣，突出脚步、换弹和空间细节。', protect: [-10, 6] },
  night: { label: '夜间舒适', gains: [-1, 0, 1, 2, -1, -2], text: '缩小动态起伏，小音量也更容易听清。', protect: [-22, 12] }
};

const expandGains = gains => gains.length === 12 ? gains : gains.flatMap(v => [v, v]);
Object.values(PRESETS).forEach(preset => { preset.gains = expandGains(preset.gains); });
Object.values(SCENES).forEach(scene => { scene.gains = expandGains(scene.gains); });
const state = {
  ctx: null, ready: null, generation: 0, graph: null, muted: false,
  eq: Array(12).fill(0), preset: 'flat',
  scene: 'daily', bass: 0, clarity: 0, balance: 0, dynamic: true, protect: true, dynamicEQ: Array(12).fill(0), aiMode: 'balanced', aiEnabled: false,
  mic: null, micToken: 0, system: null, systemToken: 0,
  ancLive: null, ancLiveToken: 0, ancLivePending: false, ancTone: null,
  fileBuffer: null, fileName: '', fileSource: null, fileOffset: 0, fileStarted: 0, fileToken: 0,
  test: null, page: 'studio', outputToken: 0, outputId: '',
  lastFrame: 0, toastTimer: 0
};

function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8500 : 4500);
}
function report(error, action) {
  if (error?.name === 'AbortError') return;
  const messages = {
    NotAllowedError: '权限未授予或已取消。请检查浏览器权限，然后重试。',
    NotFoundError: '没有找到可用设备，请连接麦克风或耳机后刷新。',
    NotReadableError: '无法读取音频设备，可能被其他程序占用。',
    OverconstrainedError: '所选设备已不可用，请重新选择。',
    SecurityError: '请使用 localhost 或 HTTPS，并允许浏览器访问音频。',
    EncodingError: '音频格式无法解码，请尝试 MP3 或 WAV 文件。'
  };
  toast(`${action}：${messages[error?.name] || error?.message || '未知错误'}`, true);
}
function cancelled() { return new DOMException('操作已停止', 'AbortError'); }
function valid(ctx, generation) { return state.ctx === ctx && state.generation === generation && ctx.state !== 'closed'; }
function disconnect(node) { if (node) { try { node.disconnect(); } catch (_) { /* already detached */ } } }
function stopTracks(stream) {
  stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
}
function ramp(param, value, ctx = state.ctx) {
  if (!ctx || ctx.state === 'closed') return;
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, 0.025);
}
function fillRange(input) {
  const percent = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
  input.style.setProperty('--fill', `${percent}%`);
}
function setConnected(id, text, connected) {
  $(id).textContent = text;
  $(id).classList.toggle('connected', connected);
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function effectiveGains() {
  const scene = SCENES[state.scene] || SCENES.daily;
  return state.eq.map((gain, index) => clamp(
    gain + scene.gains[index] + state.dynamicEQ[index]
      + (index < 2 ? state.bass : 0)
      + ([2, 3, 4].includes(index) ? state.clarity : index === 5 ? state.clarity * 0.5 : 0),
    -6, 6
  ));
}
function applyProtection() {
  const compressor = state.graph?.compressor;
  if (!compressor) return;
  const [threshold, ratio] = state.protect ? (SCENES[state.scene] || SCENES.daily).protect : [-3, 1];
  ramp(compressor.threshold, threshold); ramp(compressor.knee, state.protect ? 6 : 0);
  ramp(compressor.ratio, ratio); ramp(compressor.attack, state.protect ? 0.003 : 0.01);
  ramp(compressor.release, state.protect ? 0.18 : 0.08);
}
function applyBalance() {
  if (state.graph?.panner) ramp(state.graph.panner.pan, state.balance / 50);
}

function makeGraph(ctx) {
  const music = ctx.createGain();
  const preamp = ctx.createGain(); preamp.gain.value = Math.pow(10, -6 / 20);
  const filters = FREQUENCIES.map((frequency, index) => {
    const filter = ctx.createBiquadFilter();
    filter.type = index === 0 ? 'lowshelf' : index === FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = frequency; filter.Q.value = 1;
    filter.gain.value = $('eq-enabled').checked ? effectiveGains()[index] : 0;
    return filter;
  });
  const mix = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  const [threshold, ratio] = state.protect ? (SCENES[state.scene] || SCENES.daily).protect : [-3, 1];
  compressor.threshold.value = threshold; compressor.knee.value = state.protect ? 6 : 0; compressor.ratio.value = ratio;
  compressor.attack.value = 0.003; compressor.release.value = 0.18;
  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panner) panner.pan.value = state.balance / 50;
  const master = ctx.createGain(); master.gain.value = state.muted ? 0 : Number($('master').value) / 100;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.78;
  analyser.minDecibels = -90; analyser.maxDecibels = -6;
  const nodes = [music, preamp, ...filters, mix, compressor, ...(panner ? [panner] : []), master, analyser, ctx.destination];
  nodes.forEach((node, i) => { if (i < nodes.length - 1) node.connect(nodes[i + 1]); });
  return { music, preamp, filters, mix, compressor, panner, master, analyser,
    spectrum: new Uint8Array(analyser.frequencyBinCount), samples: new Float32Array(analyser.fftSize) };
}

// Store the context synchronously so concurrent user actions share one engine.
function ensureEngine() {
  if (state.ready) return state.ready;
  if (state.ctx) {
    const ctx = state.ctx;
    return ctx.resume().then(() => {
      if (state.ctx !== ctx) throw cancelled();
      engineUI(); return ctx;
    });
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return Promise.reject(new Error('此浏览器不支持 Web Audio，请使用新版 Chrome 或 Edge。'));
  const generation = ++state.generation;
  let ctx;
  try {
    ctx = new AC({ latencyHint: 'interactive' });
    state.ctx = ctx;
    state.graph = makeGraph(ctx);
    ctx.onstatechange = () => { if (state.ctx === ctx) engineUI(); };
  } catch (error) {
    if (ctx) ctx.close().catch(() => {});
    state.ctx = null; state.graph = null;
    return Promise.reject(error);
  }
  state.ready = (async () => {
    try {
      await ctx.resume();
      if (!valid(ctx, generation)) throw cancelled();
      if (state.outputId && typeof ctx.setSinkId === 'function') {
        try { await ctx.setSinkId(state.outputId); }
        catch (error) { state.outputId = ''; $('output-device').value = ''; report(error, '恢复输出设备失败'); }
      }
      if (!valid(ctx, generation)) throw cancelled();
      engineUI();
      refreshDevices();
      return ctx;
    } catch (error) {
      if (state.ctx === ctx) stopAll(false);
      throw error;
    } finally {
      if (state.ctx === ctx) state.ready = null;
    }
  })();
  // Also observe the rejection if an independent permission dialog is still open.
  state.ready.catch(() => {});
  return state.ready;
}
function engineUI() {
  const running = state.ctx?.state === 'running';
  $('engine-dot').classList.toggle('on', running);
  $('engine-status').textContent = !state.ctx ? '引擎待启动' : running ? '音频引擎运行中' : '引擎已暂停';
  $('power').innerHTML = `<svg><use href="#i-power"/></svg>${!state.ctx ? '启动引擎' : running ? '停止引擎' : '恢复引擎'}`;
  $('sample-rate').textContent = state.ctx ? `${state.ctx.sampleRate / 1000} kHz` : '—';
  const parts = [];
  if (state.system) parts.push('共享音频');
  if (state.fileSource) parts.push('本地音频');
  if (state.test) parts.push('测试旋律');
  if (state.mic) parts.push('环境监听');
  if (state.ancLive) parts.push('反相耳返测试');
  $('session-state').textContent = parts.length ? `${parts.join(' + ')} → 耳机输出${state.muted ? '（已静音）' : ''}` : state.ctx ? '引擎就绪，等待连接音源' : '就绪，等待连接音源';
  $('monitor-state').textContent = parts.length && running ? 'LIVE OUTPUT' : 'WAITING FOR AUDIO';
  $('monitor-empty').hidden = parts.length > 0 && running;
  $('spectrum').setAttribute('aria-label', parts.length ? '实时输出频谱' : '实时输出频谱，等待音源');
}
function stopAll(notify = true) {
  // Invalidate every pending permission/decode request before releasing the graph.
  ++state.generation; ++state.fileToken; ++state.outputToken;
  const ctx = state.ctx;
  if (state.graph && ctx?.state !== 'closed') {
    state.graph.master.gain.cancelScheduledValues(ctx.currentTime);
    state.graph.master.gain.setValueAtTime(0, ctx.currentTime);
    disconnect(state.graph.master);
  }
  stopAncLive(); stopAncTone(); releaseMic(); releaseSystem(); stopTest(); stopFile(false);
  state.ctx = null; state.graph = null; state.ready = null;
  if (ctx && ctx.state !== 'closed') { ctx.onstatechange = null; ctx.close().catch(() => {}); }
  $('choose-file').disabled = false;
  $('choose-file').textContent = '选择文件 ＋';
  const AC = window.AudioContext || window.webkitAudioContext;
  $('output-device').disabled = !AC?.prototype?.setSinkId;
  $('latency').textContent = '—'; $('peak-value').textContent = '−∞';
  engineUI(); drawSpectrum();
  if (notify) toast('已停止全部播放，并释放麦克风和共享音频。');
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [id, kind, defaultName] of [['mic-device', 'audioinput', '系统默认麦克风'], ['output-device', 'audiooutput', '系统默认输出']]) {
      const select = $(id), selected = select.value;
      select.replaceChildren(new Option(defaultName, ''));
      devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'default')
        .forEach((device, index) => select.add(new Option(device.label || `${kind === 'audioinput' ? '麦克风' : '输出设备'} ${index + 1}`, device.deviceId)));
      if ([...select.options].some(option => option.value === selected)) select.value = selected;
      // If an output disappeared, synchronize the actual sink with the default UI.
      else if (id === 'output-device' && state.outputId) await changeOutput('');
    }
  } catch (error) { report(error, '读取设备失败'); }
}
async function changeOutput(requestedId = $('output-device').value) {
  const token = ++state.outputToken;
  const previous = state.outputId;
  if (!state.ctx) {
    state.outputId = requestedId;
    $('output-device').value = requestedId;
    return;
  }
  const ctx = state.ctx;
  if (typeof ctx.setSinkId !== 'function') {
    $('output-device').value = previous;
    toast('此浏览器不支持输出切换，请在系统声音设置中选择耳机。', true); return;
  }
  $('output-device').disabled = true;
  try {
    // Empty string explicitly restores the system default output.
    await ctx.setSinkId(requestedId);
    if (token !== state.outputToken || ctx !== state.ctx) return;
    state.outputId = requestedId; $('output-device').value = requestedId;
    toast('输出设备已切换。');
  } catch (error) {
    if (token === state.outputToken) { $('output-device').value = previous; report(error, '切换输出失败'); }
  } finally { if (token === state.outputToken) $('output-device').disabled = false; }
}

function releaseMic() {
  ++state.micToken;
  if (state.mic) {
    stopTracks(state.mic.stream);
    state.mic.nodes.forEach(disconnect);
    state.mic = null;
  }
  $('transparency').checked = false;
  $('mic-state').textContent = '麦克风未启用'; $('mic-level').style.width = '0%';
  engineUI();
}
async function startMic() {
  stopAncLive();
  releaseMic();
  const token = ++state.micToken;
  $('transparency').checked = true;
  $('mic-state').textContent = '等待麦克风权限…';
  let stream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('麦克风不可用，请用 Chrome / Edge 访问 localhost 或 HTTPS。');
    const ctx = await ensureEngine(), generation = state.generation;
    if (token !== state.micToken) return;
    const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } };
    if ($('mic-device').value) constraints.deviceId = { exact: $('mic-device').value };
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    if (token !== state.micToken || !valid(ctx, generation)) { stopTracks(stream); return; }
    const source = ctx.createMediaStreamSource(stream);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = Number($('highpass').value); hp.Q.value = 0.707;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = 0.707;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    source.connect(hp); hp.connect(lp); lp.connect(analyser); analyser.connect(gain); gain.connect(state.graph.mix);
    state.mic = { stream, hp, gain, analyser, samples: new Float32Array(1024), nodes: [source, hp, lp, analyser, gain] };
    ramp(gain.gain, Number($('ambient').value) / 100);
    stream.getTracks().forEach(track => { track.onended = () => { if (state.mic?.stream === stream) { releaseMic(); toast('麦克风已断开。'); } }; });
    $('mic-state').textContent = '正在监听环境'; engineUI(); refreshDevices();
    toast('通透模式已开启。请用耳机监听，避免外放反馈。');
  } catch (error) {
    stopTracks(stream);
    if (token === state.micToken) { releaseMic(); report(error, '开启通透失败'); }
  }
}
// A separate, explicitly enabled experiment; this is not adaptive ANC.
function makeAncLiveGraph(ctx, destination) {
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 40; hp.Q.value = 0.707;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.707;
  const inverse = ctx.createGain(); inverse.gain.value = -1;
  const level = ctx.createGain(); level.gain.value = 0;
  hp.connect(lp); lp.connect(inverse); inverse.connect(level); level.connect(destination);
  return { head: hp, level, nodes: [hp, lp, inverse, level] };
}
function stopAncLive() {
  ++state.ancLiveToken;
  state.ancLivePending = false;
  if (state.ancLive) {
    // Disconnect immediately, including when a fade-in is still scheduled.
    state.ancLive.nodes.forEach(disconnect);
    stopTracks(state.ancLive.stream);
    state.ancLive = null;
  }
  $('anc-live-toggle').setAttribute('aria-pressed', 'false');
  $('anc-live-toggle').textContent = '启用测试';
  $('anc-live-status').textContent = '测试已关闭 · 不输出反相信号';
  if (state.ancTone) { ramp(state.ancTone.inverseGain.gain, 0); $('anc-tone-state').textContent = '原始测试音'; }
  engineUI();
}
function stopAncTone() {
  if (state.ancTone) {
    state.ancTone.oscillators.forEach(disconnect);
    state.ancTone.gains.forEach(disconnect);
    state.ancTone.oscillators.forEach(o => { try { o.stop(); } catch (_) {} });
    state.ancTone = null;
  }
  if ($('anc-tone-toggle')) $('anc-tone-toggle').textContent = '播放对比音';
  if ($('anc-tone-state')) $('anc-tone-state').textContent = '对比音已停止';
}
async function toggleAncTone() {
  if (state.ancTone) { stopAncTone(); return; }
  try {
    const ctx = await ensureEngine();
    const frequency = 160, osc = ctx.createOscillator(), sourceGain = ctx.createGain(), inverseGain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = frequency;
    sourceGain.gain.value = 0.07; inverseGain.gain.value = 0;
    osc.connect(sourceGain); sourceGain.connect(state.graph.mix);
    // Same oscillator, opposite branch: this isolates the audible A/B comparison.
    osc.connect(inverseGain); inverseGain.gain.value = state.ancLive ? -0.07 : 0;
    inverseGain.connect(state.graph.mix); osc.start();
    state.ancTone = { oscillators: [osc], gains: [sourceGain, inverseGain], inverseGain };
    $('anc-tone-toggle').textContent = '停止对比音'; $('anc-tone-state').textContent = state.ancLive ? '反相中 · 理想混音' : '原始测试音';
    toast('对比音已播放：先听原始音，再启用反相测试比较。');
  } catch (error) { report(error, '播放对比音失败'); }
}
async function startAncLive() {
  stopAncLive();
  // Positive ear-return would confound the comparison. Do not auto-restore it.
  releaseMic();
  const token = ++state.ancLiveToken;
  state.ancLivePending = true;
  $('anc-live-toggle').setAttribute('aria-pressed', 'true');
  $('anc-live-toggle').textContent = '取消测试';
  $('anc-live-status').textContent = '等待麦克风权限…再次点击可取消';
  let stream, graph, source;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('请使用 localhost 或 HTTPS，并允许麦克风访问。');
    const ctx = await ensureEngine(), generation = state.generation;
    if (token !== state.ancLiveToken) return;
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } };
    if ($('mic-device').value) audio.deviceId = { exact: $('mic-device').value };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (token !== state.ancLiveToken || !valid(ctx, generation)) { stopTracks(stream); return; }
    source = ctx.createMediaStreamSource(stream);
    graph = makeAncLiveGraph(ctx, state.graph.mix);
    source.connect(graph.head);
    state.ancLive = { stream, level: graph.level, nodes: [source, ...graph.nodes] };
    state.ancLivePending = false;
    ramp(graph.level.gain, Number($('anc-live-volume').value) / 100);
    stream.getTracks().forEach(track => { track.onended = () => {
      if (state.ancLive?.stream === stream) { stopAncLive(); toast('测试麦克风已断开。'); }
    }; });
    $('anc-live-toggle').textContent = '关闭测试';
    $('anc-live-status').textContent = '测试已启用 · 正在输出低频反相耳返';
    if (state.ancTone) { ramp(state.ancTone.inverseGain.gain, -0.07); $('anc-tone-state').textContent = '反相中 · 理想混音'; }
    engineUI(); refreshDevices();
  } catch (error) {
    disconnect(source); graph?.nodes.forEach(disconnect); stopTracks(stream);
    if (token === state.ancLiveToken) { stopAncLive(); report(error, '反相耳返测试失败'); }
  }
}
function releaseSystem() {
  ++state.systemToken;
  if (state.system) {
    stopTracks(state.system.stream); disconnect(state.system.source); state.system = null;
  }
  $('system-connect').disabled = false; $('system-connect').textContent = '接入音频 ↗';
  setConnected('system-state', '未连接', false);
  $('system-description').textContent = '在共享窗口中勾选「分享音频」';
  updateSourceSummary(); engineUI();
}
async function startSystem() {
  const token = ++state.systemToken;
  let stream;
  $('system-connect').disabled = true;
  $('system-connect').textContent = '等待共享…';
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('此环境不支持音频共享。请使用桌面 Chrome / Edge 和 localhost / HTTPS。');
    const ready = ensureEngine();
    const generation = state.generation;
    // Invoke directly within the click's transient activation, before any await.
    const request = navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude'
    });
    stream = await request;
    const ctx = await ready;
    if (token !== state.systemToken || !valid(ctx, generation)) { stopTracks(stream); return; }
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) throw new Error('所选共享没有音频。请重试并勾选「分享音频」，或改为共享另一个有声音的标签页。');
    stopFile(true); stopTest();
    const source = ctx.createMediaStreamSource(stream);
    source.connect(state.graph.music);
    state.system = { stream, source };
    // The browser requires a video track for display capture; no frame is read or stored.
    stream.getVideoTracks().forEach(track => { track.enabled = false; });
    stream.getTracks().forEach(track => { track.onended = () => { if (state.system?.stream === stream) { releaseSystem(); toast('音频共享已结束。'); } }; });
    setConnected('system-state', '已连接', true);
    $('system-description').textContent = audioTrack.label || '正在接收共享音频';
    $('system-connect').textContent = '断开音频';
    engineUI(); updateSourceSummary();
    toast('共享音频已接入 EQ。若听到重复声，请检查来源播放与系统路由。');
  } catch (error) {
    stopTracks(stream);
    if (token === state.systemToken) { releaseSystem(); report(error, '接入音频失败'); }
  } finally {
    if (token === state.systemToken) $('system-connect').disabled = false;
  }
}

function updateSourceSummary() {
  $('source-summary').textContent = state.system ? '共享音频 → 6 段 EQ → 耳机' : state.test ? '测试旋律正在播放，4 秒后自动结束。' : state.fileSource ? `${state.fileName} → 6 段 EQ → 耳机` : state.fileBuffer ? `已载入 ${state.fileName}，点击播放试听。` : '还没有音源？用测试旋律快速试听。';
  $('file-play').disabled = !state.fileBuffer;
  $('file-play').textContent = state.fileSource ? '暂停文件' : '播放文件';
  $('test-sound').innerHTML = `<svg><use href="#i-play"/></svg>${state.test ? '停止试听' : '试听旋律 · 4 秒'}`;
  setConnected('file-state', state.fileSource ? '播放中' : state.fileBuffer ? '已载入' : '未载入', !!state.fileSource);
}
async function loadFile(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) { toast('第一版支持 100 MB 以内的音频，请选择更小的文件。', true); return; }
  const token = ++state.fileToken;
  $('choose-file').disabled = true; $('choose-file').textContent = '正在载入…';
  try {
    const ctx = await ensureEngine(), generation = state.generation;
    const bytes = await file.arrayBuffer();
    if (token !== state.fileToken || !valid(ctx, generation)) return;
    const buffer = await ctx.decodeAudioData(bytes);
    if (token !== state.fileToken || !valid(ctx, generation)) return;
    stopFile(false);
    state.fileBuffer = buffer; state.fileName = file.name; state.fileOffset = 0;
    $('file-name').textContent = `${file.name} · ${Math.floor(buffer.duration / 60)}:${String(Math.floor(buffer.duration % 60)).padStart(2, '0')}`;
    updateSourceSummary(); toast('音频已载入，点击「播放文件」开始试听。');
  } catch (error) { if (token === state.fileToken) report(error, '载入音频失败'); }
  finally { if (token === state.fileToken) { $('choose-file').disabled = false; $('choose-file').textContent = '选择文件 ＋'; } }
}
function stopFile(preservePosition = true) {
  if (state.fileSource) {
    const source = state.fileSource;
    if (preservePosition && state.ctx) state.fileOffset = Math.min(state.fileBuffer.duration, state.fileOffset + state.ctx.currentTime - state.fileStarted);
    state.fileSource = null; source.onended = null;
    try { source.stop(); } catch (_) { /* already ended */ }
    disconnect(source);
  }
  if (!preservePosition) state.fileOffset = 0;
  updateSourceSummary(); engineUI();
}
async function playFile() {
  if (state.fileSource) { stopFile(true); return; }
  if (!state.fileBuffer) return;
  const token = state.fileToken;
  $('file-play').disabled = true;
  try {
    const ctx = await ensureEngine();
    if (token !== state.fileToken || state.fileSource) return;
    releaseSystem(); stopTest();
    const source = ctx.createBufferSource(); source.buffer = state.fileBuffer;
    source.connect(state.graph.music);
    if (state.fileOffset >= source.buffer.duration - 0.01) state.fileOffset = 0;
    state.fileSource = source; state.fileStarted = ctx.currentTime;
    source.onended = () => { if (state.fileSource === source) { disconnect(source); state.fileSource = null; state.fileOffset = 0; updateSourceSummary(); engineUI(); } };
    source.start(0, state.fileOffset);
    updateSourceSummary(); engineUI();
  } catch (error) { report(error, '播放失败'); }
  finally { updateSourceSummary(); }
}
function stopTest() {
  if (state.test) {
    const test = state.test; state.test = null;
    test.oscillators.forEach(oscillator => { oscillator.onended = null; try { oscillator.stop(); } catch (_) { /* already stopped */ } disconnect(oscillator); });
    test.gains.forEach(disconnect);
  }
  updateSourceSummary(); engineUI();
}
async function playTest() {
  if (state.test) { stopTest(); return; }
  $('test-sound').disabled = true;
  try {
    const ctx = await ensureEngine();
    releaseSystem(); stopFile(true);
    const test = { oscillators: [], gains: [] }; state.test = test;
    // Quiet finite melody with smooth envelopes; never used as anti-noise.
    [220, 277.18, 329.63, 440, 329.63, 277.18, 220, 164.81].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.type = 'triangle'; oscillator.frequency.value = frequency;
      const start = ctx.currentTime + index * 0.5;
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.12, start + 0.035);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.46); gain.gain.setValueAtTime(0, start + 0.49);
      oscillator.connect(gain); gain.connect(state.graph.music);
      test.oscillators.push(oscillator); test.gains.push(gain);
      oscillator.start(start); oscillator.stop(start + 0.5);
      if (index === 7) oscillator.onended = () => { if (state.test === test) stopTest(); };
    });
    updateSourceSummary(); engineUI();
  } catch (error) { report(error, '试听失败'); }
  finally { $('test-sound').disabled = false; }
}

function saveEQ() {
  try { localStorage.setItem('earlab-eq-v2', JSON.stringify({ eq: state.eq, preset: state.preset })); } catch (_) { /* storage may be blocked */ }
}
function saveEnhancement() {
  try {
    localStorage.setItem('earlab-enhancement-v1', JSON.stringify({
      scene: state.scene, bass: state.bass, clarity: state.clarity,
      balance: state.balance, dynamic: state.dynamic, protect: state.protect
    }));
  } catch (_) { /* storage may be blocked */ }
}
function balanceText(value) {
  if (!value) return '居中';
  return `${Math.abs(value)} ${value < 0 ? '左' : '右'}`;
}
function applyEQ() {
  const gains = effectiveGains();
  state.graph?.filters.forEach((filter, index) => ramp(filter.gain, $('eq-enabled').checked ? gains[index] : 0));
  state.eq.forEach((gain, index) => {
    $(`eq-${index}`).value = gain; fillRange($(`eq-${index}`));
    $(`eq-value-${index}`).textContent = `${gain > 0 ? '+' : ''}${gain} dB`;
    $(`eq-${index}`).disabled = !$('eq-enabled').checked;
  });
  document.querySelector('.eq-card').classList.toggle('bypassed', !$('eq-enabled').checked);
  document.querySelectorAll('[data-preset]').forEach(button => {
    const active = button.dataset.preset === state.preset;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  $('eq-description').textContent = !$('eq-enabled').checked ? 'EQ 已旁路，保留 −6 dB 增益余量。' : PRESETS[state.preset]?.text || '自定义调校，找到你的声音。';
}
function applyEnhancement(save = true) {
  const scene = SCENES[state.scene] || SCENES.daily;
  $('enhancement-mode').textContent = scene.label;
  $('enhancement-description').textContent = scene.text;
  $('taste-bass').value = state.bass; $('taste-clarity').value = state.clarity; $('balance').value = state.balance;
  ['taste-bass', 'taste-clarity', 'balance'].forEach(id => fillRange($(id)));
  $('taste-bass-value').textContent = state.bass > 0 ? `+${state.bass}` : String(state.bass);
  $('taste-clarity-value').textContent = state.clarity > 0 ? `+${state.clarity}` : String(state.clarity);
  $('balance-value').textContent = balanceText(state.balance);
  $('dynamic-eq').checked = state.dynamic; $('safe-limit').checked = state.protect;
  $('dynamic-state').textContent = state.dynamic ? '开启' : '关闭';
  $('protection-state').textContent = state.protect ? '强保护' : '轻量';
  $('limiter-output-state').textContent = state.protect ? '强保护' : '轻量';
  document.querySelectorAll('[data-scene]').forEach(button => {
    const active = button.dataset.scene === state.scene;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  applyEQ(); applyBalance(); applyProtection();
  if (save) saveEnhancement();
}
function initEnhancement() {
  try {
    const stored = JSON.parse(localStorage.getItem('earlab-enhancement-v1'));
    if (SCENES[stored?.scene]) state.scene = stored.scene;
    if (Number.isFinite(stored?.bass)) state.bass = clamp(stored.bass, -3, 3);
    if (Number.isFinite(stored?.clarity)) state.clarity = clamp(stored.clarity, -3, 3);
    if (Number.isFinite(stored?.balance)) state.balance = clamp(stored.balance, -50, 50);
    if (typeof stored?.dynamic === 'boolean') state.dynamic = stored.dynamic;
    if (typeof stored?.protect === 'boolean') state.protect = stored.protect;
  } catch (_) { /* malformed or unavailable storage uses defaults */ }
  document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => {
    state.scene = button.dataset.scene; applyEnhancement();
  }));
  $('taste-bass').addEventListener('input', event => { state.bass = Number(event.target.value); applyEnhancement(); });
  $('taste-clarity').addEventListener('input', event => { state.clarity = Number(event.target.value); applyEnhancement(); });
  $('balance').addEventListener('input', event => { state.balance = Number(event.target.value); applyEnhancement(); });
  $('dynamic-eq').addEventListener('change', event => { state.dynamic = event.target.checked; if (!state.dynamic) state.dynamicEQ.fill(0); applyEnhancement(); });
  $('ai-adaptive').addEventListener('change', event => { state.aiEnabled = event.target.checked; if (!state.aiEnabled) state.dynamicEQ.fill(0); $('ai-state').textContent = state.aiEnabled ? '开启' : '关闭'; applyEQ(); });
  $('ai-mode').addEventListener('change', event => { state.aiMode = event.target.value; });
  $('safe-limit').addEventListener('change', event => { state.protect = event.target.checked; applyEnhancement(); });
  applyEnhancement(false);
}
function initEQ() {
  try {
    const stored = JSON.parse(localStorage.getItem('earlab-eq-v2'));
    if (Array.isArray(stored?.eq) && stored.eq.length === 6 && stored.eq.every(n => Number.isFinite(n) && n >= -6 && n <= 6)) {
      state.eq = stored.eq.length === 12 ? stored.eq : stored.eq.flatMap((v, i) => [v, v]);
      state.preset = Object.keys(PRESETS).find(key => PRESETS[key].gains.every((n, i) => n === state.eq[i])) || 'custom';
    }
  } catch (_) { /* malformed or unavailable storage uses defaults */ }
  FREQUENCIES.forEach((frequency, index) => {
    const band = document.createElement('div'); band.className = 'eq-band';
    const label = frequency >= 1000 ? `${frequency / 1000}k` : `${frequency}`;
    band.innerHTML = `<output id="eq-value-${index}" for="eq-${index}">0 dB</output><input id="eq-${index}" type="range" min="-6" max="6" value="0" step="0.5" aria-label="${frequency} Hz 增益 dB"><label for="eq-${index}">${label} Hz</label>`;
    $('equalizer').appendChild(band);
    $(`eq-${index}`).addEventListener('input', event => {
      state.eq[index] = Number(event.target.value); state.preset = 'custom'; applyEQ(); saveEQ();
    });
  });
  document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
    state.preset = button.dataset.preset; state.eq = [...PRESETS[state.preset].gains]; applyEQ(); saveEQ();
  }));
  $('eq-reset').addEventListener('click', () => { state.preset = 'flat'; state.eq = [...PRESETS.flat.gains]; applyEQ(); saveEQ(); });
  $('eq-enabled').addEventListener('change', applyEQ);
  applyEQ();
}

function canvasContext(id) {
  const canvas = $(id), rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * scale), height = Math.round(rect.height * scale);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d'); context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  return { context, width: rect.width, height: rect.height };
}
function spectrumBandAverage(spectrum, analyser, fromHz, toHz) {
  if (!state.ctx) return 0;
  const from = Math.max(1, Math.floor(fromHz * analyser.fftSize / state.ctx.sampleRate));
  const to = Math.min(spectrum.length - 1, Math.ceil(toHz * analyser.fftSize / state.ctx.sampleRate));
  let total = 0, count = 0;
  for (let i = from; i <= to; i++) { total += spectrum[i]; count++; }
  return count ? total / count : 0;
}
function updateDynamicEQ(spectrum, analyser) {
  if (!state.dynamic && !state.aiEnabled) return;
  const band = (a,b) => spectrumBandAverage(spectrum, analyser, a, b);
  const low=band(35,180), body=band(180,900), vocal=band(900,3000), high=band(5000,16000);
  const next=Array(12).fill(0); let text='开启';
  if(state.aiEnabled){
    const target=state.aiMode;
    if(low>body+18){ next[0]=-1.2; next[1]=-1; next[2]=-.6; text='AI 正在收低频'; }
    if(body>vocal+10){ next[3]=-.7; next[4]=-.5; next[5]=.7; text='AI 正在减少闷感'; }
    if(vocal<low-8){ next[5]=.8; next[6]=1.0; next[7]= target==='vocal'?1.3:.6; text='AI 正在增强人声'; }
    if(high>vocal+25){ next[8]=-.6; next[9]=-.9; next[10]=-.8; text='AI 正在柔化高频'; }
    if(target==='immersive'){ next[1]+=0.4; next[2]+=0.3; next[8]+=0.3; }
    if(target==='vocal'){ next[5]+=0.4; next[6]+=0.5; }
  } else if(low>high+28){ next[0]=-1.2; next[1]=-.8; text='收低频'; }
  else if(high>low+35){ next[8]=-.8; next[9]=-1.2; text='柔高频'; }
  const smooth=next.map((v,i)=>state.dynamicEQ[i]*.82+v*.18);
  if(smooth.some((v,i)=>Math.abs(v-state.dynamicEQ[i])>.05)){ state.dynamicEQ=smooth; applyEQ(); }
  $('dynamic-state').textContent=text;
}
function drawSpectrum() {
  if (state.page !== 'studio') return;
  const plot = canvasContext('spectrum'); if (!plot || !state.graph) return;
  const { context: c, width: w, height: h } = plot;
  const { analyser, spectrum, samples } = state.graph;
  analyser.getByteFrequencyData(spectrum); analyser.getFloatTimeDomainData(samples);
  updateDynamicEQ(spectrum, analyser);
  let peak = 0; for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  $('peak-value').textContent = peak < 0.000001 ? '−∞' : (20 * Math.log10(peak)).toFixed(1);
  const maxFreq = Math.min(20000, state.ctx.sampleRate / 2);
  const bars = 88, gap = 3, barWidth = Math.max(1, w / bars - gap);
  c.fillStyle = '#72976a';
  for (let i = 0; i < bars; i++) {
    const low = 32 * Math.pow(maxFreq / 32, i / bars), high = 32 * Math.pow(maxFreq / 32, (i + 1) / bars);
    const from = Math.max(1, Math.floor(low * analyser.fftSize / state.ctx.sampleRate));
    const to = Math.min(spectrum.length - 1, Math.max(from, Math.ceil(high * analyser.fftSize / state.ctx.sampleRate)));
    let value = 0; for (let j = from; j <= to; j++) value = Math.max(value, spectrum[j]);
    const height = value / 255 * (h - 16);
    if (height > 0) c.fillRect(i * w / bars + gap / 2, h - height, barWidth, height);
  }
}
function drawANC() {
  if (state.page !== 'anc') return;
  const frequency = Number($('anc-frequency').value), delay = Number($('anc-delay').value), strength = Number($('anc-strength').value) / 100;
  $('anc-frequency-value').textContent = `${frequency} Hz`; $('anc-delay-value').textContent = `${delay.toFixed(1)} ms`; $('anc-strength-value').textContent = `${Math.round(strength * 100)}%`;
  const phase = 2 * Math.PI * frequency * delay / 1000;
  const residual = Math.sqrt(Math.max(0, 1 + strength * strength - 2 * strength * Math.cos(phase)));
  $('anc-residual').textContent = `${Math.round(residual * 100)}%`;
  $('anc-explanation').textContent = residual < 0.001 ? '此纯音在理想模型中完全抵消。真实环境包含多个频率，并且声学路径随佩戴变化。' : residual < 1 ? `当前残余幅度约为原声的 ${(residual * 100).toFixed(1)}%。这是单频数学结果，不是实测降噪性能。` : `残余幅度达到原声的 ${(residual * 100).toFixed(1)}%，反相信号在此延迟下${residual > 1.01 ? '增强了' : '未减小'}噪声。`;
  const plot = canvasContext('anc-canvas'); if (!plot) return;
  const { context: c, width: w, height: h } = plot;
  const left = 28, right = w - 18, mid = h / 2 - 7;
  c.strokeStyle = '#e7ecdf'; c.lineWidth = 1;
  for (let i = 0; i <= 8; i++) { const x = left + (right - left) * i / 8; c.beginPath(); c.moveTo(x, 15); c.lineTo(x, h - 29); c.stroke(); }
  [-1, 0, 1].forEach(n => { c.beginPath(); c.moveTo(left, mid + n * h / 6); c.lineTo(right, mid + n * h / 6); c.stroke(); });
  const signals = [angle => Math.sin(angle), angle => -strength * Math.sin(angle - phase), angle => Math.sin(angle) - strength * Math.sin(angle - phase)];
  signals.forEach((signal, index) => {
    c.strokeStyle = ['#819690', '#bb9355', '#277c5e'][index]; c.lineWidth = index === 2 ? 2.5 : 1.2;
    c.setLineDash(index === 1 ? [5, 4] : []); c.beginPath();
    for (let x = left; x <= right; x++) { const angle = 2 * Math.PI * frequency * 0.02 * (x - left) / (right - left); const y = mid - signal(angle) * h / 6; if (x === left) c.moveTo(x, y); else c.lineTo(x, y); }
    c.stroke();
  });
  c.setLineDash([]); c.font = '10px Segoe UI'; c.fillStyle = '#93a086'; c.fillText('0 ms', left, h - 10); c.fillText('20 ms', right - 32, h - 10);
}
function frame(now) {
  requestAnimationFrame(frame);
  if (now - state.lastFrame < 65 || document.hidden) return;
  state.lastFrame = now;
  if (!state.ctx) return;
  drawSpectrum();
  const ctx = state.ctx;
  // Browser-provided output estimates only, never label this end-to-end latency.
  const estimates = [ctx.baseLatency, ctx.outputLatency].filter(value => typeof value === 'number' && Number.isFinite(value));
  $('latency').textContent = estimates.length ? `≈ ${(estimates.reduce((a, b) => a + b, 0) * 1000).toFixed(1)} ms` : '浏览器未提供';
  if (state.mic) {
    state.mic.analyser.getFloatTimeDomainData(state.mic.samples);
    let sum = 0; for (const value of state.mic.samples) sum += value * value;
    const rms = Math.sqrt(sum / state.mic.samples.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -90;
    $('mic-level').style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
  }
}
function navigate() {
  const page = location.hash.slice(1);
  state.page = ['studio', 'anc', 'guide'].includes(page) ? page : 'studio';
  document.querySelectorAll('.page').forEach(section => { section.hidden = section.id !== `page-${state.page}`; });
  document.querySelectorAll('[data-page]').forEach(link => {
    const active = link.dataset.page === state.page;
    link.classList.toggle('active', active);
    if (active) { link.setAttribute('aria-current', 'page'); $('page-label').textContent = { studio: '声音工作台', anc: '降噪实验室', guide: '接入与指南' }[state.page]; }
    else link.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0); drawSpectrum(); drawANC();
}

function init() {
  initEQ();
  initEnhancement();
  document.querySelectorAll('input[type=range]').forEach(input => { fillRange(input); input.addEventListener('input', () => fillRange(input)); });
  $('power').addEventListener('click', async () => {
    if (state.ctx?.state === 'running') { stopAll(); return; }
    try { await ensureEngine(); toast('音频引擎就绪。连接音源或播放测试旋律。'); } catch (error) { report(error, '启动引擎失败'); }
  });
  $('stop-all').addEventListener('click', () => stopAll());
  document.addEventListener('keydown', event => { if (event.key === 'Escape') stopAll(); });
  $('master').addEventListener('input', () => {
    $('master-value').innerHTML = `${$('master').value}<span>%</span>`;
    if (state.graph) ramp(state.graph.master.gain, state.muted ? 0 : Number($('master').value) / 100);
  });
  $('mute').addEventListener('click', () => {
    state.muted = !state.muted;
    $('mute').setAttribute('aria-pressed', String(state.muted)); $('mute').textContent = state.muted ? '取消静音' : '静音输出';
    if (state.graph) ramp(state.graph.master.gain, state.muted ? 0 : Number($('master').value) / 100);
    engineUI();
  });
  $('output-device').addEventListener('change', () => changeOutput());
  $('refresh-devices').addEventListener('click', async () => { await refreshDevices(); toast('设备列表已刷新。开启通透并授权后可显示设备名称。'); });
  navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
  $('transparency').addEventListener('change', () => { if ($('transparency').checked) startMic(); else releaseMic(); });
  $('mic-device').addEventListener('change', () => {
    if ($('transparency').checked) startMic();
    else if (state.ancLive || state.ancLivePending) startAncLive();
  });
  $('ambient').addEventListener('input', () => { $('ambient-value').textContent = `${$('ambient').value}%`; if (state.mic) ramp(state.mic.gain.gain, Number($('ambient').value) / 100); });
  $('highpass').addEventListener('input', () => { $('highpass-value').textContent = `${$('highpass').value} Hz`; if (state.mic) ramp(state.mic.hp.frequency, Number($('highpass').value)); });
  $('system-connect').addEventListener('click', () => { if (state.system) releaseSystem(); else startSystem(); });
  $('choose-file').addEventListener('click', () => $('audio-file').click());
  $('audio-file').addEventListener('change', () => { const file = $('audio-file').files[0]; $('audio-file').value = ''; loadFile(file); });
  $('file-play').addEventListener('click', playFile);
  $('test-sound').addEventListener('click', playTest);
  ['anc-frequency', 'anc-delay', 'anc-strength'].forEach(id => $(id).addEventListener('input', drawANC));
  $('anc-live-toggle').addEventListener('click', () => {
    if (state.ancLive || state.ancLivePending) stopAncLive();
    else startAncLive();
  });
  $('anc-tone-toggle').addEventListener('click', toggleAncTone);
  $('anc-live-volume').addEventListener('input', () => {
    $('anc-live-volume-value').textContent = `${$('anc-live-volume').value}%`;
    if (state.ancLive) ramp(state.ancLive.level.gain, Number($('anc-live-volume').value) / 100);
  });
  $('anc-reset').addEventListener('click', () => { $('anc-frequency').value = 200; $('anc-delay').value = 0; $('anc-strength').value = 100; ['anc-frequency', 'anc-delay', 'anc-strength'].forEach(id => fillRange($(id))); drawANC(); });
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!window.isSecureContext || !navigator.mediaDevices) {
    $('compat-banner').hidden = false; $('compat-banner').textContent = '当前环境不支持音频采集权限。请通过 localhost 或 HTTPS 打开，推荐桌面 Chrome / Edge。本地文件试听仍可用于验证音效。';
  }
  if (!AC?.prototype?.setSinkId) {
    $('output-device').disabled = true;
    $('output-hint').textContent = '浏览器不支持设备切换，请在系统中选择耳机。';
  } else $('output-hint').textContent = '授权麦克风后，可刷新并选择具体设备。';
  window.addEventListener('hashchange', navigate);
  window.addEventListener('resize', () => { drawSpectrum(); drawANC(); });
  window.addEventListener('pagehide', () => stopAll(false));
  navigate(); refreshDevices(); engineUI(); requestAnimationFrame(frame);
}
init();
