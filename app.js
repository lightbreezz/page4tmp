const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let key, manifest, position = 0, session = 0, busy = false, timer, playing = false, previousEffect = -1;
const cache = new Map();
const encoder = new TextEncoder();
const effects = [
  { name: '轻轻淡入', frames: () => [{ opacity: 0 }, { opacity: 1 }] },
  { name: '时光滑过', frames: d => [{ transform: `translateX(${d * 100}%)` }, { transform: 'translateX(0)' }] },
  { name: '缓缓靠近', frames: () => [{ transform: 'scale(1.16)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }] },
  { name: '翻开一页', frames: d => [{ transform: `rotateY(${d * 75}deg)`, opacity: 0, transformOrigin: d > 0 ? 'left center' : 'right center' }, { transform: 'rotateY(0deg)', opacity: 1 }] },
  { name: '光影展开', frames: d => [{ clipPath: `inset(0 ${d > 0 ? '100% 0 0' : '0 0 100%'})` }, { clipPath: 'inset(0 0 0 0)' }] },
  { name: '记忆浮现', frames: () => [{ filter: 'blur(14px)', transform: 'translateY(25px)', opacity: 0 }, { filter: 'blur(0px)', transform: 'translateY(0)', opacity: 1 }] }
];
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
$('autoplay').onclick = () => { if (playing) stopPlaying(); else { playing = true; $('autoplay').textContent = 'Ⅱ 暂停播放'; $('autoplay').setAttribute('aria-pressed', 'true'); schedule(); } };
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlaying(); });
window.addEventListener('pagehide', lock);
document.addEventListener('keydown', event => { if ($('album').hidden) return; if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); navigate(event.key === 'ArrowRight' ? 1 : -1); } if (event.key === 'Escape' && !document.fullscreenElement) lock(); });
let pointer;
$('stage').addEventListener('pointerdown', event => { if (event.isPrimary) pointer = { x: event.clientX, y: event.clientY, id: event.pointerId }; });
$('stage').addEventListener('pointerup', event => { if (!pointer || event.pointerId !== pointer.id) return; const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y; pointer = undefined; if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) navigate(dx < 0 ? 1 : -1); });
$('stage').addEventListener('pointercancel', () => { pointer = undefined; });
$('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('stage').requestFullscreen) await $('stage').requestFullscreen(); else $('stage').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'center' }); } catch {} };
if (!$('stage').requestFullscreen) $('fullscreen').textContent = '聚焦相片 ↗';
