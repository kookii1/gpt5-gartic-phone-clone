const params = parseHash();
const roomId = params.room || '';
const name = params.name || localStorage.getItem('gartic_name') || 'Player';

// For demo we show a placeholder. In a real run, server will provide the drawing (as events or PNG).
socket.emit('request_draw_for_describe', { roomId }, (res)=>{});
socket.on('phase_describe', (data)=>{
  // data.toDescribe[socket.id] contains drawing events
  // For simplicity, display a message:
  document.getElementById('drawingPreview').innerText = 'Drawing received. (In full implementation you will see the drawing here.)';
});

document.getElementById('submit').addEventListener('click', ()=>{
  const text = document.getElementById('desc').value.trim();
  if(!text) return alert('write something');
  socket.emit('submit_description', {roomId, text}, (res)=>{
    if(res && res.ok) location.href = '/after.html#room='+roomId;
  });
});
