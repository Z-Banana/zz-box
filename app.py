import os
import random
import string
import time
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'cross-device-toolbox-secret')
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# 内存数据
online_devices = {}
rooms = {}
clipboard_data = {}
bill_data = {}
relay_messages = []

# 新功能
vote_data = {}
dice_rooms = {}
roulette_data = {}
random_picker = {}

# ==================== 工具函数 ====================
def generate_code(length=6):
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=length))

def generate_device_id():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=12))

def now_ts():
    return datetime.now()

def clean_offline():
    timeout = timedelta(minutes=2)
    now = now_ts()
    offline = [did for did, info in online_devices.items() if now - info.get('last_seen', now) > timeout]
    for did in offline:
        del online_devices[did]
        socketio.emit('device_offline', {'device_id': did})


# ==================== 页面路由 ====================
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/about')
def about():
    return render_template('about.html')

# ==================== API: 设备 ====================
@app.route('/api/device/register', methods=['POST'])
def register_device():
    data = request.json or {}
    device_id = data.get('device_id') or generate_device_id()
    nickname = data.get('nickname', '未知设备')
    online_devices[device_id] = {
        'nickname': nickname,
        'sid': None,
        'last_seen': now_ts(),
        'ip': request.remote_addr
    }
    return jsonify({'device_id': device_id, 'nickname': nickname})

@app.route('/api/devices/online')
def get_online_devices():
    clean_offline()
    return jsonify([
        {'id': did, 'nickname': info['nickname'], 'ip': info.get('ip')}
        for did, info in online_devices.items()
    ])

# ==================== API: 房间 ====================
@app.route('/api/room/create', methods=['POST'])
def create_room():
    data = request.json or {}
    room_type = data.get('type', 'general')
    name = data.get('name', '未命名房间')
    created_by = data.get('device_id')
    room_code = generate_code()
    rooms[room_code] = {
        'type': room_type,
        'name': name,
        'created_by': created_by,
        'created_at': now_ts(),
        'members': set()
    }
    return jsonify({'room_code': room_code, 'name': name})

@app.route('/api/room/<code>/join', methods=['POST'])
def join_room_api(code):
    data = request.json or {}
    device_id = data.get('device_id')
    room = rooms.get(code.upper())
    if not room:
        return jsonify({'error': '房间不存在'}), 404
    room['members'].add(device_id)
    return jsonify({'room_code': code.upper(), 'name': room['name']})

@app.route('/api/room/<code>')
def get_room(code):
    room = rooms.get(code.upper())
    if not room:
        return jsonify({'error': '房间不存在'}), 404
    return jsonify({
        'room_code': code.upper(),
        'name': room['name'],
        'type': room['type'],
        'member_count': len(room['members']),
        'created_by': room.get('created_by')
    })

# ==================== API: 剪贴板 ====================
@app.route('/api/clipboard/<room_code>', methods=['GET', 'POST'])
def clipboard_api(room_code):
    room_code = room_code.upper()
    if request.method == 'POST':
        data = request.json or {}
        item = {
            'device_id': data.get('device_id'),
            'nickname': data.get('nickname'),
            'content': data.get('content', ''),
            'time': now_ts().isoformat()
        }
        clipboard_data.setdefault(room_code, [])
        clipboard_data[room_code].insert(0, item)
        clipboard_data[room_code] = clipboard_data[room_code][:50]
        socketio.emit('clipboard_update', {'room_code': room_code, 'item': item}, room=room_code)
        return jsonify({'success': True})
    return jsonify(clipboard_data.get(room_code, []))

# ==================== API: 账单 ====================
@app.route('/api/bill/<room_code>', methods=['GET', 'POST'])
def bill_api(room_code):
    room_code = room_code.upper()
    if request.method == 'POST':
        if room_code not in bill_data:
            bill_data[room_code] = {'title': 'AA账单', 'items': []}
        return jsonify({'room_code': room_code})
    return jsonify(bill_data.get(room_code, {'title': 'AA账单', 'items': []}))

