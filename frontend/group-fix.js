// ════════════════════════════════════════════════════════════════
// GROUP FIX — Replace these functions in your index.html <script>
//
// Fixes:
//  1. "Get recommendations" no longer says "go to For You page"
//     — group now uses its own session tracking via S.groupSessions
//  2. Admin selects hotel → Vote panel shown to all members
//     → If vote passes: only host sees "I'll go here", clicks it
//     → If vote fails: back to hotel list
//  3. All members get feedback after group visit
//     — /recommend/group-select marks selectedRestaurant on all sessions
//
// ADD to S state object:
//   S.groupSessions = [];     // sessions returned from /recommend/group
//   S.groupVoteRestId = null; // restaurant currently being voted on
//   S.myVote = null;          // current user's vote (true/false/null)
//   S.votes = {};             // { userId: true/false } (simulated client-side)
// ════════════════════════════════════════════════════════════════

// ── Extra CSS to add inside <style> ─────────────────────────
/*
.vote-panel{background:linear-gradient(135deg,var(--gold-bg),var(--orange-bg));border:2px solid var(--gold-border);border-radius:var(--rl);padding:1.4rem;margin-bottom:1.2rem}
.vote-panel-title{font-family:var(--font-h);font-size:15px;font-weight:800;margin-bottom:.35rem}
.vote-panel-sub{font-size:12px;color:var(--text2);margin-bottom:1rem;line-height:1.55}
.vote-track{display:flex;gap:6px;margin-bottom:.85rem;height:8px;border-radius:4px;overflow:hidden;background:var(--bg4)}
.vote-yes-bar{background:var(--green);border-radius:4px 0 0 4px;transition:width .3s}
.vote-no-bar{background:var(--red);border-radius:0 4px 4px 0;transition:width .3s}
.vote-counts{display:flex;justify-content:space-between;font-size:11px;font-weight:700;margin-bottom:.85rem}
.vote-counts .yes{color:var(--green)}
.vote-counts .no{color:var(--red)}
.vote-rest-preview{background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:.8rem;display:flex;align-items:center;gap:10px;margin-bottom:.9rem}
.vote-rest-emoji{font-size:28px}
.vote-rest-name{font-family:var(--font-h);font-size:14px;font-weight:700}
.vote-rest-meta{font-size:11px;color:var(--text3)}
.vote-actions{display:flex;gap:8px}
.rcard-propose{position:relative}
.propose-btn{position:absolute;bottom:10px;right:10px;z-index:2;background:var(--gold);color:#fff;border:none;border-radius:20px;padding:5px 13px;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-b);transition:all .18s;box-shadow:0 2px 8px rgba(212,146,10,.3)}
.propose-btn:hover{background:#b87a00}
*/

