// ==================== 全局状态 ====================
const socket = io({
    transports: ['polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    timeout: 20000
});
let deviceId = localStorage.getItem('device_id') || generateId();
let nickname = localStorage.getItem('nickname') || '我的设备';
let currentRooms = {};
let roomCreators = {}; // {type: device_id} 记录谁是房主
let rtcPeer = null;
let rtcDataChannel = null;
let receivedChunks = [];
let fileMeta = null;
let pendingFile = null;
let deviceListCache = [];
let rouletteInterval = null;
let scanTargetType = null;

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    localStorage.setItem('device_id', deviceId);
    document.getElementById('nicknameInput').value = nickname;

    document.querySelectorAll('.nav-card').forEach(card => {
        card.addEventListener('click', () => switchTab(card.dataset.tab));
    });

    socket.on('connect', () => {
        showToast('已连接服务器', 'success');
        updateConnStatus(true);
        socket.emit('register', {device_id: deviceId, nickname: nickname});
        // 重连后自动重新加入房间
        for (const [type, code] of Object.entries(currentRooms)) {
            if (code) socket.emit('join_room_socket', {room_code: code});
        }
    });

    socket.on('disconnect', (reason) => {
        updateConnStatus(false);
        console.log('[SOCKET] 断开原因:', reason);
    });
    socket.on('reconnect', (attemptNumber) => {
        showToast('已重新连接', 'success');
        updateConnStatus(true);
    });
    socket.on('reconnect_attempt', (attemptNumber) => {
        console.log('[SOCKET] 重连尝试 #' + attemptNumber);
    });
    socket.on('reconnect_error', (error) => {
        console.log('[SOCKET] 重连失败:', error);
    });
    socket.on('registered', (data) => {
        document.getElementById('onlineCount').textContent = data.online_count;
    });
    socket.on('device_online', (data) => {
        showToast(`${data.nickname} 上线`, 'success');
        fetchDevices();
    });
    socket.on('device_offline', () => fetchDevices());

    socket.on('webrtc_offer', handleRTCOffer);
    socket.on('webrtc_answer', handleRTCAnswer);
    socket.on('webrtc_ice_candidate', handleICECandidate);

    socket.on('clipboard_update', (data) => {
        if (currentRooms.clipboard === data.room_code) {
            showToast(`${data.item.nickname} 更新了剪贴板`, 'info');
            renderClipboardItem(data.item);
        }
    });

    socket.on('bill_update', (data) => {
        if (currentRooms.bill === data.room_code) loadBill(data.room_code);
    });

    socket.on('remote_control', (data) => handleRemoteCmd(data));

    socket.on('relay_message', (data) => {
        showToast(`收到 ${data.from_nickname || '未知设备'} 的链接`, 'info');
        renderRelayItem(data);
    });

    socket.on('dice_roll', (data) => {
        if (currentRooms.dice === data.room_code) showDiceResult(data.roll);
    });

    socket.on('vote_created', (data) => {
        if (currentRooms.vote === data.room_code) {
            showVoteActive(data.vote);
            checkOwner('vote', data.vote.created_by);
        }
    });
    socket.on('vote_update', (data) => {
        if (currentRooms.vote === data.room_code) updateVoteResults(data.options, data.total);
    });
    socket.on('vote_revealed', (data) => {
        if (currentRooms.vote === data.room_code) {
            updateVoteResults(data.options, data.total);
            document.getElementById('voteResultSection').style.display = 'block';
            document.getElementById('voteRevealBtn').style.display = 'none';
        }
    });

    socket.on('roulette_setup', (data) => {
        if (currentRooms.roulette === data.room_code) {
            document.getElementById('rouletteSetup').style.display = 'none';
            document.getElementById('rouletteGame').style.display = 'block';
        }
    });
    socket.on('roulette_spin', (data) => {
        if (currentRooms.roulette === data.room_code) startRouletteAnimation();
    });
    socket.on('roulette_result', (data) => {
        if (currentRooms.roulette === data.room_code) stopRouletteAnimation(data.winner);
    });

    socket.on('random_setup', (data) => {
        if (currentRooms.random === data.room_code) {
            document.getElementById('randomSetup').style.display = 'none';
            document.getElementById('randomGame').style.display = 'block';
        }
    });
    socket.on('random_result', (data) => {
        if (currentRooms.random === data.room_code && data.mode === 'group') {
            document.getElementById('randomResult').textContent = data.result;
            showToast(`${data.picker || '某人'} 抽中了: ${data.result}`, 'info');
        }
    });

    setInterval(() => { if (socket.connected) socket.emit('heartbeat', {device_id: deviceId}); }, 8000);
    fetchDevices();
    setInterval(fetchDevices, 10000);
    loadRelayInbox();
    setInterval(loadRelayInbox, 10000);

    handleUrlParams();
});

// ==================== 工具函数 ====================
function generateId() {
    return Math.random().toString(36).substring(2, 14);
}

function showToast(msg, type='info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function switchTab(tabId) {
    document.querySelectorAll('.nav-card').forEach(c => c.classList.remove('active'));
    document.querySelector(`.nav-card[data-tab="${tabId}"]`).classList.add('active');
    document.querySelectorAll('.card').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
}