@app.route('/api/bill/<room_code>/item', methods=['POST'])
def add_bill_item(room_code):
    room_code = room_code.upper()
    data = request.json or {}
    item = {
        'id': random.randint(100000, 999999),
        'description': data.get('description'),
        'amount': float(data.get('amount', 0)),
        'payer': data.get('payer'),
        'participants': data.get('participants', [])
    }
    bill_data.setdefault(room_code, {'title': 'AA账单', 'items': []})
    bill_data[room_code]['items'].append(item)
    socketio.emit('bill_update', {'room_code': room_code}, room=room_code)
    return jsonify({'item_id': item['id']})

@app.route('/api/bill/<room_code>/calculate')
def calculate_bill(room_code):
    room_code = room_code.upper()
    items = bill_data.get(room_code, {}).get('items', [])
    balances = {}
    for item in items:
        amount = item['amount']
        payer = item['payer']
        participants = item.get('participants', [])
        if not participants:
            continue
        share = amount / len(participants)
        balances[payer] = balances.get(payer, 0) + amount
        for p in participants:
            balances[p] = balances.get(p, 0) - share

    debtors = [(p, -b) for p, b in balances.items() if b < -0.01]
    creditors = [(p, b) for p, b in balances.items() if b > 0.01]
    transactions = []
    debtors.sort(key=lambda x: x[1], reverse=True)
    creditors.sort(key=lambda x: x[1], reverse=True)
    i, j = 0, 0
    while i < len(debtors) and j < len(creditors):
        d_name, d_amount = debtors[i]
        c_name, c_amount = creditors[j]
        amt = min(d_amount, c_amount)
        if amt > 0.01:
            transactions.append({'from': d_name, 'to': c_name, 'amount': round(amt, 2)})
        debtors[i] = (d_name, d_amount - amt)
        creditors[j] = (c_name, c_amount - amt)
        if debtors[i][1] < 0.01: i += 1
        if creditors[j][1] < 0.01: j += 1

    return jsonify({'balances': balances, 'transactions': transactions, 'total': sum(i['amount'] for i in items)})

# ==================== API: 链接接力 ====================
@app.route('/api/relay', methods=['POST'])
def send_relay():
    data = request.json or {}
    msg = {
        'from_device': data.get('from_device'),
        'from_nickname': data.get('from_nickname'),
        'to_device': data.get('to_device'),
        'content': data.get('content'),
        'type': data.get('type', 'link'),
        'created_at': now_ts().isoformat()
    }
    relay_messages.append(msg)
    if len(relay_messages) > 100:
        relay_messages.pop(0)
    target = data.get('to_device')
    if target in online_devices:
        socketio.emit('relay_message', msg, room=online_devices[target]['sid'])
    return jsonify({'success': True})

@app.route('/api/relay/<device_id>')
def get_relay(device_id):
    global relay_messages
    msgs = [m for m in relay_messages if m['to_device'] == device_id]
    relay_messages = [m for m in relay_messages if m['to_device'] != device_id]
    return jsonify(msgs)

# ==================== 新功能 API ====================

# 匿名投票
@app.route('/api/vote/<room_code>', methods=['GET', 'POST'])
def vote_api(room_code):
    room_code = room_code.upper()
    if request.method == 'POST':
        data = request.json or {}
        if 'question' in data:
            # 创建投票
            vote_data[room_code] = {
                'question': data['question'],
                'options': {opt: 0 for opt in data.get('options', [])},
                'voters': set(),
                'revealed': False,
                'created_by': data.get('device_id')
            }
            socketio.emit('vote_created', {
                'room_code': room_code,
                'vote': {
                    'question': data['question'],
                    'options': vote_data[room_code]['options'],
                    'revealed': False,
                    'created_by': data.get('device_id')
                }
            }, room=room_code)
            return jsonify({'success': True})
        else:
            # 投票
            v = vote_data.get(room_code)
            if not v:
                return jsonify({'error': '投票不存在'}), 404
            voter = data.get('device_id')
            option = data.get('option')
            if voter in v['voters']:
                return jsonify({'error': '已投票'}), 400
            if option in v['options']:
                v['options'][option] += 1
                v['voters'].add(voter)
                socketio.emit('vote_update', {
                    'room_code': room_code,
                    'options': v['options'],
                    'total': len(v['voters'])
                }, room=room_code)
            return jsonify({'success': True})
    else:
        v = vote_data.get(room_code)
        if not v:
            return jsonify(None)
        return jsonify({
            'question': v['question'],
            'options': v['options'],
            'total': len(v['voters']),
            'revealed': v['revealed'],
            'created_by': v.get('created_by')
        })

