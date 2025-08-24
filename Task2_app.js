const socket = io();
const $ = (s)=>document.querySelector(s);
let state = {
  me: null,
  rooms: [],
  people: [],
  current: null, // { type:'room'|'dm', id, title, toUserId? }
  isTyping:false,
  debounce:null,
  messages: new Map() // roomId -> [msg]
};
function setModal(show){ $("#loginModal").style.display = show ? "grid" : "none"; }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function drawRooms(){
  const box = $("#rooms"); box.innerHTML = "";
  state.rooms.forEach(r=>{
    const d=document.createElement("div");
    d.className="item"; d.textContent=`# ${r.name}`;
    d.onclick=()=>{
      state.current={ type:"room", id:r.id, title:`# ${r.name}` };
      $("#chatTitle").textContent=state.current.title;
      openHistory(r.id);
      socket.emit("room:join",{roomId:r.id});
    };
    box.appendChild(d);
  });
}
function drawPeople(){
  const box = $("#people"); box.innerHTML = "";
  $("#onlineCount").textContent = `(${state.people.length})`;
  state.people.forEach(p=>{
    const d=document.createElement("div");
    d.className="item";
    d.innerHTML=`<span class="dot"></span><span class="name">@ ${p.username}</span>`;
    d.onclick=()=>{
      socket.emit("dm:open",{toUserId:p.id},({roomId,history})=>{
        state.current={ type:"dm", id:roomId, title:`@ ${p.username}`, toUserId:p.id };
        $("#chatTitle").textContent=state.current.title;
        $("#messages").innerHTML="";
        (history||[]).forEach(append);
      });
    };
    box.appendChild(d);
  });
}
function openHistory(roomId){
  $("#messages").innerHTML="";
  (state.messages.get(roomId)||[]).forEach(append);
}
function userName(id){
  if (id===state.me?.id) return state.me.username;
  return state.people.find(p=>p.id===id)?.username || "user";
}
function append(msg){
  const wrap = $("#messages");
  const me = msg.from === state.me?.id;
  const el = document.createElement("div");
  el.className = `msg ${me?"me":"them"}`;
  const time = new Date(msg.ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  el.innerHTML =
    `<div>${esc(msg.text)}</div>
     <div class="meta">${me?"You":esc(userName(msg.from))} • ${time}${me?` <span class="ticks" data-id="${msg.id}">✓</span>`:""}</div>`;
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
  if (!me && state.current && state.current.id===msg.roomId){
    socket.emit("msg:seen", { roomId: msg.roomId, msgId: msg.id });
  }
}
function setTicks(id, kind){
  const t = document.querySelector(`.ticks[data-id="${id}"]`);
  if (!t) return;
  if (kind==="delivered") t.textContent="✓✓";
  if (kind==="seen") { t.textContent="✓✓"; t.classList.add("seen"); }
}
/* ---------------- Login ---------------- */
$("#joinBtn").onclick = ()=>{
  const name = $("#username").value.trim().toLowerCase();
  if (!name) return $("#loginError").textContent="Enter a username";
  socket.emit("auth:login",{username:name},(res)=>{
    if (!res?.ok) { $("#loginError").textContent = res?.error || "Login failed"; return; }
    state.me = res.me;
    state.rooms = res.rooms;
    state.people = res.people.filter(p=>p.id!==state.me.id);
    $("#who").textContent = `Logged in as @${state.me.username}`;
    (res.history||[]).forEach(m=>{
      if (!state.messages.has(m.roomId)) state.messages.set(m.roomId,[]);
      state.messages.get(m.roomId).push(m);
    });
    setModal(false); drawRooms(); drawPeople();
    // open General by default
    const g = state.rooms[0];
    if (g){
      state.current = { type:"room", id:g.id, title:`# ${g.name}` };
      $("#chatTitle").textContent = state.current.title;
      openHistory(g.id);
      socket.emit("room:join",{roomId:g.id});
    }
  });
};
$("#composer").addEventListener("submit",(e)=>{
  e.preventDefault();
  if (!state.current) return;
  const text = $("#msg").value.trim();
  if (!text) return;
  const payload = { text };
  if (state.current.type==="room") payload.roomId = state.current.id;
  else payload.toUserId = state.current.toUserId;
  socket.emit("msg:send", payload, (ack)=>{
    if (ack?.ok) $("#msg").value="";
  });
});
/* --------------- Typing --------------- */
$("#msg").addEventListener("input", ()=>{
  if (!state.current) return;
  if (!state.isTyping){ state.isTyping=true; emitTyping(true); }
  clearTimeout(state.debounce);
  state.debounce = setTimeout(()=>{ state.isTyping=false; emitTyping(false); }, 900);
});
function emitTyping(isTyping){
  const payload = { isTyping };
  if (state.current.type==="room") payload.roomId = state.current.id;
  else payload.toUserId = state.current.toUserId;
  socket.emit("typing", payload);
}
/* --------------- Socket events --------------- */
socket.on("users:list",(list)=>{
  if (!state.me) return;
  state.people = list.filter(u=>u.id!==state.me.id);
  drawPeople();
});
socket.on("presence:join", ({roomId,username})=>{
  if (state.current && state.current.id===roomId){
    showTyping(`${username} joined`); setTimeout(hideTyping,1200);
  }
});
socket.on("presence:leave", ({username})=>{
  showTyping(`${username} left`); setTimeout(hideTyping,1200);
});
socket.on("msg:new",(msg)=>{
  if (!state.messages.has(msg.roomId)) state.messages.set(msg.roomId,[]);
  state.messages.get(msg.roomId).push(msg);
  if (state.current && state.current.id===msg.roomId) append(msg);
});
socket.on("msg:delivered",({id})=>setTicks(id,"delivered"));
socket.on("msg:seen",({id})=>setTicks(id,"seen"));
socket.on("typing",({roomId,username,isTyping})=>{
  if (!state.current || state.current.id!==roomId) return;
  if (isTyping) showTyping(`${username} is typing…`); else hideTyping();
});
function showTyping(t){ const el=$("#typing"); el.textContent=t; el.hidden=false; }
function hideTyping(){ $("#typing").hidden=true; }
document.addEventListener("DOMContentLoaded", ()=> setModal(true));
