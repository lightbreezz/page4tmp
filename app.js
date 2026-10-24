const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let key, manifest, position = 0, session = 0, busy = false, timer, playing = false, previousEffect = -1;
const cache = new Map();
const encoder = new TextEncoder();
let cameraStream, gestureRecognizer, visionLoop, lastVideoTime = -1, lastDetectionAt = 0, gestureCandidate = '', gestureApplied = false, gestureLastLogged = '', gestureSamples = [], videoReadyLogged = false, heartPhotos = [], mosaicShape = 'heart', heartAnimating = false;
const heartMosaic = $('heart-mosaic');
const shapeNames = ['heart', 'circle', 'star', 'flower', 'diamond', 'moon'];
const shapeLabels = { heart: '爱心', circle: '圆形', star: '五角星', flower: '六瓣花', diamond: '菱形', moon: '月牙' };
let configuredShapes = ['heart'];
function randomConfiguredShape() { return configuredShapes[Math.floor(Math.random() * configuredShapes.length)] || 'heart'; }
const effects = [
  { name: '轻轻淡入', frames: () => [{ opacity: 0 }, { opacity: 1 }] },
  { name: '时光滑过', frames: d => [{ transform: `translateX(${d * 100}%)` }, { transform: 'translateX(0)' }] },
  { name: '缓缓靠近', frames: () => [{ transform: 'scale(1.16)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }] },
  { name: '翻开一页', frames: d => [{ transform: `rotateY(${d * 75}deg)`, opacity: 0, transformOrigin: d > 0 ? 'left center' : 'right center' }, { transform: 'rotateY(0deg)', opacity: 1 }] },
  { name: '光影展开', frames: d => [{ clipPath: `inset(0 ${d > 0 ? '100% 0 0' : '0 0 100%'})` }, { clipPath: 'inset(0 0 0 0)' }] },
  { name: '记忆浮现', frames: () => [{ filter: 'blur(14px)', transform: 'translateY(25px)', opacity: 0 }, { filter: 'blur(0px)', transform: 'translateY(0)', opacity: 1 }] }
];
function setGestureStatus(message) { $('gesture-state').textContent = message; }
function gestureLog(level, message, details) {
  const prefix = `[手势 ${new Date().toLocaleTimeString()}] ${message}`;
  if (details === undefined) console[level](prefix); else console[level](prefix, details);
}
function resetScatter() {
  mosaicShape = 'heart'; heartAnimating = false;
  heartMosaic.querySelectorAll('.heart-tile').forEach(tile => tile.getAnimations().forEach(animation => animation.cancel()));
  heartMosaic.replaceChildren(); heartMosaic.hidden = true;
  const current = $('mount').querySelector('.photo'); if (current) current.style.opacity = '';
}
function selectGridPoints(points, count, rows) {
  if (points.length <= count) return points;
  const groups = Array.from({ length: rows }, (_, row) => points.filter(point => point.row === row));
  const exact = groups.map(group => group.length * count / points.length);
  const amounts = exact.map(Math.floor);
  const remaining = count - amounts.reduce((sum, value) => sum + value, 0);
  exact.map((value, row) => ({ row, fraction: value - amounts[row] })).sort((a, b) => b.fraction - a.fraction).slice(0, remaining).forEach(({ row }) => amounts[row]++);
  return groups.flatMap((group, row) => {
    const amount = amounts[row];
    if (!amount) return [];
    if (amount >= group.length) return group;
    if (amount === 1) return [group[Math.floor((group.length - 1) / 2)]];
    return Array.from({ length: amount }, (_, i) => group[Math.round(i * (group.length - 1) / (amount - 1))]);
  });
}
function shapeGrid(count, shape = 'star', fillAll = false) {
  const shapes = {
    circle: (x, y) => x * x + y * y <= 1,
    heart: (x, y) => (x * x + y * y - 1) ** 3 - x * x * y ** 3 <= 0,
    star: (x, y) => Math.hypot(x, y) <= .7 + .3 * Math.cos(5 * (Math.atan2(y, x) - Math.PI / 2)),
    flower: (x, y) => Math.hypot(x, y) <= .72 + .23 * Math.cos(6 * Math.atan2(y, x)),
    diamond: (x, y) => Math.abs(x) + Math.abs(y) <= 1.2,
    moon: (x, y) => (x + .12) ** 2 + y * y <= .92 ** 2 && (x - .27) ** 2 + (y - .09) ** 2 > .77 ** 2
  };
  const inside = shapes[shape] || shapes.circle;
  let cols = 10, rows = 10, points = [];
  do {
    points = [];
    for (let row = 0; row < rows; row++) {
      const y = 1.1 - row * 2.2 / (rows - 1);
      for (let col = 0; col < cols; col++) {
        const x = -1.1 + col * 2.2 / (cols - 1);
        if (inside(x, y)) points.push({ col, row });
      }
    }
    if (points.length < count) { cols++; rows++; }
  } while (points.length < count);
  return { cols, rows, points: fillAll ? points : selectGridPoints(points, count, rows) };
}
function mosaicLayout(shape, count, stage, fillAll = false) {
  const grid = shapeGrid(count, shape, fillAll);
  const tileSize = Math.min((stage.width - 24) / grid.cols, (stage.height - 24) / grid.rows);
  const offsetX = (stage.width - grid.cols * tileSize) / 2, offsetY = (stage.height - grid.rows * tileSize) / 2;
  const positions = grid.points.map(({ col, row }) => ({ x: offsetX + col * tileSize + tileSize * .05, y: offsetY + row * tileSize + tileSize * .05 }));
  return { ...grid, tileSize, positions };
}
async function createHeartThumbnail(index, token, canvas, context) {
  const photo = manifest.photos[index];
  const bytes = await decrypt(await fetchBytes(`./assets/${photo.file}`), key);
  if (token !== session) throw new Error('STALE');
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
  const size = 112, scale = Math.max(size / bitmap.width, size / bitmap.height);
  const cropWidth = size / scale, cropHeight = size / scale;
  context.clearRect(0, 0, size, size);
  context.drawImage(bitmap, (bitmap.width - cropWidth) / 2, (bitmap.height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, size, size);
  bitmap.close();
  const thumbnail = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('THUMBNAIL')), 'image/webp', .76));
  const url = URL.createObjectURL(thumbnail), image = new Image();
  image.src = url; await image.decode();
  return { url, image, title: photo.title };
}
async function prepareHeartMosaic(token) {
  if (heartPhotos.length !== manifest.photos.length) {
    heartPhotos.forEach(photo => URL.revokeObjectURL(photo.url)); heartPhotos = [];
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 112;
    const context = canvas.getContext('2d', { alpha: false });
    for (let index = 0; index < manifest.photos.length; index++) {
      setGestureStatus(`正在准备全部照片 ${index + 1}/${manifest.photos.length}`);
      heartPhotos.push(await createHeartThumbnail(index, token, canvas, context));
      if ((index + 1) % 10 === 0 || index + 1 === manifest.photos.length) gestureLog('info', '已准备相册缩略图', { ready: index + 1, total: manifest.photos.length });
    }
  }
  const minimumTiles = Math.max(120, heartPhotos.length * 3);
  mosaicShape = configuredShapes[Math.floor(Math.random() * configuredShapes.length)];
  const stage = $('stage').getBoundingClientRect(), layout = mosaicLayout(mosaicShape, minimumTiles, stage, true);
  heartMosaic.replaceChildren();
  const photoElements = [];
  for (const [index, point] of layout.points.entries()) {
    const photo = heartPhotos[index % heartPhotos.length], tile = new Image();
    tile.className = 'heart-tile'; tile.alt = photo.title; tile.draggable = false; tile.src = photo.url;
    const { x: homeX, y: homeY } = layout.positions[index];
    Object.assign(tile.style, { width: `${layout.tileSize * .98}px`, height: `${layout.tileSize * .98}px`, left: `${homeX}px`, top: `${homeY}px` });
    tile.dataset.homeX = homeX; tile.dataset.homeY = homeY;
    tile.dataset.tileIndex = index;
    tile.style.transform = 'rotate(0deg)';
    tile.dataset.x = homeX; tile.dataset.y = homeY; tile.dataset.angle = 0;
    heartMosaic.append(tile); photoElements.push(tile);
  }
  heartMosaic.hidden = false;
  const current = $('mount').querySelector('.photo'); if (current) current.style.opacity = '0';
  gestureLog('info', `全部照片已排成${shapeLabels[mosaicShape]}`, { uniquePhotos: heartPhotos.length, tiles: photoElements.length, repeatsPerPhoto: Math.ceil(photoElements.length / heartPhotos.length), shape: mosaicShape, grid: `${layout.cols}x${layout.rows}` });
}
async function animateShape(targetShape) {
  if (busy || heartMosaic.hidden || !heartMosaic.childElementCount) { gestureLog('warn', '照片队形尚未就绪', { busy, mosaicVisible: !heartMosaic.hidden, tiles: heartMosaic.childElementCount }); return; }
  if (heartAnimating) { gestureLog('info', '照片队形仍在变化'); return; }
  if (mosaicShape === targetShape) {
    heartMosaic.animate([{ transform: 'scale(.985)' }, { transform: 'scale(1.025)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' });
    gestureLog('info', `照片已经是${shapeLabels[targetShape]}，已给出反馈`); return;
  }
  heartAnimating = true; mosaicShape = targetShape;
  gestureLog('info', `全部照片重排为${shapeLabels[targetShape] || targetShape}`, { tiles: heartMosaic.childElementCount });
  const stage = $('stage').getBoundingClientRect();
  const layout = mosaicLayout(targetShape, heartMosaic.childElementCount, stage);
  const animations = [...heartMosaic.children].map(tile => {
    const fromX = Number(tile.dataset.x), fromY = Number(tile.dataset.y), fromAngle = Number(tile.dataset.angle);
    const target = layout.positions[Number(tile.dataset.tileIndex)];
    const toX = target.x, toY = target.y, toAngle = 0;
    const animation = tile.animate([{ left: `${fromX}px`, top: `${fromY}px`, transform: `rotate(${fromAngle}deg)` }, { left: `${toX}px`, top: `${toY}px`, transform: `rotate(${toAngle}deg)` }], { duration: reducedMotion.matches ? 1 : 900, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
    return { tile, animation, toX, toY, toAngle };
  });
  await Promise.all(animations.map(item => item.animation.finished.catch(() => {})));
  for (const { tile, animation, toX, toY, toAngle } of animations) {
    tile.style.left = `${toX}px`; tile.style.top = `${toY}px`; tile.style.transform = `rotate(${toAngle}deg)`;
    tile.dataset.x = toX; tile.dataset.y = toY; tile.dataset.angle = toAngle; animation.cancel();
  }
  heartAnimating = false;
}
async function startGesture() {
  gestureLog('info', '收到手势操控按钮点击', { cameraAlreadyOn: !!cameraStream, secureContext: isSecureContext, origin: location.origin });
  if (cameraStream) { stopGesture('user-toggled-off'); return; }
  if (!navigator.mediaDevices?.getUserMedia || !isSecureContext) {
    gestureLog('error', '浏览器不支持摄像头，或页面不是安全来源', { mediaDevices: !!navigator.mediaDevices, getUserMedia: !!navigator.mediaDevices?.getUserMedia, secureContext: isSecureContext });
    setGestureStatus('请使用 HTTPS 网页'); return;
  }
  const button = $('gesture-toggle'); button.disabled = true; setGestureStatus('正在开启相机…');
  try {
    gestureLog('info', '请求摄像头权限', { facingMode: 'user', audio: false, width: 640, height: 480 });
    cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
    const videoTrack = cameraStream.getVideoTracks()[0];
    gestureLog('info', '摄像头权限已获准', { trackState: videoTrack?.readyState, settings: videoTrack?.getSettings?.() });
    const video = $('camera-preview'); video.srcObject = cameraStream; video.hidden = false; await video.play(); setGestureStatus('正在加载手势识别…');
    gestureLog('info', '相机预览已播放', { readyState: video.readyState, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
    const moduleUrl = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs';
    gestureLog('info', '开始加载 MediaPipe 模块', { url: moduleUrl });
    const { FilesetResolver, GestureRecognizer } = await import(moduleUrl);
    gestureLog('info', 'MediaPipe 模块加载完成', { filesetResolver: !!FilesetResolver, gestureRecognizer: !!GestureRecognizer });
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm');
    gestureLog('info', 'MediaPipe WASM 资源已就绪');
    const options = { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task' }, runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: .55, minHandPresenceConfidence: .55, minTrackingConfidence: .55 };
    try {
      gestureRecognizer = await GestureRecognizer.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
      gestureLog('info', '手势分类模型已就绪', { delegate: 'GPU', modelUrl: options.baseOptions.modelAssetPath });
    } catch (gpuError) {
      gestureLog('warn', 'GPU 初始化失败，改用 CPU', gpuError);
      gestureRecognizer = await GestureRecognizer.createFromOptions(vision, options);
      gestureLog('info', '手势分类模型已就绪', { delegate: 'CPU', modelUrl: options.baseOptions.modelAssetPath });
    }
    await prepareHeartMosaic(session);
    button.classList.add('active'); $('gesture-title').textContent = '关闭手势操控'; setGestureStatus('等待手势');
    lastVideoTime = -1; gestureCandidate = ''; gestureApplied = false; gestureLastLogged = ''; gestureSamples = []; videoReadyLogged = false;
    gestureLog('info', '识别循环已启动，张掌随机聚成配置形状，握拳排圆形', { configuredShapes }); visionLoop = requestAnimationFrame(detectGesture);
  } catch (error) {
    gestureLog('error', '手势初始化失败', { name: error.name, message: error.message, error });
    stopGesture('startup-error'); setGestureStatus(error.name === 'NotAllowedError' ? '请允许使用摄像头' : '相机或识别模型无法启动');
  }
  finally { button.disabled = false; }
}
function detectGesture(now) {
  if (!cameraStream || !gestureRecognizer) return;
  const video = $('camera-preview');
  if (video.readyState < 2 && !videoReadyLogged) { videoReadyLogged = true; gestureLog('warn', '相机尚未输出视频帧', { readyState: video.readyState, videoWidth: video.videoWidth, videoHeight: video.videoHeight }); }
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastDetectionAt > 100) {
    if (videoReadyLogged) { videoReadyLogged = false; gestureLog('info', '相机视频帧已就绪'); }
    lastDetectionAt = now;
    try {
      lastVideoTime = video.currentTime; const result = gestureRecognizer.recognizeForVideo(video, now);
      const best = result.gestures?.[0]?.[0], category = best?.categoryName || '', score = best?.score || 0;
      const rawPose = score >= .3 && /open.?palm/i.test(category) ? 'open' : score >= .3 && /closed.?fist/i.test(category) ? 'fist' : '';
      gestureSamples.push(rawPose); if (gestureSamples.length > 3) gestureSamples.shift();
      let nextPose = gestureCandidate;
      if (gestureSamples.filter(sample => sample === 'open').length >= 2) nextPose = 'open';
      else if (gestureSamples.filter(sample => sample === 'fist').length >= 2) nextPose = 'fist';
      if (nextPose !== gestureCandidate) { gestureCandidate = nextPose; gestureApplied = false; }
      if (gestureCandidate !== gestureLastLogged) {
        gestureLastLogged = gestureCandidate;
        gestureLog('info', gestureCandidate ? '识别到手势' : result.landmarks?.length ? '手在画面内，等待张掌或握拳' : '当前画面未检测到手', { classification: gestureCandidate || 'none/unclear', rawCategory: category || 'none', confidence: Number(score.toFixed(2)), handCount: result.landmarks?.length || 0, confirmation: `${gestureSamples.filter(sample => sample === gestureCandidate).length}/3`, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
      }
      setGestureStatus(gestureCandidate === 'open' ? '稳定识别：张开手掌' : gestureCandidate === 'fist' ? '稳定识别：握拳' : result.landmarks?.length ? `${category || '手势'} ${Math.round(score * 100)}% · 稳定识别中` : '请把手放入画面');
      if (gestureCandidate && !gestureApplied) {
        gestureApplied = true;
        const targetShape = gestureCandidate === 'open' ? randomConfiguredShape() : 'circle';
        gestureLog('info', gestureCandidate === 'open' ? `张掌，随机选择${shapeLabels[targetShape]}队形` : '握拳，执行全部照片排成圆形');
        animateShape(targetShape);
      }
    } catch (error) {
      gestureLog('error', '视频帧识别失败，停止手势操控', error);
      stopGesture('inference-error'); setGestureStatus('手势识别出错，请查看控制台'); return;
    }
  }
  visionLoop = requestAnimationFrame(detectGesture);
}
function stopGesture(reason = 'unspecified') {
  gestureLog('info', '停止手势操控', { reason, cameraWasOn: !!cameraStream, modelWasReady: !!gestureRecognizer });
  if (visionLoop) cancelAnimationFrame(visionLoop); visionLoop = undefined;
  if (cameraStream) cameraStream.getTracks().forEach(track => track.stop()); cameraStream = undefined;
  if (gestureRecognizer) gestureRecognizer.close(); gestureRecognizer = undefined;
  const video = $('camera-preview'); video.pause(); video.srcObject = null; video.hidden = true;
  $('gesture-toggle').classList.remove('active'); $('gesture-title').textContent = '开启手势操控'; setGestureStatus('相机未开启'); gestureCandidate = ''; gestureApplied = false; gestureLastLogged = ''; gestureSamples = []; resetScatter();
}
async function fetchBytes(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('FETCH');
  return response.arrayBuffer();
}
async function decrypt(bytes, activeKey) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, activeKey, bytes.slice(12));
}
async function photoUrl(index, token) {
  if (cache.has(index)) return cache.get(index);
  const activeKey = key;
  const photo = manifest.photos[index];
  const promise = (async () => {
    const data = await decrypt(await fetchBytes(`./assets/${photo.file}`), activeKey);
    if (token !== session) throw new Error('STALE');
    return URL.createObjectURL(new Blob([data], { type: 'image/webp' }));
  })();
  cache.set(index, promise);
  try { return await promise; } catch (error) { if (cache.get(index) === promise) cache.delete(index); throw error; }
}
function trimCache(index) {
  const count = manifest.photos.length;
  const keep = new Set([index, (index + 1) % count, (index - 1 + count) % count]);
  for (const [i, promise] of cache) if (!keep.has(i)) { cache.delete(i); promise.then(url => URL.revokeObjectURL(url)).catch(() => {}); }
}
async function showPhoto(index, direction = 1, animate = true) {
  if (busy || !manifest) return;
  busy = true;
  const token = session;
  $('stage').setAttribute('aria-busy', 'true');
  $('retry').hidden = true;
  $('photo-status').textContent = '正在翻开这一页…';
  try {
    const url = await photoUrl(index, token);
    const image = new Image(); image.className = 'photo'; image.draggable = false;
    image.alt = manifest.photos[index].title; image.src = url;
    await image.decode();
    if (token !== session) return;
    resetScatter();
    const old = [...$('mount').children];
    $('mount').append(image);
    position = index;
    const photo = manifest.photos[index];
    $('photo-title').textContent = photo.title;
    $('photo-number').textContent = `MEMORY ${String(index + 1).padStart(2, '0')}`;
    $('counter').textContent = `${String(index + 1).padStart(2, '0')} / ${String(manifest.photos.length).padStart(2, '0')}`;
    $('progress-fill').style.width = `${(index + 1) / manifest.photos.length * 100}%`;
    $('photo-status').textContent = '';
    let choice;
    do { choice = Math.floor(Math.random() * effects.length); } while (choice === previousEffect);
    previousEffect = choice;
    const effect = effects[choice];
    $('effect-label').textContent = effect.name;
    if (animate && !reducedMotion.matches) await image.animate(effect.frames(direction), { duration: 680, easing: 'cubic-bezier(.22,.61,.36,1)' }).finished.catch(() => {});
    old.forEach(node => node.remove());
    if (token !== session) return;
    trimCache(index);
    photoUrl((index + 1) % manifest.photos.length, token).catch(() => {});
  } catch (error) {
    if (token === session) { $('photo-status').textContent = '这一页未能加载，请检查网络后重试'; $('retry').hidden = false; $('retry').onclick = () => showPhoto(index, direction, animate); stopPlaying(); }
  } finally {
    if (token === session) { busy = false; $('stage').setAttribute('aria-busy', 'false'); }
  }
}
function navigate(direction) {
  if (!manifest || busy) return;
  return showPhoto((position + direction + manifest.photos.length) % manifest.photos.length, direction);
}
function stopPlaying() { clearTimeout(timer); playing = false; $('autoplay').textContent = '▷ 自动播放'; $('autoplay').setAttribute('aria-pressed', 'false'); }
function schedule() { timer = setTimeout(async () => { if (!playing) return; await navigate(1); if (playing) schedule(); }, 5000); }
function lock() {
  stopGesture('album-locked');
  heartPhotos.forEach(photo => URL.revokeObjectURL(photo.url)); heartPhotos = [];
  session++; stopPlaying(); key = undefined; manifest = undefined; busy = false; position = 0;
  for (const value of cache.values()) value.then(url => URL.revokeObjectURL(url)).catch(() => {});
  cache.clear(); $('mount').replaceChildren(); $('album').hidden = true; $('login').hidden = false;
  $('password').value = ''; $('password').type = 'password'; $('reveal').textContent = '显示'; $('reveal').setAttribute('aria-label', '显示密码'); $('login-status').textContent = ''; $('password').focus();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('unlock').disabled = true; $('login-status').textContent = '正在打开珍藏的时光…';
  let phase = 'network';
  try {
    if (!crypto.subtle) throw new Error('HTTPS');
    const [configBytes, albumBytes] = await Promise.all([fetchBytes('./config.json'), fetchBytes('./album.bin')]);
    const config = JSON.parse(new TextDecoder().decode(configBytes));
    const requestedShapes = Array.isArray(config.gestureShapes) ? config.gestureShapes : ['heart'];
    configuredShapes = [...new Set(requestedShapes.filter(shape => shapeNames.includes(shape)))];
    if (!configuredShapes.length) configuredShapes = ['heart'];
    const material = await crypto.subtle.importKey('raw', encoder.encode($('password').value), 'PBKDF2', false, ['deriveKey']);
    const candidate = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: Uint8Array.from(atob(config.salt), ch => ch.charCodeAt(0)), iterations: config.iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    phase = 'password';
    const album = JSON.parse(new TextDecoder().decode(await decrypt(albumBytes, candidate)));
    key = candidate; manifest = album; session++; $('password').value = '';
    document.title = album.title; $('album-title').textContent = album.title;
    $('login').hidden = true; $('album').hidden = false; $('login-status').textContent = '';
    await showPhoto(0, 1, false); $('stage').focus({ preventScroll: true });
  } catch (error) {
    $('login-status').textContent = error.message === 'HTTPS' ? '请通过 HTTPS 或本机 localhost 打开相册。' : phase === 'password' ? '密码不正确，请再试一次。' : '相册暂时无法加载，请检查网络后重试。';
  } finally { $('unlock').disabled = false; }
});
$('reveal').onclick = () => { const reveal = $('password').type === 'password'; $('password').type = reveal ? 'text' : 'password'; $('reveal').textContent = reveal ? '隐藏' : '显示'; $('reveal').setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码'); };
$('previous').onclick = () => navigate(-1); $('next').onclick = () => navigate(1); $('lock').onclick = lock;
$('gesture-toggle').onclick = startGesture;
$('autoplay').onclick = () => { if (playing) stopPlaying(); else { playing = true; $('autoplay').textContent = 'Ⅱ 暂停播放'; $('autoplay').setAttribute('aria-pressed', 'true'); schedule(); } };
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPlaying(); if (cameraStream) stopGesture('page-hidden'); } });
window.addEventListener('pagehide', lock);
document.addEventListener('keydown', event => { if ($('album').hidden) return; if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); navigate(event.key === 'ArrowRight' ? 1 : -1); } if (event.key === 'Escape' && !document.fullscreenElement) lock(); });
let pointer;
$('stage').addEventListener('pointerdown', event => { if (event.isPrimary) pointer = { x: event.clientX, y: event.clientY, id: event.pointerId }; });
$('stage').addEventListener('pointerup', event => { if (!pointer || event.pointerId !== pointer.id) return; const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y; pointer = undefined; if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) navigate(dx < 0 ? 1 : -1); });
$('stage').addEventListener('pointercancel', () => { pointer = undefined; });
$('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('stage').requestFullscreen) await $('stage').requestFullscreen(); else $('stage').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'center' }); } catch {} };
if (!$('stage').requestFullscreen) $('fullscreen').textContent = '聚焦相片 ↗';