function updateConnStatus(online) {
    const el = document.getElementById('connStatus');
    if (online) {
        el.textContent = '● 已连接';
        el.className = 'badge badge-online';
    } else {
        el.textContent = '● 断开';
        el.className = 'badge badge-offline';
    }
}

function saveNickname() {
    nickname = document.getElementById('nicknameInput').value || '我的设备';
    localStorage.setItem('nickname', nickname);
    socket.emit('register', {device_id: deviceId, nickname: nickname});
    showToast('昵称已保存', 'success');
}

async function fetchDevices() {
    try {
        const res = await fetch('/api/devices/online');
        const devices = await res.json();
        document.getElementById('onlineCount').textContent = devices.length;
        deviceListCache = devices;
        updateDeviceSelects(devices);
        updateInviteDevices(devices);
    } catch (e) {}
}

function updateDeviceSelects(devices) {
    const others = devices.filter(d => d.id !== deviceId);
    const opts = '<option value="">选择设备</option>' + others.map(d => 
        `<option value="${d.id}">${d.nickname}</option>`
    ).join('');

    const t1 = document.getElementById('transferTarget');
    const t2 = document.getElementById('shareTarget');
    const v1 = t1 ? t1.value : '';
    const v2 = t2 ? t2.value : '';

    if (t1) {
        t1.innerHTML = opts;
        if (v1 && others.find(d => d.id === v1)) t1.value = v1;
    }
    if (t2) {
        t2.innerHTML = opts;
        if (v2 && others.find(d => d.id === v2)) t2.value = v2;
    }
}

function updateInviteDevices(devices) {
    const container = document.getElementById('inviteDevices');
    if (!container) return;
    const others = devices.filter(d => d.id !== deviceId);
    if (others.length === 0) {
        container.innerHTML = '<span style="color:var(--gray-400)">暂无其他设备</span>';
        return;
    }
    container.innerHTML = others.map(d => 
        `<span class="device-chip"><span class="dot"></span>${d.nickname}</span>`
    ).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function handleUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const room = params.get('room');
    if (tab) {
        switchTab(tab);
        if (room) {
            setTimeout(() => {
                const map = {
                    transfer: 'transferRoomInput', share: 'shareRoomInput',
                    remote: 'clientRoomInput', clock: 'clockRoomInput',
                    clipboard: 'cbRoomInput', bill: 'billRoomInput',
                    dice: 'diceRoomInput', vote: 'voteRoomInput',
                    roulette: 'rouletteRoomInput', random: 'randomRoomInput'
                };
                const el = document.getElementById(map[tab]);
                if (el) el.value = room;
                // 自动显示加入输入框
                const joinMap = {
                    transfer: 'transfer', share: 'share', clipboard: 'clipboard',
                    bill: 'bill', dice: 'dice',
                    vote: 'vote', roulette: 'roulette', random: 'random'
                };
                if (joinMap[tab]) showJoinInput(joinMap[tab]);
            }, 200);
        }
    }
}

function showJoinInput(type) {
    const map = {
        transfer: 'transferJoinInput', share: 'shareJoinInput',
        clipboard: 'cbJoinInput', clock: 'clockJoinInput',
        bill: 'billJoinInput', dice: 'diceJoinInput',
        vote: 'voteJoinInput', roulette: 'rouletteJoinInput',
        random: 'randomJoinInput', remote: 'hostJoinInput',
        remoteClient: 'clientJoinInput'
    };
    const el = document.getElementById(map[type]);
    if (el) el.style.display = 'block';
}

// ==================== 扫码功能 ====================
function openScanModal(type) {
    scanTargetType = type;
    const modal = document.getElementById('scanModal');
    modal.classList.remove('hidden');
    const roomCode = currentRooms[type];
    const displayCode = roomCode || '请创建房间';
    document.getElementById('scanRoomCode').textContent = displayCode;
    const qr = document.getElementById('scanQR');
    qr.innerHTML = '';
    if (roomCode) {
        const url = `${window.location.origin}?tab=${type}&room=${roomCode}`;
        new QRCode(qr, {text: url, width: 180, height: 180});
    } else {
        qr.innerHTML = '<p style="color:var(--gray-400)">请先创建房间</p>';
    }
}

function closeScanModal() {
    document.getElementById('scanModal').classList.add('hidden');
    scanTargetType = null;
}

// ==================== 邀请面板 ====================
function openInvite() {
    const modal = document.getElementById('inviteModal');
    modal.classList.remove('hidden');
    const qr = document.getElementById('inviteQR');
    qr.innerHTML = '';
    let activeRoom = null;
    let activeType = null;
    for (const [type, code] of Object.entries(currentRooms)) {
        if (code) { activeRoom = code; activeType = type; break; }
    }
    if (activeRoom) {
        const url = `${window.location.origin}?tab=${activeType}&room=${activeRoom}`;
        new QRCode(qr, {text: url, width: 160, height: 160});
    } else {
        new QRCode(qr, {text: window.location.href, width: 160, height: 160});
    }
    fetchDevices();
}

function closeInvite() {
    document.getElementById('inviteModal').classList.add('hidden');
}

