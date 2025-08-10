// client common helpers
const socket = io();

// small URL helpers
function parseHash(){
  const h = location.hash.slice(1);
  const obj = {};
  if(!h) return obj;
  h.split('&').forEach(kv=>{
    const [k,v]=''+kv.split('=');
    if(!k) return;
    obj[k] = decodeURIComponent(v||'');
  });
  return obj;
}