// ════════════════════════════════════════════════════════════════
// RENDERING GROUP ROOM — complete replacement for renderRoom()
// ════════════════════════════════════════════════════════════════
async function renderRoom() {
  const room = S.room;
  if (!room) return;
  const isHost = String(room.host) === String(S.user?._id);

  document.getElementById('room-title').textContent  = 'Room ' + room.code;
  document.getElementById('room-sub').textContent    = room.members.length + ' member' + (room.members.length !== 1 ? 's' : '') + ' · ' + (isHost ? 'You are the host' : 'Member');
  document.getElementById('room-status').textContent = room.members.length > 1 ? room.members.length + ' in room' : 'Waiting for members…';

  const allC   = [...new Set(room.members.flatMap(m => m.preferredCuisines || []))];
  const avgB   = Math.round(room.members.reduce((s, m) => s + (m.budgetPreference || 2), 0) / room.members.length);
  const avgS   = Math.round(room.members.reduce((s, m) => s + (m.spicePreference  || 3), 0) / room.members.length);
  const vegWin = room.members.some(m => m.vegPreference === 'veg');

  const membersHTML = room.members.map((m, i) => `
    <div class="mrow">
      <div class="mleft">
        <div class="mav" style="background:${COLORS[i % COLORS.length]}">${(m.name || '?').slice(0, 2).toUpperCase()}</div>
        <div>
          <div class="mname">${m.name || 'Member'}${String(m.userId) === String(S.user?._id) ? ' <span style="font-size:10px;color:var(--text3)">(you)</span>' : ''}</div>
          <div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:2px">
            ${(m.preferredCuisines || []).slice(0, 2).map(c => `<span class="tag tc">${c}</span>`).join('')}
            <span class="tag tb">${'₹'.repeat(m.budgetPreference || 2)}</span>
            <span class="tag">${m.vegPreference === 'veg' ? '🥦' : m.vegPreference === 'nonveg' ? '🍖' : '🍽️'}</span>
          </div>
        </div>
      </div>
      ${isHost && String(m.userId) !== String(S.user?._id)
        ? `<button class="mkick" onclick="kickMember('${room.code}','${m.userId}')">×</button>`
        : ''}
    </div>`).join('');

  // ── Recommendations section ───────────────────────────────
  let recsHTML = `<div style="text-align:center;padding:2rem;color:var(--text3);font-size:13px">Need at least 2 members.<br>Share the room code!</div>`;

  if (room.members.length >= 2) {
    // FIX 1: only fetch if we haven't already, to avoid re-creating sessions
    if (!S.groupRests.length) {
      try {
        const d       = await req('POST', '/recommend/group', { code: room.code });
        S.groupRests  = (d.restaurants || []).slice(0, 5);
        // Store sessions returned — these are OUR session IDs that will be marked later
        S.groupSessions = d.sessions || []; // backend returns sessions in the response if we add them
      } catch (e) {
        recsHTML = emptyH('⚠️', 'Could not load', e.message);
        renderRoomBody(room, isHost, membersHTML, allC, avgB, avgS, vegWin, recsHTML);
        return;
      }
    }

    // ── Voting panel (if vote in progress) ──────────────────
    let voteHTML = '';
    if (S.groupVoteRestId) {
      const vr    = S.groupRests.find(r => String(r._id || r.id) === String(S.groupVoteRestId));
      const myV   = S.myVote;
      const yeses = Object.values(S.votes).filter(v => v === true).length;
      const nos   = Object.values(S.votes).filter(v => v === false).length;
      const total = room.members.length;
      const yesPct = total ? Math.round((yeses / total) * 100) : 0;
      const noPct  = total ? Math.round((nos  / total) * 100) : 0;

      voteHTML = `
        <div class="vote-panel" id="vote-panel">
          <div class="vote-panel-title">🗳️ Host's pick — vote now!</div>
          <div class="vote-panel-sub">The host has proposed a restaurant. Vote yes to confirm or no to go back to the list.</div>
          <div class="vote-rest-preview">
            <div class="vote-rest-emoji">${vr?.emoji || '🍽️'}</div>
            <div>
              <div class="vote-rest-name">${vr?.name || 'Restaurant'}</div>
              <div class="vote-rest-meta">${vr?.address || ''} · ⭐ ${vr?.rating || '—'} · ${'₹'.repeat(vr?.priceLevel || 1)}</div>
            </div>
          </div>
          <div class="vote-track">
            <div class="vote-yes-bar" style="width:${yesPct}%"></div>
            <div class="vote-no-bar" style="width:${noPct}%"></div>
          </div>
          <div class="vote-counts">
            <span class="yes">👍 Yes: ${yeses}/${total}</span>
            <span class="no">👎 No: ${nos}/${total}</span>
          </div>
          <div class="vote-actions">
            ${!isHost ? `
              <button class="btn btn-green btn-sm" style="flex:1" ${myV===true?'disabled':''} onclick="castVote(true)">
                ${myV===true ? '✓ Voted Yes' : '👍 Yes, let\'s go!'}
              </button>
              <button class="btn btn-red btn-sm" style="flex:1" ${myV===false?'disabled':''} onclick="castVote(false)">
                ${myV===false ? '✓ Voted No' : '👎 No, try another'}
              </button>
            ` : `
              <div style="font-size:12px;color:var(--text2);flex:1;display:flex;align-items:center">Waiting for members to vote…</div>
              <button class="btn btn-orange btn-sm" id="confirm-go-btn" style="display:none" onclick="confirmGroupSelection('${S.groupVoteRestId}')">
                ✅ Confirm — I'll go here!
              </button>
              <button class="btn btn-ghost btn-sm" onclick="cancelVote()">Cancel vote</button>
            `}
          </div>
          ${isHost && yeses >= Math.ceil(total / 2) ? `<div style="margin-top:.75rem;padding:.7rem;background:var(--green-bg);border-radius:var(--r);border:1px solid rgba(40,165,108,.25);font-size:12px;color:var(--green);display:flex;align-items:center;justify-content:space-between">
            <span>✅ Majority voted Yes! Confirm the choice.</span>
            <button class="btn btn-green btn-sm" onclick="confirmGroupSelection('${S.groupVoteRestId}')">Confirm →</button>
          </div>` : ''}
          ${!isHost && nos >= Math.ceil(total / 2) ? `<div style="margin-top:.75rem;padding:.7rem;background:var(--red-bg);border-radius:var(--r);border:1px solid rgba(214,60,60,.2);font-size:12px;color:var(--red)">
            ❌ Majority voted No — host will choose another option.
          </div>` : ''}
        </div>`;
    }

    // ── Restaurant cards with "Propose" button for host ──────
    const cardsHTML = S.groupRests.map(r => {
      const id  = r._id || r.id;
      const pct = r.matchScore || Math.round(r.rating * 20);
      const tags = (r.tags || []).map(t => `<span class="tag ${t === 'veg' ? 'tv' : t === 'nonveg' ? 'tnv' : 'tb'}">${t}</span>`).join('')
                 + (r.cuisines || []).map(c => `<span class="tag tc">${c}</span>`).join('');
      const com = r.communityScore != null && r.feedbackCount > 0
        ? `<span class="com-badge">👥 ${r.communityScore} (${r.feedbackCount})</span>` : '';
      return `<div class="rcard rcard-propose" style="${String(id) === String(S.groupVoteRestId) ? 'border-color:var(--gold);box-shadow:0 0 0 3px rgba(212,146,10,.15)' : ''}">
        <div onclick="openRest('${id}','room')" style="cursor:pointer">
          <div class="rci">${r.emoji || '🍽️'}</div>
          <div class="rcb">
            <div class="rct"><div class="rcn">${r.name}</div><div><div class="mp">${pct}%</div><div class="ml">match</div></div></div>
            <div class="rcm">${r.address || ''}</div>
            <div class="rctags">${tags}</div>
            <div class="mbar"><div class="mbar-f" style="width:${pct}%"></div></div>
            <div class="rcf"><span>⭐ ${r.rating}</span><span>${'🌶'.repeat(Math.min(r.spiceLevel || 1, 5))}</span><span style="color:var(--gold);font-weight:700">${'₹'.repeat(r.priceLevel || 1)}</span></div>
            ${com ? `<div style="margin-top:5px">${com}</div>` : ''}
          </div>
        </div>
        ${isHost && !S.groupVoteRestId ? `<button class="propose-btn" onclick="event.stopPropagation();proposeRestaurant('${id}')">Propose this →</button>` : ''}
        ${String(id) === String(S.groupVoteRestId) ? `<div style="position:absolute;top:8px;left:8px;background:var(--gold);color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700">Proposed</div>` : ''}
      </div>`;
    }).join('');

    const aiBadge = `<div class="ai-banner" style="margin-bottom:.75rem">✨ <strong>AI-optimized</strong> — Score = avg satisfaction + least-satisfied member + rating + distance</div>`;
    recsHTML = voteHTML + aiBadge + `<div class="rgrid">${cardsHTML}</div>`;
  }

  renderRoomBody(room, isHost, membersHTML, allC, avgB, avgS, vegWin, recsHTML);
}