// ==================== 房间系统 ====================
async function createRoom(type) {
    const nameMap = {
        transfer: '文件传输房间', share: '网站分享房间', clipboard: '剪贴板房间',
        remote: '遥控房间', clock: '计时器房间', bill: 'AA账单',
        dice: '掷骰子房间', vote: '投票房间', roulette: '抽人房间', random: '随机决定房间'
    };
    const res = await fetch('/api/room/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({type, name: nameMap[type] || '房间', device_id: deviceId})
    });
    const data = await res.json();
    roomCreators[type] = deviceId;

    const inputMap = {
        transfer: 'transferRoomInput', share: 'shareRoomInput',
        clipboard: 'cbRoomInput', remote: 'hostRoomInput', clock: 'clockRoomInput',
        bill: 'billRoomInput', dice: 'diceRoomInput', vote: 'voteRoomInput',
        roulette: 'rouletteRoomInput', random: 'randomRoomInput'
    };
    const input = document.getElementById(inputMap[type]);
    if (input) input.value = data.room_code;
    joinRoom(type);
}

async function joinRoom(type, subtype) {
    const inputMap = {
        transfer: 'transferRoomInput', share: 'shareRoomInput',
        clipboard: 'cbRoomInput', remote: subtype === 'client' ? 'clientRoomInput' : 'hostRoomInput',
        clock: 'clockRoomInput', bill: 'billRoomInput', dice: 'diceRoomInput',
        vote: 'voteRoomInput', roulette: 'rouletteRoomInput', random: 'randomRoomInput'
    };
    const input = document.getElementById(inputMap[type]);
    const code = input.value.trim().toUpperCase();
    if (!code) { showToast('请输入房间码', 'error'); return; }

    const res = await fetch(`/api/room/${code}/join`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device_id: deviceId})
    });

    if (!res.ok) { showToast('房间不存在', 'error'); return; }

    // 获取房间信息看谁是房主
    const roomRes = await fetch(`/api/room/${code}`);
    const roomData = await roomRes.json();
    roomCreators[type] = roomData.created_by;

    currentRooms[type] = code;
    socket.emit('join_room_socket', {room_code: code});

    if (type === 'transfer') {
        document.getElementById('transferJoinPanel').style.display = 'none';
        document.getElementById('transferPanel').style.display = 'block';
        document.getElementById('transferRoomBar').style.display = 'flex';
        document.getElementById('transferRoomCode').textContent = code;
    } else if (type === 'share') {
        document.getElementById('shareJoinPanel').style.display = 'none';
        document.getElementById('sharePanel').style.display = 'block';
        document.getElementById('shareRoomBar').style.display = 'flex';
        document.getElementById('shareRoomCode').textContent = code;
    } else if (type === 'clipboard') {
        document.getElementById('cbJoinPanel').style.display = 'none';
        document.getElementById('cbPanel').style.display = 'block';
        document.getElementById('cbRoomBar').style.display = 'flex';
        document.getElementById('cbRoomCode').textContent = code;
        loadClipboard(code);
    } else if (type === 'remote') {
        if (subtype === 'client') {
            document.getElementById('clientPanel').style.display = 'none';
            document.getElementById('clientActive').style.display = 'block';
        } else {
            document.getElementById('hostPanel').style.display = 'none';
            document.getElementById('hostActive').style.display = 'block';
            document.getElementById('hostRoomCode').textContent = code;
            const qr = document.getElementById('hostQR');
            qr.innerHTML = '';
            const url = `${window.location.origin}?tab=remote&room=${code}`;
            new QRCode(qr, {text: url, width: 160, height: 160});
        }
    } else if (type === 'bill') {
        document.getElementById('billJoinPanel').style.display = 'none';
        document.getElementById('billPanel').style.display = 'block';
        document.getElementById('billRoomBar').style.display = 'flex';
        document.getElementById('billRoomCode').textContent = code;
        loadBill(code);
    } else if (type === 'dice') {
        document.getElementById('diceJoinPanel').style.display = 'none';
        document.getElementById('dicePanel').style.display = 'block';
        document.getElementById('diceRoomBar').style.display = 'flex';
        document.getElementById('diceRoomCode').textContent = code;
        await fetch(`/api/dice/${code}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({action: 'join', device_id: deviceId})
        });
        loadDiceHistory(code);
    } else if (type === 'vote') {
        document.getElementById('voteJoinPanel').style.display = 'none';
        document.getElementById('votePanel').style.display = 'block';
        document.getElementById('voteRoomBar').style.display = 'flex';
        document.getElementById('voteRoomCode').textContent = code;
        loadVote(code);
    } else if (type === 'roulette') {
        document.getElementById('rouletteJoinPanel').style.display = 'none';
        document.getElementById('roulettePanel').style.display = 'block';
        document.getElementById('rouletteRoomBar').style.display = 'flex';
        document.getElementById('rouletteRoomCode').textContent = code;
    } else if (type === 'random') {
        document.getElementById('randomJoinPanel').style.display = 'none';
        document.getElementById('randomPanel').style.display = 'block';
        document.getElementById('randomRoomBar').style.display = 'flex';
        document.getElementById('randomRoomCode').textContent = code;
    }

    showToast(`已加入房间 ${code}`, 'success');
}

function leaveRoom(type) {
    delete currentRooms[type];
    delete roomCreators[type];
    socket.emit('leave_room_socket', {room_code: ''});

    const resetMap = {
        transfer: {join: 'transferJoinPanel', panel: 'transferPanel', bar: 'transferRoomBar', input: 'transferRoomInput'},
        share: {join: 'shareJoinPanel', panel: 'sharePanel', bar: 'shareRoomBar', input: 'shareRoomInput'},
        clipboard: {join: 'cbJoinPanel', panel: 'cbPanel', bar: 'cbRoomBar', input: 'cbRoomInput'},
        bill: {join: 'billJoinPanel', panel: 'billPanel', bar: 'billRoomBar', input: 'billRoomInput'},
        dice: {join: 'diceJoinPanel', panel: 'dicePanel', bar: 'diceRoomBar', input: 'diceRoomInput'},
        vote: {join: 'voteJoinPanel', panel: 'votePanel', bar: 'voteRoomBar', input: 'voteRoomInput'},
        roulette: {join: 'rouletteJoinPanel', panel: 'roulettePanel', bar: 'rouletteRoomBar', input: 'rouletteRoomInput'},
        random: {join: 'randomJoinPanel', panel: 'randomPanel', bar: 'randomRoomBar', input: 'randomRoomInput'}
    };

    if (type === 'remote') {
        document.getElementById('hostPanel').style.display = 'block';
        document.getElementById('hostActive').style.display = 'none';
        document.getElementById('clientPanel').style.display = 'block';
        document.getElementById('clientActive').style.display = 'none';
        document.getElementById('hostRoomInput').value = '';
        document.getElementById('clientRoomInput').value = '';
    } else if (resetMap[type]) {
        const m = resetMap[type];
        document.getElementById(m.join).style.display = 'block';
        document.getElementById(m.panel).style.display = 'none';
        document.getElementById(m.bar).style.display = 'none';
        document.getElementById(m.input).value = '';
        // 隐藏加入输入框
        const joinInputId = m.join.replace('Panel', 'Input');
        const joinInput = document.getElementById(joinInputId);
        if (joinInput) joinInput.style.display = 'none';
    }

}

function checkOwner(type, creatorId) {
    const isOwner = creatorId === deviceId;
    if (type === 'vote') {
        document.getElementById('voteEditBtn').style.display = isOwner ? 'inline-flex' : 'none';
    } else if (type === 'random') {
        document.getElementById('randomEditBtn').style.display = isOwner ? 'inline-flex' : 'none';
    }
}

// ==================== 1. 文件传输 ====================
async function initRTC(target, initiator=true) {
    const cfg = {iceServers: [{urls:'stun:stun.l.google.com:19302'}, {urls:'stun:stun1.l.google.com:19302'}]};
    rtcPeer = new RTCPeerConnection(cfg);
    rtcPeer.onicecandidate = (e) => {
        if (e.candidate) socket.emit('webrtc_ice_candidate', {
            target_device: target, candidate: e.candidate, from_device: deviceId
        });
    };
    rtcPeer.ondatachannel = (e) => setupChannel(e.channel);
    if (initiator) {
        rtcDataChannel = rtcPeer.createDataChannel('file');
        setupChannel(rtcDataChannel);
        const offer = await rtcPeer.createOffer();
        await rtcPeer.setLocalDescription(offer);
        socket.emit('webrtc_offer', {
            target_device: target, offer, from_device: deviceId, from_nickname: nickname
        });
    }
}

function setupChannel(ch) {
    rtcDataChannel = ch;
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => {
        showToast('连接已建立', 'success');
        if (pendingFile) sendFileData();
    };
    ch.onmessage = (e) => {
        if (typeof e.data === 'string') {
            const msg = JSON.parse(e.data);
            if (msg.type === 'meta') {
                fileMeta = msg;
                receivedChunks = [];
                showTransferStatus(`接收中: ${msg.name}`, 0);
            } else if (msg.type === 'done') {
                const blob = new Blob(receivedChunks);
                const url = URL.createObjectURL(blob);
                const div = document.createElement('div');
                div.className = 'file-item';
                div.innerHTML = `<span>📄 ${escapeHtml(fileMeta.name)} (${formatSize(fileMeta.size)})</span><a href="${url}" download="${fileMeta.name}" class="btn btn-sm btn-primary">下载</a>`;
                document.getElementById('receivedFiles').prepend(div);
                showToast('文件接收完成', 'success');
                document.getElementById('transferStatus').innerHTML = '';
                // 清理状态，防止标题残留
                fileMeta = null;
                receivedChunks = [];
            }
        } else {
            receivedChunks.push(e.data);
            if (fileMeta) {
                const pct = Math.min(100, receivedChunks.length * 16384 / fileMeta.size * 100);
                showTransferStatus(`接收中: ${fileMeta.name}`, pct);
            }
        }
    };
}

async function handleRTCOffer(data) {
    const cfg = {iceServers: [{urls:'stun:stun.l.google.com:19302'}, {urls:'stun:stun1.l.google.com:19302'}]};
    rtcPeer = new RTCPeerConnection(cfg);
    rtcPeer.onicecandidate = (e) => {
        if (e.candidate) socket.emit('webrtc_ice_candidate', {
            target_device: data.from_device, candidate: e.candidate, from_device: deviceId
        });
    };
    rtcPeer.ondatachannel = (e) => setupChannel(e.channel);
    await rtcPeer.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await rtcPeer.createAnswer();
    await rtcPeer.setLocalDescription(answer);
    socket.emit('webrtc_answer', {target_device: data.from_device, answer, from_device: deviceId});
    showToast(`${data.from_nickname || '某设备'} 请求发送文件`, 'info');
}

async function handleRTCAnswer(data) {
    await rtcPeer.setRemoteDescription(new RTCSessionDescription(data.answer));
}

async function handleICECandidate(data) {
    if (rtcPeer) await rtcPeer.addIceCandidate(new RTCIceCandidate(data.candidate));
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    const target = document.getElementById('transferTarget').value;
    if (!target) { showToast('请选择接收设备', 'error'); return; }
    pendingFile = file;
    fileMeta = {name: file.name, size: file.size, type: file.type};
    initRTC(target, true);
    showTransferStatus(`准备发送: ${file.name}`, 0);
}

function sendFileData() {
    if (!rtcDataChannel || rtcDataChannel.readyState !== 'open' || !pendingFile) return;
    rtcDataChannel.send(JSON.stringify({type:'meta', ...fileMeta}));
    const chunkSize = 16384;
    let offset = 0;
    const reader = new FileReader();
    reader.onload = (e) => {
        rtcDataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        const pct = Math.min(100, offset / pendingFile.size * 100);
        showTransferStatus(`发送中: ${fileMeta.name}`, pct);
        if (offset < pendingFile.size) readChunk();
        else {
            rtcDataChannel.send(JSON.stringify({type:'done'}));
            showToast('发送完成', 'success');
            pendingFile = null;
            fileMeta = null; // 清理，防止标题残留
            document.getElementById('transferStatus').innerHTML = '';
        }
    };
    function readChunk() { reader.readAsArrayBuffer(pendingFile.slice(offset, offset + chunkSize)); }
    readChunk();
}

function showTransferStatus(text, pct) {
    document.getElementById('transferStatus').innerHTML = `
        <p style="font-size:0.875rem;margin-bottom:4px">${escapeHtml(text)}</p>
        <div style="width:100%;height:6px;background:var(--gray-200);border-radius:3px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:var(--primary);transition:width 0.3s"></div>
        </div>`;
}

function clearReceived() {
    document.getElementById('receivedFiles').innerHTML = '';
}

function formatSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
    return (b/(1024*1024)).toFixed(1) + ' MB';
}

document.getElementById('dropZone').addEventListener('dragover', e => { e.preventDefault(); e.currentTarget.classList.add('dragover'); });
document.getElementById('dropZone').addEventListener('dragleave', e => { e.currentTarget.classList.remove('dragover'); });
document.getElementById('dropZone').addEventListener('drop', e => {
    e.preventDefault(); e.currentTarget.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFileSelect({target:{files:e.dataTransfer.files}});
});

// ==================== 2. 网站快捷分享 ====================
function generateShareQR() {
    const url = document.getElementById('shareUrl').value.trim();
    const box = document.getElementById('shareQR');
    box.innerHTML = '';
    if (!url) return;
    new QRCode(box, {text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M});
}

async function sendLinkRelay() {
    const url = document.getElementById('shareUrl').value.trim();
    const target = document.getElementById('shareTarget').value;
    if (!url) { showToast('请输入网址', 'error'); return; }
    if (!target) { showToast('请选择目标设备', 'error'); return; }
    await fetch('/api/relay', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from_device: deviceId, from_nickname: nickname, to_device: target, content: url, type: 'link'})
    });
    showToast('链接已发送', 'success');
}

async function loadRelayInbox() {
    const res = await fetch(`/api/relay/${deviceId}`);
    const msgs = await res.json();
    const box = document.getElementById('relayInbox');
    if (!msgs.length) { box.innerHTML = '<p style="color:var(--gray-400);font-size:0.875rem">暂无收到的链接</p>'; return; }
    box.innerHTML = msgs.map(m => renderRelayHTML(m)).join('');
}

function renderRelayItem(data) {
    const box = document.getElementById('relayInbox');
    const div = document.createElement('div');
    div.innerHTML = renderRelayHTML(data);
    box.prepend(div.firstElementChild);
}

function renderRelayHTML(m) {
    return `<div class="file-item" style="margin-bottom:8px">
        <div style="overflow:hidden">
            <div style="font-size:0.8rem;color:var(--gray-500)">来自 ${escapeHtml(m.from_nickname || '未知')}</div>
            <div style="font-size:0.875rem;word-break:break-all">${escapeHtml(m.content)}</div>
        </div>
        <a href="${m.content}" target="_blank" class="btn btn-sm btn-primary" style="flex-shrink:0">打开</a>
    </div>`;
}

// ==================== 3. 剪贴板 ====================
async function sendClipboard() {
    const content = document.getElementById('cbContent').value.trim();
    if (!content || !currentRooms.clipboard) return;
    await fetch(`/api/clipboard/${currentRooms.clipboard}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device_id: deviceId, nickname: nickname, content})
    });
    document.getElementById('cbContent').value = '';
}

