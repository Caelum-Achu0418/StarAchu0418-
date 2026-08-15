const CACHE='starachu-plume-v2';
const CORE=['./','./index.html','./proactive.js','./manifest.json'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  event.respondWith(
    fetch(req).then(resp=>{
      if(resp&&resp.ok){const copy=resp.clone();caches.open(CACHE).then(cache=>cache.put(req,copy));}
      return resp;
    }).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')))
  );
});
