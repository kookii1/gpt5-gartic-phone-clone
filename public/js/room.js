// room page client logic
const params = parseHash();
const roomId = params.room || '';
const name = params.name || localStorage.getItem('gartic_name') || 'Player';
const isHost = params.host === '1';

document.getElementById('roomLabel').textContent = roomId;
document.getElementById('roomLink').value = location.origin + '/room.html#room=' + roomId;

const roundsInput = document.getElementById('rounds');
const drawTimeInput = document.getElementById('drawTime');
const playersDiv = document.getElementById('players');

socket.emit('join_room', {roomId, name}, (res)=> {
  if(!res || !res.ok) alert('server error joining');
});

socket.on('room_update', (room) => {
  document.getElementById('roomLabel').textContent = room.id;
  const list = Object.values(room.players || {}).map(p=> `<div>${p.name}</div>`).join('');
  playersDiv.innerHTML = list || '(none)';
  if(room.settings) {
    roundsInput.value = room.settings.rounds;
    drawTimeInput.value = room.settings.drawTimeSec;
  }
});

document.getElementById('copyLink').addEventListener('click', ()=> {
  navigator.clipboard.writeText(document.getElementById('roomLink').value).then(()=> alert('copied'));
});

document.getElementById('saveSettings').addEventListener('click', ()=>{
  const s = { rounds: Number(roundsInput.value), drawTimeSec: Number(drawTimeInput.value) };
  socket.emit('update_settings', { roomId, settings: s });
});

document.getElementById('start').addEventListener('click', ()=> {
  socket.emit('start_game', { roomId }, (res)=> {
    if(!res || !res.ok) alert('failed to start');
    else location.href = '/draw.html#room='+roomId+'&name='+encodeURIComponent(name);
  });
});

window.addEventListener('beforeunload', ()=> socket.emit('leave_room'));