async function loadClipboard(code) {
    const res = await fetch(`/api/clipboard/${code}`);
    const items = await res.json();
    const box = document.getElementById('cbHistory');
    box.innerHTML = '';
    items.forEach(item => renderClipboardItem(item, false));
}

function renderClipboardItem(item, prepend=true) {
    const box = document.getElementById('cbHistory');
    const div = document.createElement('div');
    div.className = 'clip-item';
    div.innerHTML = `
        <div class="clip-content">${escapeHtml(item.content)}</div>
        <div class="clip-meta">
            <span>${escapeHtml(item.nickname)} · ${new Date(item.time).toLocaleString()}</span>
            <button class="btn btn-sm btn-secondary" onclick="copyText(this)">📋 复制</button>
        </div>`;
    div.querySelector('button').dataset.text = item.content;
    if (prepend) box.prepend(div); else box.appendChild(div);
}

async function copyText(btn) {
    const text = btn.dataset.text;
    try {
        await navigator.clipboard.writeText(text);
        showToast('已复制', 'success');
    } catch (err) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('已复制', 'success');
    }
}

// ==================== 4. 手机遥控（加强版） ====================
function sendRemote(action) {
    if (!currentRooms.remote) return;
    socket.emit('remote_control', {
        room_code: currentRooms.remote,
        action: action,
        from_device: deviceId,
        from_nickname: nickname
    });
    showToast(`发送: ${action}`, 'info');
}