@app.route('/api/vote/<room_code>/reveal', methods=['POST'])
def reveal_vote(room_code):
    room_code = room_code.upper()
    v = vote_data.get(room_code)
    if v:
        v['revealed'] = True
        socketio.emit('vote_revealed', {
            'room_code': room_code,
            'options': v['options'],
            'total': len(v['voters'])
        }, room=room_code)
    return jsonify({'success': True})

# 掷骰子
@app.route('/api/dice/<room_code>', methods=['GET', 'POST'])
def dice_api(room_code):
    room_code = room_code.upper()
    if request.method == 'POST':
        data = request.json or {}
        action = data.get('action')
        if action == 'join':
            dice_rooms.setdefault(room_code, {'members': set(), 'last_roll': None, 'history': []})
            dice_rooms[room_code]['members'].add(data.get('device_id'))
            return jsonify({'success': True})
        elif action == 'roll':
            dice_rooms.setdefault(room_code, {'members': set(), 'last_roll': None, 'history': []})
            result = random.randint(1, 6)
            roll_data = {
                'device_id': data.get('device_id'),
                'nickname': data.get('nickname'),
                'result': result,
                'time': now_ts().isoformat()
            }
            dice_rooms[room_code]['last_roll'] = roll_data
            dice_rooms[room_code]['history'].append(roll_data)
            if len(dice_rooms[room_code]['history']) > 50:
                dice_rooms[room_code]['history'].pop(0)
            socketio.emit('dice_roll', {'room_code': room_code, 'roll': roll_data}, room=room_code)
            return jsonify(roll_data)
    else:
        room = dice_rooms.get(room_code, {'members': set(), 'last_roll': None, 'history': []})
        return jsonify({
            'members_count': len(room['members']),
            'last_roll': room['last_roll'],
            'history': room['history'][-10:]
        })

# 随机抽人
@app.route('/api/roulette/<room_code>', methods=['GET', 'POST'])
def roulette_api(room_code):
    room_code = room_code.upper()
    if request.method == 'POST':
        data = request.json or {}
        action = data.get('action')
        if action == 'setup':
            roulette_data[room_code] = {
                'names': data.get('names', []),
                'spinning': False,
                'winner': None,
                'created_by': data.get('device_id'),
                'mode': data.get('mode', 'manual')  # manual 或 auto
            }
            socketio.emit('roulette_setup', {
                'room_code': room_code,
                'names': data.get('names', []),
                'mode': data.get('mode', 'manual')
            }, room=room_code)
            return jsonify({'success': True})
        elif action == 'spin':
            r = roulette_data.get(room_code)
            if not r:
                return jsonify({'error': '房间不存在'}), 400
            r['spinning'] = True
            r['winner'] = None
            socketio.emit('roulette_spin', {'room_code': room_code}, room=room_code)
            import threading
            def finish():
                time.sleep(3)
                names = r['names']
                # 如果名单为空，从房间成员中抽取
                if not names and room_code in rooms:
                    names = list(rooms[room_code]['members'])
                    # 获取昵称
                    names = [online_devices.get(did, {}).get('nickname', did[:6]) for did in names if did in online_devices]
                if not names:
                    names = ['未知']
                winner = random.choice(names)
                r['spinning'] = False
                r['winner'] = winner
                socketio.emit('roulette_result', {'room_code': room_code, 'winner': winner}, room=room_code)
            threading.Thread(target=finish).start()
            return jsonify({'success': True})
    else:
        r = roulette_data.get(room_code, {'names': [], 'spinning': False, 'winner': None, 'mode': 'manual'})
        return jsonify(r)

