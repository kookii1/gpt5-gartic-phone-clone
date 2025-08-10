// room page client logic
const params = parseHash();
const roomId = params.room || '';
const name = params.name || localStorage.getItem('gartic_name') || 'Player';
let amHost = false;

document.getElementById('roomLabel').textContent = roomId;
updateRoomLink(roomId);

const roundsInput = document.getElementById('rounds');
const drawTimeInput = document.getElementById('drawTime');
const playersDiv = document.getElementById('players');
const startBtn = document.getElementById('start');
const saveBtn = document.getElementById('saveSettings');
const hostNote = document.getElementById('hostNote');

if(!roomId){
  alert('Missing room id.');
}

socket.emit('join_room', {roomId, name}, (res)=> {
  if(!res || !res.ok){
    alert('Could not join room (maybe it was not created yet).');
  }
});

socket.on('room_update', (room) => {
  if(!room) return;
  document.getElementById('roomLabel').textContent = room.id;
  updateRoomLink(room.id);
  const list = Object.values(room.players || {}).map(p=> `<div>${p.name}${p.id===room.hostId?' (Host)':''}</div>`).join('');
  playersDiv.innerHTML = list || '(none)';
  amHost = room.hostId === socket.id;
  applyHostState(amHost);
  if(room.settings) {
    roundsInput.value = room.settings.rounds;
    drawTimeInput.value = room.settings.drawTimeSec;
  }
});

function updateRoomLink(id){
  // include name param so friend can set their name quickly (they can edit after landing)
  const link = location.origin + '/room.html#room=' + encodeURIComponent(id);
  document.getElementById('roomLink').value = link;
}

function applyHostState(isHost){
  roundsInput.disabled = !isHost;
  drawTimeInput.disabled = !isHost;
  saveBtn.disabled = !isHost;
  startBtn.disabled = !isHost;
  hostNote.style.display = isHost ? 'none' : 'block';
}

document.getElementById('copyLink').addEventListener('click', ()=> {
  const input = document.getElementById('roomLink');
  const text = input.value;
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(text).then(()=> alert('Link copied'));
  } else {
    input.select();
    try {
      document.execCommand('copy');
      alert('Link copied');
    } catch(e){
      prompt('Copy the link manually:', text);
    }
    input.blur();
  }
});

document.getElementById('saveSettings').addEventListener('click', ()=> {
  if(!amHost) return;
  const s = { rounds: Number(roundsInput.value), drawTimeSec: Number(drawTimeInput.value) };
  socket.emit('update_settings', { roomId, settings: s });
});

document.getElementById('start').addEventListener('click', ()=> {
  if(!amHost){
    alert('Only host can start.');
    return;
  }
  socket.emit('start_game', { roomId }, (res)=> {
    if(!res || !res.ok){
      alert('Failed to start: '+ (res && res.err ? res.err : 'unknown'));
    }else{
      location.href = '/draw.html#room='+encodeURIComponent(roomId)+'&name='+encodeURIComponent(name);
    }
  });
});

window.addEventListener('beforeunload', ()=> socket.emit('leave_room'));
