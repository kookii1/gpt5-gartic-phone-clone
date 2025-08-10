// Simple game + signaling server for Gartic-like (classic mode)
// Run: npm install && node index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// serve static public folder
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const rooms = {}; // roomId -> { id, hostId, players: {sockId: {name, id}}, settings, gameState }

function makeRoom() {
  return nanoid(7);
}

function ensureRoom(roomId){
  if(!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      hostId: null,
      players: {},
      // default settings:
      settings: { rounds: 3, drawTimeSec: 60 },
      // game state for classic mode:
      game: {
        started: false,
        phase: null,
        roundIndex: 0,
        // sequence: array of chains per player (each chain entry will be {type:'prompt'|'drawing'|'description', data:...})
        sequences: {} // playerId -> [stageObj,...]
      }
    };
  }
  return rooms[roomId];
}

io.on('connection', socket => {
  console.log('conn', socket.id);

  socket.on('create_room', ({name}, cb) => {
    const id = makeRoom();
    ensureRoom(id);
    socket.join(id);
    const r = rooms[id];
    r.hostId = socket.id;
    r.players[socket.id] = { name: name || 'Player', id: socket.id };
    socket.data.roomId = id;
    socket.data.name = name;
    io.to(id).emit('room_update', r);
    cb && cb({ok:true,roomId:id});
  });

  socket.on('join_room', ({roomId, name}, cb) => {
    if(!rooms[roomId]) return cb && cb({ok:false,err:'no room'});
    socket.join(roomId);
    const r = rooms[roomId];
    r.players[socket.id] = { name: name || 'Player', id: socket.id };
    socket.data.roomId = roomId;
    socket.data.name = name;
    if(!r.hostId) r.hostId = socket.id;
    io.to(roomId).emit('room_update', r);
    cb && cb({ok:true, roomId});
  });

  socket.on('leave_room', () => {
    const roomId = socket.data.roomId;
    if(!roomId) return;
    const r = rooms[roomId];
    if(r){
      delete r.players[socket.id];
      if(r.hostId === socket.id){
        r.hostId = Object.keys(r.players)[0] || null;
      }
      io.to(roomId).emit('room_update', r);
    }
    socket.leave(roomId);
    delete socket.data.roomId;
  });

  socket.on('update_settings', ({roomId, settings}) => {
    if(!rooms[roomId]) return;
    const r = rooms[roomId];
    if(socket.id !== r.hostId) return;
    r.settings = Object.assign(r.settings, settings);
    io.to(roomId).emit('room_update', r);
  });

  // host starts classic game
  socket.on('start_game', ({roomId}, cb) => {
    const r = rooms[roomId];
    if(!r) return cb && cb({ok:false, err:'no room'});
    if(socket.id !== r.hostId) return cb && cb({ok:false, err:'not host'});
    if(r.game.started) return cb && cb({ok:false, err:'already started'});
    r.game.started = true;
    r.game.phase = 'collect_prompts';
    r.game.roundIndex = 0;
    r.game.sequences = {};
    Object.values(r.players).forEach(p => {
      r.game.sequences[p.id] = [{ type:'prompt', from: p.id, data: null }];
    });
    io.to(roomId).emit('game_started', {settings: r.settings});
    io.to(roomId).emit('game_phase', r.game);
    cb && cb({ok:true});
  });

  // a player submits their initial prompt
  socket.on('submit_prompt', ({roomId, prompt}, cb) => {
    const r = rooms[roomId]; if(!r) return cb && cb({ok:false,err:'no room'});
    if(r.game.phase !== 'collect_prompts') return cb && cb({ok:false,err:'bad phase'});
    if(!r.game.sequences[socket.id]) return cb && cb({ok:false,err:'no seq'});
    r.game.sequences[socket.id][0].data = prompt;
    const all = Object.keys(r.players).every(pid => r.game.sequences[pid][0].data);
    if(all){
      r.game.phase = 'drawing';
      r.game.roundIndex = 0;
      const ids = Object.keys(r.players);
      const n = ids.length;
      const mapping = {};
      ids.forEach((pid, i) => {
        const from = ids[(i+1)%n];
        mapping[pid] = { prompt: r.game.sequences[from][0].data, fromName: r.players[from].name, fromId: from };
      });
      r.game.currentTargets = mapping;
      io.to(roomId).emit('phase_drawing', { mapping, settings: r.settings });
      startRoundTimer(roomId);
    }
    cb && cb({ok:true});
  });

  socket.on('drawing_event', ({roomId, targetId, ev}) => {
    io.to(targetId).emit('drawing_event', {from: socket.id, ev});
    const r = rooms[roomId]; if(!r) return;
    r.game.savedDrawings = r.game.savedDrawings || {};
    if(!r.game.savedDrawings[targetId]) r.game.savedDrawings[targetId] = [];
    if(ev.type === 'stroke_end' || ev.type === 'bucket' || ev.type === 'clear'){
      r.game.savedDrawings[targetId].push(ev);
    }
  });

  socket.on('finish_drawing', ({roomId}, cb) => {
    const r = rooms[roomId]; if(!r) return cb && cb({ok:false,err:'no room'});
    r.game.done = r.game.done || {};
    r.game.done[socket.id] = true;
    const allDone = Object.keys(r.players).every(pid => r.game.done[pid]);
    if(allDone){
      r.game.phase = 'describe';
      r.game.done = {};
      r.game.toDescribe = {};
      Object.keys(r.players).forEach(pid => {
        r.game.toDescribe[pid] = r.game.savedDrawings && r.game.savedDrawings[pid] ? r.game.savedDrawings[pid] : [];
      });
      io.to(roomId).emit('phase_describe', { toDescribe: r.game.toDescribe });
    }
    cb && cb({ok:true});
  });

  socket.on('submit_description', ({roomId, text}, cb) => {
    const r = rooms[roomId]; if(!r) return cb && cb({ok:false,err:'no room'});
    r.game.descriptions = r.game.descriptions || {};
    r.game.descriptions[socket.id] = text;
    const all = Object.keys(r.players).every(pid => r.game.descriptions && r.game.descriptions[pid]);
    if(all){
      r.game.phase = 'reveal';
      const reveal = {};
      Object.keys(r.players).forEach(pid => {
        const prompt = r.game.sequences[pid][0].data;
        let drawingOwner = null;
        if(r.game.currentTargets){
          for(const rec in r.game.currentTargets){
            if(r.game.currentTargets[rec].prompt === prompt){
              drawingOwner = rec; break;
            }
          }
        }
        const drawingEvents = r.game.savedDrawings && r.game.savedDrawings[drawingOwner] ? r.game.savedDrawings[drawingOwner] : [];
        const descriptionFrom = drawingOwner;
        const descriptionText = r.game.descriptions && r.game.descriptions[descriptionFrom] ? r.game.descriptions[descriptionFrom] : '';
        reveal[pid] = { prompt, drawingOwner, drawingEvents, descriptionText };
      });
      io.to(roomId).emit('game_reveal', { reveal });
    }
    cb && cb({ok:true});
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if(roomId && rooms[roomId]){
      delete rooms[roomId].players[socket.id];
      if(rooms[roomId].hostId === socket.id){
        rooms[roomId].hostId = Object.keys(rooms[roomId].players)[0] || null;
      }
      io.to(roomId).emit('room_update', rooms[roomId]);
    }
  });

});

// minimal interval timer (not robust)
function startRoundTimer(roomId){
  const r = rooms[roomId];
  if(!r) return;
  const secs = r.settings.drawTimeSec || 60;
  let t = secs;
  const iv = setInterval(()=>{
    io.to(roomId).emit('tick', {t});
    t--;
    if(t<0){
      clearInterval(iv);
      io.to(roomId).emit('round_timeout');
      // optionally mark done for everyone
    }
  }, 1000);
}

server.listen(PORT, ()=> console.log('server listening on', PORT));