function handleRemoteCmd(data) {
    const log = document.getElementById('remoteLog');
    if (log) {
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${data.from_nickname || '未知'} → ${data.action}`;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
    }
    simulateKeyForPPT(data.action);
    showToast(`遥控: ${data.action}`, 'info');
}

function simulateKeyForPPT(action) {
    const keyMap = {
        'next': {key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39},
        'prev': {key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, which: 37},
        'play': {key: ' ', code: 'Space', keyCode: 32, which: 32}
    };
    const k = keyMap[action];
    if (!k) return;

    // 方法1-3: document, body, window
    [document, document.body, window].forEach(target => {
        ['keydown', 'keypress', 'keyup'].forEach(type => {
            target.dispatchEvent(new KeyboardEvent(type, {
                key: k.key, code: k.code, keyCode: k.keyCode, which: k.which,
                bubbles: true, cancelable: true, view: window,
                charCode: 0, shiftKey: false, ctrlKey: false, altKey: false
            }));
        });
    });

    // 方法4: 视频元素控制
    document.querySelectorAll('video').forEach(v => {
        if (action === 'play') { if (v.paused) v.play(); else v.pause(); }
    });

    // 方法5: 焦点元素
    window.focus();
    const active = document.activeElement;
    if (active && active !== document.body) {
        ['keydown', 'keyup'].forEach(type => {
            active.dispatchEvent(new KeyboardEvent(type, {
                key: k.key, code: k.code, keyCode: k.keyCode, which: k.which,
                bubbles: true, cancelable: true
            }));
        });
    }

    // 方法6: 创建并触发原生事件（兼容旧版浏览器）
    try {
        const evt = document.createEvent('KeyboardEvent');
        evt.initKeyboardEvent('keydown', true, true, window, k.key, 0, false, false, false, false);
        Object.defineProperty(evt, 'keyCode', {value: k.keyCode});
        Object.defineProperty(evt, 'which', {value: k.which});
        document.dispatchEvent(evt);
    } catch(e) {}
}



// ==================== 6. AA账单 ====================
async function addBillItem() {
    const desc = document.getElementById('billDesc').value.trim();
    const amount = parseFloat(document.getElementById('billAmount').value);
    const payer = document.getElementById('billPayer').value.trim();
    const parts = document.getElementById('billParticipants').value.trim();
    if (!desc || isNaN(amount) || !payer || !parts) { showToast('请填写完整', 'error'); return; }
    const participants = parts.split(/[,，]/).map(s => s.trim()).filter(s => s);
    const code = currentRooms.bill;
    await fetch(`/api/bill/${code}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({})});
    await fetch(`/api/bill/${code}/item`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({description: desc, amount, payer, participants})
    });
    document.getElementById('billDesc').value = '';
    document.getElementById('billAmount').value = '';
    document.getElementById('billPayer').value = '';
    document.getElementById('billParticipants').value = '';
    loadBill(code);
}

