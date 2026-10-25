// Private Zone frontend — vanilla JS, no build step.
let token = localStorage.getItem('pz_token') || '';
let me = null, config = null, currentChatPeer = null, currentCall = null, pc = null, localStream = null, signalIndex = -1, signalTimer = null;
const $ = id => document.getElementById(id);
async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('Request failed: ' + r.status));
  return data;
}
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('view-' + name).classList.remove('hidden');
  if (name === 'feed') loadFeed();
  if (name === 'explore') loadExplore();
  if (name === 'events') loadEvents();
  if (name === 'friends') loadFriends();
  if (name === 'chats') loadChats();
  if (name === 'earn') loadEarn();
  if (name === 'marketplace') loadMarketplace();
  if (name === 'watch') loadWatch();
  if (name === 'profile') loadProfile();
}
async function init() {
  config = await api('/api/config');
  $('earnNote').textContent = `Platform fee shown in split math: ${config.platformFeePercent}%. Payouts are records only — no real money is sent until Stripe Connect is verified.`;
  $('turnNote').textContent = config.turnConfigured ? 'TURN is configured.' : 'Note: production video on some networks needs a TURN server — see README.';
  if (!config.premiumConfigured) $('premiumBtn').textContent = '⭐ Premium (not configured yet)';
  document.querySelectorAll('#nav button').forEach(b => b.onclick = () => showView(b.dataset.view));
  if (!token) return;
  try { const d = await api('/api/auth/me'); me = d.user; afterLogin(); } catch { token = ''; localStorage.removeItem('pz_token'); }
}
function afterLogin() {
  $('authView').classList.add('hidden'); $('appView').classList.remove('hidden');
  ['nav', 'notifBtn', 'premiumBtn', 'logoutBtn'].forEach(id => $(id).classList.remove('hidden'));
  showView('feed'); loadNotifications(); setInterval(pollIncoming, 4000);
}
$('signupBtn').onclick = async () => {
  try { const d = await api('/api/auth/signup', 'POST', { name: $('suName').value, email: $('suEmail').value, password: $('suPass').value }); token = d.token; localStorage.setItem('pz_token', token); me = d.user; afterLogin(); }
  catch (e) { $('authMsg').textContent = e.message; }
};
$('loginBtn').onclick = async () => {
  try { const d = await api('/api/auth/login', 'POST', { email: $('liEmail').value, password: $('liPass').value }); token = d.token; localStorage.setItem('pz_token', token); me = d.user; afterLogin(); }
  catch (e) { $('authMsg').textContent = e.message; }
};
$('logoutBtn').onclick = () => { token = ''; localStorage.removeItem('pz_token'); location.reload(); };
$('premiumBtn').onclick = () => {
  if (config.premiumConfigured) window.open(config.premiumPaymentLink, '_blank');
  else alert('Premium checkout is not configured yet. The owner must paste a payment link he creates in his own Stripe dashboard into STRIPE_PREMIUM_PAYMENT_LINK (see README). No link has been invented.');
};
$('postBtn').onclick = async () => {
  const pollOptions = [...document.querySelectorAll('.pollOpt')].map(i => i.value.trim()).filter(Boolean);
  if (pollOptions.length === 1) { alert('A poll needs 2 to 4 options — add one more or clear the poll fields.'); return; }
  try {
    await api('/api/posts', 'POST', { text: $('postText').value, imageUrl: $('postImage').value, videoUrl: $('postVideo').value, ...(pollOptions.length ? { pollOptions } : {}) });
    $('postText').value = ''; $('postImage').value = ''; $('postVideo').value = '';
    document.querySelectorAll('.pollOpt').forEach(i => i.value = '');
    loadFeed();
  } catch (e) { alert(e.message); }
};
$('storyBtn').onclick = async () => { await api('/api/stories', 'POST', { text: $('storyText').value }); $('storyText').value = ''; loadFeed(); };
const REACTION_EMOJIS = ['❤️', '😂', '🔥', '👍', '😮', '😢'];
function renderPost(p, score) {
  const reactions = p.reactions || {};
  const pollHtml = p.poll ? `<div class="poll">
    <div class="muted">📊 Poll — ${p.poll.totalVotes} vote(s)${p.poll.myVote !== null && p.poll.myVote !== undefined ? ' · you voted' : ''}</div>
    ${p.poll.options.map(o => `<div class="poll-option"><button onclick="votePost('${p.id}', ${o.optionIndex})">${esc(o.text)}${p.poll.myVote === o.optionIndex ? ' ✓' : ''}</button> <span>${o.votes} votes · ${o.percent}%</span><div class="poll-bar"><div style="width:${o.percent}%"></div></div></div>`).join('')}
  </div>` : '';
  return `<div class="card post">
    <strong>${esc(p.author?.name)}</strong> ${p.isDemo ? '<span class="demo-badge">DEMO</span>' : ''} <span class="muted">${new Date(p.createdAt).toLocaleString()}</span>
    ${score !== undefined ? `<span class="muted"> · 🔥 ${score}</span>` : ''}
    <p>${esc(p.text)}</p>
    ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" style="max-width:100%">` : ''}
    ${p.videoUrl ? `<video src="${esc(p.videoUrl)}" controls style="max-width:100%"></video>` : ''}
    ${pollHtml}
    <div>
      <button onclick="likePost('${p.id}')">👍 Like (${p.likes})${p.likedByMe ? ' ✓' : ''}</button>
      <button onclick="sharePost('${p.id}')">↗ Share (${p.shares})</button>
      <button onclick="savePost('${p.id}')">${p.savedByMe ? 'Saved ✓' : 'Save'}</button>
      <button onclick="hidePost('${p.id}')">Hide</button>
    </div>
    <div class="reactions">
      ${REACTION_EMOJIS.map(e => `<button class="react-btn${p.myReaction === e ? ' active' : ''}" onclick="reactPost('${p.id}', '${e}')">${e} ${reactions[e] || 0}</button>`).join('')}
    </div>
    <div>${p.comments.map(c => `<div><strong>${esc(c.author?.name)}:</strong> ${esc(c.text)}</div>`).join('')}</div>
    <input id="c-${p.id}" placeholder="Write a comment…"><button onclick="commentPost('${p.id}')">Comment</button>
  </div>`;
}
async function loadFeed() {
  const posts = (await api('/api/posts')).posts;
  const stories = (await api('/api/stories')).stories;
  $('stories').innerHTML = stories.map(s => `<div>👤 ${esc(s.author?.name)}: ${esc(s.text)} ${s.isDemo ? '<span class="demo-badge">DEMO</span>' : ''}</div>`).join('') || '<p class="muted">No stories yet.</p>';
  $('feed').innerHTML = posts.map(p => renderPost(p)).join('') || '<p class="muted">No posts yet — be the first.</p>';
}
async function loadExplore() {
  const posts = (await api('/api/explore')).posts;
  $('exploreList').innerHTML = posts.map(p => renderPost(p, p.engagement)).join('') || '<p class="muted">Nothing trending yet.</p>';
}
window.likePost = async id => { await api(`/api/posts/${id}/like`, 'POST', {}); loadFeed(); };
window.sharePost = async id => { await api(`/api/posts/${id}/share`, 'POST', {}); loadFeed(); };
window.savePost = async id => { await api(`/api/posts/${id}/save`, 'POST', {}); loadFeed(); };
window.hidePost = async id => { await api(`/api/posts/${id}/hide`, 'POST', {}); loadFeed(); };
window.commentPost = async id => { const v = $('c-' + id).value; if (!v) return; await api(`/api/posts/${id}/comment`, 'POST', { text: v }); loadFeed(); };
window.reactPost = async (id, emoji) => { await api(`/api/posts/${id}/react`, 'POST', { emoji }); const view = document.querySelector('.view:not(.hidden)')?.id; if (view === 'view-explore') loadExplore(); else loadFeed(); };
window.votePost = async (id, optionIndex) => { await api(`/api/posts/${id}/vote`, 'POST', { optionIndex }); const view = document.querySelector('.view:not(.hidden)')?.id; if (view === 'view-explore') loadExplore(); else loadFeed(); };

async function loadFriends() {
  const f = (await api('/api/friends')).friends;
  $('friendList').innerHTML = f.map(x => `<div>${esc(x.other?.name)} — ${x.status} ${x.status === 'pending' && x.toId === me.id ? `<button onclick="acceptFriend('${x.fromId}')">Accept</button> <button onclick="declineFriend('${x.fromId}')">Decline</button>` : ''}</div>`).join('') || '<p class="muted">No friends yet.</p>';
}
window.acceptFriend = async fromId => { await api('/api/friends/accept', 'POST', { fromId }); loadFriends(); };
window.declineFriend = async fromId => { await api('/api/friends/decline', 'POST', { fromId }); loadFriends(); };
$('searchBtn').onclick = async () => {
  const users = (await api('/api/users?q=' + encodeURIComponent($('userSearch').value))).users;
  $('userList').innerHTML = users.filter(u => u.id !== me.id).map(u => `<div>${esc(u.name)} ${u.isDemo ? '<span class="demo-badge">DEMO</span>' : ''} <button onclick="friendReq('${u.id}')">Add friend</button> <button onclick="openChat('${u.id}','${esc(u.name)}')">Message</button></div>`).join('') || '<p class="muted">No users found.</p>';
};
window.friendReq = async id => { try { await api('/api/friends/request', 'POST', { toId: id }); alert('Friend request sent.'); } catch (e) { alert(e.message); } };

async function loadChats() {
  const chats = (await api('/api/chats')).chats;
  $('chatList').innerHTML = chats.map(c => `<div><button onclick="openChat('${c.peer.id}','${esc(c.peer.name)}')">${esc(c.peer.name)}</button> ${c.lastMessage ? esc(c.lastMessage.text) : '<span class="muted">No messages yet</span>'}</div>`).join('') || '<p class="muted">No chats yet — add a friend first, then message them.</p>';
}
window.openChat = async (peerId, name) => {
  currentChatPeer = peerId; $('chatBox').classList.remove('hidden'); $('chatTitle').textContent = 'Chat with ' + name; showView('chats');
  const d = await api('/api/chats/' + peerId);
  $('chatMessages').innerHTML = d.messages.map(m => `<div><strong>${esc(m.author?.name)}:</strong> ${esc(m.text)} ${m.type === 'call' ? '📹' : ''}</div>`).join('');
};
$('chatSend').onclick = async () => { if (!currentChatPeer) return; await api('/api/chats/' + currentChatPeer, 'POST', { text: $('chatInput').value }); $('chatInput').value = ''; openChat(currentChatPeer, $('chatTitle').textContent.replace('Chat with ', '')); };

async function loadEarn() {
  const collabs = (await api('/api/earn/collabs')).collabs;
  const payouts = (await api('/api/earn/payouts')).payouts;
  const friends = (await api('/api/friends')).friends.filter(f => f.status === 'accepted');
  $('collabMembers').innerHTML = friends.map(f => `<label><input type="checkbox" class="memberPick" value="${f.other.id}"> ${esc(f.other.name)} — split <input type="number" class="memberSplit" data-id="${f.other.id}" value="50" style="width:80px">%</label><br>`).join('') || '<p class="muted">Add accepted friends first to build a collab team.</p>';
  $('collabList').innerHTML = collabs.map(c => {
    const pot = c.sources.reduce((s, x) => s + Number(x.amount || 0), 0);
    return `<div class="card"><strong>${esc(c.name)}</strong> — pot $${pot.toFixed(2)}
      <div>Sources: ${c.sources.map(s => `${esc(s.name)} $${Number(s.amount).toFixed(2)}`).join(', ') || 'none yet'}</div>
      <div>Members: ${c.memberDetails.map(m => `${esc(m.user?.name)} ${m.splitPercent}%`).join(', ')}</div>
      <button onclick="cashout('${c.id}')">Cash out (record only)</button></div>`;
  }).join('') || '<p class="muted">No collabs yet.</p>';
  $('payoutList').innerHTML = payouts.map(p => `<div>${esc(p.collabName)} — pot $${p.pot.toFixed(2)}, platform fee ${p.platformFeePercent}% = $${p.platformFee.toFixed(2)}, distributable $${p.distributable.toFixed(2)} — ${p.shares.map(s => `${s.percent}%`).join(', ')} — <strong>RECORD ONLY, no real money sent</strong></div>`).join('') || '<p class="muted">No payouts recorded yet.</p>';
}
$('addSourceBtn').onclick = () => { const d = document.createElement('div'); d.innerHTML = '<input class="srcName" placeholder="Source name"><input class="srcAmt" type="number" placeholder="Amount ($)">'; $('collabSources').appendChild(d); };
$('createCollabBtn').onclick = async () => {
  const members = [...document.querySelectorAll('.memberPick:checked')].map(cb => ({ userId: cb.value, splitPercent: Number(document.querySelector(`.memberSplit[data-id="${cb.value}"]`)?.value || 0) }));
  // Always include me if not already picked, adjusting is left to the owner: require explicit picks to sum to 100.
  const sources = [...document.querySelectorAll('#collabSources > div, #collabSources')].length ? [] : [];
  const srcNames = [...document.querySelectorAll('.srcName')]; const srcAmts = [...document.querySelectorAll('.srcAmt')];
  const srcList = srcNames.map((n, i) => ({ name: n.value, amount: Number(srcAmts[i]?.value || 0) })).filter(s => s.name);
  try { await api('/api/earn/collabs', 'POST', { name: $('collabName').value, members, sources: srcList }); $('earnMsg').textContent = 'Collab created.'; loadEarn(); }
  catch (e) { $('earnMsg').textContent = e.message; }
};
window.cashout = async id => { try { const d = await api(`/api/earn/collabs/${id}/cashout`, 'POST', {}); alert(`Payout recorded (record only): pot $${d.payout.pot.toFixed(2)}, fee $${d.payout.platformFee.toFixed(2)}, distributable $${d.payout.distributable.toFixed(2)}. No real money was sent.`); loadEarn(); } catch (e) { alert(e.message); } };

async function loadMarketplace() {
  const l = (await api('/api/marketplace')).listings;
  $('listingList').innerHTML = l.map(x => `<div class="card"><strong>${esc(x.title)}</strong> — $${Number(x.price).toFixed(2)} by ${esc(x.seller?.name)} ${x.isDemo ? '<span class="demo-badge">DEMO</span>' : ''}<p>${esc(x.description)}</p></div>`).join('') || '<p class="muted">No listings yet.</p>';
}
$('listBtn').onclick = async () => { await api('/api/marketplace', 'POST', { title: $('listTitle').value, price: $('listPrice').value, description: $('listDesc').value }); loadMarketplace(); };
async function loadWatch() {
  const v = (await api('/api/watch')).videos;
  $('watchList').innerHTML = v.map(x => `<div class="card"><strong>${esc(x.author?.name)}</strong><p>${esc(x.text)}</p><video src="${esc(x.videoUrl)}" controls style="max-width:100%"></video></div>`).join('') || '<p class="muted">No videos yet — post with a video URL and it will appear here.</p>';
}
async function loadEvents() {
  const events = (await api('/api/events')).events;
  $('eventList').innerHTML = events.map(e => `<div class="card">
    <strong>${esc(e.title)}</strong> ${e.isDemo ? '<span class="demo-badge">DEMO</span>' : ''} <span class="muted">by ${esc(e.creator?.name)}</span>
    <p class="muted">${esc(e.date)}${e.location ? ' · ' + esc(e.location) : ''}</p>
    <p>${esc(e.description)}</p>
    <div class="muted">✅ Going ${e.rsvpCounts.going} · 🤔 Interested ${e.rsvpCounts.interested} · ❌ Not going ${e.rsvpCounts['not-going']}${e.myRsvp ? ' · You: ' + e.myRsvp : ''}</div>
    <div>
      <button class="${e.myRsvp === 'going' ? 'active' : ''}" onclick="rsvpEvent('${e.id}', 'going')">Going</button>
      <button class="${e.myRsvp === 'interested' ? 'active' : ''}" onclick="rsvpEvent('${e.id}', 'interested')">Interested</button>
      <button class="${e.myRsvp === 'not-going' ? 'active' : ''}" onclick="rsvpEvent('${e.id}', 'not-going')">Not going</button>
    </div>
  </div>`).join('') || '<p class="muted">No events yet — create the first one.</p>';
}
$('eventBtn').onclick = async () => {
  try {
    await api('/api/events', 'POST', { title: $('eventTitle').value, date: $('eventDate').value, location: $('eventLocation').value, description: $('eventDesc').value });
    $('eventTitle').value = ''; $('eventDate').value = ''; $('eventLocation').value = ''; $('eventDesc').value = ''; $('eventMsg').textContent = 'Event created.';
    loadEvents();
  } catch (e) { $('eventMsg').textContent = e.message; }
};
window.rsvpEvent = async (id, status) => { await api(`/api/events/${id}/rsvp`, 'POST', { status }); loadEvents(); };

async function loadProfile() {
  $('profileInfo').innerHTML = `<p><strong>${esc(me.name)}</strong><br>${esc(me.bio || 'No bio yet.')}</p>`;
  $('bioInput').value = me.bio || '';
}
$('bioBtn').onclick = async () => { const d = await api('/api/profile', 'POST', { bio: $('bioInput').value }); me = d.user; loadProfile(); };
async function loadNotifications() {
  try {
    const n = (await api('/api/notifications')).notifications;
    const unread = n.filter(x => !x.read).length;
    $('notifCount').textContent = unread ? unread : '';
    $('notifList').innerHTML = n.map(x => `<div>${esc(x.text)} <span class="muted">${new Date(x.createdAt).toLocaleString()}</span></div>`).join('') || '<p class="muted">No notifications.</p>';
  } catch {}
}
$('notifBtn').onclick = () => { showView('profile'); loadProfile(); loadNotifications(); };
$('readAllBtn').onclick = async () => { await api('/api/notifications/read-all', 'POST', {}); loadNotifications(); };

// ---------- Video calls (WebRTC + server signaling) ----------
async function pollIncoming() {
  if (!me) return;
  try {
    const d = await api('/api/calls/incoming');
    if (d.calls.length) {
      const c = d.calls[0];
      $('incomingCall').classList.remove('hidden');
      $('incomingCall').innerHTML = `<strong>${esc(c.caller?.name)} is calling you.</strong> <button onclick="acceptCall('${c.id}')">Answer</button> <button onclick="endCall('${c.id}')">Decline</button>`;
    } else $('incomingCall').classList.add('hidden');
  } catch {}
}
function iceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  // TURN is only added if the server config exposes it in a future step; see README.
  // Production: set TURN_URL/TURN_USERNAME/TURN_CREDENTIAL on the server and extend /api/config to return them.
  return servers;
}
async function startCall(peerId, callId, isCaller) {
  currentCall = { id: callId, peerId };
  $('callModal').classList.remove('hidden'); $('callStatus').textContent = isCaller ? 'Calling…' : 'Connecting…';
  pc = new RTCPeerConnection({ iceServers: iceServers() });
  pc.ontrack = e => { $('remoteVideo').srcObject = e.streams[0]; $('callStatus').textContent = 'Connected'; };
  pc.onicecandidate = e => { if (e.candidate) api(`/api/calls/${callId}/signal`, 'POST', { type: 'candidate', payload: e.candidate }).catch(() => {}); };
  try { localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); $('localVideo').srcObject = localStream; localStream.getTracks().forEach(t => pc.addTrack(t, localStream)); }
  catch { $('callStatus').textContent = 'Camera/mic not allowed — continuing with avatar fallback (audio/video from the other side still shows if they share).'; }
  if (isCaller) {
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await api(`/api/calls/${callId}/signal`, 'POST', { type: 'offer', payload: offer });
  }
  signalIndex = -1;
  signalTimer = setInterval(async () => {
    try {
      const d = await api(`/api/calls/${callId}/signal?since=${signalIndex}`, 'GET');
      for (const s of d.signals) {
        signalIndex = Math.max(signalIndex, s.index);
        if (s.type === 'offer' && !isCaller) { await pc.setRemoteDescription(new RTCSessionDescription(s.payload)); const ans = await pc.createAnswer(); await pc.setLocalDescription(ans); await api(`/api/calls/${callId}/signal`, 'POST', { type: 'answer', payload: ans }); }
        else if (s.type === 'answer' && isCaller) { await pc.setRemoteDescription(new RTCSessionDescription(s.payload)); $('callStatus').textContent = 'Connected'; }
        else if (s.type === 'candidate') { try { await pc.addIceCandidate(new RTCIceCandidate(s.payload)); } catch {} }
      }
      if (d.status === 'ended') stopCallUI();
    } catch {}
  }, 1500);
}
function stopCallUI() {
  if (signalTimer) clearInterval(signalTimer);
  if (pc) pc.close(); pc = null;
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  $('callModal').classList.add('hidden'); currentCall = null;
}
window.acceptCall = async callId => {
  const d = await api(`/api/calls/${callId}/signal`, 'POST', { type: 'accept', payload: null });
  $('incomingCall').classList.add('hidden');
  const call = await api('/api/calls/' + callId);
  startCall(call.callerId, callId, false);
};
window.endCall = async callId => {
  try { await api(`/api/calls/${callId}/end`, 'POST', {}); } catch {}
  stopCallUI();
};
$('videoCallBtn').onclick = $('voiceCallBtn').onclick = async () => {
  if (!currentChatPeer) return alert('Open a chat first.');
  const d = await api('/api/calls', 'POST', { calleeId: currentChatPeer });
  startCall(currentChatPeer, d.call.id, true);
};
$('endCallBtn').onclick = async () => { if (currentCall) await window.endCall(currentCall.id); };
$('muteBtn').onclick = () => { if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled); };
$('camBtn').onclick = () => { if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = !t.enabled); };
$('speakerBtn').onclick = () => { $('remoteVideo').volume = $('remoteVideo').volume > 0 ? 0 : 1; };

init();