function renderRoomBody(room, isHost, membersHTML, allC, avgB, avgS, vegWin, recsHTML) {
  document.getElementById('room-body').innerHTML = `
    <div class="rgrid-room">
      <div><div class="rpanel">
        <div class="code-box">
          <div class="code-lbl">Room Code</div>
          <div class="code-val">${room.code}</div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:.5rem">Share with friends</div>
          <button class="btn btn-gold btn-sm" id="copy-btn" onclick="copyCode('${room.code}')">📋 Copy</button>
        </div>
        <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.5rem">Members (${room.members.length})</div>
        ${membersHTML}
        <div style="margin-top:.85rem;padding-top:.85rem;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px">
          <button class="btn btn-ghost btn-sm btn-full" onclick="refreshRoom()">🔄 Refresh members</button>
          ${room.members.length >= 2 ? `<button class="btn btn-gold btn-sm btn-full" onclick="reloadGroupRecs()">🔄 Get new recommendations</button>` : ''}
        </div>
      </div></div>

      <div>
        <div class="group-banner">
          <span style="font-size:22px">🤖</span>
          <div>
            <div style="font-family:var(--font-h);font-size:13px;font-weight:700">Merged preferences</div>
            <div style="font-size:11px;color:var(--text2)">${allC.slice(0, 3).join(', ')}${allC.length > 3 ? ' +more' : ''} · ${'₹'.repeat(avgB)} avg · Spice ${avgS}/5${vegWin ? ' · 🥦 veg-safe' : ''}</div>
          </div>
          <div class="gb-avs">${room.members.map((m, i) => `<div class="gb-av" style="background:${COLORS[i % COLORS.length]}">${(m.name || '?').slice(0, 2).toUpperCase()}</div>`).join('')}</div>
        </div>

        ${isHost && !S.groupVoteRestId && S.groupRests.length ? `<div style="font-size:12px;color:var(--text2);padding:.6rem .9rem;background:var(--gold-bg);border:1px solid var(--gold-border);border-radius:var(--r);margin-bottom:.9rem">
          👆 Click <strong>Propose this →</strong> on any restaurant to start a group vote.
        </div>` : ''}
        ${!isHost && S.groupRests.length ? `<div style="font-size:12px;color:var(--text2);padding:.6rem .9rem;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);margin-bottom:.9rem">
          👀 Waiting for the host to propose a restaurant…
        </div>` : ''}

        ${recsHTML}
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// FIX 1: reloadGroupRecs — forces fresh fetch and re-render
// ════════════════════════════════════════════════════════════════
async function reloadGroupRecs() {
  S.groupRests        = [];
  S.groupSessions     = [];
  S.groupVoteRestId   = null;
  S.myVote            = null;
  S.votes             = {};
  await renderRoom();
  toast('New recommendations loaded!', 'ok');
}

// ════════════════════════════════════════════════════════════════
// FIX 2: VOTING FLOW
// Host calls proposeRestaurant(id) → vote panel shown
// Members cast votes via castVote(true/false)
// Host confirms when majority votes yes via confirmGroupSelection(id)
// ════════════════════════════════════════════════════════════════
function proposeRestaurant(id) {
  S.groupVoteRestId = id;
  S.votes           = {};
  S.myVote          = null;
  // Host auto-votes yes for their own proposal
  if (S.user?._id) S.votes[String(S.user._id)] = true;
  S.myVote = true;
  renderRoom();
  toast('Restaurant proposed — members can now vote!', 'ok');
}

function castVote(yes) {
  if (!S.user?._id) return;
  S.votes[String(S.user._id)] = yes;
  S.myVote = yes;
  renderRoom();
  if (!yes) {
    toast('You voted No. Waiting for others…', '');
  } else {
    toast('You voted Yes! Waiting for others…', 'ok');
  }
}

function cancelVote() {
  S.groupVoteRestId = null;
  S.votes           = {};
  S.myVote          = null;
  renderRoom();
  toast('Vote cancelled — choose another restaurant', '');
}

// ════════════════════════════════════════════════════════════════
// FIX 2 + 3: Host confirms — calls /group-select to mark
// selectedRestaurant on ALL member sessions
// ════════════════════════════════════════════════════════════════
async function confirmGroupSelection(restaurantId) {
  const btn = document.getElementById('confirm-go-btn');
  if (btn) setLoad(btn, true, 'Confirming…');

  try {
    const d = await req('POST', '/recommend/group-select', {
      roomCode:     S.room.code,
      restaurantId: restaurantId,
    });

    toast(d.message || 'Group selection confirmed! Everyone will be asked for feedback after the visit.', 'ok');

    // Clear vote state
    S.groupVoteRestId = null;
    S.votes           = {};
    S.myVote          = null;

    // Show success state
    const r = S.groupRests.find(x => String(x._id || x.id) === String(restaurantId));
    const rBody = document.getElementById('room-body');
    if (rBody) {
      const successBanner = document.createElement('div');
      successBanner.style.cssText = 'background:var(--green-bg);border:1.5px solid rgba(40,165,108,.3);border-radius:var(--rl);padding:1.2rem;text-align:center;margin-bottom:1rem';
      successBanner.innerHTML = `
        <div style="font-size:28px;margin-bottom:.4rem">${r?.emoji || '🍽️'}</div>
        <div style="font-family:var(--font-h);font-size:16px;font-weight:800;color:var(--green);margin-bottom:.3rem">✅ "${r?.name || 'Restaurant'}" confirmed!</div>
        <div style="font-size:12px;color:var(--text2)">All ${d.sessionsUpdated} members will be prompted for feedback after your visit.</div>`;
      rBody.prepend(successBanner);
    }

    checkPending();

  } catch (e) {
    toast(e.message, 'err');
    if (btn) setLoad(btn, false, '✅ Confirm — I\'ll go here!');
  }
}

// ════════════════════════════════════════════════════════════════
// FIX 1: openRest from group — override rd-go to use group flow
// Replace the existing openRest to handle 'room' source correctly
// ════════════════════════════════════════════════════════════════
async function openRest(id, from) {
  S.restFrom = from;
  const backMap   = { room: 'room', nearby: 'nearby', personal: 'personal' };
  const backLabel = { room: 'Group Room', nearby: 'Nearby', personal: 'For You' };

  document.getElementById('rest-bc').textContent = '← ' + (backLabel[from] || 'Back');
  document.getElementById('rest-bc').onclick     = () => goPage(backMap[from] || 'personal');
  document.getElementById('rd-back').onclick     = () => goPage(backMap[from] || 'personal');

  // FIX 1: group restaurants use propose flow, not selectRest
  if (from === 'room') {
    const isHost = String(S.room?.host) === String(S.user?._id);
    document.getElementById('rd-go').textContent = isHost ? 'Propose to group →' : 'View only (host decides)';
    document.getElementById('rd-go').disabled    = !isHost;
    document.getElementById('rd-go').onclick     = isHost ? () => { proposeRestaurant(id); goPage('room'); } : null;
  } else {
    document.getElementById('rd-go').textContent = 'I\'ll go here →';
    document.getElementById('rd-go').disabled    = false;
    document.getElementById('rd-go').onclick     = () => selectRest(id);
  }

  let r = [...S.allRests, ...S.personalRests, ...(S.groupRests || [])].find(x => String(x._id || x.id) === String(id));
  if (!r) {
    try { const d = await req('GET', '/restaurants/' + id); r = d.restaurant; }
    catch (e) { toast('Could not load restaurant', 'err'); return; }
  }

  const pct = r.matchScore || Math.round(r.rating * 20);
  document.getElementById('rd-name').textContent  = r.name;
  document.getElementById('rd-addr').textContent  = '📍 ' + (r.address || '');
  document.getElementById('rd-match').textContent = pct + '%';
  document.getElementById('rd-badges').innerHTML  = [
    `<span class="ipill">⭐ ${r.rating}</span>`,
    `<span class="ipill">${'₹'.repeat(r.priceLevel || 1)}</span>`,
    `<span class="ipill">🌶 ${r.spiceLevel || 1}/5</span>`,
    ...(r.cuisines || []).map(c => `<span class="ipill">${c}</span>`),
  ].join('');
  document.getElementById('rd-tags').innerHTML = (r.tags || []).map(t =>
    `<span class="tag ${t === 'veg' ? 'tv' : t === 'nonveg' ? 'tnv' : 'tb'}" style="margin-right:4px">${t}</span>`).join('');
  document.getElementById('rd-menu').innerHTML = (r.menu || []).map(sec => `<div class="msec">
    <div class="msect">${sec.category}</div>
    ${(sec.items || []).map(i => `<div class="mi"><div class="mil"><div class="min">${i.name}</div><div class="mid">${i.description || ''}</div></div><div class="mip">₹${i.price}</div></div>`).join('')}
  </div>`).join('');
  document.getElementById('rd-stats').innerHTML = [
    ['Cuisine', (r.cuisines || []).join(', ')],
    ['Price', '₹'.repeat(r.priceLevel || 1)],
    ['Spice', r.spiceLevel + '/5'],
    ['Rating', r.rating + ' ⭐'],
    ['Community', r.communityScore ? r.communityScore + '★ (' + r.feedbackCount + ' reviews)' : 'No reviews yet'],
    ['Diet', r.tags?.includes('veg') && r.tags?.includes('nonveg') ? 'Veg & Non-veg' : r.tags?.includes('veg') ? 'Vegetarian' : 'Non-vegetarian'],
  ].map(([l, v]) => `<div class="srow"><span style="color:var(--text3)">${l}</span><span>${v}</span></div>`).join('');

  const sim = S.allRests.filter(x => String(x._id || x.id) !== String(id) && (x.cuisines || []).some(c => (r.cuisines || []).includes(c))).slice(0, 2);
  document.getElementById('rd-similar').innerHTML = sim.length
    ? sim.map(s => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="openRest('${s._id || s.id}','${from}')">
        <div><div style="font-size:13px;font-weight:600">${s.emoji || '🍽️'} ${s.name}</div><div style="font-size:11px;color:var(--text3)">${(s.cuisines || []).join(', ')}</div></div>
        <span style="color:var(--orange)">→</span></div>`).join('')
    : '<div style="font-size:12px;color:var(--text3)">None found</div>';

  goPage('restaurant');
}

// ════════════════════════════════════════════════════════════════
// selectRest — personal only (unchanged from original, left for clarity)
// ════════════════════════════════════════════════════════════════
async function selectRest(id) {
  if (!S.user) { toast('Please log in first', 'err'); return; }
  if (!S.currentSession) { toast('Get recommendations first from the For You page', 'err'); return; }
  try {
    await req('POST', '/recommend/select', { sessionId: S.currentSession._id, restaurantId: id });
    const r = [...S.allRests, ...S.personalRests].find(x => String(x._id || x.id) === String(id));
    toast('"' + (r?.name || 'Restaurant') + '" logged — rate it after your visit! 🍽️', 'ok');
    checkPending(); setTimeout(() => goPage('home'), 1000);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ════════════════════════════════════════════════════════════════
// UPDATED S STATE ADDITIONS — add these to your S object:
// ════════════════════════════════════════════════════════════════
/*
const S = {
  // ... existing fields ...
  groupSessions:   [],     // sessions from /recommend/group
  groupVoteRestId: null,   // restaurant being voted on
  myVote:          null,   // true/false/null
  votes:           {},     // { userId: true/false }
};
*/