async function loadBill(code) {
    const res = await fetch(`/api/bill/${code}`);
    const data = await res.json();
    const box = document.getElementById('billItems');
    const items = data.items || [];
    if (!items.length) { box.innerHTML = '<p style="color:var(--gray-400);font-size:0.875rem">暂无记录</p>'; return; }
    box.innerHTML = items.map(item => `
        <div class="bill-item">
            <div>
                <div style="font-weight:600">${escapeHtml(item.description)}</div>
                <div style="font-size:0.75rem;color:var(--gray-500)">付款: ${escapeHtml(item.payer)}</div>
            </div>
            <div style="font-weight:700;color:var(--primary)">¥${item.amount.toFixed(2)}</div>
        </div>
    `).join('');
}

async function calculateBill() {
    const code = currentRooms.bill;
    const res = await fetch(`/api/bill/${code}/calculate`);
    const r = await res.json();
    const box = document.getElementById('billResult');
    box.style.display = 'block';
    let html = `<h4 style="margin-bottom:12px;color:#166534">总计: ¥${r.total.toFixed(2)}</h4>`;
    html += '<div style="margin-bottom:12px"><strong>余额:</strong></div>';
    for (const [p, b] of Object.entries(r.balances)) {
        const color = b >= -0.01 ? 'var(--success)' : 'var(--danger)';
        const sign = b >= 0 ? '+' : '';
        html += `<div style="margin-bottom:4px">${escapeHtml(p)}: <span style="color:${color};font-weight:600">${sign}¥${b.toFixed(2)}</span></div>`;
    }
    if (r.transactions.length) {
        html += '<div style="margin-top:12px"><strong>建议转账:</strong></div>';
        html += r.transactions.map(t => 
            `<div style="margin-bottom:4px">${escapeHtml(t.from)} → ${escapeHtml(t.to)}: <b>¥${t.amount.toFixed(2)}</b></div>`
        ).join('');
    } else {
        html += '<div style="margin-top:12px;color:var(--gray-500)">已平衡，无需转账</div>';
    }
    box.innerHTML = html;
}

