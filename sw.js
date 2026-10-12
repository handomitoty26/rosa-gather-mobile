const CACHE='rosa-gather-mobile-v202';
// 이 앱의 옛 캐시만 지운다(같은 주소의 기숙사 앱 캐시는 건드리지 않음): 지금 이름이 아니고 'rosa-gather-mobile-v' 바로 뒤가 숫자
const OWN='rosa-gather-mobile-v';
const isOwnOldCache=k=>k!==CACHE&&k.startsWith(OWN)&&/^[0-9]/.test(k.slice(OWN.length));
const ASSETS=['./','./index.html','./styles.css?v=202','./app.js?v=202','./manifest.webmanifest','./icon.svg','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(isOwnOldCache).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==location.origin)return;
  if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(c=>c.put('./index.html',copy));return response}).catch(()=>caches.match('./index.html')));return;}
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));return response}).catch(()=>caches.match('./index.html'))));
});
