const params = parseHash();
const roomId = params.room || '';
socket.emit('request_reveal', {roomId});
socket.on('game_reveal', ({reveal})=>{
  const area = document.getElementById('revealArea');
  area.innerHTML = '';
  Object.entries(reveal).forEach(([starter, data])=>{
    const el = document.createElement('div');
    el.style.border = '1px solid rgba(255,255,255,0.06)';
    el.style.padding = '12px';
    el.style.margin = '8px';
    el.innerHTML = `<h4>Starter: ${starter}</h4>
      <div><b>Prompt:</b> ${data.prompt}</div>
      <div><b>Description:</b> ${data.descriptionText}</div>
      <div><b>Drawing events:</b> <pre style="white-space:pre-wrap">${JSON.stringify(data.drawingEvents||[],null,2)}</pre></div>`;
    area.appendChild(el);
  });
});