// ==================== 7. 同步掷骰子 ====================
async function rollDice() {
    if (!currentRooms.dice) return;
    const res = await fetch(`/api/dice/${currentRooms.dice}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'roll', device_id: deviceId, nickname: nickname})
    });
    const data = await res.json();
    animateDice(data.result);
}

function animateDice(finalResult) {
    const display = document.getElementById('diceDisplay');
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    let count = 0;
    const interval = setInterval(() => {
        display.textContent = faces[Math.floor(Math.random() * 6)];
        count++;
        if (count > 10) {
            clearInterval(interval);
            display.textContent = faces[finalResult - 1];
        }
    }, 80);
}

function showDiceResult(roll) {
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    document.getElementById('diceDisplay').textContent = faces[roll.result - 1];
    document.getElementById('diceResultText').textContent = `点数: ${roll.result}`;
    document.getElementById('diceRoller').textContent = `${roll.nickname || '未知'} 掷出了 ${roll.result} 点`;
    loadDiceHistory(currentRooms.dice);
}

async function loadDiceHistory(code) {
    const res = await fetch(`/api/dice/${code}`);
    const data = await res.json();
    const box = document.getElementById('diceHistory');
    const history = data.history || [];
    if (!history.length) { box.innerHTML = '<p style="color:var(--gray-400);font-size:0.875rem">暂无记录</p>'; return; }
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    box.innerHTML = history.slice().reverse().map(h => `
        <div class="bill-item" style="margin-bottom:6px">
            <span>${escapeHtml(h.nickname)}</span>
            <span style="font-size:1.2rem">${faces[h.result - 1]} ${h.result}</span>
        </div>
    `).join('');
}

// ==================== 8. 匿名投票 ====================
async function createVote() {
    const question = document.getElementById('voteQuestion').value.trim();
    const optionsText = document.getElementById('voteOptions').value.trim();
    if (!question || !optionsText) { showToast('请填写问题和选项', 'error'); return; }
    const options = optionsText.split('\n').map(s => s.trim()).filter(s => s);
    if (options.length < 2) { showToast('至少需要2个选项', 'error'); return; }

    const res = await fetch(`/api/vote/${currentRooms.vote}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({question, options, device_id: deviceId})
    });
    const data = await res.json();
    if (data.success) {
        showToast('投票已创建', 'success');
        // 本地立即切换显示
        document.getElementById('voteCreateSection').style.display = 'none';
        document.getElementById('voteActiveSection').style.display = 'block';
        document.getElementById('voteQuestionDisplay').textContent = question;
        document.getElementById('voteOptionsList').innerHTML = options.map(opt => `
            <button class="btn btn-secondary w-full mb-2" style="justify-content:space-between" onclick="castVote('${escapeHtml(opt).replace(/'/g, "\'")}')">
                <span>${escapeHtml(opt)}</span>
                <span style="color:var(--gray-500)">0 票</span>
            </button>
        `).join('');
        checkOwner('vote', deviceId);
    } else {
        showToast(data.error || '创建失败', 'error');
    }
}

async function loadVote(code) {
    const res = await fetch(`/api/vote/${code}`);
    const data = await res.json();
    if (!data) {
        document.getElementById('voteCreateSection').style.display = 'block';
        document.getElementById('voteActiveSection').style.display = 'none';
        return;
    }
    showVoteActive(data);
    checkOwner('vote', data.created_by);
}

function showVoteActive(data) {
    document.getElementById('voteCreateSection').style.display = 'none';
    document.getElementById('voteActiveSection').style.display = 'block';
    document.getElementById('voteQuestionDisplay').textContent = data.question;

    const box = document.getElementById('voteOptionsList');
    box.innerHTML = Object.entries(data.options).map(([opt, count]) => `
        <button class="btn btn-secondary w-full mb-2" style="justify-content:space-between" onclick="castVote('${escapeHtml(opt).replace(/'/g, "\'")}')">
            <span>${escapeHtml(opt)}</span>
            <span style="color:var(--gray-500)">${count} 票</span>
        </button>
    `).join('');

    if (data.revealed) {
        document.getElementById('voteResultSection').style.display = 'block';
        document.getElementById('voteRevealBtn').style.display = 'none';
        updateVoteResults(data.options, data.total);
    } else {
        document.getElementById('voteResultSection').style.display = 'none';
        document.getElementById('voteRevealBtn').style.display = 'block';
    }
}