# 随机决定器
@app.route('/api/random/<room_code>', methods=['GET', 'POST'])
def random_api(room_code):
    room_code = room_code.upper()
    if request.method == 'POST':
        data = request.json or {}
        action = data.get('action')
        if action == 'setup':
            random_picker[room_code] = {
                'options': data.get('options', []),
                'result': None,
                'mode': data.get('mode', 'individual'),
                'created_by': data.get('device_id')
            }
            socketio.emit('random_setup', {
                'room_code': room_code,
                'options': data.get('options', []),
                'mode': data.get('mode', 'individual')
            }, room=room_code)
            return jsonify({'success': True})
        elif action == 'pick':
            r = random_picker.get(room_code)
            if not r or not r['options']:
                return jsonify({'error': '无选项'}), 400
            result = random.choice(r['options'])
            if r.get('mode') == 'group':
                socketio.emit('random_result', {
                    'room_code': room_code,
                    'result': result,
                    'picker': data.get('nickname'),
                    'picker_id': data.get('device_id'),
                    'mode': 'group'
                }, room=room_code)
            return jsonify({'result': result})
    else:
        r = random_picker.get(room_code, {'options': [], 'result': None, 'mode': 'individual', 'created_by': None})
        return jsonify(r)

# ==================== SocketIO 事件 ====================
@socketio.on('connect')
def handle_connect():
    emit('connected', {'sid': request.sid})

@socketio.on('disconnect')
def handle_disconnect():
    for did, info in list(online_devices.items()):
        if info.get('sid') == request.sid:
            del online_devices[did]
            socketio.emit('device_offline', {'device_id': did})
            break

@socketio.on('register')
def handle_register(data):
    global relay_messages
    device_id = data.get('device_id')
    nickname = data.get('nickname', '未知设备')
    online_devices[device_id] = {
        'nickname': nickname,
        'sid': request.sid,
        'last_seen': now_ts(),
        'ip': request.remote_addr
    }
    join_room(device_id)
    emit('registered', {'device_id': device_id, 'online_count': len(online_devices)})
    socketio.emit('device_online', {
        'device_id': device_id,
        'nickname': nickname,
        'ip': request.remote_addr
    }, skip_sid=request.sid)
    pending = [m for m in relay_messages if m['to_device'] == device_id]
    if pending:
        for m in pending:
            emit('relay_message', m)
        relay_messages = [m for m in relay_messages if m['to_device'] != device_id]

@socketio.on('heartbeat')
def handle_heartbeat(data):
    device_id = data.get('device_id')
    if device_id in online_devices:
        online_devices[device_id]['last_seen'] = now_ts()
        online_devices[device_id]['sid'] = request.sid

@socketio.on('join_room_socket')
def handle_join_room_socket(data):
    room_code = data.get('room_code', '').upper()
    if room_code and room_code in rooms:
        join_room(room_code)
        rooms[room_code]['members'].add(request.sid)
        emit('joined_room', {'room_code': room_code})

@socketio.on('leave_room_socket')
def handle_leave_room_socket(data):
    room_code = data.get('room_code', '').upper()
    if room_code:
        leave_room(room_code)
        if room_code in rooms:
            rooms[room_code]['members'].discard(request.sid)

@socketio.on('webrtc_offer')
def handle_webrtc_offer(data):
    target = data.get('target_device')
    if target and target in online_devices:
        socketio.emit('webrtc_offer', {
            'offer': data.get('offer'),
            'from_device': data.get('from_device'),
            'from_nickname': data.get('from_nickname')
        }, room=online_devices[target]['sid'])

@socketio.on('webrtc_answer')
def handle_webrtc_answer(data):
    target = data.get('target_device')
    if target and target in online_devices:
        socketio.emit('webrtc_answer', {
            'answer': data.get('answer'),
            'from_device': data.get('from_device')
        }, room=online_devices[target]['sid'])

@socketio.on('webrtc_ice_candidate')
def handle_ice_candidate(data):
    target = data.get('target_device')
    if target and target in online_devices:
        socketio.emit('webrtc_ice_candidate', {
            'candidate': data.get('candidate'),
            'from_device': data.get('from_device')
        }, room=online_devices[target]['sid'])

@socketio.on('remote_control')
def handle_remote_control(data):
    room_code = data.get('room_code', '').upper()
    action = data.get('action')
    if room_code:
        socketio.emit('remote_control', {
            'action': action,
            'from_device': data.get('from_device'),
            'from_nickname': data.get('from_nickname')
        }, room=room_code)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=True)