async function castVote(option) {
    await fetch(`/api/vote/${currentRooms.vote}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device_id: deviceId, option})
    });
    showToast('投票成功', 'success');
}

function updateVoteResults(options, total) {
    const box = document.getElementById('voteResults');
    document.getElementById('voteTotal').textContent = total;
    const max = Math.max(...Object.values(options), 1);
    box.innerHTML = Object.entries(options).map(([opt, count]) => {
        const pct = total > 0 ? (count / total * 100).toFixed(1) : 0;
        const width = max > 0 ? (count / max * 100) : 0;
        return `
            <div style="margin-bottom:10px">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:0.875rem">
                    <span>${escapeHtml(opt)}</span>
                    <span>${count} 票 (${pct}%)</span>
                </div>
                <div style="width:100%;height:8px;background:var(--gray-200);border-radius:4px;overflow:hidden">
                    <div style="width:${width}%;height:100%;background:var(--primary);transition:width 0.3s"></div>
                </div>
            </div>`;
    }).join('');
}

async function revealVote() {
    await fetch(`/api/vote/${currentRooms.vote}/reveal`, {method: 'POST'});
}

function editVote() {
    document.getElementById('voteCreateSection').style.display = 'block';
    document.getElementById('voteActiveSection').style.display = 'none';
}

// ==================== 9. 随机抽人 ====================
async function setupRoulette() {
    const namesText = document.getElementById('rouletteNames').value.trim();
    let names = [];
    let mode = 'manual';

    if (namesText) {
        names = namesText.split('\n').map(s => s.trim()).filter(s => s);
        if (names.length < 2) { showToast('至少需要2人', 'error'); return; }
    } else {
        // 不输入名单，使用房间成员
        mode = 'auto';
        const res = await fetch(`/api/room/${currentRooms.roulette}`);
        const roomData = await res.json();
        // 从在线设备中获取房间成员昵称
        names = deviceListCache
            .filter(d => d.id !== deviceId)
            .map(d => d.nickname);
        if (names.length < 1) { showToast('房间内暂无其他成员', 'error'); return; }
    }

    await fetch(`/api/roulette/${currentRooms.roulette}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'setup', names, mode, device_id: deviceId})
    });
    document.getElementById('rouletteSetup').style.display = 'none';
    document.getElementById('rouletteGame').style.display = 'block';
    showToast('名单已确定', 'success');
}

async function spinRoulette() {
    if (!currentRooms.roulette) return;
    document.getElementById('rouletteSpinBtn').disabled = true;
    await fetch(`/api/roulette/${currentRooms.roulette}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'spin'})
    });
}

function startRouletteAnimation() {
    const display = document.getElementById('rouletteDisplay');
    document.getElementById('rouletteWinner').textContent = '';
    document.getElementById('rouletteSpinBtn').disabled = true;

    fetch(`/api/roulette/${currentRooms.roulette}`)
        .then(r => r.json())
        .then(data => {
            let names = data.names || [];
            if (!names.length) {
                names = deviceListCache.filter(d => d.id !== deviceId).map(d => d.nickname);
            }
            if (!names.length) names = ['未知'];
            let count = 0;
            rouletteInterval = setInterval(() => {
                display.textContent = names[Math.floor(Math.random() * names.length)];
                count++;
            }, 100);
        });
}

function stopRouletteAnimation(winner) {
    if (rouletteInterval) clearInterval(rouletteInterval);
    document.getElementById('rouletteDisplay').textContent = winner;
    document.getElementById('rouletteWinner').textContent = `🎉 ${winner} 被选中！`;
    document.getElementById('rouletteSpinBtn').disabled = false;
    showToast(`抽中: ${winner}`, 'success');

    // 全屏显示结果
    document.getElementById('rouletteResultName').textContent = winner;
    document.getElementById('rouletteResultModal').classList.remove('hidden');
}

function closeRouletteResult() {
    document.getElementById('rouletteResultModal').classList.add('hidden');
}

// ==================== 10. 随机决定器 ====================
async function setupRandom() {
    const optionsText = document.getElementById('randomOptions').value.trim();
    const mode = document.getElementById('randomMode').value;
    if (!optionsText) { showToast('请输入选项', 'error'); return; }
    const options = optionsText.split('\n').map(s => s.trim()).filter(s => s);
    if (options.length < 2) { showToast('至少需要2个选项', 'error'); return; }
    await fetch(`/api/random/${currentRooms.random}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'setup', options, mode, device_id: deviceId})
    });
    document.getElementById('randomSetup').style.display = 'none';
    document.getElementById('randomGame').style.display = 'block';
    checkOwner('random', deviceId);
    showToast('选项已确定', 'success');
}

async function pickRandom() {
    if (!currentRooms.random) return;
    const res = await fetch(`/api/random/${currentRooms.random}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'pick', nickname: nickname, device_id: deviceId})
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); return; }

    // 本地动画
    const resultEl = document.getElementById('randomResult');
    fetch(`/api/random/${currentRooms.random}`)
        .then(r => r.json())
        .then(rData => {
            const opts = rData.options || [];
            let count = 0;
            const interval = setInterval(() => {
                resultEl.textContent = opts[Math.floor(Math.random() * opts.length)] || '?';
                count++;
                if (count > 15) {
                    clearInterval(interval);
                    resultEl.textContent = data.result;
                    showToast(`结果: ${data.result}`, 'success');
                }
            }, 80);
        });
}

function editRandom() {
    document.getElementById('randomSetup').style.display = 'block';
    document.getElementById('randomGame').style.display = 'none';
}
